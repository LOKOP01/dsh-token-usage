// 用真实数据走一遍工具 execute 的完整路径，逐字段校验无损 JSON。
import { Config, apply } from '../lib/index.js'

const tools = []
const commands = []
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => fn(),
  on: () => () => {},
  inject(deps, cb) {
    cb({
      commands: deps.includes('commands') ? { register: (d) => { commands.push(d); return () => {} } } : undefined,
      tools: deps.includes('tools') ? { register: (d) => { tools.push(d); return () => {} } } : undefined,
    })
  },
}

apply(ctx, Config['~standard'].validate({}).value)
const tool = tools[0]

/** 递归找出所有不合法的值。 */
function findProblems(value, path = 'root', out = []) {
  if (value === null) return out
  const t = typeof value
  if (t === 'string' || t === 'boolean') return out
  if (t === 'number') {
    if (!Number.isFinite(value)) out.push(`${path} = ${value}（非有限数字）`)
    return out
  }
  if (t === 'undefined') { out.push(`${path} = undefined`); return out }
  if (t === 'function') { out.push(`${path} = function`); return out }
  if (t === 'symbol') { out.push(`${path} = symbol`); return out }
  if (value instanceof Map) { out.push(`${path} = Map`); return out }
  if (value instanceof Set) { out.push(`${path} = Set`); return out }
  if (Array.isArray(value)) {
    value.forEach((item, i) => findProblems(item, `${path}[${i}]`, out))
    return out
  }
  for (const [key, item] of Object.entries(value)) findProblems(item, `${path}.${key}`, out)
  return out
}

const cases = [
  ['默认（14 天）', {}],
  ['全部历史', { days: 0 }],
  ['今天', { days: 1 }],
  ['按模型', { groupBy: 'model' }],
  ['按会话', { groupBy: 'session' }],
  ['指定区间', { from: '2026-10-01', to: '2026-10-13' }],
  ['强制刷新', { days: 3, refresh: true }],
]

let failed = 0
for (const [label, args] of cases) {
  const t0 = performance.now()
  const result = await tool.execute(args, {})
  const ms = performance.now() - t0
  const problems = findProblems(result)
  if (problems.length > 0) {
    failed++
    console.log(`✗ ${label}: 发现 ${problems.length} 个非法值`)
    for (const p of problems.slice(0, 5)) console.log(`    ${p}`)
  } else {
    console.log(`✓ ${label}: 无损 JSON（${ms.toFixed(0)}ms）`)
  }
}

// 命令路径同样校验（JSON 输出走的是 JSON.stringify，另当别论）
console.log('\n=== 命令输出（/token --json）===')
const cmdResult = commands[0].handler({ rawInput: 'all --json', agent: {}, attachments: [], signal: new AbortController().signal, commandId: 'c' })
console.log('kind =', cmdResult.kind, '长度 =', cmdResult.text.length)
JSON.parse(cmdResult.text)
console.log('✓ 命令 JSON 输出可解析')

console.log('\n=== 命令报表输出（前 22 行）===')
const textResult = commands[0].handler({ rawInput: '7', agent: {}, attachments: [], signal: new AbortController().signal, commandId: 'c2' })
console.log(textResult.text.split('\n').slice(0, 22).join('\n'))

console.log(`\n${failed === 0 ? '全部通过：工具返回值均为无损 JSON' : `${failed} 个用例失败`}`)
process.exit(failed === 0 ? 0 : 1)
