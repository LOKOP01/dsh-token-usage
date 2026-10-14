/**
 * dsh-token-usage — 统计 DeepSeek Harness 每日消耗的 token。
 *
 * ## 统计范围
 *
 * 直接读取 `<DSH_HOME>/sessions/**` 下的会话日志，因此覆盖 harness 的**全部**对话：
 *
 * - 每个工作目录下的主会话；
 * - 子 Agent（`origin: 'subagent'`，独立会话文件）；
 * - workflow 脚本派生的每个子任务（同样是独立会话）；
 * - 标题生成、压缩摘要等旁路模型调用（它们的 usage 记在所属会话里）。
 *
 * 数字来自 provider 返回的真实 `usage`，不是本地估算，所以与账单口径一致。
 *
 * ## 为什么读日志而不是只听实时事件
 *
 * 监听 `session/event` 只能统计**本进程启动之后**产生的用量，历史会话与其它
 * profile 的会话都会漏掉。读日志则一次覆盖全部历史，且天然与 DSH 自身的持久化
 * 保持一致。实时事件用于增量失效缓存，让「刚聊完就查」也能立刻看到最新数字。
 *
 * ## 零依赖
 *
 * 插件以链接（junction）方式安装时，Node 在插件目录下找不到 `node_modules`，
 * 任何裸导入都可能失败。因此本插件只用 `node:` 内置模块，不依赖
 * schemastery / zod 等包，Config 校验也自行实现 Standard Schema 接口。
 *
 * @module dsh-token-usage
 */

import { join } from 'node:path'

import { resolveDshHome, listSessionLogs, readSessionEvents, SessionLogCache } from './scan.js'
import {
  addTotals,
  aggregateByDay,
  aggregateByHour,
  dayKey,
  emptyTotals,
  extractSessionUsage,
  groupRecords,
  isValidTimeZone,
} from './usage.js'
import { renderReport } from './format.js'

/** Cordis 插件名。 */
export const name = 'token-usage'

/**
 * 本插件不声明硬依赖。
 *
 * 统计只读会话日志，`commands` 与 `tools` 都按可选依赖处理：任何一个缺席时，
 * 另一条入口照常可用，插件也不会因此不激活。
 */
export const inject = []

/** 命令名（不含斜杠）。 */
export const COMMAND_NAME = 'token'

/** 工具名。 */
export const TOOL_NAME = 'token_usage'

/**
 * 手写的 Standard Schema 校验器。
 *
 * Cordis 只要求 `plugin.Config` 满足 `~standard.validate`，并不要求它是
 * schemastery 实例。自己实现就免掉了运行时依赖，同时保留配置校验与设置页面的
 * 字段描述。
 *
 * @param shape - 字段名到字段定义的映射。
 * @returns 可挂到 `plugin.Config` 上的 schema 对象。
 */
function createSchema(shape) {
  const coerce = (raw) => {
    const source = raw !== null && typeof raw === 'object' ? raw : {}
    const value = {}
    const issues = []

    for (const [key, field] of Object.entries(shape)) {
      const provided = source[key]

      if (provided === undefined) {
        value[key] = typeof field.default === 'function' ? field.default() : field.default
        continue
      }

      if (field.type === 'boolean') {
        if (typeof provided !== 'boolean') {
          issues.push({ message: `${key} 必须是布尔值`, path: [key] })
          continue
        }
        value[key] = provided
        continue
      }

      if (field.type === 'string') {
        if (typeof provided !== 'string') {
          issues.push({ message: `${key} 必须是字符串`, path: [key] })
          continue
        }
        value[key] = provided
        continue
      }

      if (field.type === 'number') {
        if (typeof provided !== 'number' || !Number.isFinite(provided)) {
          issues.push({ message: `${key} 必须是数字`, path: [key] })
          continue
        }
        value[key] = provided
        continue
      }

      issues.push({ message: `${key} 的类型未知`, path: [key] })
    }

    return issues.length > 0 ? { issues } : { value }
  }

  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-token-usage',
      validate: coerce,
    },
  }
}

/** 运行时配置。 */
export const Config = createSchema({
  enabled: {
    type: 'boolean',
    default: true,
    description: '总开关：关闭后不注册命令与工具',
  },
  timeZone: {
    type: 'string',
    default: '',
    description: '统计分天的时区；留空则跟随系统时区',
  },
  dshHome: {
    type: 'string',
    default: '',
    description: 'DSH 主目录；留空则依次取 DSH_HOME 环境变量与 ~/.dsh',
  },
  defaultDays: {
    type: 'number',
    default: 14,
    description: '/token 默认展示最近多少天',
  },
  includeSubagents: {
    type: 'boolean',
    default: true,
    description: '是否计入子 Agent 与 workflow 子任务消耗的 token',
  },
  cacheTtlMs: {
    type: 'number',
    default: 5000,
    description: '统计结果的缓存时长（毫秒）；0 表示每次查询都重新扫描',
  },
})

/** 系统时区；取不到时退回 UTC。 */
function systemTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone === 'string' && zone.length > 0) return zone
  } catch {
    // 忽略：退回 UTC
  }
  return 'UTC'
}

/**
 * 把任意值规整成无损 JSON。
 *
 * 工具结果会经过 harness 的无损 JSON 校验，`undefined`、`NaN`、`Infinity`、
 * `Map`、`Set`、函数、Symbol 都会让整次工具调用失败。这里用一次 JSON 往返
 * 做兜底：JSON.stringify 会丢掉对象里的 undefined 属性、把 NaN/Infinity 变成
 * null，再解析回来就一定是合法结构。
 *
 * @param value - 待规整的值。
 * @returns 保证可序列化的等价结构。
 */
export function toLosslessJson(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/**
 * 执行一次全量扫描并生成报表。
 *
 * @param options - 扫描选项。
 * @param options.dshHome - DSH 主目录。
 * @param options.timeZone - 分天时区。
 * @param options.days - 展示最近多少天；`0` 表示全部。
 * @param options.includeSubagents - 是否计入子 Agent。
 * @param options.cache - 会话读取缓存。
 * @param options.from - 起始日 `YYYY-MM-DD`（含）。
 * @param options.to - 结束日 `YYYY-MM-DD`（含）。
 * @param options.sessionFilter - 仅统计指定会话 id。
 * @returns 报表对象。
 */
export function buildReport(options) {
  const {
    dshHome,
    timeZone,
    days = 14,
    includeSubagents = true,
    cache,
    from,
    to,
    sessionFilter,
  } = options

  const startedAt = Date.now()
  // 用 join 而不是手拼字符串：Windows 下反斜杠与正斜杠混用会让路径校验出问题。
  const sessionsRoot = join(dshHome, 'sessions')
  const entries = listSessionLogs(sessionsRoot)
  cache?.prune?.(entries)

  const records = []
  const scanned = { sessions: 0, subagentSessions: 0, events: 0, skippedSessions: 0, failedSessions: 0 }
  const sessionTotals = []

  for (const entry of entries) {
    const events = cache !== undefined ? cache.read(entry) : readSessionEvents(entry.path)
    if (events.length === 0) {
      scanned.failedSessions += 1
      continue
    }

    const result = extractSessionUsage(events, {
      sessionId: entry.sessionId,
      timeZone,
      includeSubagents,
    })

    if (result.skipped === true) {
      scanned.skippedSessions += 1
      continue
    }

    scanned.sessions += 1
    if (result.isSubagent === true) scanned.subagentSessions += 1
    scanned.events += events.length

    let sessionRecords = result.records
    if (Array.isArray(sessionFilter) && sessionFilter.length > 0) {
      sessionRecords = sessionRecords.filter((record) => sessionFilter.includes(record.sessionId))
    }
    // 标记来源：浏览器界面要区分主会话与子 Agent 的调用，而 record 本身不带这个信息。
    for (const record of sessionRecords) {
      record.isSubagent = result.isSubagent === true
      record.cwdSlug = entry.cwdSlug
    }
    records.push(...sessionRecords)

    if (result.records.length > 0) {
      const totals = emptyTotals()
      for (const record of result.records) addTotals(totals, record)
      sessionTotals.push({
        key: `${entry.sessionId.slice(0, 20)}…（${result.isSubagent === true ? '子 Agent' : '主会话'}）`,
        sessionId: entry.sessionId,
        cwdSlug: entry.cwdSlug,
        isSubagent: result.isSubagent === true,
        lastTime: Math.max(...result.records.map((record) => record.timeMs)),
        ...totals,
      })
    }
  }

  // 日期区间筛选（含边界）。
  let filtered = records
  if (typeof from === 'string' && from.length > 0) {
    filtered = filtered.filter((record) => record.day >= from)
  }
  if (typeof to === 'string' && to.length > 0) {
    filtered = filtered.filter((record) => record.day <= to)
  }

  // 相对范围必须先过滤记录，不能只裁剪趋势图的日期桶。
  if (days > 0) {
    const today = dayKey(Date.now(), timeZone)
    const firstDay = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10)
    filtered = filtered.filter((record) => record.day >= firstDay && record.day <= today)
  }
  // 会话排行同样按选定区间重算，避免显示全历史会话的用量。
  const selectedSessions = groupRecords(filtered, (record) => record.sessionId).map((group) => {
    const meta = sessionTotals.find((session) => session.sessionId === group.key)
    const sessionRecords = filtered.filter((record) => record.sessionId === group.key)
    return { ...meta, ...group, sessionId: group.key, lastTime: Math.max(...sessionRecords.map((record) => record.timeMs)) }
  })
  const { days: dayBuckets, totals } = aggregateByDay(filtered, { days, now: Date.now(), timeZone })

  const todayKey = dayKey(Date.now(), timeZone)
  const today = dayBuckets.find((bucket) => bucket.day === todayKey)

  // 界面上的「使用趋势」在单日视图下按小时展开，因此只在该视图下算小时桶。
  const hours = days === 1
    ? aggregateByHour(filtered, { day: dayBuckets[0]?.day ?? todayKey, timeZone })
    : []

  const report = {
    timeZone,
    dshHome,
    days: dayBuckets,
    hours,
    totals,
    today,
    models: groupRecords(filtered, (record) => `${record.provider}/${record.model}`, 15),
    providers: groupRecords(filtered, (record) => record.provider, 10),
    sessions: selectedSessions.slice(0, 12),
    // 界面的「请求日志」表格要逐条调用；按时间倒序，最新一条在最上面。
    records: [...filtered].sort((a, b) => b.timeMs - a.timeMs),
    scanned,
    recordCount: filtered.length,
    durationMs: Date.now() - startedAt,
    scope: { from, to },
  }
  return report
}

/**
 * 把报表压成适合工具返回的结构化对象。
 *
 * 工具返回值应当是稳定、紧凑的 JSON：模型不需要条形图，但需要可比较的数字。
 * 这里必须产出**无损 JSON**——`undefined`、`NaN`、`Infinity`、`Map`、`Set`
 * 都会让工具调用以 `value is not lossless JSON` 失败，所以每个字段都显式取值。
 *
 * @param report - 报表对象。
 * @param limit - 每日明细最多返回多少天。
 * @returns 结构化对象。
 */
export function reportToJson(report, limit = 60) {
  const days = report.days.slice(-limit)
  const scope = {}
  if (typeof report.scope?.from === 'string') scope.from = report.scope.from
  if (typeof report.scope?.to === 'string') scope.to = report.scope.to

  return {
    timeZone: report.timeZone,
    totals: {
      totalTokens: report.totals.totalTokens,
      promptTokens: report.totals.promptTokens,
      outputTokens: report.totals.outputTokens,
      cacheReadTokens: report.totals.cacheReadTokens,
      cacheWriteTokens: report.totals.cacheWriteTokens,
      reasoningTokens: report.totals.reasoningTokens,
      calls: report.totals.calls,
      note: '总量 = 输入 + 输出；「输入」(promptTokens) 已含命中缓存的 cacheReadTokens。',
    },
    today: report.today === undefined
      ? null
      : { day: report.today.day, totalTokens: report.today.totalTokens, calls: report.today.calls },
    days: days.map((day) => ({
      day: day.day,
      totalTokens: day.totalTokens,
      promptTokens: day.promptTokens,
      outputTokens: day.outputTokens,
      cacheReadTokens: day.cacheReadTokens,
      calls: day.calls,
      sessions: day.sessions.size,
    })),
    models: report.models.map((group) => ({
      model: group.key,
      totalTokens: group.totalTokens,
      promptTokens: group.promptTokens,
      outputTokens: group.outputTokens,
      cacheReadTokens: group.cacheReadTokens,
      calls: group.calls,
    })),
    sessions: report.sessions.map((session) => ({
      sessionId: session.sessionId,
      subagent: session.isSubagent === true,
      totalTokens: session.totalTokens,
      calls: session.calls,
    })),
    scanned: {
      sessions: report.scanned.sessions,
      subagentSessions: report.scanned.subagentSessions,
      events: report.scanned.events,
      skippedSessions: report.scanned.skippedSessions,
      failedSessions: report.scanned.failedSessions,
    },
    scope,
  }
}

/**
 * 把报表压成浏览器界面消费的结构化对象。
 *
 * 与 `reportToJson` 分开是有意的：那个面是给模型读的，这个面是给界面画的。
 * 界面需要小时桶、逐条调用明细、以及可以直接排序的分组表；模型不需要这些
 * （明细会白白吃掉上下文）。两者的口径完全一致，因为都源自同一个 `report`。
 *
 * 明细条数必须封顶：单个区间可能有上万次调用，全量传进浏览器会让首屏卡住。
 *
 * @param report - 报表对象。
 * @param options - 序列化选项。
 * @param options.recordLimit - 调用明细最多返回多少条。
 * @returns 界面用的结构化对象（无损 JSON）。
 */
export function reportToView(report, options = {}) {
  const { recordLimit = 400 } = options

  const totalsView = (item) => ({
    inputTokens: item.inputTokens ?? 0,
    totalTokens: item.totalTokens,
    promptTokens: item.promptTokens,
    outputTokens: item.outputTokens,
    cacheReadTokens: item.cacheReadTokens,
    cacheWriteTokens: item.cacheWriteTokens,
    reasoningTokens: item.reasoningTokens,
    calls: item.calls,
  })

  const scope = {}
  if (typeof report.scope?.from === 'string') scope.from = report.scope.from
  if (typeof report.scope?.to === 'string') scope.to = report.scope.to
  if (typeof report.scope?.days === 'number') scope.days = report.scope.days

  const records = (report.records ?? []).slice(0, recordLimit)

  return {
    timeZone: report.timeZone,
    generatedAt: Date.now(),
    durationMs: Math.round(report.durationMs),
    totals: totalsView(report.totals),
    today: report.today === undefined ? null : { day: report.today.day, ...totalsView(report.today) },
    scope,
    days: report.days.map((day) => ({ day: day.day, sessions: day.sessions.size, ...totalsView(day) })),
    hours: (report.hours ?? []).map((hour) => ({
      hour: hour.hour,
      label: hour.label,
      sessions: hour.sessions.size,
      ...totalsView(hour),
    })),
    models: report.models.map((group) => ({ key: group.key, ...totalsView(group) })),
    providers: report.providers.map((group) => ({ key: group.key, ...totalsView(group) })),
    sessions: report.sessions.map((session) => ({
      sessionId: session.sessionId,
      // 兜底成空串：这个对象最终要过 JSON，而 undefined 会让字段整个消失。
      cwdSlug: session.cwdSlug ?? '',
      subagent: session.isSubagent === true,
      lastTime: session.lastTime ?? 0,
      ...totalsView(session),
    })),
    records: records.map((record) => ({
      timeMs: record.timeMs,
      day: record.day,
      sessionId: record.sessionId,
      cwdSlug: record.cwdSlug ?? '',
      subagent: record.isSubagent === true,
      provider: record.provider,
      model: record.model,
      durationMs: record.durationMs ?? 0,
      ...totalsView(record),
    })),
    recordTotal: report.records?.length ?? 0,
    scanned: {
      sessions: report.scanned.sessions,
      subagentSessions: report.scanned.subagentSessions,
      events: report.scanned.events,
      skippedSessions: report.scanned.skippedSessions,
      failedSessions: report.scanned.failedSessions,
    },
  }
}

/**
 * 解析 `/token` 的参数。
 *
 * 支持的写法：
 * - 无参数：最近 `defaultDays` 天；
 * - `7` / `7d`：最近 7 天；
 * - `all` / `全部`：全部历史；
 * - `today` / `今天`：仅今天；
 * - `2026-10-01`：那一天；
 * - `2026-10-01..2026-10-13`：区间；
 * - `--json`：输出结构化 JSON。
 *
 * @param rawInput - 命令行的其余部分。
 * @param defaultDays - 配置里的默认天数。
 * @returns 解析结果；`error` 非空表示解析失败。
 */
export function parseCommandInput(rawInput, defaultDays) {
  const text = (rawInput ?? '').trim()
  const result = { days: defaultDays, from: undefined, to: undefined, json: false, error: undefined }
  if (text.length === 0) return result

  const tokens = text.split(/\s+/u).filter((token) => token.length > 0)
  const rest = []

  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (lower === '--json' || lower === 'json') {
      result.json = true
      continue
    }
    if (lower === 'all' || token === '全部' || token === '所有') {
      result.days = 0
      result.from = undefined
      result.to = undefined
      continue
    }
    if (lower === 'today' || token === '今天' || token === '今日') {
      result.days = 1
      continue
    }
    rest.push(token)
  }

  const spec = rest.join('')
  if (spec.length === 0) return result

  // 区间：A..B
  const range = /^(\d{4}-\d{2}-\d{2})?\.\.(\d{4}-\d{2}-\d{2})?$/u.exec(spec)
  if (range !== null) {
    if (range[1] === undefined && range[2] === undefined) {
      result.error = '区间写法需要至少一个日期，例如 2026-10-01..2026-10-13'
      return result
    }
    result.from = range[1]
    result.to = range[2]
    result.days = 0
    return result
  }

  // 单日：YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/u.test(spec)) {
    result.from = spec
    result.to = spec
    result.days = 0
    return result
  }

  // 天数：7 / 7d / 7天
  const dayCount = /^(\d+)(?:d|天)?$/u.exec(spec)
  if (dayCount !== null) {
    const n = Number(dayCount[1])
    if (n <= 0 || n > 3650) {
      result.error = `天数需要在 1..3650 之间，收到 ${n}`
      return result
    }
    result.days = n
    return result
  }

  result.error = `无法识别的参数「${text}」`
  return result
}

/** 一行用法说明。 */
const USAGE = [
  '用法：/token [天数 | 今天 | 全部 | YYYY-MM-DD | A..B] [--json]',
  '示例：/token 7 ｜ /token today ｜ /token 2026-10-01..2026-10-13 ｜ /token all --json',
].join('\n')

/**
 * 浏览器界面取数的路由。
 *
 * 路径带包名前缀，和 DSH 给插件分配的 `/plugins/<包名>/...` 空间保持一致；
 * client-modules 的 bundle 路由是 `/plugins` 前缀，而精确路径优先于前缀，
 * 所以这里不会和它冲突。
 */
export const DATA_PATH = '/plugins/dsh-token-usage/data'

/** 单次响应最多回传多少条调用明细。 */
const DATASET_RECORD_LIMIT = 600

/** 允许访问数据路由的主机名（仅回环，避免被局域网其它机器读走用量）。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * 从 Host 头里取出主机名（去掉端口，兼容 IPv6 方括号写法）。
 *
 * @param host - `Host` 请求头的值。
 * @returns 小写主机名；无法判定时为空串。
 */
function hostnameOf(host) {
  if (typeof host !== 'string') return ''
  const value = host.trim().toLowerCase()
  if (value.length === 0) return ''
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? value : value.slice(0, end + 1)
  }
  const colon = value.lastIndexOf(':')
  return colon === -1 ? value : value.slice(0, colon)
}

/**
 * 判断请求是否来自回环地址。
 *
 * `Host` 必须是回环主机名；浏览器带 `Origin` 时它也必须指向回环。
 * 这是防 DNS rebinding 的最小充分条件：外部页面即使能解析到 127.0.0.1，
 * 也带不上回环的 `Origin`。
 *
 * @param req - HTTP 请求。
 * @returns 允许访问时为 true。
 */
export function isLoopbackRequest(req) {
  if (!LOOPBACK_HOSTS.has(hostnameOf(req?.headers?.host))) return false
  const origin = req?.headers?.origin
  if (typeof origin !== 'string' || origin.trim().length === 0) return true
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * 写一个 JSON 响应。
 *
 * @param res - HTTP 响应。
 * @param status - 状态码。
 * @param value - 待序列化的值。
 */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    // 用量是实时数据，任何中间层缓存都会让界面显示过期数字。
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 把 URL 查询串折算成一次统计查询。
 *
 * 支持 `?days=7`、`?from=2026-10-01&to=2026-10-13`、`?refresh=1`。
 * 参数非法时明确回 400，而不是悄悄退回默认值——界面上的下拉框如果和
 * 实际口径不一致，用户看到的数字就没有意义。
 *
 * @param url - 请求 URL。
 * @param defaultDays - 配置里的默认天数。
 * @returns `{ query, force }`；`error` 非空表示参数非法。
 */
export function parseDataQuery(url, defaultDays) {
  const text = typeof url === 'string' ? url : '/'
  let params
  try {
    params = new URL(text, 'http://localhost').searchParams
  } catch {
    return { error: '无法解析请求 URL' }
  }

  const rawDays = params.get('days')
  const from = params.get('from') ?? undefined
  const to = params.get('to') ?? undefined

  let days = defaultDays
  if (rawDays !== null && rawDays.length > 0) {
    const parsed = Number(rawDays)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 3650) {
      return { error: `days 需要在 0..3650 之间，收到「${rawDays}」` }
    }
    days = Math.floor(parsed)
  }

  const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  if (from !== undefined && !isDate(from)) return { error: `from 需要是 YYYY-MM-DD，收到「${from}」` }
  if (to !== undefined && !isDate(to)) return { error: `to 需要是 YYYY-MM-DD，收到「${to}」` }
  // 指定了绝对区间时，相对天数不再参与筛选，否则两个口径会互相打架。
  if (isDate(from) || isDate(to)) days = 0

  return {
    query: { days, from, to },
    force: params.get('refresh') === '1' || params.get('refresh') === 'true',
  }
}

/**
 * 处理一次界面取数请求。
 *
 * @param req - HTTP 请求。
 * @param res - HTTP 响应。
 * @param getReport - 取得报表的函数（带缓存）。
 * @param options - 处理选项。
 * @param options.defaultDays - 默认天数。
 * @param options.recordLimit - 明细条数上限。
 */
export function handleDataRequest(req, res, getReport, options) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }
  if (!isLoopbackRequest(req)) {
    sendJson(res, 403, { error: '仅允许本机访问' })
    return
  }

  const parsed = parseDataQuery(req.url, options.defaultDays)
  if (parsed.error !== undefined) {
    sendJson(res, 400, { error: parsed.error })
    return
  }

  try {
    const report = getReport(parsed.query, parsed.force)
    sendJson(res, 200, toLosslessJson(reportToView(report, { recordLimit: options.recordLimit })))
  } catch (error) {
    sendJson(res, 500, { error: `统计失败：${error instanceof Error ? error.message : String(error)}` })
  }
}

/**
 * 把插件挂到 Host。
 *
 * @param ctx - 挂载上下文。
 * @param rawConfig - Loader 传入的配置；缺省字段按 schema 默认值处理。
 */
export function apply(ctx, rawConfig) {
  const config = rawConfig ?? {}
  if (config.enabled === false) {
    ctx.logger?.info?.('dsh-token-usage: 已在配置中关闭')
    return
  }

  const timeZone = isValidTimeZone(config.timeZone) ? config.timeZone : systemTimeZone()
  const dshHome = resolveDshHome(config.dshHome)
  const defaultDays = Number.isFinite(config.defaultDays) && config.defaultDays >= 0
    ? Math.floor(config.defaultDays)
    : 14
  const includeSubagents = config.includeSubagents !== false
  const cacheTtlMs = Number.isFinite(config.cacheTtlMs) && config.cacheTtlMs >= 0
    ? config.cacheTtlMs
    : 5000

  /** 会话日志读取缓存：按 mtime + size 命中，跨查询复用。 */
  const logCache = new SessionLogCache()

  /** 报表级缓存：短时间内重复查询不必重算聚合。 */
  let cachedReport = null
  let cachedAt = 0

  /**
   * 取得报表，命中缓存时直接复用。
   *
   * @param query - 查询参数。
   * @param force - 跳过缓存。
   */
  const getReport = (query = {}, force = false) => {
    const now = Date.now()
    const sameQuery = cachedReport !== null
      && cachedReport.scope.from === query.from
      && cachedReport.scope.to === query.to
      && cachedReport.scope.days === query.days
    if (!force && sameQuery && cacheTtlMs > 0 && now - cachedAt < cacheTtlMs) {
      return cachedReport
    }

    const report = buildReport({
      dshHome,
      timeZone,
      days: query.days ?? defaultDays,
      includeSubagents,
      cache: logCache,
      from: query.from,
      to: query.to,
      sessionFilter: query.sessionFilter,
    })
    report.scope.days = query.days ?? defaultDays
    cachedReport = report
    cachedAt = now
    return report
  }

  // 实时事件只用于让缓存失效：日志本身才是数据源。
  // 这样「刚聊完立刻查」能拿到最新数字，同时不必为每条事件做增量累加。
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
    if (event.data?.usage === undefined) return
    cachedAt = 0
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: 'dsh-token-usage',
      name: COMMAND_NAME,
      description: '统计 harness 每日消耗的 token（含子 Agent 与 workflow 子任务）',
      input: { hint: '[天数|today|all|YYYY-MM-DD|A..B] [--json]' },
      handler: (invocation) => {
        const parsed = parseCommandInput(invocation.rawInput, defaultDays)
        if (parsed.error !== undefined) {
          return { kind: 'error', text: `${parsed.error}\n${USAGE}` }
        }

        let report
        try {
          report = getReport({ days: parsed.days, from: parsed.from, to: parsed.to }, true)
        } catch (error) {
          return { kind: 'error', text: `统计失败：${error instanceof Error ? error.message : String(error)}` }
        }

        if (parsed.json) {
          return { kind: 'success', text: JSON.stringify(reportToJson(report), null, 2) }
        }

        const lines = [renderReport(report)]
        if (report.scanned.sessions === 0) {
          lines.push('未找到任何会话日志。若 harness 装在别处，请在插件配置里指定 dshHome。')
        }
        lines.push(USAGE)
        return { kind: 'success', text: lines.join('\n\n') }
      },
    })
  })

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register({
      name: TOOL_NAME,
      description:
        '统计 DeepSeek Harness 消耗的 token：读取全部会话日志中 provider 返回的真实 usage，'
        + '按本地时区分天汇总，覆盖主会话、子 Agent 与 workflow 子任务。'
        + '用于回答「今天/本周/本月用了多少 token」这类问题。',
      parameters: {
        type: 'object',
        properties: {
          days: {
            type: 'integer',
            description: '统计最近多少天；0 表示全部历史。默认取插件配置的 defaultDays。',
            minimum: 0,
            maximum: 3650,
          },
          from: {
            type: 'string',
            description: '起始日 YYYY-MM-DD（含）。与 to 一起使用时按区间筛选。',
          },
          to: {
            type: 'string',
            description: '结束日 YYYY-MM-DD（含）。',
          },
          groupBy: {
            type: 'string',
            enum: ['day', 'model', 'session'],
            description: '聚合维度；默认 day。',
          },
          refresh: {
            type: 'boolean',
            description: '是否绕过缓存强制重新扫描；默认 false。',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          description: '按维度聚合的 token 用量。',
          additionalProperties: true,
        },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value, null, 2) },
        ],
      },
      execute: (args) => {
        const input = args !== null && typeof args === 'object' ? args : {}
        const days = typeof input.days === 'number' ? Math.max(0, Math.min(3650, Math.floor(input.days))) : defaultDays
        const report = getReport(
          {
            days,
            from: typeof input.from === 'string' ? input.from : undefined,
            to: typeof input.to === 'string' ? input.to : undefined,
          },
          input.refresh === true,
        )

        // 工具结果必须是无损 JSON：undefined / NaN / Map / Set 都会让调用失败。
        // 这里统一走一次 JSON 往返，把任何残留的非法值挡在返回之前。
        const payload = toLosslessJson(reportToJson(report))
        if (input.groupBy === 'model') {
          return { groupBy: 'model', timeZone: report.timeZone, models: payload.models, totals: payload.totals, scanned: payload.scanned }
        }
        if (input.groupBy === 'session') {
          return { groupBy: 'session', timeZone: report.timeZone, sessions: payload.sessions, totals: payload.totals, scanned: payload.scanned }
        }
        return payload
      },
    })
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: DATA_PATH,
      handler: (req, res) => {
        handleDataRequest(req, res, getReport, { defaultDays, recordLimit: DATASET_RECORD_LIMIT })
      },
    }), 'dsh-token-usage: 数据路由')
  })

  ctx.logger?.info?.(
    `dsh-token-usage: 已启用（时区 ${timeZone}，默认 ${defaultDays} 天，`
    + `${includeSubagents ? '含' : '不含'}子 Agent，会话目录 ${dshHome}/sessions）`,
  )
}
