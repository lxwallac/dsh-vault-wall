/**
 * 墙决策核心 —— 纯函数、零 cordis 依赖，可整链路单测。
 *
 * `decideWall(exec, state)` 复刻 guard 的完整判定：
 *   路径参数命中隔离规则 → 按规则 mode 给出 hidden / deny / ask / 借出放行；
 *   命令文本启发式命中保护根 → 同上；
 *   panic 开启 → 一切落在 allowRoots 之外的路径型参数 / 命令绝对 token 被拒。
 * 未知工具与无命中 → allow。
 *
 * v0.4 新增两种决策与两个开关：
 *  - `ask`：规则 `mode: "ask"` 命中，且这次调用**还没被用户同意**——交给审批门处置。
 *    本函数给出的 `reason` 就是「没人问过」时的 fail-closed 拒绝文案，因此任何只读 `reason`
 *    的调用方都会自动得到正确行为；审批门则抢在 guard 之前跑完审批并把同意记进台账。
 *  - `ask-approved`：审批台账里已有这次调用、这个路径的同意记录 → 放行。
 *  - `state.dryRun`：试算模式，不消耗 `once` 借出、不产生任何副作用。审批门、verify 阶段
 *    与 `/wall test` 都用它，保证「同一次调用只消耗一次借出」。
 *  - `state.approved`：审批台账（`ApprovalLedger`），缺席即视为「没问过」。
 *
 * 另有风险门槛：`mode: "ask"` 的规则可写 `minRisk`，低于门槛的风险等级直接放行不问人
 * ——这就是文章里「同一个工具在特定参数组合下变高风险」的动态风险评估落点。
 *
 * 副作用仅一处：`state.borrow.allow(...)`（消耗 once 借出），由调用方注入；
 * `state.borrow` 缺席时无副作用（试算用 `probeWall`，见文件末尾）。
 */

import { classifyToolArgs, absolutePathTokens } from './classify.js'
import { textMentions, normalizeAbs, insideOrEqual, ci } from './rules.js'
import { toolRisk, atLeastRisk } from './risk.js'
import { askReason, unapprovedDenialReason } from './ask.js'

/** 天然递归聚合、会穿透目标目录子树读取内容的工具族（path 参数为目标目录）。 */
const RECURSIVE_TOOLS = new Set(['glob', 'grep'])
/** 命令文本里的递归/聚合启发式标记（anti-accident，非 anti-adversary）。 */
const RECURSION_HINT = /(^|[\s;|&(])(-r|-R|--recursive|-recurse|\/s|\/S|\/r|\/R)(\s|$|["'])|(^|[\s;|&])rg(\s|$)/i

/**
 * 目标目录之下是否藏着受保护根（严格位于其内）。用于阻断“祖先路径 + 递归聚合”
 * 穿透：grep/glob 指向保护区祖先目录时会递归扫进保护区把内容读出来。
 * @returns {boolean}
 */
export function protectedRootUnder(engine, dirAbs) {
  const d = normalizeAbs(dirAbs)
  if (d === '') return false
  for (const entry of engine.entries) {
    for (const raw of entry.textRoots()) {
      const root = normalizeAbs(raw)
      if (root === '') continue
      // root 严格位于 d 之下才构成“递归会扫到保护区”；root === d 由 matchPath 分支处理。
      if (ci(root) !== ci(d) && insideOrEqual(d, root)) return true
    }
  }
  return false
}

/** 第一条“管辖该工具”的命中规则；规则级 tools 白名单过滤。 */
export function governingEntry(engine, toolName, targetAbs) {
  for (const entry of engine.entries) {
    if (entry.toolSet !== undefined && !entry.toolSet.has(toolName)) continue
    if (entry.match(targetAbs)) return entry
  }
  return null
}

/** 命令文本启发式：第一条“管辖该工具”且文本提到其保护根的规则。 */
export function firstTextHit(engine, toolName, text) {
  for (const entry of engine.entries) {
    if (entry.toolSet !== undefined && !entry.toolSet.has(toolName)) continue
    for (const root of entry.textRoots()) {
      if (textMentions(text, root)) return { entry, root }
    }
  }
  return null
}

/** 与官方 fs 工具错误同风格的“不存在”伪装文案（hidden 模式）。 */
export function hiddenReason(toolName, p) {
  switch (toolName) {
    case 'read':
    case 'read_image':
      return `cannot read "${p}": not found`
    case 'write':
      return `cannot write "${p}": directory does not exist`
    case 'edit':
    case 'str_replace_editor':
      return `cannot edit "${p}": not found`
    case 'glob':
      return `no files matched under "${p}": path does not exist`
    case 'grep':
      return `cannot search "${p}": path does not exist`
    default:
      return `cannot access "${p}": No such file or directory`
  }
}

/** 规则级决策文案：deny 模式直接说明被哪条规则拦（此时不再伪装）。 */
export function denialReason(toolName, p, entry) {
  if (entry !== null && entry !== undefined && entry.mode === 'deny') {
    return `[vault-wall] access to "${p}" is denied by rule "${entry.id}"`
  }
  return hiddenReason(toolName, p)
}

/** 表示「墙拒绝了这个调用」的决策集合。 */
export const DENIAL_DECISIONS = new Set(['hidden-deny', 'deny', 'ask', 'panic-deny'])

/** 该决策是否属于拒绝（`ask` 也算：没人问过就是拒）。 */
export function isWallDenial(decision) {
  return DENIAL_DECISIONS.has(String(decision))
}

/** 该决策是否属于「经授权放行」（借出或审批通过）——授权范围内的可见性不算泄漏。 */
export function isAuthorizedDecision(decision) {
  const value = String(decision)
  return value === 'borrow-allow' || value === 'ask-approved'
}

/**
 * 一条命中规则对一个工具的处置：`hidden-deny` / `deny` / `ask` / `allow`。
 * 最后一种来自 ask 规则的风险门槛：工具风险低于 `minRisk` 时不值得打扰用户，直接放行。
 * @param {{mode: string, minRisk?: string, id: string, note?: string}} entry
 * @param {string} toolName
 * @returns {'hidden-deny'|'deny'|'ask'|'allow'}
 */
export function entryDisposition(entry, toolName) {
  if (entry.mode === 'ask') {
    return atLeastRisk(toolRisk(toolName), entry.minRisk ?? 'low') ? 'ask' : 'allow'
  }
  return entry.mode === 'deny' ? 'deny' : 'hidden-deny'
}

/**
 * 借出放行查询：`state.borrow` 允许缺席（试算路径不注入借出存储）。
 * 缺席时一律视为“没有借出”，且不产生任何副作用。
 * `state.dryRun` 时按试算模式查询：读得到结果，但不消耗 `once`。
 */
function borrowAllow(state, agent, targetAbs, toolName) {
  const store = state.borrow
  if (store === undefined || store === null) return false
  return store.allow(agent, targetAbs, toolName, { consume: state.dryRun !== true })
}

/** 审批台账查询：`state.approved` 缺席即视为“没问过”。 */
function approvedAllow(state, exec, targetAbs) {
  const ledger = state.approved
  if (ledger === undefined || ledger === null || typeof ledger.covers !== 'function') return false
  return ledger.covers(exec, targetAbs)
}

/**
 * 命中之后的完整处置（路径族与文本族共用）：
 * 借出 → 审批已同意 → 规则处置（hidden/deny/ask/低风险放行）。
 * @returns {{decision: string, reason?: string}}
 */
function resolveHit(state, exec, toolName, targetAbs, entry) {
  if (borrowAllow(state, exec.agent, targetAbs, toolName)) return { decision: 'borrow-allow' }
  if (approvedAllow(state, exec, targetAbs)) return { decision: 'ask-approved' }
  const disposition = entryDisposition(entry, toolName)
  if (disposition === 'allow') return { decision: 'allow' }
  if (disposition === 'ask') {
    // reason 是「没人问过」时的 fail-closed 拒绝文案；审批门会抢在 guard 之前把同意记进台账。
    return { decision: 'ask', reason: unapprovedDenialReason({ tool: toolName, path: targetAbs, entry }) }
  }
  return { decision: disposition, reason: denialReason(toolName, targetAbs, entry) }
}

/** 审批弹窗文案（供审批门调用，集中在这里免得两处文案漂移）。 */
export function askPromptReason(toolName, targetAbs, entry) {
  return askReason({ tool: toolName, path: targetAbs, risk: toolRisk(toolName), entry })
}

/** 规范化 panic 白名单（只保留绝对路径）。 */
export function compileAllowRoots(list) {
  return (list ?? []).map(normalizeAbs).filter(Boolean)
}

/** panic 检查：返回 { path, reason } 或 undefined（全部在可见根内）。 */
function panicDenial(exec, allowRoots) {
  const covered = (abs) => allowRoots.some((root) => insideOrEqual(root, abs))
  for (const candidate of classifyToolArgs(exec)) {
    if (candidate.kind === 'path') {
      if (!covered(candidate.path)) {
        return { path: candidate.path, reason: `[vault-wall] panic: "${candidate.path}" is outside the allowed roots` }
      }
    } else {
      for (const token of absolutePathTokens(candidate.text)) {
        const abs = normalizeAbs(token)
        if (abs === '') continue
        if (!covered(abs)) {
          return { path: abs, reason: `[vault-wall] panic: command references "${abs}" outside the allowed roots` }
        }
      }
    }
  }
  return undefined
}

/**
 * 一次工具调用的完整墙决策。
 * @param {{ name: string, arguments: unknown, agent?: object }} exec
 * @param {{ engine: import('./rules.js').RulesEngine | null, panic: boolean, allowRoots: string[],
 *   borrow?: import('./borrow.js').BorrowStore | null, approved?: import('./ask.js').ApprovalLedger | null,
 *   dryRun?: boolean }} state
 *   `borrow` 可缺席：缺席即视为“没有借出”，且不会消耗 `once` 借出。
 *   `approved` 可缺席：缺席即视为“没问过”，ask 规则一律 fail-closed。
 *   `dryRun`：试算，不产生任何副作用（审批门 / verify / `/wall test` 用）。
 * @returns {{ decision: 'allow'|'hidden-deny'|'deny'|'ask'|'ask-approved'|'borrow-allow'|'panic-deny', tool: string, path?: string, ruleId?: string, reason?: string }}
 */
export function decideWall(exec, state) {
  const tool = String(exec.name ?? '?')
  if (state.panic) {
    const denial = panicDenial(exec, state.allowRoots)
    if (denial !== undefined) return { decision: 'panic-deny', tool, ...denial }
    return { decision: 'allow', tool }
  }
  const engine = state.engine
  if (engine === null) return { decision: 'allow', tool }

  for (const candidate of classifyToolArgs(exec)) {
    if (candidate.kind === 'path') {
      const entry = governingEntry(engine, tool, candidate.path)
      if (entry === null) {
        // 递归聚合工具指向“保护区祖先目录”：不拦则工具会扫进保护区读取内容。
        if (RECURSIVE_TOOLS.has(tool)) {
          const ancestor = normalizeAbs(candidate.path)
          if (ancestor !== '' && protectedRootUnder(engine, ancestor)) {
            if (borrowAllow(state, exec.agent, ancestor, tool)) {
              return { decision: 'borrow-allow', tool, path: ancestor }
            }
            return { decision: 'hidden-deny', tool, path: ancestor, reason: hiddenReason(tool, ancestor) }
          }
        }
        continue
      }
      const resolution = resolveHit(state, exec, tool, candidate.path, entry)
      if (resolution.decision === 'borrow-allow') return { decision: 'borrow-allow', tool, path: candidate.path, ruleId: entry.id }
      if (resolution.decision === 'ask-approved') return { decision: 'ask-approved', tool, path: candidate.path, ruleId: entry.id }
      return {
        decision: resolution.decision,
        tool,
        path: candidate.path,
        ruleId: entry.id,
        reason: resolution.reason,
      }
    } else {
      const hit = firstTextHit(engine, tool, candidate.text)
      if (hit !== null) {
        const resolution = resolveHit(state, exec, tool, hit.root, hit.entry)
        if (resolution.decision === 'borrow-allow') return { decision: 'borrow-allow', tool, path: hit.root, ruleId: hit.entry.id }
        if (resolution.decision === 'ask-approved') return { decision: 'ask-approved', tool, path: hit.root, ruleId: hit.entry.id }
        return {
          decision: resolution.decision,
          tool,
          path: hit.root,
          ruleId: hit.entry.id,
          reason: resolution.reason,
        }
      }
      // 命令带递归标记且提到保护区祖先目录：不拦则递归列举/读取会穿透保护区。
      if (RECURSION_HINT.test(candidate.text)) {
        for (const token of absolutePathTokens(candidate.text)) {
          const ancestor = normalizeAbs(token)
          if (ancestor === '') continue
          if (protectedRootUnder(engine, ancestor)) {
            if (borrowAllow(state, exec.agent, ancestor, tool)) {
              return { decision: 'borrow-allow', tool, path: ancestor }
            }
            return { decision: 'hidden-deny', tool, path: ancestor, reason: hiddenReason(tool, ancestor) }
          }
        }
      }
    }
  }
  return { decision: 'allow', tool }
}

/**
 * 试算决策（v0.3 新增）：与 {@link decideWall} 同一条判定逻辑，但**永不消费借出**——
 * 显式清掉 `borrow`，因此「如果现在有个新 agent 来碰这个路径，墙会怎么判」可以安全地问出来。
 * 供 `/wall test` 命令（以及任何只想预览、不想改变状态的调用方）使用。
 * @param {{ name: string, arguments: unknown, agent?: object }} exec
 * @param {{ engine: import('./rules.js').RulesEngine | null, panic: boolean, allowRoots: string[] }} state
 */
export function probeWall(exec, state) {
  return decideWall(exec, { ...state, borrow: null, approved: null, dryRun: true })
}
