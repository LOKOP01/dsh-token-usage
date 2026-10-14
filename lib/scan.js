/**
 * 会话日志发现与读取。
 *
 * DSH 把每个会话的追加日志写在
 * `<DSH_HOME>/sessions/<cwd-slug>/<session-id>/session.vN.jsonl.zstd`。
 * 文件是**多帧** zstd 流：每帧对应一次刷盘，而不是一个连续的压缩流。
 * Node 的 `createZstdDecompress` 只认第一帧，之后的帧会报
 * `ZSTD_error_prefix_unknown`，所以这里逐帧扫描魔数并分别解压。
 *
 * 本模块零外部依赖，只使用 `node:` 内置模块。
 *
 * @module dsh-token-usage/scan
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** zstd 帧魔数（小端 0xFD2FB528）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话日志文件名，例如 `session.v4.jsonl.zstd` 或 `session.jsonl.zstd`。 */
const LOG_NAME = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/u

/**
 * 解析 DSH 主目录。
 *
 * @param override - 配置里显式指定的目录；为空时回退到 `DSH_HOME`，再回退到 `~/.dsh`。
 * @returns 绝对路径。
 */
export function resolveDshHome(override) {
  if (typeof override === 'string' && override.trim().length > 0) return override.trim()
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * 从文件名解析日志格式版本，用于在同名多版本共存时取最高版本。
 *
 * @param name - 文件名。
 * @returns 版本号；无版本后缀时为 0；不匹配时为 -1。
 */
export function logVersion(name) {
  const match = LOG_NAME.exec(name)
  if (match === null) return -1
  return match[1] === undefined ? 0 : Number(match[1])
}

/**
 * 枚举全部会话日志文件。
 *
 * 目录是两层结构：第一层是按工作目录编码的 slug，第二层是会话 id。
 * 同一会话目录里可能同时留着旧版 `session.jsonl.zstd` 与新版
 * `session.v4.jsonl.zstd`（新版是旧版的超集），因此每个会话只保留版本最高的一个。
 *
 * @param sessionsRoot - `<DSH_HOME>/sessions` 目录。
 * @returns 每个会话一项，含会话 id、工作目录 slug 与日志路径。
 */
export function listSessionLogs(sessionsRoot) {
  let cwdDirs
  try {
    cwdDirs = readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    // 目录不存在（DSH 尚未写入任何会话）不是错误，返回空集合。
    return []
  }

  const out = []
  for (const cwdEntry of cwdDirs) {
    if (!cwdEntry.isDirectory()) continue
    const cwdPath = join(sessionsRoot, cwdEntry.name)

    let sessionDirs
    try {
      sessionDirs = readdirSync(cwdPath, { withFileTypes: true })
    } catch {
      continue
    }

    for (const sessionEntry of sessionDirs) {
      if (!sessionEntry.isDirectory()) continue
      const sessionPath = join(cwdPath, sessionEntry.name)

      let files
      try {
        files = readdirSync(sessionPath, { withFileTypes: true })
      } catch {
        continue
      }

      let best = null
      let bestVersion = -1
      for (const file of files) {
        if (!file.isFile()) continue
        const version = logVersion(file.name)
        if (version < 0) continue
        if (version > bestVersion) {
          bestVersion = version
          best = file.name
        }
      }
      if (best === null) continue

      const path = join(sessionPath, best)
      let stat
      try {
        stat = statSync(path)
      } catch {
        continue
      }

      out.push({
        sessionId: sessionEntry.name,
        cwdSlug: cwdEntry.name,
        path,
        version: bestVersion,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      })
    }
  }
  return out
}

/**
 * 解压一个多帧 zstd 缓冲区。
 *
 * 逐帧解压而不是一次性解压整文件：帧边界由魔数给出，但魔数也可能偶然出现在
 * 压缩数据内部，因此某段解压失败时向后寻找下一个魔数再试，而不是直接放弃。
 * 活跃会话的最后一帧可能写到一半，同样由这条路径兜住。
 *
 * @param buffer - 完整文件内容。
 * @returns 解压后的 UTF-8 文本，按帧顺序拼接。
 */
export function decompressFrames(buffer) {
  const offsets = []
  let index = buffer.indexOf(ZSTD_MAGIC, 0)
  while (index !== -1) {
    offsets.push(index)
    index = buffer.indexOf(ZSTD_MAGIC, index + ZSTD_MAGIC.length)
  }
  if (offsets.length === 0) return ''

  const parts = []
  let start = offsets[0]
  let cursor = 1

  while (start < buffer.length) {
    // 依次尝试 [start, end) 作为一帧；失败则把 end 推到下一个魔数。
    let end = cursor < offsets.length ? offsets[cursor] : buffer.length
    let text = null

    for (;;) {
      try {
        text = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
        break
      } catch {
        if (cursor >= offsets.length) break
        end = cursor + 1 < offsets.length ? offsets[cursor + 1] : buffer.length
        cursor += 1
      }
    }

    if (text === null) break
    parts.push(text)
    start = end
    cursor += 1
    if (cursor > offsets.length) break
  }

  return parts.join('')
}

/**
 * 解析一段 JSONL 文本。
 *
 * 无法解析的行（截断、损坏）被跳过：统计不该因为一行坏数据而整体失败。
 *
 * @param text - JSONL 文本。
 * @returns 解析成功的事件对象数组。
 */
export function parseJsonl(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 跳过坏行
    }
  }
  return events
}

/**
 * 读取并解析一个会话日志。
 *
 * @param path - 日志文件路径。
 * @returns 事件数组；读取失败时为空数组。
 */
export function readSessionEvents(path) {
  let buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return []
  }
  return parseJsonl(decompressFrames(buffer))
}

/**
 * 带 mtime + size 缓存的会话读取器。
 *
 * 一次全量扫描要解压数 MB 压缩数据；缓存让「未变化的会话」不再重复解压，
 * 于是反复查询的代价只与新增内容有关。
 */
export class SessionLogCache {
  /** @type {Map<string, { mtimeMs: number, size: number, events: unknown[] }>} */
  #cache = new Map()

  /**
   * 读取一个会话的事件，命中缓存时直接复用。
   *
   * @param entry - `listSessionLogs` 返回的一项。
   * @returns 事件数组。
   */
  read(entry) {
    const hit = this.#cache.get(entry.path)
    if (hit !== undefined && hit.mtimeMs === entry.mtimeMs && hit.size === entry.size) {
      return hit.events
    }
    const events = readSessionEvents(entry.path)
    this.#cache.set(entry.path, { mtimeMs: entry.mtimeMs, size: entry.size, events })
    return events
  }

  /**
   * 丢弃缓存中已不存在的会话，避免长期运行时无限增长。
   *
   * @param entries - 本次扫描到的会话列表。
   */
  prune(entries) {
    if (this.#cache.size <= entries.length) return
    const live = new Set(entries.map((entry) => entry.path))
    for (const key of this.#cache.keys()) {
      if (!live.has(key)) this.#cache.delete(key)
    }
  }

  /** 清空缓存。 */
  clear() {
    this.#cache.clear()
  }
}
