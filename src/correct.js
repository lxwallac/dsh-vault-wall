/**
 * 纠正（Correct）—— 文章 Harness 五要素的最后一格：
 * 「发现问题时自动修正或回退；在确认无法恢复之前不暴露中间状态」。
 *
 * 这里处理的是文章反复点到的一种具体失败：**Agent 撞墙后反复重试，耗尽迭代预算**。
 * 消融实验说「工具执行结果缺失会让 Agent 盲目执行，反复重试直到耗尽迭代预算」，
 * 思考题 4 直接问「除了工具结果缺失，还有哪些情况可能让 Agent 陷入这种循环？
 * 你会设计怎样的检测和终止机制？」——本模块就是那个检测与终止机制，专治一个情形：
 * 同一个 agent 反复去碰同一处受保护路径。
 *
 * 与官方 `dsh-repeat-tool-reminder` 的分工：那个 guard 针对**完全相同的工具调用**做
 * 通用循环提醒（建议式，不改判决）；本模块只盯**被这道墙拒绝过的路径**，而且会真的
 * 改变后续行为——升级为明确的停止指令，必要时熔断。两者互补，不重叠。
 *
 * 三个设计要点：
 *  1. **按 (agent, 规则, 路径) 计数**，不是按工具调用整体计数：换一条路径重新计数，
 *     免得把「agent 在正常探索若干不同位置」误判成循环。
 *  2. **提醒只在跨越阈值时出现**（默认第 3 次），前两次判决与 v0.3 完全一致——最小 diff。
 *  3. **计数在 post-execute 累加**：被拒绝的调用同样会经过 post-execute，
 *     因此一个计数器就能覆盖所有尝试，不需要跨事件状态（与官方 guard 同一取舍）。
 *
 * @module vault-wall/correct
 */

/** 默认阈值：同一个 (agent, 规则, 路径) 第 3 次被拒即升级。 */
export const DEFAULT_REPEAT_THRESHOLD = 3

/** 默认观察窗口：超过这个时间没有再次触碰，旧计数视为过期。 */
export const DEFAULT_REPEAT_WINDOW_MS = 5 * 60 * 1000

/** 计数表的默认容量上限（防止长时间运行时无界增长）。 */
export const DEFAULT_STREAK_CAP = 500

/** 计数键：规则 + 路径（都用不可见分隔符拼接，避免 `a|b` 与 `a` + `|b` 撞键）。 */
function streakKey({ ruleId, path }) {
  return `${ruleId ?? '-'}\u0000${path ?? '-'}`
}

/**
 * 按 agent 统计「同一处受保护路径被拒了几次」。
 * 时钟可注入，便于单测；表容量有上限，超限时淘汰最久未触碰的条目。
 */
export class DenialStreaks {
  /**
   * @param {object} [options]
   * @param {number} [options.threshold] 达到多少次（含）即升级；`0` 表示关闭
   * @param {number} [options.windowMs] 观察窗口
   * @param {number} [options.cap] 计数条目上限
   * @param {() => number} [options.now] 可注入时钟
   */
  constructor({ threshold = DEFAULT_REPEAT_THRESHOLD, windowMs = DEFAULT_REPEAT_WINDOW_MS, cap = DEFAULT_STREAK_CAP, now = () => Date.now() } = {}) {
    const t = Number(threshold)
    this.threshold = Number.isFinite(t) && t > 0 ? Math.floor(t) : 0
    const w = Number(windowMs)
    this.windowMs = Number.isFinite(w) && w > 0 ? w : DEFAULT_REPEAT_WINDOW_MS
    const c = Number(cap)
    this.cap = Number.isFinite(c) && c > 0 ? Math.floor(c) : DEFAULT_STREAK_CAP
    this.now = now
    /** @type {Map<string, Map<string, {count: number, lastTs: number, tool?: string, path?: string, ruleId?: string, escalated: boolean}>>} */
    this.byAgent = new Map()
    /** 当前条目总数（Map 的 size 之和；单独维护以免每次统计都遍历）。 */
    this.entries = 0
  }

  /** 内部：取某个 agent 的计数表（不存在则建）。 */
  _agentMap(agentKey) {
    let map = this.byAgent.get(agentKey)
    if (map === undefined) {
      map = new Map()
      this.byAgent.set(agentKey, map)
    }
    return map
  }

  /** 单条记录是否已过期（超过窗口）。 */
  _stale(record, now) {
    return now - record.lastTs > this.windowMs
  }

  /**
   * 记一次拒绝，并返回累加后的计数与是否升级。
   * @param {string} agentKey
   * @param {{tool?: string, path?: string, ruleId?: string, decision?: string}} info
   * @returns {{count: number, escalated: boolean, threshold: number, first: boolean}}
   */
  note(agentKey, info = {}) {
    const key = streakKey(info)
    const now = this.now()
    const map = this._agentMap(agentKey)
    let record = map.get(key)
    if (record !== undefined && this._stale(record, now)) {
      map.delete(key)
      this.entries -= 1
      record = undefined
    }
    if (record === undefined) {
      record = { count: 0, lastTs: now, escalated: false }
      map.set(key, record)
      this.entries += 1
      this._evictIfNeeded()
    }
    if (info.tool !== undefined) record.tool = String(info.tool)
    if (info.path !== undefined) record.path = String(info.path)
    if (info.ruleId !== undefined) record.ruleId = String(info.ruleId)
    const first = record.count === 0
    record.count += 1
    record.lastTs = now
    const escalated = this.threshold > 0 && record.count >= this.threshold
    if (escalated) record.escalated = true
    return { count: record.count, escalated, threshold: this.threshold, first }
  }

  /**
   * 只看「如果现在再拒一次会是多少次」，不写状态。
   * guard 在**拒绝之前**调用它：跨越阈值的那一次就能把纠正指令直接写进错误文案，
   * 而不是等 agent 再撞一次才收到。
   * @param {string} agentKey
   * @param {{path?: string, ruleId?: string}} info
   * @returns {{count: number, escalated: boolean, threshold: number}}
   */
  peek(agentKey, info = {}) {
    const map = this.byAgent.get(agentKey)
    const record = map === undefined ? undefined : map.get(streakKey(info))
    const now = this.now()
    const base = record === undefined || this._stale(record, now) ? 0 : record.count
    const count = base + 1
    return { count, escalated: this.threshold > 0 && count >= this.threshold, threshold: this.threshold }
  }

  /** 清零某个 agent 的全部计数（新用户消息 = 全新指令，不该被当成循环）。 */
  reset(agentKey) {
    const map = this.byAgent.get(agentKey)
    if (map === undefined) return 0
    const removed = map.size
    this.byAgent.delete(agentKey)
    this.entries -= removed
    return removed
  }

  /** 清掉全部过期条目（由定时器周期性调用）。 */
  sweep() {
    const now = this.now()
    for (const [agentKey, map] of [...this.byAgent]) {
      for (const [key, record] of [...map]) {
        if (this._stale(record, now)) {
          map.delete(key)
          this.entries -= 1
        }
      }
      if (map.size === 0) this.byAgent.delete(agentKey)
    }
  }

  /** 超限时淘汰最久未触碰的条目（保持表有界）。 */
  _evictIfNeeded() {
    if (this.entries <= this.cap) return
    let oldest = null
    for (const [agentKey, map] of this.byAgent) {
      for (const [key, record] of map) {
        if (oldest === null || record.lastTs < oldest.record.lastTs) oldest = { agentKey, key, record }
      }
    }
    if (oldest === null) return
    const map = this.byAgent.get(oldest.agentKey)
    map.delete(oldest.key)
    this.entries -= 1
    if (map.size === 0) this.byAgent.delete(oldest.agentKey)
  }

  /** 当前所有已升级（或已达阈值）的循环，最新在前 —— 供 `/wall report` 展示。 */
  list() {
    const rows = []
    for (const [agentKey, map] of this.byAgent) {
      for (const [, record] of map) {
        rows.push({ agentKey, ...record })
      }
    }
    return rows.sort((a, b) => b.lastTs - a.lastTs)
  }

  /** 已达升级阈值的循环数量。 */
  escalatedCount() {
    return this.list().filter((row) => row.escalated).length
  }
}

/**
 * 跨越阈值后追加到拒绝文案里的**纠正指令**。
 * 这是「纠正」最便宜也最有效的一次投放：错误结果本身就是模型下一次决策的输入，
 * 因此停止指令会精确地出现在它正要重试的那一刻，无需任何额外上下文通道。
 * @param {{tool?: string, path?: string, ruleId?: string, count: number, threshold: number}} info
 */
export function repeatNoticeText({ tool, path, ruleId, count, threshold }) {
  const target = path === undefined ? 'the protected location' : `"${path}"`
  const rule = ruleId === undefined ? '' : ` (rule "${ruleId}")`
  return [
    `[vault-wall] repeat denial #${count} for ${tool ?? 'this tool'} on ${target}${rule}: the denial is a policy decision, not a transient failure.`,
    `Repeating it will not change the outcome (threshold ${threshold}).`,
    'Stop retrying this path: either use a different, unprotected target, or stop and report to the user that this location is off-limits and ask how to proceed.',
  ].join(' ')
}

/**
 * 升级文案：post-execute 用它把该次调用的结果替换成纯纠正反馈（`{kind:'block', feedback}`）。
 * 比追加一行更强——模型看到的结果只剩这句指令，不会再从原始输出里找「也许下次能行」的线索。
 * @param {{tool?: string, path?: string, ruleId?: string, count: number, action?: 'notice'|'panic'}} info
 */
export function escalationFeedback({ tool, path, ruleId, count, action = 'notice' }) {
  const target = path === undefined ? 'a protected location' : `"${path}"`
  const rule = ruleId === undefined ? '' : ` (rule "${ruleId}")`
  const lines = [
    `[vault-wall] repeated attempts to reach ${target}${rule} using \`${tool ?? 'this tool'}\` were denied ${count} times.`,
    'This is an enforced boundary, not an intermittent error: further identical attempts cannot succeed.',
    'Do not call this path or tool combination again in this session.',
    'Instead: finish what you can without it, and tell the user that this location is off-limits so they can decide (they can grant access with the `/wall borrow` command, or change the rule in settings).',
  ]
  if (action === 'panic') {
    lines.push('The wall has also tripped its circuit breaker (panic mode): all path-bearing tool calls outside the allowlist are now denied until the user runs `/wall panic off`.')
  }
  return lines.join(' ')
}
