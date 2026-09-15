/**
 * 审批门（Ask Gate）—— 人在回路（Human in the loop）的纯逻辑层。
 *
 * 文章执行层护栏的核心要求：
 *  - 「高风险操作需额外审查或人工确认」，而且「这类复核必须由**上下文之外**的机制完成
 *    —— 独立的审查进程、最小权限凭证、沙盒隔离、人在回路 —— 否则它会和被注入的
 *    Agent 一起沦陷」。本模块对应的就是人在回路那一条：审批由**宿主**的审批通道
 *    （`ctx.approval`，弹在用户的 Web UI 上）执行，而不是问模型自己。
 *  - 「实施人工干预机制，可以让 Agent 在无法完成任务时平稳地移交控制权」；还有两种
 *    触发条件之一就是「高风险操作」。
 *  - 审批结果必须让模型能分辨三种「没通过」：「人说不」（rejected）、「没人可问」
 *    （unavailable）、「问了但被打断」（cancelled）。这三种文案不同，模型才能对用户
 *    说清楚发生了什么，而不是一律重试。
 *
 * 本模块只做三件不依赖宿主的事：文案、审批通过后该借出什么、以及一份**按调用对象**
 * 记录的审批台账（guard 阶段据此放行；因为 guard 是单调守卫，只能拒绝、不能放行，
 * 所以「问过人并且人说了可以」这件事必须先被记下来，guard 才敢放）。
 *
 * 台账用 WeakMap 以 exec 为键：审批门与 guard 拿到的是**同一个** exec 对象
 * （`dsh-tools` 的 `prepareExecution` 创建一次，随后依次经过 waterfall 与守卫），
 * 因此既不需要 callId 对齐，也不会留下跨会话残留。
 *
 * @module vault-wall/ask
 */

import { describeRisk } from './risk.js'

/** 审批通道可能的四种结果（与宿主 `ApprovalOutcome` 词表一致）。 */
export const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/**
 * 审批结果 → 本插件的处置类别。
 * 只有 `allowed-once` 是放行，其余三种一律拒绝（fail-closed）；
 * 但三种拒绝要能被区分，否则模型无法向用户解释。
 * @param {string} outcome
 * @returns {'granted'|'rejected'|'cancelled'|'unavailable'}
 */
export function approvalClass(outcome) {
  if (outcome === 'allowed-once') return 'granted'
  if (outcome === 'rejected') return 'rejected'
  if (outcome === 'cancelled') return 'cancelled'
  return 'unavailable'
}

/**
 * 送给审批通道的 `reason`（会原样显示在用户的审批弹窗里）。
 * 刻意写明路径、规则 id、工具与风险等级：审批是给人看的，人不该在信息不全时点「允许」。
 * @param {{tool: string, path: string, risk: string, entry?: {id?: string, note?: string}}} info
 */
export function askReason({ tool, path, risk, entry }) {
  const parts = [
    `[vault-wall] "${path}" 受规则保护`,
    entry?.id !== undefined ? `（规则 "${entry.id}"）` : '',
    `，agent 想用 \`${tool}\` 触碰它（风险：${risk}／${describeRisk(risk)}）。`,
    '允许这一次吗？',
  ]
  if (entry?.note) parts.push(`规则备注：${entry.note}`)
  // 说清「同意之后会记住多少」：借出只覆盖**这一条路径**（不是整棵树），
  // 否则人点「允许」时无从判断自己授权的范围，也找不到要整棵树时该用什么。
  if (entry?.remember === true) {
    const ttl = Number(entry.borrowTtlMs)
    if (Number.isFinite(ttl) && ttl > 0) {
      parts.push(`（同意后 ${Math.round(ttl / 1000)} 秒内不再询问这条路径，同目录其它文件仍会问；要授权整棵目录请用 /wall borrow add <目录>）`)
    } else {
      parts.push('（只授权这一次，不记借出）')
    }
  } else if (entry !== undefined && entry.remember === false) {
    parts.push('（这是 ask 规则的 remember=false：每次触碰都要单独确认）')
  }
  return parts.join('')
}

/**
 * 审批被拒（或通道缺席）后给模型的错误文案。三种情况分别说明，并明确**要求停止重试**
 * —— 这是「纠正」的一半：错误文案本身就是一次纠偏，而不是让模型在原地撞墙。
 * @param {'rejected'|'cancelled'|'unavailable'} cls
 * @param {{tool: string, path: string, entry?: {id?: string}}} info
 */
export function approvalDenialReason(cls, { tool, path, entry }) {
  const rule = entry?.id !== undefined ? ` (rule "${entry.id}")` : ''
  switch (cls) {
    case 'rejected':
      return `[vault-wall] the user rejected ${tool} access to "${path}"${rule}. The decision is final for this session step: do not retry this call. Report to the user that the request was denied and ask how they want to proceed.`
    case 'cancelled':
      return `[vault-wall] approval for ${tool} access to "${path}"${rule} was cancelled before a decision was made. Do not retry immediately; ask the user whether to try again.`
    default:
      return `[vault-wall] ${tool} access to "${path}"${rule} requires user approval, but no approval channel is available in this session, so it is denied. Do not retry: tell the user this action needs an interactive session (or a pre-granted borrow) instead.`
  }
}

/**
 * 「ask 规则但没走到审批门」时的拒绝文案（fail-closed 兜底）。
 * 触发条件是审批门没挂上、审批门内部出错、或调用方绕过了 pre-execute 阶段——
 * 三种都意味着没人问过，因此只能拒绝。
 * @param {{tool: string, path: string, entry?: {id?: string}}} info
 */
export function unapprovedDenialReason({ tool, path, entry }) {
  const rule = entry?.id !== undefined ? ` (rule "${entry.id}")` : ''
  return `[vault-wall] "${path}"${rule} is approval-gated: this call was never approved by the user, so it is denied.`
}

/**
 * 审批通过后应当借出的路径：规则里**实际命中**的那条路径（而不是整个规则的全部路径）。
 * 只借出命中项，是为了让「同意读这一个文件」不变成「同意这一整棵树」。
 * @param {{path?: string}} decision
 * @returns {string} 绝对路径；无命中路径时返回空串（调用方据此跳过借出）
 */
export function askBorrowPath(decision) {
  return typeof decision?.path === 'string' ? decision.path : ''
}

/**
 * 审批台账。WeakMap<exec, record>，仅存活于本次调用的生命周期。
 */
export class ApprovalLedger {
  constructor() {
    /** @type {WeakMap<object, {ruleIds: Set<string>, paths: string[], risk: string, ts: number}>} */
    this.records = new WeakMap()
  }

  /**
   * 记下「这一次调用、这些路径，用户已经同意」。
   * @param {object} exec
   * @param {{paths?: string[], ruleIds?: (string|undefined)[], risk?: string}} info
   */
  grant(exec, { paths = [], ruleIds = [], risk = 'unknown' } = {}) {
    if (exec === null || typeof exec !== 'object') return
    const record = {
      ruleIds: new Set(ruleIds.filter((id) => typeof id === 'string' && id !== '')),
      paths: paths.filter((p) => typeof p === 'string' && p !== ''),
      risk,
      ts: Date.now(),
    }
    this.records.set(exec, record)
  }

  /** 取这条调用的审批记录（没有则 undefined）。不删除：guard 之后可能还要给 verify 看。 */
  peek(exec) {
    if (exec === null || typeof exec !== 'object') return undefined
    return this.records.get(exec)
  }

  /**
   * guard 用：这次调用的这个路径是否已被用户同意。
   * 有记录即视为同意（审批门只会在 `allowed-once` 时写入）。
   */
  covers(exec, targetAbs) {
    const record = this.peek(exec)
    if (record === undefined) return false
    if (targetAbs === undefined || targetAbs === null || targetAbs === '') return true
    return record.paths.length === 0 || record.paths.includes(targetAbs)
  }
}
