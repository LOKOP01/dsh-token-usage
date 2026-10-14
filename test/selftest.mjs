/**
 * 自检：用假的 ctx 与真实会话日志驱动插件，验证解析、聚合、格式化与命令行为。
 *
 *   node test/selftest.mjs
 *
 * 插件零依赖，因此不需要任何模块解析映射。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import {
  Config,
  apply,
  buildReport,
  handleDataRequest,
  parseCommandInput,
  parseDataQuery,
  reportToJson,
  reportToView,
  COMMAND_NAME,
  DATA_PATH,
  TOOL_NAME,
} from '../lib/index.js'
import { decompressFrames, listSessionLogs, logVersion } from '../lib/scan.js'
import {
  aggregateByDay,
  aggregateByHour,
  dayKey,
  dayRange,
  emptyTotals,
  extractSessionUsage,
  groupRecords,
  isValidTimeZone,
  normalizeUsage,
  streamDurationMs,
} from '../lib/usage.js'
import { bar, cacheRate, comma, human, percent, renderDaily, renderReport } from '../lib/format.js'

/* ---------- 1. Config schema ---------- */
const parsed = Config['~standard'].validate({})
assert.ok(!('issues' in parsed), '空配置应校验通过')
assert.equal(parsed.value.enabled, true)
assert.equal(parsed.value.defaultDays, 14)
assert.equal(parsed.value.includeSubagents, true)
assert.ok('issues' in Config['~standard'].validate({ defaultDays: 'x' }), '非数字应被拒绝')
assert.ok('issues' in Config['~standard'].validate({ enabled: 1 }), '非布尔应被拒绝')
assert.equal(Config['~standard'].validate({ timeZone: 'Asia/Tokyo' }).value.timeZone, 'Asia/Tokyo')
console.log('✓ Config 默认值与校验正确')

/* ---------- 2. usage 归一化 ---------- */
// 已用 1413 条真实记录反推确认：totalTokens = input + output + cacheRead + cacheWrite。
const normalized = normalizeUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 80 })
assert.equal(normalized.totalTokens, 230, '缺 totalTokens 时应按 input+output+cacheRead 补齐')
assert.equal(normalized.promptTokens, 180, '全部输入 = input + cacheRead + cacheWrite')
assert.equal(normalized.calls, 1)
assert.equal(normalized.cacheReadTokens, 80, '缓存读取应保留为独立明细')
const declared = normalizeUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 800, totalTokens: 950 })
assert.equal(declared.totalTokens, 950, 'provider 给了总账应以它为准')
// provider 少报时取较大值，宁可高估不漏计
const underreported = normalizeUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, totalTokens: 10 })
assert.equal(underreported.totalTokens, 1050, 'provider 总账偏小时应取公式值')
assert.equal(normalizeUsage(undefined).totalTokens, 0, '空 usage 应全零')
assert.equal(normalizeUsage({ inputTokens: NaN, outputTokens: 10 }).totalTokens, 10, 'NaN 应按 0 处理')
// 真机 deepseek-official 样本：无 totalTokens，需正确补齐
const official = normalizeUsage({ inputTokens: 5975, outputTokens: 166, cacheReadTokens: 2048, reasoningTokens: 42 })
assert.equal(official.totalTokens, 8189, '应补齐为 5975+166+2048')
assert.equal(official.reasoningTokens, 42, 'reasoning 是 output 子集，只展示不重复计入')
console.log('✓ usage 归一化正确（含缓存读取为额外项）')

/* ---------- 3. 时区与分天 ---------- */
assert.ok(isValidTimeZone('Asia/Shanghai'))
assert.ok(isValidTimeZone('UTC'))
assert.ok(!isValidTimeZone('Not/AZone'))
assert.ok(!isValidTimeZone(''))

// 2026-10-13T14:52:10+08:00 = 06:52:10Z
const ts = Date.parse('2026-10-13T06:52:10Z')
assert.equal(dayKey(ts, 'Asia/Shanghai'), '2026-10-13', '东八区应归到 13 日')
assert.equal(dayKey(ts, 'UTC'), '2026-10-13')
// 东八区 13 日 00:30 = 12 日 16:30Z：UTC 视角是前一天，本地视角是当天
const edge = Date.parse('2026-10-12T16:30:00Z')
assert.equal(dayKey(edge, 'Asia/Shanghai'), '2026-10-13', '本地凌晨应归到本地日')
assert.equal(dayKey(edge, 'UTC'), '2026-10-12', 'UTC 视角应归到前一日')

const range = dayRange('2026-10-13', 'Asia/Shanghai')
assert.equal(new Date(range.start).toISOString(), '2026-10-12T16:00:00.000Z', '东八区 13 日应始于 12 日 16:00Z')
assert.equal(range.end - range.start, 86_400_000)
assert.equal(dayRange('bogus', 'UTC'), null, '非法日期应返回 null')
console.log('✓ 时区分天与区间计算正确')

/* ---------- 4. 会话用量提取 ---------- */
const headerEvent = {
  type: 'session',
  id: 'session-test',
  createdAt: ts,
  cwd: 'F:\\work',
  isSeeded: false,
}
const events = [
  headerEvent,
  {
    type: 'assistant/message',
    seq: 10,
    time: ts,
    data: {
      // 自洽样本：totalTokens = 1000 + 200 + 800（真机数据里两者恒等）
      usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 2000, cacheReadTokens: 800 },
      message: { source: { kind: 'model', provider: 'p1', model: 'm1' } },
    },
  },
  // 无 usage：不计入
  { type: 'assistant/message', seq: 11, time: ts, data: { message: { source: { provider: 'p1', model: 'm1' } } } },
  // 全零：不计入，也不增加调用次数
  {
    type: 'assistant/message',
    seq: 12,
    time: ts,
    data: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, message: { source: { provider: 'p1', model: 'm1' } } },
  },
  // attempt：刻意带 usage，验证它不会被计入
  {
    type: 'assistant/attempt',
    seq: 13,
    time: ts,
    data: { stream: [{ chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } } }] },
  },
  {
    type: 'assistant/message',
    seq: 14,
    time: ts + 1000,
    data: {
      usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 400 },
      message: { source: { kind: 'model', provider: 'p2', model: 'm2' } },
    },
  },
]

const extracted = extractSessionUsage(events, { sessionId: 'session-test', timeZone: 'Asia/Shanghai' })
assert.equal(extracted.records.length, 2, '只应提取 2 条有效记录')
assert.equal(extracted.totals.totalTokens, 2000 + 1000, '应为 2000 + (500+100+400)')
assert.equal(extracted.totals.promptTokens, (1000 + 800) + (500 + 400), '全部输入应含缓存读取')
assert.equal(extracted.totals.calls, 2, '全零记录不应计入调用次数')
assert.equal(extracted.records[0].provider, 'p1')
assert.equal(extracted.records[1].model, 'm2')
assert.equal(extracted.records[1].totalTokens, 1000, '缺 totalTokens 时应补齐为 input+output+cacheRead')
assert.equal(extracted.isSubagent, false)

// 子 Agent 排除
const subEvents = [{ type: 'session', id: 's2', createdAt: ts, origin: 'subagent', delegationDepth: 1 }, events[1]]
const skipped = extractSessionUsage(subEvents, { sessionId: 's2', timeZone: 'UTC', includeSubagents: false })
assert.equal(skipped.skipped, true, '排除子 Agent 时应标记为跳过')
assert.equal(skipped.totals.totalTokens, 0)
const kept = extractSessionUsage(subEvents, { sessionId: 's2', timeZone: 'UTC', includeSubagents: true })
assert.equal(kept.totals.totalTokens, 2000, '包含子 Agent 时应正常统计')
assert.equal(kept.isSubagent, true)
console.log('✓ 会话用量提取正确（忽略 attempt、忽略全零）')

/* ---------- 5. 按天聚合 ---------- */
const dayRecords = [
  { sessionId: 'a', timeMs: ts, day: '2026-10-12', provider: 'p1', model: 'm1', ...normalizeUsage({ inputTokens: 100, outputTokens: 50 }) },
  { sessionId: 'a', timeMs: ts, day: '2026-10-12', provider: 'p1', model: 'm1', ...normalizeUsage({ inputTokens: 200, outputTokens: 50 }) },
  { sessionId: 'b', timeMs: ts, day: '2026-10-13', provider: 'p2', model: 'm2', ...normalizeUsage({ inputTokens: 300, outputTokens: 100 }) },
]
const aggregated = aggregateByDay(dayRecords, { days: 0, timeZone: 'Asia/Shanghai' })
assert.equal(aggregated.days.length, 2, '应有 2 天')
assert.equal(aggregated.days[0].day, '2026-10-12', '应按日期升序')
assert.equal(aggregated.days[0].totalTokens, 400)
assert.equal(aggregated.days[0].calls, 2)
assert.equal(aggregated.days[0].sessions.size, 1, '同一天应去重会话数')
assert.equal(aggregated.totals.totalTokens, 800)
assert.equal(aggregated.days[1].byModel.size, 1, '应按 provider/model 分组')

// 补齐空白日：以 now 为锚点
const now = Date.parse('2026-10-15T04:00:00Z') // 东八区 10-15 12:00
const filled = aggregateByDay(dayRecords, { days: 5, now, timeZone: 'Asia/Shanghai' })
assert.equal(filled.days.length, 5, '应补齐为 5 个连续日')
assert.deepEqual(
  filled.days.map((d) => d.day),
  ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'],
  '应是以今天结尾的连续日历',
)
assert.equal(filled.days[0].totalTokens, 0, '空白日应为 0')
assert.equal(filled.days[1].totalTokens, 400)
console.log('✓ 按天聚合与空白日补齐正确')

/* ---------- 6. 分组与格式化 ---------- */
const groups = groupRecords(dayRecords, (r) => r.model, 1)
assert.equal(groups.length, 1, 'limit 应生效')
assert.equal(groups[0].key, 'm1')
assert.equal(groups[0].totalTokens, 400)
assert.equal(comma(1234567), '1,234,567')
assert.equal(human(9999), '9,999')
assert.equal(human(12345), '1.2万')
assert.equal(human(123_456_789), '1.23亿')
assert.equal(percent(50, 200), '25.0%')
assert.equal(percent(1, 0), '-', '分母为 0 应返回 -')
assert.equal(bar(0, 100), '', '零值不应有柱子')
assert.ok(bar(1, 10000).length >= 1, '非零值至少一个字符')
assert.equal(bar(100, 100, 10), '█'.repeat(10))

const dailyText = renderDaily(aggregated.days, { timeZone: 'Asia/Shanghai' })
assert.ok(dailyText.includes('2026-10-12'), '应包含日期')
assert.ok(dailyText.includes('日期'), '应包含表头')
assert.ok(dailyText.includes('缓存命中率'), '应包含缓存命中率列')
console.log('✓ 分组与格式化正确')

/* ---------- 7. 命令参数解析 ---------- */
assert.equal(parseCommandInput('', 14).days, 14, '空参数应取默认天数')
assert.equal(parseCommandInput('  ', 7).days, 7)
assert.equal(parseCommandInput('30', 14).days, 30)
assert.equal(parseCommandInput('7d', 14).days, 7)
assert.equal(parseCommandInput('7天', 14).days, 7)
assert.equal(parseCommandInput('all', 14).days, 0, 'all 应表示全部')
assert.equal(parseCommandInput('全部', 14).days, 0)
assert.equal(parseCommandInput('today', 14).days, 1)
assert.equal(parseCommandInput('今天', 14).days, 1)
assert.equal(parseCommandInput('2026-10-01', 14).from, '2026-10-01')
assert.equal(parseCommandInput('2026-10-01', 14).to, '2026-10-01')
const rangeParsed = parseCommandInput('2026-10-01..2026-10-13', 14)
assert.equal(rangeParsed.from, '2026-10-01')
assert.equal(rangeParsed.to, '2026-10-13')
assert.equal(rangeParsed.days, 0)
assert.equal(parseCommandInput('--json', 14).json, true)
assert.equal(parseCommandInput('7 --json', 14).json, true)
assert.equal(parseCommandInput('7 --json', 14).days, 7)
assert.ok(parseCommandInput('bogus', 14).error !== undefined, '未知参数应报错')
assert.ok(parseCommandInput('0', 14).error !== undefined, '0 天应报错')
assert.ok(parseCommandInput('99999', 14).error !== undefined, '过大天数应报错')
assert.ok(parseCommandInput('..', 14).error !== undefined, '空区间应报错')
console.log('✓ 命令参数解析正确')

/* ---------- 8. 多帧 zstd 解压 ---------- */
// 真实日志是多帧的：这里造 3 帧，验证不会只解出第一帧。
const frame1 = zstdCompressSync(Buffer.from('{"a":1}\n', 'utf8'))
const frame2 = zstdCompressSync(Buffer.from('{"b":2}\n', 'utf8'))
const frame3 = zstdCompressSync(Buffer.from('{"c":3}\n', 'utf8'))
const multi = Buffer.concat([frame1, frame2, frame3])
const text = decompressFrames(multi)
assert.ok(text.includes('"a":1'), '应解出第 1 帧')
assert.ok(text.includes('"b":2'), '应解出第 2 帧')
assert.ok(text.includes('"c":3'), '应解出第 3 帧')
assert.equal(decompressFrames(Buffer.from('not zstd')), '', '非 zstd 应返回空串')
assert.equal(decompressFrames(Buffer.alloc(0)), '', '空缓冲应返回空串')
// 末帧截断（模拟活跃会话正在写入）
const truncated = Buffer.concat([frame1, frame2.subarray(0, Math.floor(frame2.length / 2))])
const partial = decompressFrames(truncated)
assert.ok(partial.includes('"a":1'), '截断时至少应解出完整帧')
console.log('✓ 多帧 zstd 解压正确（含截断容错）')

/* ---------- 9. 会话文件发现 ---------- */
assert.equal(logVersion('session.v4.jsonl.zstd'), 4)
assert.equal(logVersion('session.jsonl.zstd'), 0)
assert.equal(logVersion('session.v10.jsonl'), 10)
assert.equal(logVersion('other.txt'), -1)

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-token-test-'))
try {
  const cwdDir = join(sandbox, 'sessions', '--F-work--')
  const s1 = join(cwdDir, 'session-aaa')
  const s2 = join(cwdDir, 'session-bbb')
  mkdirSync(s1, { recursive: true })
  mkdirSync(s2, { recursive: true })
  // s1 同时有旧版与新版：应只取新版
  writeFileSync(join(s1, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from('{"old":true}\n')))
  writeFileSync(join(s1, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from('{"new":true}\n')))
  writeFileSync(join(s2, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from('{"x":1}\n')))

  const found = listSessionLogs(join(sandbox, 'sessions'))
  assert.equal(found.length, 2, '应发现 2 个会话')
  const aaa = found.find((entry) => entry.sessionId === 'session-aaa')
  assert.ok(aaa.path.endsWith('session.v4.jsonl.zstd'), '应优先选版本最高的日志')
  assert.equal(aaa.version, 4)
  assert.equal(aaa.cwdSlug, '--F-work--')
  assert.deepEqual(listSessionLogs(join(sandbox, 'nope')), [], '目录不存在应返回空数组')
  console.log('✓ 会话文件发现正确（含版本优先级）')

  /* ---------- 10. 端到端报表 ---------- */
  const report = buildReport({
    dshHome: sandbox,
    timeZone: 'Asia/Shanghai',
    days: 0,
    includeSubagents: true,
  })
  assert.equal(report.scanned.sessions, 2, '应扫描到 2 个会话')
  assert.equal(report.scanned.failedSessions, 0)
  // 这三个日志里没有 assistant/message，故总量为 0，但不应抛错
  assert.equal(report.totals.totalTokens, 0)
  assert.equal(report.durationMs >= 0, true)

  const json = reportToJson(report)
  assert.equal(json.timeZone, 'Asia/Shanghai')
  assert.equal(typeof json.totals.totalTokens, 'number')
  assert.ok(Array.isArray(json.days))
  assert.ok(Array.isArray(json.models))
  assert.ok(Array.isArray(json.sessions))
  assert.equal(json.today, null, '无用量时 today 应为 null')
  console.log('✓ 端到端报表可运行（空数据不抛错）')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

/* ---------- 11. apply() 注册 ---------- */
function makeCtx({ withCommands = true, withTools = true, withWebServer = true } = {}) {
  const commands = []
  const tools = []
  const routes = []
  const listeners = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn) => fn(),
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
    inject(deps, cb) {
      if (deps.includes('commands') && !withCommands) return
      if (deps.includes('tools') && !withTools) return
      if (deps.includes('webServer') && !withWebServer) return
      const child = {
        effect: (fn) => fn(),
        commands: withCommands && deps.includes('commands') ? { register: (def) => { commands.push(def); return () => {} } } : undefined,
        tools: withTools && deps.includes('tools') ? { register: (def) => { tools.push(def); return () => {} } } : undefined,
        webServer: withWebServer && deps.includes('webServer')
          ? {
            register: (route) => {
              routes.push(route)
              return () => {}
            },
          }
          : undefined,
      }
      cb(child)
    },
  }
  return { ctx, commands, tools, routes, listeners }
}

const env = makeCtx()
apply(env.ctx, Config['~standard'].validate({ defaultDays: 3 }).value)

assert.equal(env.commands.length, 1, '应注册一个命令')
assert.equal(env.commands[0].name, COMMAND_NAME)
assert.equal(env.tools.length, 1, '应注册一个工具')
assert.equal(env.tools[0].name, TOOL_NAME)
assert.equal(typeof env.tools[0].execute, 'function')
assert.equal(env.tools[0].parameters.type, 'object')
assert.ok(env.tools[0].description.includes('子 Agent'), '工具描述应说明覆盖范围')
assert.equal(env.listeners.length, 1, '应订阅 session/event 用于缓存失效')
assert.equal(env.listeners[0].event, 'session/event')
assert.equal(env.routes.length, 1, '应注册一个数据路由')
assert.equal(env.routes[0].path, DATA_PATH)
assert.equal(env.routes[0].kind, 'exact')

// 命令：参数错误
const bad = env.commands[0].handler({ rawInput: 'bogus', agent: {}, attachments: [], signal: new AbortController().signal, commandId: 'c1' })
assert.equal(bad.kind, 'error', '未知参数应返回错误')
assert.ok(bad.text.includes('用法'), '错误应给出用法')

// 命令：正常执行（指向空的临时目录，避免依赖真实环境）
const emptyHome = mkdtempSync(join(tmpdir(), 'dsh-token-empty-'))
try {
  const env2 = makeCtx()
  apply(env2.ctx, Config['~standard'].validate({ dshHome: emptyHome, timeZone: 'Asia/Shanghai' }).value)
  const ok = env2.commands[0].handler({ rawInput: '7', agent: {}, attachments: [], signal: new AbortController().signal, commandId: 'c2' })
  assert.equal(ok.kind, 'success', '正常查询应成功')
  assert.ok(ok.text.includes('Token 用量统计'), '应包含标题')
  assert.ok(ok.text.includes('Asia/Shanghai'), '应显示时区')
  assert.ok(ok.text.includes('未找到任何会话日志'), '空目录应给出提示')
  assert.ok(ok.text.includes('用法'), '应附带用法')

  const asJson = env2.commands[0].handler({ rawInput: 'all --json', agent: {}, attachments: [], signal: new AbortController().signal, commandId: 'c3' })
  assert.equal(asJson.kind, 'success')
  const parsedJson = JSON.parse(asJson.text)
  assert.equal(parsedJson.totals.totalTokens, 0)

  // 工具：正常执行
  const toolResult = await env2.tools[0].execute({ days: 7 }, {})
  assert.equal(typeof toolResult, 'object')
  assert.equal(toolResult.totals.totalTokens, 0)
  const byModel = await env2.tools[0].execute({ groupBy: 'model' }, {})
  assert.equal(byModel.groupBy, 'model')
  const bySession = await env2.tools[0].execute({ groupBy: 'session' }, {})
  assert.equal(bySession.groupBy, 'session')
  console.log('✓ 命令与工具行为正确')
} finally {
  rmSync(emptyHome, { recursive: true, force: true })
}

/* ---------- 12. 可选依赖缺席时降级 ---------- */
const noCommands = makeCtx({ withCommands: false })
apply(noCommands.ctx, Config['~standard'].validate({}).value)
assert.equal(noCommands.commands.length, 0, 'commands 缺席时不应注册命令')
assert.equal(noCommands.tools.length, 1, '工具仍应注册')

const noTools = makeCtx({ withTools: false })
apply(noTools.ctx, Config['~standard'].validate({}).value)
assert.equal(noTools.tools.length, 0, 'tools 缺席时不应注册工具')
assert.equal(noCommands.commands.length, 0)
console.log('✓ 可选依赖缺席时优雅降级')

/* ---------- 13. 关闭开关 ---------- */
const disabled = makeCtx()
apply(disabled.ctx, Config['~standard'].validate({ enabled: false }).value)
assert.equal(disabled.commands.length, 0, '关闭后不应注册命令')
assert.equal(disabled.tools.length, 0, '关闭后不应注册工具')
console.log('✓ 关闭开关生效')

/* ---------- 14. 无配置调用 ---------- */
const bare = makeCtx()
apply(bare.ctx, undefined)
assert.equal(bare.commands.length, 1, '未传配置时应使用默认值')
console.log('✓ 未传配置时使用默认值')

/* ---------- 15. 报表渲染 ---------- */
const fakeReport = {
  timeZone: 'Asia/Shanghai',
  dshHome: 'C:\\x',
  totals: {
    ...emptyTotals(),
    totalTokens: 1000,
    promptTokens: 850,
    inputTokens: 50,
    outputTokens: 150,
    cacheReadTokens: 800,
    calls: 3,
  },
  days: [
    {
      day: '2026-10-12',
      ...emptyTotals(),
      totalTokens: 400,
      promptTokens: 350,
      inputTokens: 50,
      outputTokens: 50,
      cacheReadTokens: 300,
      calls: 1,
      byModel: new Map(),
      byProvider: new Map(),
      sessions: new Set(['a']),
    },
    {
      day: '2026-10-13',
      ...emptyTotals(),
      totalTokens: 600,
      promptTokens: 500,
      inputTokens: 0,
      outputTokens: 100,
      cacheReadTokens: 500,
      calls: 2,
      byModel: new Map(),
      byProvider: new Map(),
      sessions: new Set(['b']),
    },
  ],
  models: [{ key: 'p/m', ...emptyTotals(), totalTokens: 1000, promptTokens: 850, outputTokens: 150, calls: 3 }],
  providers: [{ key: 'p', ...emptyTotals(), totalTokens: 1000, promptTokens: 850, outputTokens: 150, calls: 3 }],
  sessions: [{ key: 'sess…', sessionId: 'sess', ...emptyTotals(), totalTokens: 1000, calls: 3 }],
  scanned: { sessions: 2, subagentSessions: 1, events: 10, skippedSessions: 0, failedSessions: 0 },
  durationMs: 12,
  scope: {},
}
const rendered = renderReport(fakeReport)
assert.ok(rendered.includes('Token 用量统计'), '应包含标题')
assert.ok(rendered.includes('Asia/Shanghai'), '应包含时区')
assert.ok(rendered.includes('按模型'), '应包含模型小节')
assert.ok(rendered.includes('子 Agent 1 个'), '应报告子 Agent 数量')
assert.ok(rendered.includes('2026-10-12'))
assert.ok(rendered.includes('命中缓存 800'), '应展示缓存命中量')
assert.ok(rendered.includes('94.1%'), '缓存命中率应以全部输入为分母（800/850）')
console.log('✓ 报表渲染正确')

/* ---------- 16. 缓存命中率口径 ---------- */
// 关键回归：分母必须是「全部输入」，用 inputTokens 会算出 >100% 的荒谬值。
assert.equal(cacheRate({ cacheReadTokens: 800, promptTokens: 850 }), '94.1%')
assert.equal(cacheRate({ cacheReadTokens: 0, promptTokens: 0 }), '-', '无输入时不应除以零')
// 真机比例：2.15 亿缓存命中 / 2.18 亿总量，命中率约 96%，绝不可能是 3000%
const realish = { cacheReadTokens: 215_189_760, promptTokens: 222_180_697 }
const rate = Number(cacheRate(realish).replace('%', ''))
assert.ok(rate > 0 && rate <= 100, `命中率必须落在 0..100，实际 ${rate}`)
console.log('✓ 缓存命中率口径正确（不会超过 100%）')

/* ---------- 17. 工具返回值必须是无损 JSON ---------- */
// 回归：返回对象里只要有一个 undefined/NaN/Map/Set，工具调用就会以
// `tool "..." returned invalid output: value is not lossless JSON` 失败。
function assertLosslessJson(value, path = 'root') {
  if (value === null) return
  const type = typeof value
  if (type === 'string' || type === 'boolean') return
  if (type === 'number') {
    assert.ok(Number.isFinite(value), `${path} 必须是有限数字，实际 ${value}`)
    return
  }
  assert.ok(type !== 'undefined', `${path} 不能是 undefined`)
  assert.ok(!(value instanceof Map), `${path} 不能是 Map`)
  assert.ok(!(value instanceof Set), `${path} 不能是 Set`)
  assert.ok(Array.isArray(value) || type === 'object', `${path} 类型不受支持：${type}`)
  for (const [key, item] of Object.entries(value)) {
    assertLosslessJson(item, `${path}.${key}`)
  }
}

const jsonWithData = reportToJson(fakeReport)
assertLosslessJson(jsonWithData)
assert.equal(jsonWithData.today, null, '无今天数据时应为 null 而不是 undefined')
assert.deepEqual(jsonWithData.scope, {}, 'scope 不应带 undefined 字段')

// 空报表（无任何会话）同样必须无损
const emptyReport = buildReport({
  dshHome: join(tmpdir(), 'dsh-token-definitely-missing'),
  timeZone: 'UTC',
  days: 14,
  includeSubagents: true,
})
const emptyJson = reportToJson(emptyReport)
assertLosslessJson(emptyJson)
assert.equal(emptyJson.today, null)
assert.deepEqual(emptyJson.days, [], '无数据时 days 应为空数组')
assert.deepEqual(emptyJson.models, [])
assert.deepEqual(emptyJson.sessions, [])
// 工具返回的 JSON 必须能原样序列化并解析回来
assert.deepEqual(JSON.parse(JSON.stringify(emptyJson)), emptyJson)
console.log('✓ 工具返回值是无损 JSON（空数据亦不例外）')

/* ---------- 18. 界面取数：参数解析与路由 ---------- */
// 界面下拉框的值直接变成这里的查询串，因此非法参数必须明确报错，
// 而不是静默退回默认值——悄悄换口径会让界面上的数字失去意义。
assert.deepEqual(parseDataQuery('/x?days=7', 14).query, { days: 7, from: undefined, to: undefined })
assert.deepEqual(parseDataQuery('/x', 14).query, { days: 14, from: undefined, to: undefined })
assert.deepEqual(parseDataQuery('/x?days=0', 14).query, { days: 0, from: undefined, to: undefined })
assert.equal(parseDataQuery('/x?days=abc', 14).error !== undefined, true)
assert.equal(parseDataQuery('/x?days=99999', 14).error !== undefined, true)
assert.equal(parseDataQuery('/x?from=2026-1-1', 14).error !== undefined, true)

// 绝对区间优先于相对天数，避免两个口径互相打架。
const ranged = parseDataQuery('/x?days=7&from=2026-10-01&to=2026-10-13', 14).query
assert.deepEqual(ranged, { days: 0, from: '2026-10-01', to: '2026-10-13' })
assert.equal(parseDataQuery('/x?refresh=1', 14).force, true)
assert.equal(parseDataQuery('/x', 14).force, false)

// 路由护栏：只接受本机请求，且只放行 GET/HEAD。
function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? {}
    },
    end(body) {
      if (body !== undefined) res.body = body.toString('utf8')
    },
  }
  return res
}
const okRes = fakeRes()
handleDataRequest(
  { method: 'GET', url: '/x?days=1', headers: { host: '127.0.0.1:19387' } },
  okRes,
  () => emptyReport,
  { defaultDays: 14, recordLimit: 10 },
)
assert.equal(okRes.status, 200)
const viewPayload = JSON.parse(okRes.body)
assertLosslessJson(viewPayload)
assert.equal(Array.isArray(viewPayload.records), true)

const postRes = fakeRes()
handleDataRequest({ method: 'POST', url: '/x', headers: { host: '127.0.0.1' } }, postRes, () => emptyReport, { defaultDays: 14, recordLimit: 10 })
assert.equal(postRes.status, 405, '非 GET/HEAD 应被拒绝')

const remoteRes = fakeRes()
handleDataRequest({ method: 'GET', url: '/x', headers: { host: '192.168.1.9:19387' } }, remoteRes, () => emptyReport, { defaultDays: 14, recordLimit: 10 })
assert.equal(remoteRes.status, 403, '非回环 Host 应被拒绝')

// 浏览器跨站页面能伪造 Host，但带不出回环 Origin。
const rebindRes = fakeRes()
handleDataRequest(
  { method: 'GET', url: '/x', headers: { host: '127.0.0.1', origin: 'http://evil.example' } },
  rebindRes,
  () => emptyReport,
  { defaultDays: 14, recordLimit: 10 },
)
assert.equal(rebindRes.status, 403, '非回环 Origin 应被拒绝')

const badParamRes = fakeRes()
handleDataRequest({ method: 'GET', url: '/x?days=nope', headers: { host: '127.0.0.1' } }, badParamRes, () => emptyReport, { defaultDays: 14, recordLimit: 10 })
assert.equal(badParamRes.status, 400, '非法参数应回 400')
assert.ok(JSON.parse(badParamRes.body).error.includes('days'))

const boomRes = fakeRes()
handleDataRequest({ method: 'GET', url: '/x', headers: { host: '127.0.0.1' } }, boomRes, () => { throw new Error('炸了') }, { defaultDays: 14, recordLimit: 10 })
assert.equal(boomRes.status, 500, '统计异常应回 500 而不是断开连接')
console.log('✓ 界面取数路由与护栏正确')

/* ---------- 19. 界面视图与小时桶 ---------- */
// 单日视图必须按小时展开成固定 24 个桶，缺失时段留白，柱子的位置才不会漂。
const hourReport = {
  ...fakeReport,
  scope: { days: 1 },
  hours: aggregateByHour(
    [
      { sessionId: 'a', timeMs: Date.parse('2026-10-13T09:15:00+08:00'), day: '2026-10-13', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: 0, promptTokens: 4, totalTokens: 6, calls: 1 },
      { sessionId: 'a', timeMs: Date.parse('2026-10-13T09:45:00+08:00'), day: '2026-10-13', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: 0, promptTokens: 4, totalTokens: 6, calls: 1 },
      { sessionId: 'b', timeMs: Date.parse('2026-10-13T21:05:00+08:00'), day: '2026-10-13', provider: 'q', model: 'n', inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, promptTokens: 5, totalTokens: 10, calls: 1 },
    ],
    { day: '2026-10-13', timeZone: 'Asia/Shanghai' },
  ),
  records: [
    { timeMs: Date.parse('2026-10-13T21:05:00+08:00'), day: '2026-10-13', sessionId: 'b', cwdSlug: 'x', isSubagent: false, provider: 'q', model: 'n', durationMs: 1200, inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, promptTokens: 5, totalTokens: 10, calls: 1 },
  ],
}
const hourView = reportToView(hourReport)
assertLosslessJson(hourView)
assert.equal(hourView.hours.length, 24, '小时桶应恒为 24 个')
assert.equal(hourView.hours[9].totalTokens, 12, '同一小时内的两次调用应合并')
assert.equal(hourView.hours[9].calls, 2)
assert.equal(hourView.hours[0].totalTokens, 0, '没有用量的时段应留白')
assert.equal(hourView.hours[21].totalTokens, 10)
assert.equal(hourView.hours[9].sessions, 1, '同一会话的两次调用只算一个会话')
assert.equal(hourView.records.length, 1)
assert.equal(hourView.records[0].durationMs, 1200)
assert.equal(hourView.records[0].subagent, false)

// 明细必须封顶：一个区间可能有上万次调用，全量传进浏览器会拖垮首屏。
const manyRecords = Array.from({ length: 50 }, (_, i) => ({
  timeMs: 1_791_800_000_000 + i,
  day: '2026-10-13',
  sessionId: 's',
  cwdSlug: 'x',
  isSubagent: false,
  provider: 'p',
  model: 'm',
  durationMs: 0,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  promptTokens: 1,
  totalTokens: 2,
  calls: 1,
}))
const capped = reportToView({ ...fakeReport, records: manyRecords, hours: [] }, { recordLimit: 10 })
assert.equal(capped.records.length, 10, '明细应被截断到上限')
assert.equal(capped.recordTotal, 50, '应报告截断前的总数，界面才能提示「另有 N 条」')
console.log('✓ 界面视图、小时桶与明细封顶正确')

/* ---------- 20. 流式耗时（速度列） ---------- */
// 只看 time0 会漏掉最长的一块，把速度高估好几倍；这里要按 time0 + Σdt 取末块结束时间。
assert.equal(streamDurationMs([{ type: 'chunk', time: 1000 }]), 0, '单点无法构成跨度')
assert.equal(streamDurationMs([]), 0)
assert.equal(streamDurationMs(undefined), 0)
assert.equal(
  streamDurationMs([
    { type: 'chunk', time: 1000 },
    { type: 'text-chunks', time0: 1100, dt: [10, 20, 30] },
    { type: 'chunk', time: 2000 },
  ]),
  1000,
  '跨度取首块起点到末块结束',
)
assert.equal(
  streamDurationMs([{ type: 'text-chunks', time0: 1000, dt: [100, 100] }]),
  200,
  '末块结束时间是 time0 + Σdt',
)
console.log('✓ 流式耗时计算正确')

console.log('\n全部自检通过。')
