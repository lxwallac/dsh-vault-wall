/**
 * 墙决策核心 —— 纯函数、零 cordis 依赖，可整链路单测。
 *
 * `decideWall(exec, state)` 复刻 guard 的完整判定：
 *   路径参数命中隔离规则 → hidden/deny 拒绝或借出放行；
 *   命令文本启发式命中保护根 → 同上；
 *   panic 开启 → 一切落在 allowRoots 之外的路径型参数 / 命令绝对 token 被拒。
 * 未知工具与无命中 → allow。
 *
 * 副作用仅一处：`state.borrow.allow(...)`（消耗 once 借出），由调用方注入。
 */

import { classifyToolArgs, absolutePathTokens } from './classify.js'
import { textMentions, normalizeAbs, insideOrEqual, ci } from './rules.js'

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
 * @param {{ engine: import('./rules.js').RulesEngine | null, panic: boolean, allowRoots: string[], borrow: import('./borrow.js').BorrowStore }} state
 * @returns {{ decision: 'allow'|'hidden-deny'|'deny'|'borrow-allow'|'panic-deny', tool: string, path?: string, ruleId?: string, reason?: string }}
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
            if (state.borrow.allow(exec.agent, ancestor, tool)) {
              return { decision: 'borrow-allow', tool, path: ancestor }
            }
            return { decision: 'hidden-deny', tool, path: ancestor, reason: hiddenReason(tool, ancestor) }
          }
        }
        continue
      }
      if (state.borrow.allow(exec.agent, candidate.path, tool)) {
        return { decision: 'borrow-allow', tool, path: candidate.path, ruleId: entry.id }
      }
      return {
        decision: entry.mode === 'deny' ? 'deny' : 'hidden-deny',
        tool,
        path: candidate.path,
        ruleId: entry.id,
        reason: denialReason(tool, candidate.path, entry),
      }
    } else {
      const hit = firstTextHit(engine, tool, candidate.text)
      if (hit !== null) {
        if (state.borrow.allow(exec.agent, hit.root, tool)) {
          return { decision: 'borrow-allow', tool, path: hit.root, ruleId: hit.entry.id }
        }
        return {
          decision: hit.entry.mode === 'deny' ? 'deny' : 'hidden-deny',
          tool,
          path: hit.root,
          ruleId: hit.entry.id,
          reason: denialReason(tool, hit.root, hit.entry),
        }
      }
      // 命令带递归标记且提到保护区祖先目录：不拦则递归列举/读取会穿透保护区。
      if (RECURSION_HINT.test(candidate.text)) {
        for (const token of absolutePathTokens(candidate.text)) {
          const ancestor = normalizeAbs(token)
          if (ancestor === '') continue
          if (protectedRootUnder(engine, ancestor)) {
            if (state.borrow.allow(exec.agent, ancestor, tool)) {
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
