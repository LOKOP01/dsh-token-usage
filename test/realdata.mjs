// 用真实会话日志端到端验证插件：统计结果应与独立实现一致。
import { buildReport, reportToJson } from '../lib/index.js'
import { resolveDshHome } from '../lib/scan.js'
import { renderReport } from '../lib/format.js'

const dshHome = resolveDshHome()
console.log('DSH_HOME =', dshHome)

const t0 = performance.now()
const report = buildReport({
  dshHome,
  timeZone: 'Asia/Shanghai',
  days: 0,
  includeSubagents: true,
})
const t1 = performance.now()

console.log(`\n首次全量扫描耗时 ${(t1 - t0).toFixed(0)}ms`)
console.log(`扫描会话 ${report.scanned.sessions} 个（子 Agent ${report.scanned.subagentSessions} 个）`)
console.log(`读取事件 ${report.scanned.events} 条`)
console.log(`有效用量记录 ${report.recordCount} 条`)
console.log(`失败会话 ${report.scanned.failedSessions} 个`)

console.log('\n' + renderReport(report))

// 缓存命中后的第二次扫描应显著更快
import { SessionLogCache } from '../lib/scan.js'
const cache = new SessionLogCache()
const t2 = performance.now()
buildReport({ dshHome, timeZone: 'Asia/Shanghai', days: 0, includeSubagents: true, cache })
const t3 = performance.now()
buildReport({ dshHome, timeZone: 'Asia/Shanghai', days: 0, includeSubagents: true, cache })
const t4 = performance.now()
console.log(`\n冷缓存 ${(t3 - t2).toFixed(0)}ms，热缓存 ${(t4 - t3).toFixed(0)}ms`)

// 输出 JSON 结构样本
const json = reportToJson(report, 3)
console.log('\n=== JSON 结构样本（最近 3 天）===')
console.log(JSON.stringify({ ...json, days: json.days }, null, 2))
