/**
 * 用量提取与每日聚合。
 *
 * ## 数据来源
 *
 * DSH 的会话日志里，`assistant/message` 事件带 provider 返回的真实用量：
 *
 * ```json
 * { "type": "assistant/message", "time": 1791874334404,
 *   "data": { "usage": { "inputTokens": 8484, "outputTokens": 201,
 *                        "totalTokens": 10093, "cacheReadTokens": 1408 },
 *             "message": { "source": { "provider": "workbuddy-ai",
 *                                      "model": "deepseek-v4.1-flash" } } } }
 * ```
 *
 * 这是唯一权威口径：它来自 provider，而不是本地估算，因此与账单一致。
 * 一个会话日志覆盖了主 Agent、它的子 Agent（独立会话、`parentSession` 指向父会话）
 * 与 workflow 子任务，所以「扫描全部会话日志」天然就是「harness 所有对话消耗」。
 *
 * ## 为什么不计 `assistant/attempt`
 *
 * `assistant/attempt` 是流式尝试的中间记录，用于崩溃恢复。它偶尔也带 usage
 * chunk，但实测这些 chunk 的 `totalTokens` 恒为 0（重试前的空尝试），
 * 且当它与 `assistant/message` 属于同一个 step 时，两者会重复。因此只统计
 * `assistant/message`，避免虚增。
 *
 * ## 字段口径（已用 1413 条真实记录反推验证）
 *
 * provider 返回的 `totalTokens` **恒等于**
 * `inputTokens + outputTokens + cacheReadTokens`（另有 `cacheWriteTokens` 时也计入）。
 * 也就是说：
 *
 * - `inputTokens` 是**未命中缓存**的输入；
 * - `cacheReadTokens` 是**命中缓存**的输入，与 `inputTokens` 并列，**不在它之内**；
 * - 因此「全部输入」= `inputTokens + cacheReadTokens + cacheWriteTokens`；
 * - `outputTokens` 是输出，`reasoningTokens` 是它的**子集**（实测恒 `<= outputTokens`），
 *   所以只展示、不重复计入总量。
 *
 * 缓存命中率按 `cacheReadTokens / 全部输入` 计算。本机实测该比值可达 98%
 * （长对话反复发送同一上下文），因此「输入」与「缓存命中」两列必须分开看，
 * 否则会把 2 亿 token 里的 2.15 亿误读成净消耗。
 *
 * `deepseek-official` 这类 provider 不返回 `totalTokens`，此时按同一公式补齐。
 *
 * @module dsh-token-usage/usage
 */

/** 单条用量记录的空值。 */
const EMPTY_TOTALS = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  promptTokens: 0,
  totalTokens: 0,
  calls: 0,
})

/**
 * 从一条 usage 对象里取出各项计数，并归一化缺失字段。
 *
 * @param usage - provider 返回的 usage。
 * @returns 归一化后的计数。
 */
export function normalizeUsage(usage) {
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const inputTokens = num(usage?.inputTokens)
  const outputTokens = num(usage?.outputTokens)
  const cacheReadTokens = num(usage?.cacheReadTokens)
  const cacheWriteTokens = num(usage?.cacheWriteTokens)
  const declaredTotal = num(usage?.totalTokens)

  // 全部输入 = 未命中 + 命中缓存 + 写入缓存。
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens
  // provider 未给总账时按已验证的同一公式补齐。
  const fallbackTotal = promptTokens + outputTokens

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: num(usage?.reasoningTokens),
    promptTokens,
    // provider 给了总账就以它为准；两者不一致时取较大值，宁可高估不漏计。
    totalTokens: Math.max(declaredTotal, fallbackTotal),
    calls: 1,
  }
}

/**
 * 把一组计数累加到目标上（就地修改）。
 *
 * @param target - 累加目标。
 * @param delta - 增量。
 */
export function addTotals(target, delta) {
  target.inputTokens += delta.inputTokens
  target.outputTokens += delta.outputTokens
  target.cacheReadTokens += delta.cacheReadTokens
  target.cacheWriteTokens += delta.cacheWriteTokens
  target.reasoningTokens += delta.reasoningTokens
  target.promptTokens += delta.promptTokens
  target.totalTokens += delta.totalTokens
  target.calls += delta.calls
}

/** 新建一个零值计数。 */
export function emptyTotals() {
  return { ...EMPTY_TOTALS }
}

/**
 * 把时间戳格式化为指定时区下的 `YYYY-MM-DD`。
 *
 * 用 `Intl.DateTimeFormat` 而不是手工做时区偏移：它能正确处理夏令时切换，
 * 也避免把「本地日」错误地当成「UTC 日」——后者会让晚上的用量记到第二天。
 *
 * @param timeMs - Unix 毫秒时间戳。
 * @param timeZone - IANA 时区名，例如 `Asia/Shanghai`。
 * @returns `YYYY-MM-DD`；时区非法时退回 UTC。
 */
export function dayKey(timeMs, timeZone) {
  const date = new Date(timeMs)
  if (Number.isNaN(date.getTime())) return '1970-01-01'
  try {
    // en-CA 的短日期格式恰好是 YYYY-MM-DD，省去手工拼装。
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

/**
 * 判断时区名是否可用。
 *
 * @param timeZone - 待检查的时区名。
 * @returns 可用时为 true。
 */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return false
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone })
    return true
  } catch {
    return false
  }
}

/** 解析 `Asia/Shanghai` 这类时区的 UTC 偏移（毫秒）。 */
function zoneOffsetMs(timeMs, timeZone) {
  const date = new Date(timeMs)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)
  const get = (type) => Number(parts.find((part) => part.type === type)?.value ?? '0')
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  )
  // 丢弃毫秒后比较，避免毫秒抖动污染偏移。
  return asUtc - Math.floor(timeMs / 1000) * 1000
}

/**
 * 求某个本地日的 `[start, end)` 时间戳区间。
 *
 * @param day - `YYYY-MM-DD`。
 * @param timeZone - IANA 时区名。
 * @returns 起止毫秒时间戳；日期非法时为 null。
 */
export function dayRange(day, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day)
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const date = Number(match[3])
  if (month < 1 || month > 12 || date < 1 || date > 31) return null

  // 先按 UTC 造出该本地日的「墙上时间」，再减去该时区在那一刻的偏移。
  const wall = Date.UTC(year, month - 1, date, 0, 0, 0)
  let start = wall - zoneOffsetMs(wall, timeZone)
  // 偏移可能因夏令时在边界处变化，用求得的起点再校正一次。
  start = wall - zoneOffsetMs(start, timeZone)
  const end = start + 24 * 60 * 60 * 1000
  return { start, end }
}

/**
 * 取会话日志头部的事件（`type: 'session'`），它携带会话元数据。
 *
 * @param events - 会话事件数组。
 * @returns 头部事件；缺失时为 undefined。
 */
export function sessionHeader(events) {
  for (const event of events) {
    if (event?.type === 'session') return event
  }
  return undefined
}

/**
 * 从流式记录里求这次调用的耗时（毫秒）。
 *
 * `assistant/message` 的 `stream` 字段是本次生成的流式回放：断点式的 `time`
 * 加上成块的 `time0` + `dt` 增量。最后一块的结束时间是 `time0 + Σdt`——只看
 * `time0` 会把最长的一块算漏，于是速度被高估好几倍。
 *
 * 这个数字是「首块到末块」的墙钟跨度，不含排队与网络往返，因此它是**流式速度**
 * 而不是端到端延迟；界面上标注清楚，避免被当成请求耗时。
 *
 * @param stream - `assistant/message` 的 `data.stream`。
 * @returns 毫秒；无法判定时为 0。
 */
export function streamDurationMs(stream) {
  if (!Array.isArray(stream) || stream.length === 0) return 0
  let first = Number.POSITIVE_INFINITY
  let last = Number.NEGATIVE_INFINITY

  for (const entry of stream) {
    if (entry === null || typeof entry !== 'object') continue
    const start = typeof entry.time === 'number'
      ? entry.time
      : (typeof entry.time0 === 'number' ? entry.time0 : undefined)
    if (start === undefined) continue
    if (start < first) first = start

    let end = start
    if (Array.isArray(entry.dt)) {
      let sum = 0
      for (const delta of entry.dt) if (typeof delta === 'number' && Number.isFinite(delta)) sum += delta
      end = start + sum
    }
    if (end > last) last = end
  }

  if (!Number.isFinite(first) || !Number.isFinite(last)) return 0
  return Math.max(0, last - first)
}

/**
 * 把一个会话的全部用量记录提取出来。
 *
 * @param events - 会话事件数组。
 * @param options - 提取选项。
 * @param options.sessionId - 会话 id，用于结果标注。
 * @param options.timeZone - 时区，用于计算 `day`。
 * @param options.includeSubagents - 是否计入子 Agent 会话（`origin: 'subagent'`）。
 * @returns `{ records, totals, header }`。
 */
export function extractSessionUsage(events, options) {
  const { sessionId, timeZone, includeSubagents = true } = options
  const header = sessionHeader(events)
  const isSubagent = header?.origin === 'subagent'

  const records = []
  const totals = emptyTotals()

  if (isSubagent && !includeSubagents) {
    return { records, totals, header, skipped: true, isSubagent }
  }

  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (usage === undefined || usage === null) continue
    // 时间戳缺失时退回会话创建时间，至少不会丢进 1970。
    const timeMs = typeof event.time === 'number' ? event.time : header?.createdAt
    if (typeof timeMs !== 'number') continue

    const counts = normalizeUsage(usage)
    // provider 明确返回全零时不产生记录，避免污染调用计数。
    if (counts.totalTokens === 0) continue

    const source = event.data?.message?.source
    const record = {
      sessionId,
      timeMs,
      day: dayKey(timeMs, timeZone),
      provider: typeof source?.provider === 'string' ? source.provider : '(未知)',
      model: typeof source?.model === 'string' ? source.model : '(未知)',
      // 流式跨度用于界面的「速度」列；取不到时为 0，界面显示为 `—`。
      durationMs: streamDurationMs(event.data?.stream),
      ...counts,
    }
    records.push(record)
    addTotals(totals, counts)
  }

  return { records, totals, header, skipped: false, isSubagent }
}

/**
 * 按天聚合用量记录。
 *
 * @param records - 用量记录数组。
 * @param options - 聚合选项。
 * @param options.timeZone - 时区（记录已带 `day`，此参数仅用于生成日期序列）。
 * @param options.days - 需要输出的天数；`0` 表示全部。
 * @param options.now - 当前时间戳，用于确定「今天」。
 * @returns `{ days, totals }`，`days` 按日期升序。
 */
export function aggregateByDay(records, options = {}) {
  const { days = 0, now = Date.now(), timeZone = 'UTC' } = options

  const byDay = new Map()
  for (const record of records) {
    let bucket = byDay.get(record.day)
    if (bucket === undefined) {
      bucket = {
        day: record.day,
        ...emptyTotals(),
        byModel: new Map(),
        byProvider: new Map(),
        sessions: new Set(),
      }
      byDay.set(record.day, bucket)
    }
    addTotals(bucket, record)
    bucket.sessions.add(record.sessionId)

    const modelKey = `${record.provider}/${record.model}`
    let modelBucket = bucket.byModel.get(modelKey)
    if (modelBucket === undefined) {
      modelBucket = emptyTotals()
      bucket.byModel.set(modelKey, modelBucket)
    }
    addTotals(modelBucket, record)

    let providerBucket = bucket.byProvider.get(record.provider)
    if (providerBucket === undefined) {
      providerBucket = emptyTotals()
      bucket.byProvider.set(record.provider, providerBucket)
    }
    addTotals(providerBucket, record)
  }

  let list = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))

  if (days > 0 && list.length > 0) {
    // 以「今天」为锚点向前取 N 天，并补齐没有用量的空白日，
    // 这样输出是连续的日历而不是稀疏的点。
    const today = dayKey(now, timeZone)
    const wanted = []
    const cursor = new Date(`${today}T00:00:00Z`)
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(cursor.getTime() - i * 86_400_000)
      wanted.push(d.toISOString().slice(0, 10))
    }
    const index = new Map(list.map((bucket) => [bucket.day, bucket]))
    list = wanted.map((day) => {
      const found = index.get(day)
      if (found !== undefined) return found
      return {
        day,
        ...emptyTotals(),
        byModel: new Map(),
        byProvider: new Map(),
        sessions: new Set(),
      }
    })
  }

  const totals = emptyTotals()
  for (const bucket of byDay.values()) addTotals(totals, bucket)

  return { days: list, totals }
}

/**
 * 把时间戳格式化为指定时区下的 `YYYY-MM-DDTHH`（小时桶键）。
 *
 * 界面上的「使用趋势」在单日视图下要按小时展开，因此需要一个稳定的小时键。
 * 与 `dayKey` 同样走 `Intl`，避免手工偏移在夏令时边界出错。
 *
 * @param timeMs - Unix 毫秒时间戳。
 * @param timeZone - IANA 时区名。
 * @returns `YYYY-MM-DDTHH`；时区非法时退回 UTC。
 */
export function hourKey(timeMs, timeZone) {
  const date = new Date(timeMs)
  if (Number.isNaN(date.getTime())) return '1970-01-01T00'
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    }).formatToParts(date)
    const get = (type) => parts.find((part) => part.type === type)?.value ?? '00'
    // 部分时区在午夜给出 24，归一化成 00，否则会和当天 00 点分成两个桶。
    const hour = get('hour') === '24' ? '00' : get('hour')
    return `${get('year')}-${get('month')}-${get('day')}T${hour}`
  } catch {
    return date.toISOString().slice(0, 13)
  }
}

/**
 * 把某一天的记录按小时分桶，输出固定 24 个桶。
 *
 * 固定长度是有意的：界面画的是「一天的时间轴」，缺数据的时段必须留白，
 * 稀疏数组会让柱子的位置随时间漂移。
 *
 * @param records - 用量记录数组。
 * @param options - 聚合选项。
 * @param options.day - 目标日期 `YYYY-MM-DD`。
 * @param options.timeZone - IANA 时区名。
 * @returns 24 个小时桶，按小时升序。
 */
export function aggregateByHour(records, options) {
  const { day, timeZone } = options
  const buckets = []
  for (let hour = 0; hour < 24; hour++) {
    const key = `${day}T${String(hour).padStart(2, '0')}`
    buckets.push({ hour: key, label: String(hour).padStart(2, '0'), ...emptyTotals(), sessions: new Set() })
  }
  const index = new Map(buckets.map((bucket) => [bucket.hour, bucket]))

  for (const record of records) {
    const key = hourKey(record.timeMs, timeZone)
    const bucket = index.get(key)
    if (bucket === undefined) continue
    addTotals(bucket, record)
    bucket.sessions.add(record.sessionId)
  }

  return buckets
}

/**
 * 汇总一组记录的分布（按模型或按会话）。
 *
 * @param records - 用量记录数组。
 * @param keyOf - 从记录取出分组键的函数。
 * @param limit - 最多返回多少项；`0` 表示不限。
 * @returns 按 token 降序的数组。
 */
export function groupRecords(records, keyOf, limit = 0) {
  const groups = new Map()
  for (const record of records) {
    const key = keyOf(record)
    let bucket = groups.get(key)
    if (bucket === undefined) {
      bucket = { key, ...emptyTotals() }
      groups.set(key, bucket)
    }
    addTotals(bucket, record)
  }
  const list = [...groups.values()].sort((a, b) => b.totalTokens - a.totalTokens)
  return limit > 0 ? list.slice(0, limit) : list
}
