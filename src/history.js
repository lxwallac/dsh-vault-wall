/**
 * 规则修订历史（快照 / 回滚）—— 文章设计模式里的**最小 diff + 可回滚**：
 * 「每次修改尽量小、带来源、可单独回滚，而不是整体重写。它让归因成为可能——
 *   出了问题能定位到具体哪一次改动。」
 *
 * 这道墙的规则本身就是「外部产物」形态的约束（文章：把确定性流程与约束写成程序和
 * Harness，这些产物可审计、可修订）。改错一条规则会让 agent 直接失去（或意外获得）
 * 一片文件系统的可见性，所以「改回去」必须是随手可做的一步，而不是靠记忆重打一遍。
 *
 * 语义：
 *  - 每次**成功应用**一份规则就记一条修订（内容与上一条相同则不记，避免灌水）；
 *  - 内存里保留最近 `limit` 条；配置了文件时同步落盘（JSON，含全文）；
 *  - 回滚 = 把某条修订的全文重新应用一次 **并记为新修订**（只增不改：历史永不回头改写，
 *    这样「什么时候回滚过」本身就留在历史里）。
 *
 * 文件读写通过注入的函数完成，因此本模块不依赖 fs、可直接单测。
 *
 * @module vault-wall/history
 */

export const HISTORY_VERSION = 1

/** 默认保留的修订条数。 */
export const DEFAULT_HISTORY_LIMIT = 20

/**
 * FNV-1a 32 位哈希（十六进制）——只用来做「内容是否相同」的快速判定与人类可读短标识，
 * 不是密码学摘要。规则文本不含机密，用不到 SHA。
 * @param {string} text
 * @returns {string}
 */
export function shortHash(text) {
  let hash = 0x811c9dc5
  const value = String(text ?? '')
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export class RuleHistory {
  /**
   * @param {object} [options]
   * @param {number} [options.limit] 内存中保留的修订条数
   * @param {() => number} [options.now] 可注入时钟
   */
  constructor({ limit = DEFAULT_HISTORY_LIMIT, now = () => Date.now() } = {}) {
    const parsed = Number(limit)
    this.limit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_HISTORY_LIMIT
    this.now = now
    /** @type {Array<{id: string, ts: number, source: string, note?: string, hash: string, bytes: number, text: string}>} */
    this.revisions = []
    this.seq = 0
  }

  /** 最新一条修订（没有则 null）。 */
  latest() {
    return this.revisions.length === 0 ? null : this.revisions[this.revisions.length - 1]
  }

  /**
   * 记一条修订。
   * @param {string} text 规则文档全文
   * @param {{source?: string, note?: string}} [meta]
   * @returns {{recorded: boolean, revision: object | null}}
   */
  record(text, { source = 'unknown', note } = {}) {
    const value = String(text ?? '')
    const current = this.latest()
    if (current !== null && current.text === value) return { recorded: false, revision: current }
    this.seq += 1
    const revision = {
      id: `r${this.seq}`,
      ts: this.now(),
      source: String(source),
      ...(typeof note === 'string' && note !== '' ? { note } : {}),
      hash: shortHash(value),
      bytes: Buffer.byteLength(value, 'utf8'),
      text: value,
    }
    this.revisions.push(revision)
    if (this.revisions.length > this.limit) this.revisions.splice(0, this.revisions.length - this.limit)
    return { recorded: true, revision }
  }

  /**
   * 修订清单（最新在前），**不含全文**（`/wall history` 不该把规则正文刷屏）。
   * @returns {Array<{id: string, ts: number, source: string, note?: string, hash: string, bytes: number, current: boolean}>}
   */
  list() {
    const latest = this.latest()
    return [...this.revisions].reverse().map((revision) => ({
      id: revision.id,
      ts: revision.ts,
      source: revision.source,
      ...(revision.note !== undefined ? { note: revision.note } : {}),
      hash: revision.hash,
      bytes: revision.bytes,
      current: latest !== null && revision.id === latest.id,
    }))
  }

  /**
   * 按标识取一条修订（含全文）。
   * `'last'` / `'current'` → 最新；`'prev'` → 上一条；其余按 id 精确匹配。
   * @param {string} selector
   * @returns {object | null}
   */
  get(selector) {
    const key = String(selector ?? '').trim()
    if (key === '' || key === 'last' || key === 'current') return this.latest()
    if (key === 'prev' || key === 'previous') {
      return this.revisions.length < 2 ? null : this.revisions[this.revisions.length - 2]
    }
    return this.revisions.find((revision) => revision.id === key) ?? null
  }

  /** 当前生效文本（最新修订的全文；没有修订则为空串）。 */
  currentText() {
    const latest = this.latest()
    return latest === null ? '' : latest.text
  }

  get size() {
    return this.revisions.length
  }

  /** 可序列化文档。 */
  toJSON() {
    return { version: HISTORY_VERSION, revisions: this.revisions.map((revision) => ({ ...revision })) }
  }

  /**
   * 从已解析的文档恢复。
   * @param {unknown} doc
   * @returns {boolean} 是否成功恢复
   */
  fromJSON(doc) {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return false
    if (doc.version !== HISTORY_VERSION) return false
    if (!Array.isArray(doc.revisions)) return false
    const restored = []
    let maxSeq = 0
    for (const raw of doc.revisions) {
      if (raw === null || typeof raw !== 'object') continue
      if (typeof raw.text !== 'string') continue
      const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `r${restored.length + 1}`
      const numeric = Number.parseInt(id.replace(/^r/, ''), 10)
      if (Number.isFinite(numeric) && numeric > maxSeq) maxSeq = numeric
      restored.push({
        id,
        ts: Number.isFinite(raw.ts) ? Number(raw.ts) : 0,
        source: typeof raw.source === 'string' ? raw.source : 'restored',
        ...(typeof raw.note === 'string' && raw.note !== '' ? { note: raw.note } : {}),
        hash: typeof raw.hash === 'string' && raw.hash !== '' ? raw.hash : shortHash(raw.text),
        bytes: Number.isFinite(raw.bytes) ? Number(raw.bytes) : Buffer.byteLength(raw.text, 'utf8'),
        text: raw.text,
      })
    }
    this.revisions = restored.slice(-this.limit)
    this.seq = maxSeq
    return true
  }

  /**
   * 从磁盘读入（注入的读函数；文件不存在视为空历史，不算错误）。
   * @param {string} filePath
   * @param {(file: string) => string} readFile
   * @returns {{loaded: boolean, error: string}}
   */
  load(filePath, readFile) {
    if (typeof readFile !== 'function' || typeof filePath !== 'string' || filePath === '') {
      return { loaded: false, error: '' }
    }
    let raw
    try {
      raw = readFile(filePath)
    } catch (error) {
      if (error?.code === 'ENOENT') return { loaded: false, error: '' }
      return { loaded: false, error: String(error?.message ?? error) }
    }
    try {
      return this.fromJSON(JSON.parse(raw)) ? { loaded: true, error: '' } : { loaded: false, error: 'unsupported history document' }
    } catch (error) {
      return { loaded: false, error: `history file is not valid JSON: ${String(error?.message ?? error)}` }
    }
  }

  /**
   * 落盘（注入的写函数）。写失败只报错、不抛——历史是辅助设施，不该拖垮墙本身。
   * @param {string} filePath
   * @param {(file: string, text: string) => void} writeFile
   * @returns {{written: boolean, error: string}}
   */
  persist(filePath, writeFile) {
    if (typeof writeFile !== 'function' || typeof filePath !== 'string' || filePath === '') {
      return { written: false, error: '' }
    }
    try {
      writeFile(filePath, `${JSON.stringify(this.toJSON(), null, 2)}\n`)
      return { written: true, error: '' }
    } catch (error) {
      return { written: false, error: String(error?.message ?? error) }
    }
  }
}
