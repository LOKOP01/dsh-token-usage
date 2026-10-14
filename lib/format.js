/**
 * 中文报表格式化。
 *
 * 输出面向两处消费者：`/token` 命令的结果面板（等宽文本）与 `token_usage`
 * 工具的返回值。两者都用同一套渲染，保证人看到的与模型读到的完全一致。
 *
 * 数值统一用「万 / 亿」这类中文量级，并保留一位小数：token 动辄百万，
 * 逐位数字既难读也占宽度。
 *
 * @module dsh-token-usage/format
 */

/** 千分位整数。 */
export function comma(value) {
  return Math.round(value).toLocaleString('en-US')
}

/**
 * 中文量级缩写。
 *
 * @param value - 原始数值。
 * @returns 例如 `1.2万`、`3.4亿`。
 */
export function human(value) {
  const n = Math.round(value)
  if (n < 10_000) return comma(n)
  if (n < 100_000_000) return `${(n / 10_000).toFixed(1)}万`
  return `${(n / 100_000_000).toFixed(2)}亿`
}

/**
 * 画一条按比例缩放的条形图。
 *
 * @param value - 当前值。
 * @param max - 基准最大值。
 * @param width - 最大宽度（字符数）。
 * @returns 由 `█` 组成的字符串；`value` 非零时至少一个字符，便于看出「有量但很小」。
 */
export function bar(value, max, width = 24) {
  if (max <= 0 || value <= 0) return ''
  const filled = Math.max(1, Math.round((value / max) * width))
  return '█'.repeat(Math.min(filled, width))
}

/**
 * 把百分比格式化为 `xx.x%`。
 *
 * @param part - 分子。
 * @param whole - 分母；为 0 时返回 `-`。
 */
export function percent(part, whole) {
  if (whole <= 0) return '-'
  return `${((part / whole) * 100).toFixed(1)}%`
}

/** 两位补零。 */
const pad = (value) => String(value).padStart(2, '0')

/**
 * 把时间戳格式化为指定时区的 `YYYY-MM-DD HH:mm`。
 *
 * @param timeMs - Unix 毫秒时间戳。
 * @param timeZone - IANA 时区名。
 */
export function formatTime(timeMs, timeZone) {
  const date = new Date(timeMs)
  if (Number.isNaN(date.getTime())) return '-'
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date)
    const get = (type) => parts.find((part) => part.type === type)?.value ?? '00'
    // 某些时区在午夜会给出 24，归一化成 00。
    const hour = get('hour') === '24' ? '00' : get('hour')
    return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ')
  }
}

/**
 * 缓存命中率。
 *
 * 分母是**全部输入**（未命中 + 命中缓存 + 写入缓存），而不是 `inputTokens`
 * 单独一项：后者只是未命中部分，拿它当分母会算出大于 100% 的荒谬比例。
 *
 * @param totals - 含 `cacheReadTokens` 与 `promptTokens` 的计数。
 * @returns 例如 `98.7%`。
 */
export function cacheRate(totals) {
  return percent(totals.cacheReadTokens, totals.promptTokens)
}

/**
 * 渲染每日用量表。
 *
 * @param days - `aggregateByDay` 返回的日桶数组。
 * @param options - 渲染选项。
 * @param options.timeZone - 时区名，用于表头。
 * @param options.showBar - 是否画条形图。
 * @param options.showCache - 是否显示缓存列。
 * @returns 多行文本。
 */
export function renderDaily(days, options = {}) {
  const { timeZone = 'UTC', showBar = true, showCache = true } = options
  if (days.length === 0) return '（该区间没有用量记录）'

  const max = Math.max(...days.map((day) => day.totalTokens))
  const lines = []

  const header = ['日期', '总 token', '输入', '输出']
  if (showCache) header.push('缓存命中率')
  header.push('调用')
  if (showBar) header.push('占比')
  lines.push(header.join('  '))

  for (const day of days) {
    const row = [
      day.day,
      human(day.totalTokens).padStart(8),
      human(day.promptTokens).padStart(8),
      human(day.outputTokens).padStart(7),
    ]
    if (showCache) {
      row.push(cacheRate(day).padStart(10))
    }
    row.push(String(day.calls).padStart(5))
    if (showBar) row.push(bar(day.totalTokens, max))
    lines.push(row.join('  '))
  }

  return lines.join('\n')
}

/**
 * 渲染「键 → 用量」的排行表。
 *
 * @param groups - `groupRecords` 的返回值。
 * @param options - 渲染选项。
 * @param options.title - 表格标题。
 * @param options.label - 键的列名。
 * @param options.limit - 最多显示多少行。
 * @param options.showBar - 是否画条形图。
 * @returns 多行文本；无数据时为空串。
 */
export function renderRanking(groups, options = {}) {
  const { title = '排行', label = '名称', limit = 10, showBar = true } = options
  if (groups.length === 0) return ''

  const shown = groups.slice(0, limit)
  const max = Math.max(...shown.map((group) => group.totalTokens))
  const lines = [`${title}`, `${label}  总 token  调用`]

  for (const group of shown) {
    const name = String(group.key)
    const row = [
      name.length > 28 ? `${name.slice(0, 27)}…` : name.padEnd(28),
      human(group.totalTokens).padStart(9),
      String(group.calls).padStart(5),
    ]
    if (showBar) row.push(bar(group.totalTokens, max, 16))
    lines.push(row.join('  '))
  }
  return lines.join('\n')
}

/**
 * 渲染一次完整统计的文本报表。
 *
 * @param report - `buildReport` 产出的报表对象。
 * @returns 多行中文文本。
 */
export function renderReport(report) {
  const { totals, days, models, providers, sessions, timeZone, scanned, durationMs, scope } = report
  const blocks = []

  blocks.push(`# Token 用量统计（时区 ${timeZone}）`)
  blocks.push(
    [
      `总计：${comma(totals.totalTokens)} token（${human(totals.totalTokens)}）`,
      `输入 ${comma(totals.promptTokens)}（其中命中缓存 ${comma(totals.cacheReadTokens)}，占 ${cacheRate(totals)}）｜ 输出 ${comma(totals.outputTokens)}`,
      `模型调用 ${comma(totals.calls)} 次 ｜ 扫描会话 ${comma(scanned.sessions)} 个（子 Agent ${comma(scanned.subagentSessions)} 个）｜ 耗时 ${Math.round(durationMs)}ms`,
    ].join('\n'),
  )
  blocks.push(
    '说明：总量 = 输入 + 输出，其中「输入」含未命中与命中缓存两部分；'
    + '命中缓存的 token 单价更低，但同样计入总量。',
  )

  if (scope?.from !== undefined || scope?.to !== undefined) {
    blocks.push(`筛选区间：${scope.from ?? '最早'} → ${scope.to ?? '最新'}`)
  }

  if (days.length > 0) {
    blocks.push(`## 每日用量`)
    blocks.push(renderDaily(days, { timeZone }))
  }

  if (models.length > 0) {
    blocks.push(renderRanking(models, { title: '## 按模型', label: '模型', limit: 12 }))
  }

  if (providers.length > 1) {
    blocks.push(renderRanking(providers, { title: '## 按 Provider', label: 'Provider', limit: 8, showBar: false }))
  }

  if (sessions.length > 0) {
    blocks.push(
      renderRanking(sessions, { title: '## 消耗最多的会话', label: '会话', limit: 8, showBar: false }),
    )
  }

  return blocks.join('\n\n')
}

/**
 * 渲染一行摘要，适合放在状态栏或简短回复里。
 *
 * @param report - 报表对象。
 * @returns 单行文本。
 */
export function renderSummaryLine(report) {
  const today = report.today
  if (today === undefined) {
    return `累计 ${human(report.totals.totalTokens)} token ｜ 调用 ${comma(report.totals.calls)} 次`
  }
  return `今日 ${human(today.totalTokens)} token ｜ 累计 ${human(report.totals.totalTokens)} token`
}
