# dsh-token-usage

统计 DeepSeek Harness **全部对话**每日消耗的 token，提供 `/token` 命令、`token_usage`
工具，以及 Harness Web UI 里的**用量统计面板**。

数字来自 provider 返回的真实 `usage`，不是本地估算，因此与账单口径一致。

## 统计范围

直接读取 `<DSH_HOME>/sessions/**` 下的会话日志，因此覆盖 harness 的**所有**对话：

| 来源 | 是否计入 | 说明 |
| --- | --- | --- |
| 主会话 | ✅ | 每个工作目录下的会话 |
| 子 Agent | ✅ | `origin: 'subagent'`，独立会话文件 |
| workflow 子任务 | ✅ | 脚本派生的每个 `agent()` 都是独立会话 |
| 标题生成、压缩摘要 | ✅ | 旁路模型调用，usage 记在所属会话里 |
| 其它 profile 的会话 | ✅ | 只要在同一个 `DSH_HOME` 下 |

> 实时事件（`session/event`）只用于让缓存失效。历史会话与其它 profile 的用量
> 不会出现在事件流里，因此数据源必须是日志而不是事件。

## 用量统计面板

插件自带一个浏览器界面：侧边栏的**用量统计**图标点开，中央主列显示完整面板。

- **指标卡**：非缓存用量（未命中输入 + 输出；缓存命中仍计入总 token）、总 token、模型调用、缓存命中率；
- **使用趋势**：按天柱状图（单日视图自动切成 **24 个小时桶**），可在 Tokens / 请求数之间切换；
- **明细页签**：请求日志（逐条调用，含来源、项目、供应商/模型、新增输入、缓存命中、输出、速度）、
  每日、模型、供应商、会话；
- **时间范围**：今天 / 7 天 / 14 天 / 30 天 / 全部；
- **自动刷新**：可选每 5 秒同步一次，刚聊完就能看到新数字。

面板只做展示，取数走宿主半侧注册的同源路由 `/plugins/dsh-token-usage/data`，
该路由**只接受回环地址**（校验 `Host`，并在浏览器带 `Origin` 时一并校验），
因此局域网里的其它机器读不到你的用量。

「速度」是**流式速度**（输出 token ÷ 首块到末块的墙钟跨度），不含排队与网络往返，
所以它不是端到端延迟；拿不到流式记录的调用显示 `—`。

## 安装

```bash
# 在本插件目录下，把包链接进 profile
# 具体命令取决于你的 DSH 版本，也可以在 GUI 的插件页面里安装本地目录
```

安装后确认 profile 的 `cordis.patch.yml` 已包含本插件：

```yaml
- insert:
    - id: token-usage
      name: dsh-token-usage
      config:
        enabled: true
```

> **首次启用界面需要重启一次 Host。** 宿主半侧（命令、工具、数据路由）在 HMR
> 下可以热重载，但客户端 bundle 的发现走的是 `client-modules` 的**进程级元数据
> 缓存**：它在启动时读过一次本包的 `package.json`（当时还没有 `dsh.client`），
> 此后不再重读。重启后侧边栏就会出现「用量统计」，仅刷新页面不能清除该宿主缓存。

### 让源码改动即时生效

默认 HMR 只监视 profile 配置。若要以链接方式开发本插件，请在 profile 的
`cordis.patch.yml` 里把插件目录加入 hmr 监视根：

```yaml
- id: hmr
  config:
    root:
      - F:/18752/Documents/plugin/token
```

## 用法

### 用量统计面板

侧边栏底部的**用量统计**图标 → 中央主列显示面板。面板不需要打开设置，
也不会占用会话。

### `/token` 命令

```
/token                      # 最近 14 天（可配置）
/token 7                    # 最近 7 天
/token today                # 仅今天
/token all                  # 全部历史
/token 2026-10-01           # 指定某一天
/token 2026-10-01..2026-10-13   # 指定区间
/token all --json           # 输出结构化 JSON
```

输出示例：

```
# Token 用量统计（时区 Asia/Shanghai）

总计：234,340,023 token（2.34亿）
输入 232,888,079（其中命中缓存 225,418,624，占 96.8%）｜ 输出 1,451,944
模型调用 1,548 次 ｜ 扫描会话 26 个（子 Agent 3 个）｜ 耗时 89ms

## 每日用量

日期  总 token  输入  输出  缓存命中率  调用  占比
2026-10-11    218.3万    213.0万     5.3万       95.3%     40  █
2026-10-12     1.39亿     1.39亿    76.5万       98.8%    816  ████████████████████████
2026-10-13   7625.9万   7576.2万    49.6万       98.0%    505  █████████████
```

### `token_usage` 工具

供 Agent 调用，回答「今天/本周/本月用了多少 token」这类问题。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `days` | integer | 统计最近多少天；`0` 表示全部历史 |
| `from` / `to` | string | 日期区间 `YYYY-MM-DD`（含边界） |
| `groupBy` | `day` \| `model` \| `session` | 聚合维度，默认 `day` |
| `refresh` | boolean | 绕过缓存强制重新扫描 |

## 口径说明

provider 返回的 `totalTokens` **恒等于**
`inputTokens + outputTokens + cacheReadTokens`（另有 `cacheWriteTokens` 时也计入）。
这一关系已用本机 1413 条真实记录逐条反推验证，完全吻合。

- `inputTokens`：**未命中**缓存的输入；
- `cacheReadTokens`：**命中**缓存的输入，与 `inputTokens` **并列**，不在它之内；
- 因此「全部输入」= `inputTokens + cacheReadTokens + cacheWriteTokens`；
- `reasoningTokens` 是 `outputTokens` 的**子集**（实测恒 `<=`），只展示、不重复计入；
- 缓存命中率 = `cacheReadTokens / 全部输入`。

长对话会反复发送同一上下文，本机实测命中率可达 96%～99%。因此**「输入」与
「缓存命中」必须分开看**：2.3 亿 token 里有 2.25 亿是缓存命中，单价远低于
未命中部分。若把命中率算成 `cacheReadTokens / inputTokens`，会得到 3000% 这种
荒谬比例——本插件刻意避免这一点。

`deepseek-official` 等 provider 不返回 `totalTokens`，此时按同一公式补齐。

### 为什么不计 `assistant/attempt`

`assistant/attempt` 是流式尝试的中间记录，用于崩溃恢复。它偶尔也带 usage
chunk，但实测这些 chunk 的 `totalTokens` **恒为 0**（重试前的空尝试），
且当它与 `assistant/message` 属于同一个 step 时，两者会重复。因此只统计
`assistant/message`，避免虚增。

### 多版本日志

同一会话目录里可能同时留着旧版 `session.jsonl.zstd` 与新版
`session.v4.jsonl.zstd`。旧版事件更多，但**用量记录完全一致**——新版只是把
被压缩/替换的历史折叠了。本插件每个会话只读版本最高的日志；已验证该策略与
「按指纹取并集」的理论值**完全相等**，而把各版本相加会虚增。

## 配置

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关 |
| `timeZone` | string | 系统时区 | 分天时区；留空则跟随系统 |
| `dshHome` | string | `$DSH_HOME` 或 `~/.dsh` | DSH 主目录 |
| `defaultDays` | number | `14` | `/token` 默认展示天数 |
| `includeSubagents` | boolean | `true` | 是否计入子 Agent 与 workflow 子任务 |
| `cacheTtlMs` | number | `5000` | 结果缓存时长；`0` 表示每次都重扫 |

面板与 `/token`、`token_usage` 共用同一份配置与同一次扫描结果（同一个 `cacheTtlMs`
缓存），所以三个入口的数字永远一致。

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: token-usage
  name: dsh-token-usage
  config:
    timeZone: Asia/Shanghai
    defaultDays: 30
    includeSubagents: true
```

## 性能

会话日志是**多帧** zstd 流（每帧对应一次刷盘）。Node 的 `createZstdDecompress`
只认第一帧，因此本插件逐帧扫描魔数分别解压，并容忍末帧截断（活跃会话正在写入）。

读取按 `mtime + size` 缓存，未变化的会话不重复解压：

| 场景 | 耗时（本机 26 个会话、9.5 MB 压缩数据） |
| --- | --- |
| 首次全量扫描 | ~490ms |
| 缓存命中 | ~70ms |

## 开发

```bash
node test/selftest.mjs    # 自检：解析、聚合、格式化、命令、工具、数据路由、无损 JSON
node test/panel.mjs       # 面板离线渲染：注册契约、各页签、错误态、自动刷新
node test/lossless.mjs    # 用真实数据校验工具返回值
node test/realdata.mjs    # 用真实会话日志打印报表
```

本插件**零外部依赖**，只用 `node:` 内置模块。以链接方式安装时，Node 在插件
目录下找不到 `node_modules`，任何裸导入都可能失败；零依赖让它在任何安装方式
下都能被加载。Config 校验也自行实现 Standard Schema 接口，不依赖 schemastery。

`lib/client.js` 是**手写**的浏览器 bundle，不走构建工具：它的格式（`window.__ModuleLoader__.load`
＋惰性 factory）本来就是产物格式，手写反而省掉了 tsdown 工具链，也让插件在
任何安装方式下都不需要构建步骤。它只从平台模块表取 `react` 与 `react/jsx-runtime`，
不 import 任何 Harness Client 包——那些包会随版本变化，而纯 JS 插件没有类型检查，
一个抛错的组件会把整个 slot 条目清空。

## 目录结构

```
lib/scan.js     会话发现、多帧 zstd 解压、JSONL 解析、mtime 缓存
lib/usage.js    usage 归一化、时区分天/小时、按天/模型/会话聚合、流式耗时
lib/format.js   中文报表、条形图、量级缩写
lib/index.js    插件入口、Config、/token 命令、token_usage 工具、界面数据路由
lib/client.js   浏览器半侧：用量统计面板（手写 bundle，零构建）
test/           自检、面板离线渲染与真实数据验证
tools/          开发用的 asar 读取器等一次性脚本
```

## License

MIT
