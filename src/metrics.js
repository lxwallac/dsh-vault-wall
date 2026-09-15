/**
 * 护栏指标（Metrics）—— 文章「护栏评估」那一段的事实基础：
 *
 *   「护栏评估不能只测试『应当拒绝的请求是否被拦截』，还要测试『明确允许的请求是否能
 *     够正常完成』。」而且「护栏也存在另一类失败：**误拒绝**」。
 *
 * 审计环形缓冲（`audit.js`）只保留最近 N 条**明细**，适合「刚刚发生了什么」；本模块
 * 保留**累计计数**，适合回答「这道墙整体上是在帮忙还是在添乱」。两者用途不同，都在。
 *
 * 刻意只累计计数、不累计文本：内存有界且不随运行时长增长（键数量另有上限），
 * 也不把路径明细摊在内存里——明细仍然只进审计。
 *
 * `/wall report` 用这些计数算出：
 *  - 判决分布（拦截率）；
 *  - **从未命中过的规则**（很可能是写错了、写宽了，或路径已经不存在）；
 *  - **疑似误拒绝**（同一条规则同一个路径被反复拒绝 → 多半是 agent 想做一件本该允许的事）；
 *  - 审批结果分布（`unavailable` 占比高 = 没有审批通道，ask 规则退化成硬拒绝）；
 *  - verify 计数（bypass/leak 只要不为 0 就是墙自己的 bug，必须处理）。
 *
 * @module vault-wall/metrics
 */

/** 需要单独计数的决策种类（与 wall-core 的决策词表一致，另加审计类事件）。 */
export const DECISION_KINDS = [
  'allow',
  'hidden-deny',
  'deny',
  'ask',
  'ask-approved',
  'borrow-allow',
  'panic-deny',
  'verify-bypass',
  'verify-leak',
  'repeat-escalation',
  'internal-error',
]

/** 键数量上限：超出后并入 `(other)`，保证内存有界。 */
export const DEFAULT_KEY_CAP = 400

/** 空计数器。 */
function emptyCounter() {
  return { total: 0, denied: 0, allowed: 0, asked: 0 }
}

export class Metrics {
  /**
   * @param {object} [options]
   * @param {number} [options.keyCap] 工具名/规则 id 的键数量上限
   * @param {() => number} [options.now] 可注入时钟
   */
  constructor({ keyCap = DEFAULT_KEY_CAP, now = () => Date.now() } = {}) {
    const cap = Number(keyCap)
    this.keyCap = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_KEY_CAP
    this.now = now
    this.total = 0
    this.byDecision = Object.fromEntries(DECISION_KINDS.map((kind) => [kind, 0]))
    this.byTool = new Map()
    this.byRule = new Map()
    this.approvals = { asked: 0, granted: 0, rejected: 0, cancelled: 0, unavailable: 0 }
    this.verify = { bypass: 0, leak: 0, leakRedacted: 0, leakBlocked: 0 }
    this.agents = 0
    this.firstTs = 0
    this.lastTs = 0
  }

  /** 取（或新建）一个受容量约束的计数桶。 */
  _bucket(map, key) {
    const name = String(key ?? '')
    if (name === '') return undefined
    let bucket = map.get(name)
    if (bucket !== undefined) return bucket
    if (map.size >= this.keyCap) {
      bucket = map.get('(other)')
      if (bucket === undefined) {
        bucket = emptyCounter()
        map.set('(other)', bucket)
      }
      return bucket
    }
    bucket = emptyCounter()
    map.set(name, bucket)
    return bucket
  }

  /**
   * 记一次工具调用的墙决策（guard / 审批门调用）。
   * @param {{tool?: string, decision?: string, ruleId?: string, risk?: string, agentLabel?: string}} entry
   */
  record(entry = {}) {
    const decision = String(entry.decision ?? 'allow')
    const ts = this.now()
    this.total += 1
    if (this.firstTs === 0) this.firstTs = ts
    this.lastTs = ts
    if (this.byDecision[decision] === undefined) this.byDecision[decision] = 0
    this.byDecision[decision] += 1

    const denied = decision === 'hidden-deny' || decision === 'deny' || decision === 'ask' || decision === 'panic-deny'
    const asked = decision === 'ask'
    const toolBucket = this._bucket(this.byTool, entry.tool)
    if (toolBucket !== undefined) {
      toolBucket.total += 1
      if (denied) toolBucket.denied += 1
      else toolBucket.allowed += 1
      if (asked) toolBucket.asked += 1
    }
    const ruleBucket = this._bucket(this.byRule, entry.ruleId)
    if (ruleBucket !== undefined) {
      ruleBucket.total += 1
      if (denied) ruleBucket.denied += 1
      else ruleBucket.allowed += 1
      if (asked) ruleBucket.asked += 1
    }
    return decision
  }

  /** 记一次审批通道结果（审批门调用）。 */
  recordApproval(cls) {
    this.approvals.asked += 1
    if (this.approvals[cls] !== undefined) this.approvals[cls] += 1
  }

  /**
   * 记一次验证发现（post-execute 调用）。
   * @param {'bypass'|'leak'} kind
   * @param {{redacted?: boolean, blocked?: boolean}} [options]
   */
  recordVerify(kind, { redacted = false, blocked = false } = {}) {
    if (kind === 'bypass') this.verify.bypass += 1
    else if (kind === 'leak') {
      this.verify.leak += 1
      if (redacted) this.verify.leakRedacted += 1
      if (blocked) this.verify.leakBlocked += 1
    }
  }

  /** 记一次重复触墙升级。 */
  recordEscalation() {
    this.byDecision['repeat-escalation'] = (this.byDecision['repeat-escalation'] ?? 0) + 1
  }

  /** 见过多少个不同的 agent（粗粒度：用于判断计数是否被多 agent 摊薄）。 */
  noteAgent(agentLabel) {
    if (typeof agentLabel !== 'string' || agentLabel === '') return
    if (this._agentSet === undefined) this._agentSet = new Set()
    this._agentSet.add(agentLabel)
    this.agents = this._agentSet.size
  }

  /** 按拦截次数排序的规则命中榜（含从未命中的规则所需的全集在 report 里补齐）。 */
  ruleHits() {
    return [...this.byRule.entries()]
      .map(([ruleId, counter]) => ({ ruleId, ...counter }))
      .sort((a, b) => b.denied - a.denied || b.total - a.total)
  }

  /** 按调用次数排序的工具榜。 */
  toolHits() {
    return [...this.byTool.entries()]
      .map(([tool, counter]) => ({ tool, ...counter }))
      .sort((a, b) => b.total - a.total)
  }

  /** 拦截总数（所有拒绝类决策之和）。 */
  deniedTotal() {
    return (this.byDecision['hidden-deny'] ?? 0) + (this.byDecision.deny ?? 0) + (this.byDecision.ask ?? 0) + (this.byDecision['panic-deny'] ?? 0)
  }

  /** 放行总数（含借出放行与审批放行）。 */
  allowedTotal() {
    return (this.byDecision.allow ?? 0) + (this.byDecision['borrow-allow'] ?? 0) + (this.byDecision['ask-approved'] ?? 0)
  }

  /** 可序列化快照（供 `/wall report` 与测试断言）。 */
  snapshot() {
    return {
      total: this.total,
      byDecision: { ...this.byDecision },
      byTool: this.toolHits(),
      byRule: this.ruleHits(),
      approvals: { ...this.approvals },
      verify: { ...this.verify },
      agents: this.agents,
      firstTs: this.firstTs,
      lastTs: this.lastTs,
    }
  }
}
