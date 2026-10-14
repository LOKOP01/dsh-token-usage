/**
 * 客户端面板的离线渲染测试。
 *
 * 浏览器 bundle 无法直接在 Node 里跑，但它的形状是可验证的：模块系统只做两件事
 * ——注册惰性工厂、物化时调 factory。这里用一个最小的 React 兼容层顶替真实
 * React，把 factory 跑起来、把面板渲染成树，从而在安装之前就发现「组件抛错」
 * 「表格列数不对」「口径算错」这类会让 slot 条目整体消失的问题。
 *
 * 真实的 React 语义（并发、批处理、真实 DOM）不在覆盖范围内；这里保证的是：
 * 组件是纯的、hooks 顺序稳定、在给定的数据下产出正确结构，且不同场景之间不串状态。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { buildReport, reportToView } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

// 先接管定时器：面板会用 setInterval 驱动自动刷新与相对时间，真定时器会让
// 测试进程一直挂着，也拿不到可复现的刷新行为。
const restoreTimers = installTimerStubs()

/* ------------------------------------------------------------ React 兼容层 */

/** 每次挂载独占一张实例表：不同场景之间不得共享 hooks 状态。 */
const instances = new Map()
let namespace = 0
let activeNs = 0
let hookOwner = null
let effectQueue = []

const Fragment = Symbol('react.fragment')

function componentInstance(path) {
  const key = `${String(activeNs)}:${path}`
  let instance = instances.get(key)
  if (instance === undefined) {
    instance = { hooks: [], index: 0 }
    instances.set(key, instance)
  }
  instance.index = 0
  return instance
}

/** 取当前组件本轮渲染的第 index 个 hook 槽位。 */
function slot() {
  const index = hookOwner.index++
  let record = hookOwner.hooks[index]
  if (record === undefined) {
    record = {}
    hookOwner.hooks[index] = record
  }
  return record
}

function sameDeps(a, b) {
  if (a === undefined || b === undefined) return false
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((item, index) => Object.is(item, b[index]))
}

const React = {
  Fragment,
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  },
  useState(initial) {
    const record = slot()
    if (!('value' in record)) {
      record.value = typeof initial === 'function' ? initial() : initial
    }
    const setter = (next) => {
      const value = typeof next === 'function' ? next(record.value) : next
      if (Object.is(value, record.value)) return
      record.value = value
    }
    return [record.value, setter]
  },
  useEffect(effect, deps) {
    const record = slot()
    if (sameDeps(record.deps, deps)) return
    if (typeof record.cleanup === 'function') record.cleanup()
    record.deps = deps
    record.cleanup = undefined
    effectQueue.push(() => {
      const cleanup = effect()
      record.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    })
  },
  useMemo(factory, deps) {
    const record = slot()
    if (sameDeps(record.deps, deps) && 'value' in record) return record.value
    record.deps = deps
    record.value = factory()
    return record.value
  },
}

const jsxRuntime = {
  jsx: (type, props, key) => ({ type, props: { ...(props ?? {}), ...(key === undefined ? {} : { key }) } }),
  jsxs: (type, props, key) => ({ type, props: { ...(props ?? {}), ...(key === undefined ? {} : { key }) } }),
  Fragment,
}

/* ------------------------------------------------------------ 渲染 */

/**
 * 把元素树渲染成普通对象树。
 *
 * @param element - React 元素。
 * @param path - 实例定位路径。
 * @returns `{ type, props, children }` 或 `{ text }`。
 */
function renderNode(element, path) {
  if (element === null || element === undefined || element === false || element === true) return null
  if (typeof element === 'string' || typeof element === 'number') return { text: String(element) }

  const { type, props } = element
  if (typeof type === 'function') {
    const previousOwner = hookOwner
    const owner = componentInstance(path)
    hookOwner = owner
    let output
    try {
      output = type({ ...props })
    } finally {
      hookOwner = previousOwner
    }
    return renderNode(output, `${path}>${type.name || 'anon'}`)
  }

  const raw = props?.children
  const list = Array.isArray(raw) ? raw : [raw]
  const children = []
  list.forEach((child, index) => {
    const rendered = renderNode(child, `${path}/${String(index)}`)
    if (rendered !== null) children.push(rendered)
  })
  const { children: _drop, ...rest } = props ?? {}
  return { type: type === Fragment ? 'Fragment' : String(type), props: rest, children }
}

function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (node.text !== undefined) {
    out.push(node.text)
    return out
  }
  for (const child of node.children ?? []) collectText(child, out)
  return out
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (node.type !== undefined && predicate(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, out)
  return out
}

/** 渲染一帧并执行本帧排队的副作用。 */
function renderFrame(element) {
  effectQueue = []
  const tree = renderNode(element, 'root')
  const queued = effectQueue
  effectQueue = []
  for (const effect of queued) effect()
  return tree
}

/* ------------------------------------------------------------ 环境装填 */

/**
 * 可控定时器。
 *
 * 面板的「自动刷新」与「N 秒前同步」都靠 `setInterval` 驱动，而组件用的是全局
 * 定时器——真跑起来会让测试进程一直不退出，也无法观察刷新行为。这里把全局
 * 定时器换成受控版本：注册被记下来，只在测试显式推进时才触发，退出时全部撤销。
 */
const timers = { intervals: [], timeouts: [] }

function installTimerStubs() {
  const realSetInterval = globalThis.setInterval
  const realSetTimeout = globalThis.setTimeout
  const realClearInterval = globalThis.clearInterval
  const realClearTimeout = globalThis.clearTimeout

  globalThis.setInterval = (fn, delay) => {
    const handle = { fn, delay, real: null }
    timers.intervals.push(handle)
    return handle
  }
  globalThis.setTimeout = (fn, delay) => {
    const handle = { fn, delay, real: null }
    timers.timeouts.push(handle)
    return handle
  }
  globalThis.clearInterval = (handle) => {
    const index = timers.intervals.indexOf(handle)
    if (index !== -1) timers.intervals.splice(index, 1)
  }
  globalThis.clearTimeout = (handle) => {
    const index = timers.timeouts.indexOf(handle)
    if (index !== -1) timers.timeouts.splice(index, 1)
  }

  return () => {
    globalThis.setInterval = realSetInterval
    globalThis.setTimeout = realSetTimeout
    globalThis.clearInterval = realClearInterval
    globalThis.clearTimeout = realClearTimeout
    timers.intervals.length = 0
    timers.timeouts.length = 0
  }
}

/** 触发所有已注册的 interval 回调一次。 */
function tickIntervals() {
  for (const handle of [...timers.intervals]) handle.fn()
}

function makeDocument() {
  const styles = []
  return {
    styles,
    api: {
      head: { appendChild: (node) => { styles.push(node) } },
      createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    },
  }
}

/**
 * 加载 bundle 并取出面板组件。
 *
 * @param options - 装载选项。
 * @param options.fetchImpl - 注入的 fetch。
 * @returns `{ Component, registered, doc, fetchCalls, plugin }`。
 */
function mount(options = {}) {
  const fetchCalls = []
  const fetchImpl = options.fetchImpl ?? ((...args) => {
    fetchCalls.push(args)
    return new Promise(() => {}) // 永不落地：用于观察加载态
  })
  const doc = makeDocument()
  let registration = null
  const win = { __ModuleLoader__: { load(entry) { registration = entry } } }

  new Function('window', 'document', 'fetch', clientSource)(win, doc.api, fetchImpl)

  assert.ok(registration !== null, 'bundle 必须调用 window.__ModuleLoader__.load 注册工厂')
  assert.equal(registration.id, 'dsh-token-usage', '注册 id 必须等于包名，否则模块系统对不上')

  const plugin = registration.factory((specifier) => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`未预期的模块请求：${specifier}`)
  })

  activeNs = namespace++
  const registered = []
  plugin.apply({
    effect: (fn) => { const cleanup = fn(); return typeof cleanup === 'function' ? cleanup : () => {} },
    slots: {
      inject: (_owner, callback) => { callback() },
      register: (options2, Component) => { registered.push({ options: options2, Component }); return () => {} },
    },
  })

  const panel = registered.find((entry) => entry.options.name === 'main')
  assert.ok(panel !== undefined, '应注册 main 面板')
  return { Component: panel.Component, registered, doc, fetchCalls, plugin }
}

/**
 * 反复渲染直到状态稳定（微任务推进 promise，再渲染若干帧）。
 *
 * @param Component - 面板组件。
 * @param rounds - 渲染轮数。
 * @returns 最后一帧的渲染树。
 */
async function settle(Component, rounds = 8) {
  let tree = renderFrame(jsxRuntime.jsx(Component, {}))
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await Promise.resolve()
    tree = renderFrame(jsxRuntime.jsx(Component, {}))
  }
  return tree
}

/* ------------------------------------------------------------ 1. 注册契约 */

const boot = mount()
assert.equal(boot.doc.styles.length, 1, 'apply 应注入恰好一份样式')
assert.ok(boot.doc.styles[0].textContent.includes('--dsw-alias-'), '样式必须走主题 token，不能写死颜色')

const icon = boot.registered.find((entry) => entry.options.name === 'sidebar.panellist')
assert.ok(icon !== undefined, '应注册 sidebar.panellist 图标')
assert.equal(icon.options.id, 'token-usage')
assert.equal(icon.options.label, '用量统计', '侧边栏按钮需要文案，否则轨道态无法提示')
assert.equal(typeof icon.Component, 'function')

const panelEntry = boot.registered.find((entry) => entry.options.name === 'main')
assert.equal(panelEntry.options.key, 'token-usage', 'main 的 key 必须与 panellist 的 id 一致')
assert.equal(boot.plugin.inject.length > 0, true, '必须声明 inject，否则服务可能尚未就绪')
assert.deepEqual(boot.plugin.inject, ['slots'])

// 图标是纯装饰 svg，不得引用外部资源。
const iconTree = renderNode(jsxRuntime.jsx(icon.Component, { size: 16, active: true }), 'icon')
assert.equal(iconTree.type, 'svg')
console.log('✓ 客户端 bundle 注册正确（id、样式、成对 slot、key/id 一致）')

/* ------------------------------------------------------------ 2. 加载态 */

let pendingRequest = null
const loading = mount({
  fetchImpl: (url, init) => {
    pendingRequest = { url, init }
    return new Promise(() => {})
  },
})
const loadingTree = renderFrame(jsxRuntime.jsx(loading.Component, {}))
const loadingText = collectText(loadingTree).join('')
assert.ok(loadingText.includes('用量统计'), '应显示标题')
assert.ok(loadingText.includes('正在统计'), '数据未到时显示加载态')
assert.ok(String(pendingRequest.url).startsWith('/plugins/dsh-token-usage/data?days=14'), `默认应取 14 天，实际 ${String(pendingRequest.url)}`)
assert.equal(pendingRequest.init.credentials, 'same-origin', '取数必须是同源请求')
console.log('✓ 加载态正确（默认 14 天、同源取数）')

/* ------------------------------------------------------------ 3. 数据态 */

const day = '2026-10-14'
const now = Date.parse('2026-10-14T18:00:00+08:00')
const records = [
  {
    timeMs: now - 60_000, day, sessionId: 'session-aaaa1111', cwdSlug: '--F-18752-Documents-plugin-token--',
    provider: 'workbuddy', model: 'deepseek-v4.1-flash', durationMs: 2000,
    inputTokens: 100, outputTokens: 400, cacheReadTokens: 9000, cacheWriteTokens: 0,
    reasoningTokens: 0, promptTokens: 9100, totalTokens: 9500, calls: 1,
  },
  {
    timeMs: now - 120_000, day, sessionId: 'session-bbbb2222', cwdSlug: '--F-18752-Documents-work--',
    provider: 'deepseek-official', model: 'deepseek-chat', durationMs: 0,
    inputTokens: 50, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, promptTokens: 50, totalTokens: 250, calls: 1,
  },
]

const emptyReport = buildReport({
  dshHome: join(tmpdir(), 'dsh-token-panel-missing'),
  timeZone: 'Asia/Shanghai',
  days: 14,
  includeSubagents: true,
})
const view = reportToView({
  ...emptyReport,
  totals: {
    inputTokens: 150, outputTokens: 600, cacheReadTokens: 9000, cacheWriteTokens: 0,
    reasoningTokens: 0, promptTokens: 9150, totalTokens: 9750, calls: 2,
  },
  today: { day, sessions: new Set(['session-aaaa1111']), inputTokens: 150, outputTokens: 600, cacheReadTokens: 9000, cacheWriteTokens: 0, reasoningTokens: 0, promptTokens: 9150, totalTokens: 9750, calls: 2 },
  days: [{
    day, sessions: new Set(['session-aaaa1111', 'session-bbbb2222']),
    inputTokens: 150, outputTokens: 600, cacheReadTokens: 9000, cacheWriteTokens: 0,
    reasoningTokens: 0, promptTokens: 9150, totalTokens: 9750, calls: 2,
  }],
  hours: [],
  models: [{ key: 'workbuddy/deepseek-v4.1-flash', inputTokens: 100, outputTokens: 400, cacheReadTokens: 9000, cacheWriteTokens: 0, reasoningTokens: 0, promptTokens: 9100, totalTokens: 9500, calls: 1 }],
  providers: [{ key: 'workbuddy', inputTokens: 100, outputTokens: 400, cacheReadTokens: 9000, cacheWriteTokens: 0, reasoningTokens: 0, promptTokens: 9100, totalTokens: 9500, calls: 1 }],
  sessions: [{ key: 'x', sessionId: 'session-aaaa1111', cwdSlug: '--F-18752-Documents-plugin-token--', isSubagent: false, lastTime: now, inputTokens: 100, outputTokens: 400, cacheReadTokens: 9000, cacheWriteTokens: 0, reasoningTokens: 0, promptTokens: 9100, totalTokens: 9500, calls: 1 }],
  records,
  scanned: { sessions: 2, subagentSessions: 0, events: 100, skippedSessions: 0, failedSessions: 0 },
})

const ready = mount({ fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(view) }) })
const tree = await settle(ready.Component)
const text = collectText(tree).join('')

assert.ok(text.includes('非缓存用量'), '应显示「非缓存用量」指标卡')
assert.ok(text.includes('总 token'), '应显示「总 token」指标卡')
assert.ok(text.includes('模型调用'), '应显示「模型调用」指标卡')
assert.ok(text.includes('缓存命中率'), '应显示「缓存命中率」指标卡')
assert.ok(text.includes('使用趋势'), '应显示趋势面板')
assert.ok(text.includes('请求日志'), '应显示请求日志页签')
assert.ok(text.includes('主会话'), '明细应标注会话来源')
assert.ok(text.includes('tok/s'), '有耗时的调用应显示速度')
assert.ok(text.includes('200 tok/s'), '速度 = 输出 400 / 2 秒 = 200 tok/s')
assert.ok(text.includes('98.4%'), '缓存命中率 = 9000 / 9150 = 98.4%')
assert.ok(text.includes('plugin/token'), `项目名应从 slug 还原，实际：${text.slice(0, 600)}`)

// 非缓存用量 = (全部输入 9150 − 命中 9000) + 输出 600 = 750
assert.ok(text.includes('750'), `非缓存用量应为 750，实际全文：${text.slice(0, 500)}`)
// 无耗时的调用显示「—」而不是 0 tok/s 或 Infinity
assert.ok(text.includes('—'), '缺耗时信息时应显示占位符')

const thead = findAll(tree, (node) => node.type === 'thead')[0]
assert.ok(thead !== undefined, '应渲染表头')
assert.equal(findAll(thead, (node) => node.type === 'th').length, 10, '请求日志应有 10 列')
const tbody = findAll(tree, (node) => node.type === 'tbody')[0]
assert.equal(findAll(tbody, (node) => node.type === 'tr').length, records.length, '明细行数应与记录数一致')
console.log('✓ 数据态正确（非缓存用量 750、命中率 98.4%、速度 200 tok/s、10 列 2 行）')

/* ------------------------------------------------------------ 4. 截断提示 */

const truncated = { ...view, recordTotal: 999, records: view.records }
const cut = mount({ fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(truncated) }) })
const cutTree = await settle(cut.Component)
const cutText = collectText(cutTree).join('')
assert.ok(cutText.includes('999'), `被截断时应提示总数，实际：${cutText.slice(0, 400)}`)
console.log('✓ 明细截断提示正确')

/* ------------------------------------------------------------ 5. 错误态 */

const failed = mount({
  fetchImpl: () => Promise.resolve({
    ok: false,
    status: 403,
    json: () => Promise.resolve({ error: '仅允许本机访问' }),
  }),
})
const failTree = await settle(failed.Component)
const failText = collectText(failTree).join('')
assert.ok(failText.includes('仅允许本机访问'), `应透出服务端原因而不是裸状态码，实际：${failText.slice(0, 300)}`)

// 空数据：不能抛错，且要给出空态文案。
const blank = reportToView(emptyReport)
const empty = mount({ fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(blank) }) })
const emptyTree = await settle(empty.Component)
const emptyText = collectText(emptyTree).join('')
assert.ok(emptyText.includes('该区间没有调用记录'), '空数据应显示空态')
assert.ok(emptyText.includes('该区间没有用量记录'), '空趋势应显示空态')
console.log('✓ 错误态与空态正确')

/* ------------------------------------------------------------ 6. 各页签 */

/**
 * 点击某个页签后重新渲染到稳定。
 *
 * @param Component - 面板组件。
 * @param label - 页签文案。
 * @returns 渲染树。
 */
async function clickTab(Component, label) {
  let current = await settle(Component, 4)
  const button = findAll(current, (node) => node.type === 'button' && collectText(node).join('') === label)[0]
  assert.ok(button !== undefined, `应找到页签「${label}」`)
  button.props.onClick()
  return settle(Component, 4)
}

const tabs = mount({ fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(view) }) })
for (const [label, expect] of [['每日', day], ['模型', 'workbuddy/deepseek-v4.1-flash'], ['供应商', 'workbuddy'], ['会话', 'session-aaaa1111']]) {
  const tabTree = await clickTab(tabs.Component, label)
  const tabText = collectText(tabTree).join('')
  assert.ok(tabText.includes(expect), `页签「${label}」应显示「${expect}」`)
  assert.ok(findAll(tabTree, (node) => node.type === 'table').length >= 1, `页签「${label}」应渲染表格`)
}
console.log('✓ 每日 / 模型 / 供应商 / 会话四个页签均可渲染')

/* ------------------------------------------------------------ 7. 时间范围切换 */

// 切到「今天」应改发 days=1，并按小时展开趋势。
const urls = []
const ranged = mount({
  fetchImpl: (url) => {
    urls.push(String(url))
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ...view, scope: { days: 1 } }) })
  },
})
let rangedTree = await settle(ranged.Component, 4)
const todayButton = findAll(rangedTree, (node) => node.type === 'button' && collectText(node).join('') === '今天')[0]
assert.ok(todayButton !== undefined, '应有「今天」范围按钮')
todayButton.props.onClick()
rangedTree = await settle(ranged.Component, 4)
assert.ok(urls.some((url) => url.endsWith('days=1')), `切换到「今天」应请求 days=1，实际请求：${urls.join(', ')}`)
console.log('✓ 时间范围切换会改发对应查询')

/* ------------------------------------------------------------ 8. 小时视图 */

// 单日视图必须按小时画 24 根柱子，缺失时段留白。
const hourly = {
  ...view,
  scope: { days: 1 },
  hours: Array.from({ length: 24 }, (_, hour) => ({
    hour: `${day}T${String(hour).padStart(2, '0')}`,
    label: String(hour).padStart(2, '0'),
    sessions: 1,
    inputTokens: hour === 9 ? 10 : 0,
    outputTokens: hour === 9 ? 20 : 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    promptTokens: hour === 9 ? 10 : 0,
    totalTokens: hour === 9 ? 30 : 0,
    calls: hour === 9 ? 1 : 0,
  })),
  days: [{ ...view.days[0], totalTokens: 30, calls: 1 }],
}
const hourMount = mount({ fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(hourly) }) })
let hourTree = await settle(hourMount.Component, 4)
const dayButton = findAll(hourTree, (node) => node.type === 'button' && collectText(node).join('') === '今天')[0]
dayButton.props.onClick()
hourTree = await settle(hourMount.Component, 4)
const hourText = collectText(hourTree).join('')
assert.ok(hourText.includes('按小时'), '单日视图应标注按小时')
assert.ok(hourText.includes('横轴 24 个小时'), `应画满 24 个小时桶，实际：${hourText.slice(0, 300)}`)
assert.equal(findAll(hourTree, (node) => node.props?.className === 'tku_chartCol').length, 24, '应有 24 根柱子')
console.log('✓ 单日视图按小时展开（24 根柱子）')

// 自定义悬浮提示：完整时间、准确数值、边缘约束与离开隐藏。
const columns = findAll(hourTree, (node) => node.props?.className === 'tku_chartCol')
const hoverEvent = { clientX: 395, clientY: 80, currentTarget: {
  parentElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400 }) },
  getBoundingClientRect: () => ({ left: 150, width: 16 }),
} }
assert.equal(columns[9].props.title, undefined, '不能再弹出延迟的原生 title')
columns[9].props.onPointerEnter(hoverEvent)
hourTree = await settle(hourMount.Component, 2)
let tooltip = findAll(hourTree, (node) => node.props?.role === 'tooltip')[0]
assert.ok(tooltip, '悬停时应显示卡片')
assert.ok(collectText(tooltip).join('').includes('2026/10/14 09:00'), '应展示完整小时')
assert.ok(collectText(tooltip).join('').includes('Tokens30'), '应展示精确 token 数')
assert.ok(tooltip.props.style.left + tooltip.props.style.width <= 392, '右侧卡片不能溢出图表')
findAll(hourTree, (node) => node.props?.className === 'tku_chart')[0].props.onPointerLeave()
hourTree = await settle(hourMount.Component, 2)
assert.equal(findAll(hourTree, (node) => node.props?.role === 'tooltip').length, 0, '移开鼠标后隐藏')
findAll(hourTree, (node) => node.props?.className === 'tku_chartCol')[9].props.onFocus({ currentTarget: hoverEvent.currentTarget })
hourTree = await settle(hourMount.Component, 2)
assert.ok(findAll(hourTree, (node) => node.props?.role === 'tooltip').length === 1, '键盘聚焦同样显示提示')
findAll(hourTree, (node) => node.type === 'button' && collectText(node).join('') === '请求数')[0].props.onClick()
hourTree = await settle(hourMount.Component, 2)
tooltip = findAll(hourTree, (node) => node.props?.role === 'tooltip')[0]
assert.ok(collectText(tooltip).join('').includes('请求数1'), '切换指标后提示应同步更新')
console.log('✓ 悬浮卡片：日期、指标、精确数值、边缘约束、隐藏与键盘支持')

/* ------------------------------------------------------------ 9. 自动刷新 */

// 勾选自动刷新后，到点必须再取一次数——这是「刚聊完就能看到新数字」的前提。
// 「同步状态」那一行有自己的 1 秒时钟，所以这里按间隔区分两类定时器。
const refreshUrls = []
const auto = mount({
  fetchImpl: (url) => {
    refreshUrls.push(String(url))
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(view) })
  },
})
let autoTree = await settle(auto.Component, 4)
const before = refreshUrls.length
const clockTimers = () => timers.intervals.filter((handle) => handle.delay === 1000).length
const refreshTimers = () => timers.intervals.filter((handle) => handle.delay === 5000).length
// 定时器表是全局的，而测试桩不模拟卸载；因此只比较「本次切换带来的增量」。
const clockBefore = clockTimers()
assert.equal(refreshTimers(), 0, '默认不应有刷新定时器')
const checkbox = findAll(autoTree, (node) => node.type === 'input' && node.props?.type === 'checkbox')[0]
assert.ok(checkbox !== undefined, '应有自动刷新开关')
checkbox.props.onChange({ target: { checked: true } })
autoTree = await settle(auto.Component, 2)
assert.equal(refreshTimers(), 1, '勾选后应挂上一个刷新定时器')

// 只推进时钟：它只更新「N 秒前同步」那一行，不该带来新的取数。
const clockOnlyCount = refreshUrls.length
for (const handle of timers.intervals.filter((item) => item.delay === 1000)) handle.fn()
await settle(auto.Component, 2)
assert.equal(refreshUrls.length, clockOnlyCount, '时钟走动不应触发取数')

for (const handle of timers.intervals.filter((item) => item.delay === 5000)) handle.fn()
autoTree = await settle(auto.Component, 4)
assert.ok(refreshUrls.length > before, '到点后应重新取数')

// 取消勾选必须撤销刷新定时器，否则关掉开关页面仍在后台轮询。
const checkboxOff = findAll(autoTree, (node) => node.type === 'input' && node.props?.type === 'checkbox')[0]
checkboxOff.props.onChange({ target: { checked: false } })
await settle(auto.Component, 2)
assert.equal(refreshTimers(), 0, '取消自动刷新后不应残留刷新定时器')
assert.equal(clockTimers(), clockBefore, '切换自动刷新不应影响同步状态的时钟')
console.log('✓ 自动刷新生效且可撤销，时钟不会触发取数')

restoreTimers()
console.log('\n面板测试全部通过。')
