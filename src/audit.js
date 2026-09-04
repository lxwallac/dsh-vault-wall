/**
 * 触碰审计 —— 进程内有界环形缓冲 + 可选 JSONL 落盘（用户数据目录，非会话日志）。
 *
 * 记录每一次“墙决策”：命中隔离路径被伪装拒绝、明确拒绝、panic 拒绝，或借出放行。
 *
 * v1 落盘语义：默认关闭；开启（config.auditFile）时每条记录同步追加为一行 JSON，
 * 文件与规则文件同级别（默认建议 ~/.dsh/vault-wall-audit.jsonl），**必须位于 DSH
 * 工作区之外**，避免 agent 自读自改审计。
 *
 * 为什么不做 DSH 会话日志事件：SessionEventMap 是类型化封闭事件表，第三方直接
 * append 未知事件会破坏会话日志不变式（官方 invariant 会拒绝），需要走官方事件词汇
 * 扩展（路线图 v0.3）。v1 用用户目录 JSONL 提供同等的“持久、可事后审计”能力。
 */

import fs from 'node:fs'

export class AuditRing {
  /**
   * @param {number} [cap]
   * @param {string} [filePath] - 开启后每条记录同步 append JSONL；留空则仅内存。
   */
  constructor(cap = 500, filePath = '') {
    const parsed = Number.parseInt(String(cap), 10)
    this.cap = Number.isFinite(parsed) ? Math.min(10_000, Math.max(1, parsed)) : 500
    this.filePath = typeof filePath === 'string' && filePath.length > 0 ? filePath : ''
    this.items = []
    this._writeWarned = false
  }

  /** 追加一条决策记录；超上限丢弃最旧；开启落盘时同步写一行 JSON。 */
  push(entry) {
    const record = {
      ts: Date.now(),
      tool: String(entry.tool ?? '?'),
      decision: String(entry.decision ?? 'allow'),
      ...(entry.agentLabel !== undefined ? { agentLabel: entry.agentLabel } : {}),
      ...(entry.path !== undefined ? { path: entry.path } : {}),
      ...(entry.ruleId !== undefined ? { ruleId: entry.ruleId } : {}),
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    }
    this.items.push(record)
    if (this.items.length > this.cap) {
      this.items.splice(0, this.items.length - this.cap)
    }
    if (this.filePath !== '') {
      try {
        fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8')
      } catch (error) {
        if (!this._writeWarned) {
          this._writeWarned = true
          console.warn(`[dsh-vault-wall] audit file write failed (further failures silenced): ${error.message}`)
        }
      }
    }
    return record
  }

  /** 最新的在前。 */
  list() {
    return [...this.items].reverse()
  }
}
