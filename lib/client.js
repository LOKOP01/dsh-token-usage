/**
 * dsh-token-usage 的浏览器半侧 —— 用量统计面板。
 *
 * ## 为什么是手写的 bundle
 *
 * DSH 的客户端插件必须提供已构建的 `lib/client.js`，格式是
 * `window.__ModuleLoader__.load({ id, factory })`：factory 只注册惰性工厂，
 * 模块副作用在首次物化时才跑。本插件坚持零依赖、零构建，因此这里手写该格式，
 * 只从平台模块表取 `react` 与 `react/jsx-runtime`（它们在 shell 的静态表里），
 * 不 import 任何 Harness Client 包——那些包会随版本变化，而纯 JS 插件没有类型检查，
 * 一个抛错的组件会把整个 slot 条目清空。
 *
 * ## 数据从哪来
 *
 * 宿主半侧把统计结果挂在 `/plugins/dsh-token-usage/data`，这里用同源 `fetch` 取。
 * 走 HTTP 而不是 Remote 是有意的：Remote 需要构建期生成的 codec，而本插件刻意
 * 不引入构建步骤。
 *
 * ## 口径
 *
 * 「非缓存用量」= 未命中缓存的输入 + 输出，不含命中缓存的部分；缓存命中仍属于实际用量，
 * 费用需按供应商定价另行计算。缓存命中率的分母是**全部输入**（未命中 + 命中 + 写入），
 * 与 `/token` 命令、`token_usage` 工具完全同源。
 */

window.__ModuleLoader__.load({
  id: 'dsh-token-usage',
  factory(require) {
    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')

    /** 宿主半侧注册的数据路由，必须与 lib/index.js 的 DATA_PATH 一致。 */
    const DATA_PATH = '/plugins/dsh-token-usage/data'

    /** 侧边栏面板 id：`sidebar.panellist` 的 id 与 `main` 的 key 必须相同。 */
    const PANEL_ID = 'token-usage'

    /** 自动刷新间隔。 */
    const AUTO_REFRESH_MS = 5000

    /** 时间范围选项，`days: 0` 表示全部历史。 */
    const RANGES = [
      { id: 'today', label: '今天', days: 1 },
      { id: '7d', label: '7 天', days: 7 },
      { id: '14d', label: '14 天', days: 14 },
      { id: '30d', label: '30 天', days: 30 },
      { id: 'all', label: '全部', days: 0 },
    ]

    /* ---------------------------------------------------------------- 格式化 */

    /** 千分位整数。 */
    function comma(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      return Math.round(n).toLocaleString('en-US')
    }

    /** 中文量级缩写：1.2万 / 3.45亿。 */
    function human(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      const abs = Math.abs(n)
      if (abs < 10_000) return comma(n)
      if (abs < 100_000_000) return `${(n / 10_000).toFixed(1)}万`
      return `${(n / 100_000_000).toFixed(2)}亿`
    }

    /** 请求日志的紧凑计数；精确值保留在单元格提示中。 */
    function compactTokens(value) {
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
      if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
      return comma(value)
    }

    /** 百分比。 */
    function ratio(part, whole) {
      const p = Number(part)
      const w = Number(whole)
      if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) return '—'
      return `${((p / w) * 100).toFixed(1)}%`
    }

    /**
     * 「非缓存用量」：未命中缓存的输入 + 输出。
     *
     * 此项只用于拆分缓存与非缓存用量，不是费用，也不替代总 token。
     */
    function realCostTokens(item) {
      const input = Math.max(0, (item.promptTokens ?? 0) - (item.cacheReadTokens ?? 0))
      return input + (item.outputTokens ?? 0)
    }

    /** 把时间戳格式化成指定时区的 `HH:mm:ss`。 */
    function clockOf(timeMs, timeZone) {
      const date = new Date(timeMs)
      if (Number.isNaN(date.getTime())) return '—'
      try {
        return new Intl.DateTimeFormat('zh-CN', {
          timeZone,
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).format(date)
      } catch {
        return date.toISOString().slice(11, 19)
      }
    }

    /** 把 `YYYY-MM-DD` 缩成 `MM-DD`，柱状图的横轴不需要年份。 */
    function shortDay(day) {
      return typeof day === 'string' && day.length >= 10 ? day.slice(5) : String(day ?? '')
    }

    /** 相对时间：刚刚 / N 分钟前。 */
    function sinceText(timeMs, now) {
      if (!timeMs) return '尚未同步'
      const seconds = Math.max(0, Math.round((now - timeMs) / 1000))
      if (seconds < 5) return '刚刚同步'
      if (seconds < 60) return `${seconds} 秒前同步`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes} 分钟前同步`
      return `${Math.floor(minutes / 60)} 小时前同步`
    }

    /** 速度：输出 token / 秒；没有耗时信息时返回 null。 */
    function speedOf(record) {
      const ms = Number(record.durationMs)
      if (!Number.isFinite(ms) || ms <= 0) return null
      return (record.outputTokens ?? 0) / (ms / 1000)
    }

    /* ---------------------------------------------------------------- 数据取用 */

    /**
     * 取一次统计数据。
     *
     * @param days - 统计最近多少天；`0` 表示全部。
     * @param signal - 取消信号。
     * @returns 界面视图对象。
     */
    async function fetchUsage(days, signal) {
      const response = await fetch(`${DATA_PATH}?days=${String(days)}`, {
        signal,
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      if (!response.ok) {
        // 服务端把失败原因放在 `error` 字段里，直接透出比 `HTTP 400` 有用得多。
        let detail = ''
        try {
          const payload = await response.json()
          if (payload !== null && typeof payload === 'object' && typeof payload.error === 'string') {
            detail = payload.error
          }
        } catch {
          // 响应不是 JSON，保持空串
        }
        throw new Error(detail.length > 0 ? detail : `请求失败（HTTP ${String(response.status)}）`)
      }
      return response.json()
    }

    /* ---------------------------------------------------------------- 样式 */

    /**
     * 面板样式。
     *
     * 颜色一律走主题 token（`--dsw-alias-*`），因此明暗主题和后续换肤都不需要改这里；
     * 极少数可选的第三级 token 用 `var(--fallback, ...)` 兜底，token 改名只会让外观
     * 轻微退化，而不会让渲染出错。
     */
    const CSS = `
.tku_page{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}
.tku_head{flex:none;display:flex;align-items:center;gap:12px;padding:0 20px;height:52px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.tku_headTitle{font-size:15px;font-weight:500;margin:0;flex:none}
.tku_headMeta{color:var(--dsw-alias-label-secondary);font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tku_btn{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:5px 12px;cursor:pointer;flex:none}
.tku_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.tku_btn:disabled{opacity:.5;cursor:default}
.tku_btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.tku_toggle{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;user-select:none}
.tku_toggle input{accent-color:var(--dsw-alias-brand-primary);width:14px;height:14px;cursor:pointer}
.tku_scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}
.tku_body{max-width:1240px;margin:0 auto;padding:18px 20px 56px}
.tku_error{margin:0 0 14px;padding:10px 14px;border-radius:12px;font-size:13px;color:var(--dsw-alias-state-error-primary);border:.5px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1)}
.tku_cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-bottom:14px}
.tku_card{border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:14px;padding:12px 14px;min-width:0}
.tku_cardLabel{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:4px}
.tku_cardValue{font-size:25px;font-weight:500;line-height:1.35;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.tku_cardHint{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tku_panel{border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:14px;padding:14px;margin-bottom:14px;min-width:0}
.tku_panelHead{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.tku_panelTitle{font-size:13px;font-weight:500;margin:0;flex:none}
.tku_panelHead .tku_spacer{flex:1;min-width:8px}
.tku_seg{display:inline-flex;gap:2px;padding:2px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);flex:none}
.tku_segItem{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;border:0;border-radius:8px;padding:3px 10px;cursor:pointer;white-space:nowrap}
.tku_segItem:hover{color:var(--dsw-alias-label-primary)}
.tku_segItem[data-on="1"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px var(--dsw-alias-border-l1)}
.tku_segItem:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.tku_chart{display:flex;align-items:flex-end;gap:2px;height:150px;padding-top:4px;position:relative}
.tku_chartTip{position:absolute;z-index:5;box-sizing:border-box;pointer-events:none;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 4px 16px var(--dsw-alias-border-l2);font-size:12px;line-height:20px}
.tku_chartTipDate{font-weight:600;margin-bottom:4px;white-space:nowrap}
.tku_chartTipRow{display:flex;align-items:center;gap:8px;white-space:nowrap}
.tku_chartTipDot{width:8px;height:8px;border-radius:2px;background:var(--dsw-alias-brand-primary);flex:none}
.tku_chartTipValue{margin-left:auto;font-variant-numeric:tabular-nums}
.tku_chartCol:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.tku_chartCol{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;height:100%;position:relative}
.tku_chartBar{background:var(--dsw-alias-brand-primary);border-radius:3px 3px 0 0;min-height:2px;transition:height .18s ease}
.tku_chartCol:hover .tku_chartBar{opacity:.78}
.tku_chartAxis{display:flex;gap:2px;margin-top:6px}
.tku_chartTick{flex:1;min-width:0;font-size:10px;color:var(--dsw-alias-label-secondary);text-align:center;white-space:nowrap;overflow:hidden;font-variant-numeric:tabular-nums}
.tku_empty{padding:28px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
.tku_tabs{display:flex;gap:2px;border-bottom:.5px solid var(--dsw-alias-border-l1);margin-bottom:0;flex-wrap:wrap}
.tku_tab{font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);background:transparent;border:0;border-bottom:2px solid transparent;padding:7px 12px;margin-bottom:-1px;cursor:pointer;white-space:nowrap}
.tku_tab:hover{color:var(--dsw-alias-label-primary)}
.tku_tab[data-on="1"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}
.tku_tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.tku_tableWrap{border:.5px solid var(--dsw-alias-border-l1);border-top:0;border-radius:0 0 14px 14px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.tku_scrollX{overflow-x:auto}
.tku_table{width:100%;border-collapse:collapse;font-size:12.5px}
.tku_table th{position:sticky;top:0;z-index:1;text-align:right;font-weight:400;font-size:11.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);white-space:nowrap}
.tku_table th:first-child,.tku_table td:first-child{text-align:left}
.tku_table th.tku_left,.tku_table td.tku_left{text-align:left}
.tku_table td{padding:7px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.tku_records th,.tku_records td{padding:8px 8px;font-size:12px}
.tku_records .tku_name{max-width:160px}
.tku_records .tku_model{max-width:220px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
.tku_records th:nth-child(4){width:100%}
.tku_records .tku_tag{border:0;padding:0;font-size:12px;color:var(--dsw-alias-label-primary)}
.tku_table tbody tr:last-child td{border-bottom:0}
.tku_table tbody tr:hover td{background:var(--dsw-alias-bg-layer-2)}
.tku_muted{color:var(--dsw-alias-label-secondary)}
.tku_mono{font-variant-numeric:tabular-nums}
.tku_name{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:bottom}
.tku_tag{display:inline-block;font-size:10.5px;line-height:16px;padding:0 6px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);vertical-align:1px}
.tku_hit{color:var(--dsw-alias-state-success-primary)}
.tku_miss{color:var(--dsw-alias-state-warn-primary)}
.tku_more{padding:10px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);border-top:.5px solid var(--dsw-alias-border-l1)}
.tku_rankBar{display:inline-block;height:6px;border-radius:3px;background:var(--dsw-alias-brand-primary);vertical-align:middle;min-width:2px}
.tku_skeleton{padding:40px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
`

    /* ---------------------------------------------------------------- 组件 */

    /** 侧边栏图标：柱状图轮廓，跟随主题前景色。 */
    function TokenUsageIcon({ size = 16 }) {
      return jsx('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block', flex: 'none' },
        children: jsx('g', {
          fill: 'currentColor',
          children: jsxs(React.Fragment, {
            children: [
              jsx('rect', { x: 1.5, y: 8.5, width: 3, height: 6, rx: 1 }),
              jsx('rect', { x: 6.5, y: 4.5, width: 3, height: 10, rx: 1 }),
              jsx('rect', { x: 11.5, y: 1.5, width: 3, height: 13, rx: 1 }),
            ],
          }),
        }),
      })
    }

    /** 一张指标卡。 */
    function Card({ label, value, hint }) {
      return jsxs('div', {
        className: 'tku_card',
        children: [
          jsx('div', { className: 'tku_cardLabel', children: label }),
          jsx('div', { className: 'tku_cardValue', children: value }),
          jsx('div', { className: 'tku_cardHint', children: hint ?? '\u00a0' }),
        ],
      })
    }

    /** 分段选择器。 */
    function Segmented({ options, value, onChange, ariaLabel }) {
      return jsx('div', {
        className: 'tku_seg',
        role: 'group',
        'aria-label': ariaLabel,
        children: options.map((option) => jsx('button', {
          type: 'button',
          className: 'tku_segItem',
          'data-on': option.id === value ? '1' : '0',
          'aria-pressed': option.id === value ? 'true' : 'false',
          onClick: () => { onChange(option.id) },
          children: option.label,
        }, option.id)),
      })
    }

    /**
     * 使用趋势柱状图。
     *
     * 用纯 DOM 画而不是引图表库：插件的唯一运行时依赖是 React，多引一个库
     * 就等于多一个随宿主升级而失效的风险点。
     */
    function TrendChart({ points, metric, unit }) {
      const [hover, setHover] = React.useState(null)
      const showTip = (event, index) => {
        const column = event.currentTarget
        const chart = column.parentElement.getBoundingClientRect()
        const rect = column.getBoundingClientRect()
        const width = Math.min(220, Math.max(0, chart.width - 16))
        const x = Number.isFinite(event.clientX) ? event.clientX - chart.left : rect.left + rect.width / 2 - chart.left
        const y = Number.isFinite(event.clientY) ? event.clientY - chart.top : 12
        setHover({ index, width, left: Math.max(8, Math.min(x + 14, chart.width - width - 8)), top: Math.max(8, Math.min(y - 32, 78)) })
      }
      if (points.length === 0) {
        return jsx('div', { className: 'tku_empty', children: '该区间没有用量记录' })
      }
      const values = points.map((point) => (metric === 'calls' ? point.calls : point.totalTokens))
      const max = Math.max(...values, 1)
      // 横轴标签在点很多时抽稀，否则文字会互相压住。
      const step = Math.max(1, Math.ceil(points.length / 12))

      return jsxs(React.Fragment, {
        children: [
          jsx('div', {
            className: 'tku_chart',
            onPointerLeave: () => { setHover(null) },
            children: [...points.map((point, index) => {
              const value = values[index]
              const height = value > 0 ? Math.max(2, (value / max) * 100) : 0
              return jsx('div', {
                className: 'tku_chartCol',
                tabIndex: 0,
                'aria-label': `${point.key}，${metric === 'calls' ? '请求数' : 'Tokens'} ${comma(value)}`,
                onPointerEnter: (event) => { showTip(event, index) },
                onPointerMove: (event) => { showTip(event, index) },
                onFocus: (event) => { showTip(event, index) },
                onBlur: () => { setHover(null) },
                onKeyDown: (event) => { if (event.key === 'Escape') setHover(null) },
                children: jsx('div', {
                  className: 'tku_chartBar',
                  style: { height: `${String(height)}%` },
                }),
              }, point.key)
            }), hover !== null && points[hover.index] ? jsxs('div', {
              className: 'tku_chartTip',
              role: 'tooltip',
              style: { left: hover.left, top: hover.top, width: hover.width },
              children: [
                jsx('div', { className: 'tku_chartTipDate', children: points[hover.index].key.replace(/-/gu, '/').replace('T', ' ') + (unit === '小时' ? ':00' : '') }),
                jsxs('div', { className: 'tku_chartTipRow', children: [
                  jsx('span', { className: 'tku_chartTipDot', 'aria-hidden': true }),
                  jsx('span', { children: metric === 'calls' ? '请求数' : 'Tokens' }),
                  jsx('span', { className: 'tku_chartTipValue', children: comma(values[hover.index]) }),
                ] }),
              ],
            }, 'tooltip') : null],
          }),
          jsx('div', {
            className: 'tku_chartAxis',
            children: points.map((point, index) => jsx('div', {
              className: 'tku_chartTick',
              children: index % step === 0 ? point.label : '',
            }, point.key)),
          }),
          jsx('div', {
            className: 'tku_muted',
            style: { fontSize: '11px', marginTop: '8px' },
            children: `横轴 ${points.length} 个${unit}　峰值 ${metric === 'calls' ? `${comma(max)} 次` : human(max)}`,
          }),
        ],
      })
    }

    /** 排行榜表格：名称 + 条形 + 各项计数。 */
    function RankingTable({ rows, keyLabel, timeZone }) {
      if (rows.length === 0) return jsx('div', { className: 'tku_empty', children: '没有数据' })
      const max = Math.max(...rows.map((row) => row.totalTokens), 1)
      const showTime = rows.some((row) => typeof row.lastTime === 'number')

      return jsx('div', {
        className: 'tku_scrollX',
        children: jsxs('table', {
          className: 'tku_table',
          children: [
            jsx('thead', {
              children: jsxs('tr', {
                children: [
                  jsx('th', { className: 'tku_left', children: keyLabel }),
                  jsx('th', { children: '总 token' }),
                  jsx('th', { children: '占比' }),
                  jsx('th', { children: '输入' }),
                  jsx('th', { children: '输出' }),
                  jsx('th', { children: '缓存命中' }),
                  jsx('th', { children: '命中率' }),
                  jsx('th', { children: '调用' }),
                  showTime ? jsx('th', { children: '最近一次' }) : null,
                ].filter(Boolean),
              }),
            }),
            jsx('tbody', {
              children: rows.map((row) => jsxs('tr', {
                children: [
                  jsx('td', {
                    className: 'tku_left',
                    children: jsx('span', { className: 'tku_name', title: String(row.key), children: String(row.key) }),
                  }),
                  jsx('td', { children: human(row.totalTokens) }),
                  jsx('td', {
                    className: 'tku_left',
                    style: { width: '120px' },
                    children: jsx('span', {
                      className: 'tku_rankBar',
                      style: { width: `${String(Math.max(2, (row.totalTokens / max) * 100))}%` },
                    }),
                  }),
                  jsx('td', { children: human(row.promptTokens) }),
                  jsx('td', { children: human(row.outputTokens) }),
                  jsx('td', { children: human(row.cacheReadTokens) }),
                  jsx('td', { children: ratio(row.cacheReadTokens, row.promptTokens) }),
                  jsx('td', { children: comma(row.calls) }),
                  showTime
                    ? jsx('td', { className: 'tku_muted', children: row.lastTime ? clockOf(row.lastTime, timeZone) : '—' })
                    : null,
                ].filter(Boolean),
              }, `${row.sessionId ?? ''}${String(row.key)}`)),
            }),
          ],
        }),
      })
    }

    /** 请求日志表格：逐条调用。 */
    function RecordsTable({ records, timeZone, total }) {
      if (records.length === 0) return jsx('div', { className: 'tku_empty', children: '该区间没有调用记录' })

      return jsxs(React.Fragment, {
        children: [
          jsx('div', {
            className: 'tku_scrollX',
            children: jsxs('table', {
              className: 'tku_table tku_records',
              children: [
                jsx('thead', {
                  children: jsxs('tr', {
                    children: [
                      jsx('th', { className: 'tku_left', children: '时间' }),
                      jsx('th', { className: 'tku_left', children: '来源' }),
                      jsx('th', { className: 'tku_left', children: '供应商' }),
                      jsx('th', { className: 'tku_left', children: '模型' }),
                      jsx('th', { children: '新增输入' }),
                      jsx('th', { children: '输出' }),
                      jsx('th', { children: '缓存命中' }),
                      jsx('th', { children: '速度' }),
                    ],
                  }),
                }),
                jsx('tbody', {
                  children: records.map((record, index) => {
                    const speed = speedOf(record)
                    return jsxs('tr', {
                      children: [
                        jsx('td', {
                          className: 'tku_left',
                          title: `${record.day} ${clockOf(record.timeMs, timeZone)} (${timeZone})`,
                          children: `${shortDay(record.day)} ${clockOf(record.timeMs, timeZone).slice(0, 5)}`,
                        }),
                        jsx('td', {
                          className: 'tku_left',
                          children: jsx('span', {
                            className: 'tku_tag',
                            title: `${projectName(record.cwdSlug)} · ${record.sessionId}`,
                            children: record.subagent ? '子 Agent' : '主会话',
                          }),
                        }),
                        jsx('td', {
                          className: 'tku_left',
                          children: jsx('span', { className: 'tku_name', title: record.provider, children: record.provider }),
                        }),
                        jsx('td', {
                          className: 'tku_left',
                          children: jsx('span', { className: 'tku_name tku_model', title: record.model, children: record.model }),
                        }),
                        jsx('td', { children: comma(record.inputTokens) }),
                        jsx('td', { children: comma(record.outputTokens) }),
                        jsx('td', {
                          title: record.cacheReadTokens > 0 ? `${comma(record.cacheReadTokens)} token` : undefined,
                          children: record.cacheReadTokens > 0 ? compactTokens(record.cacheReadTokens) : '—',
                        }),
                        jsx('td', {
                          className: speed === null ? 'tku_muted' : undefined,
                          children: speed === null ? '—' : `${speed.toFixed(0)} tok/s`,
                        }),
                      ],
                    }, `${String(record.timeMs)}-${String(index)}`)
                  }),
                }),
              ],
            }),
          }),
          total > records.length
            ? jsx('div', {
              className: 'tku_more',
              children: `仅显示最近 ${comma(records.length)} 条，该区间共 ${comma(total)} 次调用。`,
            })
            : null,
        ].filter(Boolean),
      })
    }

    /** 每日明细表。 */
    function DaysTable({ days }) {
      if (days.length === 0) return jsx('div', { className: 'tku_empty', children: '没有数据' })
      return jsx('div', {
        className: 'tku_scrollX',
        children: jsxs('table', {
          className: 'tku_table',
          children: [
            jsx('thead', {
              children: jsxs('tr', {
                children: [
                  jsx('th', { className: 'tku_left', children: '日期' }),
                  jsx('th', { children: '总 token' }),
                  jsx('th', { children: '新增输入' }),
                  jsx('th', { children: '缓存命中' }),
                  jsx('th', { children: '输出' }),
                  jsx('th', { children: '命中率' }),
                  jsx('th', { children: '调用' }),
                  jsx('th', { children: '会话' }),
                  jsx('th', { className: 'tku_left', children: '占比' }),
                ],
              }),
            }),
            jsx('tbody', {
              children: (() => {
                const max = Math.max(...days.map((day) => day.totalTokens), 1)
                return days.map((day) => jsxs('tr', {
                  children: [
                    jsx('td', { className: 'tku_left', children: day.day }),
                    jsx('td', { children: human(day.totalTokens) }),
                    jsx('td', { children: comma(day.inputTokens) }),
                    jsx('td', { className: day.cacheReadTokens > 0 ? 'tku_hit' : 'tku_muted', children: comma(day.cacheReadTokens) }),
                    jsx('td', { children: comma(day.outputTokens) }),
                    jsx('td', { children: ratio(day.cacheReadTokens, day.promptTokens) }),
                    jsx('td', { children: comma(day.calls) }),
                    jsx('td', { className: 'tku_muted', children: comma(day.sessions) }),
                    jsx('td', {
                      className: 'tku_left',
                      style: { width: '120px' },
                      children: jsx('span', {
                        className: 'tku_rankBar',
                        style: { width: `${String(Math.max(2, (day.totalTokens / max) * 100))}%` },
                      }),
                    }),
                  ],
                }, day.day))
              })(),
            }),
          ],
        }),
      })
    }

    /** 把工作目录 slug 还原成可读的项目名。 */
    function projectName(slug) {
      if (typeof slug !== 'string' || slug.length === 0) return '—'
      // slug 形如 `--F-18752-Documents-plugin-token--`：首尾各两个短横，内部用
      // `-` 代替路径分隔符，字面空格被编码成 `~0020`。
      let text = slug
      if (text.startsWith('--') && text.endsWith('--')) text = text.slice(2, -2)
      text = text.replace(/~([0-9a-fA-F]{4})/gu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      const parts = text.split('-').filter((part) => part.length > 0)
      return parts.length === 0 ? slug : parts.slice(-2).join('/')
    }

    /**
     * 同步状态那一行。
     *
     * 它自己持有每秒走动的时钟，而不是把这个状态放在面板根部：面板里有几百行
     * 明细表，根部一秒一次的状态更新会让整张表跟着重渲染，而实际上变化的只有
     * 「N 秒前同步」这几个字。
     */
    function SyncStatus({ at, data }) {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        const timer = setInterval(() => { setNow(Date.now()) }, 1000)
        return () => { clearInterval(timer) }
      }, [])

      if (data === null) {
        return jsx('span', { className: 'tku_headMeta', children: '正在读取会话日志…' })
      }
      return jsx('span', {
        className: 'tku_headMeta',
        children: `${sinceText(at, now)}　时区 ${String(data.timeZone)}　`
          + `扫描 ${comma(data.scanned.sessions)} 个会话（子 Agent ${comma(data.scanned.subagentSessions)} 个）　`
          + `耗时 ${comma(data.durationMs)}ms`,
      })
    }

    /** 面板主体。 */
    function TokenUsagePanel() {
      const [rangeId, setRangeId] = React.useState('14d')
      const [metric, setMetric] = React.useState('tokens')
      const [tab, setTab] = React.useState('records')
      const [auto, setAuto] = React.useState(false)
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null, at: 0 })
      const [nonce, setNonce] = React.useState(0)

      const days = RANGES.find((range) => range.id === rangeId)?.days ?? 14

      React.useEffect(() => {
        const controller = new AbortController()
        let alive = true
        setState((previous) => ({ ...previous, status: previous.data === null ? 'loading' : 'refreshing' }))
        fetchUsage(days, controller.signal)
          .then((data) => {
            if (!alive) return
            setState({ status: 'ready', data, error: null, at: Date.now() })
          })
          .catch((error) => {
            if (!alive || error?.name === 'AbortError') return
            // 上一次的数据留着继续显示：刷新失败不该把已有内容清空。
            setState((previous) => ({
              status: 'error',
              data: previous.data,
              error: error instanceof Error ? error.message : String(error),
              at: previous.at,
            }))
          })
        return () => {
          alive = false
          controller.abort()
        }
      }, [days, nonce])

      // 自动刷新单独一个定时器：它只改 nonce，取数逻辑仍然只有一份。
      React.useEffect(() => {
        if (!auto) return undefined
        const timer = setInterval(() => { setNonce((value) => value + 1) }, AUTO_REFRESH_MS)
        return () => { clearInterval(timer) }
      }, [auto])

      const data = state.data
      const busy = state.status === 'loading' || state.status === 'refreshing'

      const trend = React.useMemo(() => {
        if (data === null) return []
        if (days === 1 && Array.isArray(data.hours) && data.hours.length > 0) {
          return data.hours.map((hour) => ({
            key: hour.hour,
            label: `${hour.label}时`,
            totalTokens: hour.totalTokens,
            calls: hour.calls,
          }))
        }
        return data.days.map((day) => ({
          key: day.day,
          label: shortDay(day.day),
          totalTokens: day.totalTokens,
          calls: day.calls,
        }))
      }, [data, days])

      const head = jsxs('div', {
        className: 'tku_head',
        children: [
          jsx('h2', { className: 'tku_headTitle', children: '用量统计' }),
          jsx(SyncStatus, { at: state.at, data }),
          jsxs('label', {
            className: 'tku_toggle',
            title: `每 ${String(AUTO_REFRESH_MS / 1000)} 秒自动刷新`,
            children: [
              jsx('input', {
                type: 'checkbox',
                checked: auto,
                onChange: (event) => { setAuto(event.target.checked) },
              }),
              `自动刷新 ${String(AUTO_REFRESH_MS / 1000)} 秒`,
            ],
          }),
          jsx('button', {
            type: 'button',
            className: 'tku_btn',
            disabled: busy,
            onClick: () => { setNonce((value) => value + 1) },
            children: busy ? '同步中…' : '立即同步',
          }),
        ],
      })

      if (data === null) {
        return jsxs('div', {
          className: 'tku_page',
          children: [
            head,
            jsx('div', {
              className: 'tku_skeleton',
              children: state.status === 'error' ? `读取失败：${String(state.error)}` : '正在统计…',
            }),
          ],
        })
      }

      const totals = data.totals
      const rangeText = days === 0 ? '全部历史' : days === 1 ? '今天' : `最近 ${String(days)} 天`
      const activeSessions = new Set(data.records.map((record) => record.sessionId)).size

      const cards = jsxs('div', {
        className: 'tku_cards',
        children: [
          jsx(Card, {
            label: '非缓存用量',
            value: human(realCostTokens(totals)),
            hint: `未命中输入 + 输出，不含缓存命中`,
          }),
          jsx(Card, {
            label: '总 token',
            value: human(totals.totalTokens),
            hint: `输入 ${human(totals.promptTokens)} ｜ 输出 ${human(totals.outputTokens)}`,
          }),
          jsx(Card, {
            label: '模型调用',
            value: comma(totals.calls),
            hint: `涉及 ${comma(activeSessions)} 个会话（明细范围内）`,
          }),
          jsx(Card, {
            label: '缓存命中率',
            value: ratio(totals.cacheReadTokens, totals.promptTokens),
            hint: `命中 ${human(totals.cacheReadTokens)} / 输入 ${human(totals.promptTokens)}`,
          }),
        ],
      })

      const trendPanel = jsxs('div', {
        className: 'tku_panel',
        children: [
          jsxs('div', {
            className: 'tku_panelHead',
            children: [
              jsx('h3', { className: 'tku_panelTitle', children: days === 1 ? '使用趋势（按小时）' : '使用趋势（按天）' }),
              jsx('span', { className: 'tku_spacer' }),
              jsx(Segmented, {
                ariaLabel: '趋势指标',
                value: metric,
                onChange: setMetric,
                options: [
                  { id: 'tokens', label: 'Tokens' },
                  { id: 'calls', label: '请求数' },
                ],
              }),
            ],
          }),
          jsx(TrendChart, {
            points: trend,
            metric,
            unit: days === 1 ? '小时' : '天',
          }),
        ],
      })

      const tabs = [
        { id: 'records', label: '请求日志' },
        { id: 'days', label: '每日' },
        { id: 'models', label: '模型' },
        { id: 'providers', label: '供应商' },
        { id: 'sessions', label: '会话' },
      ]

      let table
      if (tab === 'days') {
        table = jsx(DaysTable, { days: data.days })
      } else if (tab === 'models') {
        table = jsx(RankingTable, { rows: data.models, keyLabel: '供应商 / 模型', timeZone: data.timeZone })
      } else if (tab === 'providers') {
        table = jsx(RankingTable, { rows: data.providers, keyLabel: '供应商', timeZone: data.timeZone })
      } else if (tab === 'sessions') {
        table = jsx(RankingTable, {
          rows: data.sessions.map((session) => ({
            ...session,
            key: `${session.sessionId.slice(0, 18)}…${session.subagent ? '　子 Agent' : ''}`,
          })),
          keyLabel: '会话',
          timeZone: data.timeZone,
        })
      } else {
        table = jsx(RecordsTable, {
          records: data.records,
          timeZone: data.timeZone,
          total: data.recordTotal,
        })
      }

      return jsxs('div', {
        className: 'tku_page',
        children: [
          head,
          jsxs('div', {
            className: 'tku_scroll',
            children: jsxs('div', {
              className: 'tku_body',
              children: [
                state.status === 'error'
                  ? jsx('div', {
                    className: 'tku_error',
                    children: `刷新失败：${String(state.error)}（下面显示的是上一次成功的结果）`,
                  })
                  : null,
                jsxs('div', {
                  className: 'tku_panelHead',
                  style: { marginBottom: '12px' },
                  children: [
                    jsx(Segmented, {
                      ariaLabel: '时间范围',
                      value: rangeId,
                      onChange: setRangeId,
                      options: RANGES.map((range) => ({ id: range.id, label: range.label })),
                    }),
                    jsx('span', {
                      className: 'tku_muted',
                      style: { fontSize: '12px' },
                      children: rangeText,
                    }),
                    jsx('span', { className: 'tku_spacer' }),
                  ],
                }),
                cards,
                trendPanel,
                jsx('div', {
                  className: 'tku_tabs',
                  role: 'tablist',
                  children: tabs.map((item) => jsx('button', {
                    type: 'button',
                    role: 'tab',
                    className: 'tku_tab',
                    'data-on': item.id === tab ? '1' : '0',
                    'aria-selected': item.id === tab ? 'true' : 'false',
                    onClick: () => { setTab(item.id) },
                    children: item.label,
                  }, item.id)),
                }),
                jsx('div', { className: 'tku_tableWrap', children: table }),
              ],
            }),
          }),
        ],
      })
    }

    return {
      name: 'token-usage-panel',
      /** 只依赖 slot 注册表：其余一切都从同源数据路由取。 */
      inject: ['slots'],
      /**
       * 注册面板。
       *
       * 两个 slot 必须成对注册：`sidebar.panellist` 的 id 就是主列要派发的 key，
       * 缺了任意一半，侧边栏要么有按钮点不开、要么有页面进不去。
       *
       * @param ctx - 客户端根上下文。
       */
      apply(ctx) {
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-token-usage'
          tag.dataset.pluginCss = 'dsh-token-usage/panel.css'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => { tag.remove() }
        }, 'dsh-token-usage: 面板样式')

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 5,
          label: '用量统计',
        }, TokenUsageIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, TokenUsagePanel))
      },
    }
  },
})
