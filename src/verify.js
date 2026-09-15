/**
 * 执行后验证（Verify）—— 文章 Harness 五要素里的**验证**那一格：
 * 「自动判断操作结果的对错；安全检查只看结构化数据（如工具返回的 JSON 字段），
 *   而不看模型自由生成的文本，因为后者可能已被提示注入操纵」。
 *
 * 本模块提供两项检查，一条结构化、一条文本启发式，用途与可信度都不同：
 *
 *  1. **授权一致性校验（结构化，可信）** —— `verifyBypass()`。
 *     拿 guard / 审批门**当时真正做出的决策**（而不是此刻重算的结果）比对：
 *     如果墙判的是拒绝（hidden-deny / deny / ask / panic-deny），而这次调用居然**执行成功了**，
 *     那就意味着墙被绕过了。最现实的成因是插件自己的兜底策略：`guard()` 内部异常时
 *     选择「宁可漏，不可打崩工具管道」而放行——那是 v0.3 唯一的 fail-open 缺口，
 *     现在由这一层在事后发现，并可自动熔断（`autoPanicOnBypass`）。
 *     文章说验证要看结构化数据，这里看的就是「决策」与「结果是否为错误」这两个字段。
 *
 *  2. **泄漏扫描（文本启发式，尽力而为）** —— `findLeak()` / `redactContent()`。
 *     检查工具结果文本里是否出现了受保护根。命中即说明 agent 已经「感知到」了它，
 *     与 hidden 模式「连路径名都不透露」的承诺相违。默认脱敏（把路径换成一个标记），
 *     可选只记审计（`onLeak: 'audit'`）或整条结果转为错误（`onLeak: 'block'`）。
 *     边界要说清楚：这条是启发式，认得出**路径串**，认不出「文件内容被读出来后换了名字」；
 *     真正的读侧隐身仍需要 OS 层（见 README「边界」）。
 *
 * 本模块零 cordis 依赖，纯函数，可整链路单测。
 *
 * @module vault-wall/verify
 */

import { isWallDenial, isAuthorizedDecision } from './wall-core.js'
import { insideOrEqual, ci } from './rules.js'

/** 脱敏标记：一眼能看出这里被墙替换过。 */
export const DEFAULT_REDACTION_MARKER = '[vault-wall:redacted]'

/** 单段文本的扫描上限：超长输出（spill 之前）不做脱敏，只记审计，避免拖慢工具管道。 */
export const MAX_SCAN_CHARS = 200_000

/** 一次调用的结果是否「真的执行了」（而不是被拒绝/取消后得到的错误结果）。 */
export function isExecuted(result) {
  if (result === null || result === undefined || typeof result !== 'object') return false
  return result.isError !== true
}

/**
 * 授权一致性校验。
 * @param {{decision: string, path?: string, ruleId?: string} | undefined} recorded
 *   guard / 审批门当时记下的决策（`undefined` 表示这次调用没经过墙，例如墙未挂载）。
 * @param {unknown} result 工具执行结果
 * @returns {{kind: 'ok'} | {kind: 'bypass', decision: string, path?: string, ruleId?: string}}
 */
export function verifyBypass(recorded, result) {
  if (recorded === undefined || recorded === null) return { kind: 'ok' }
  if (!isWallDenial(recorded.decision)) return { kind: 'ok' }
  if (!isExecuted(result)) return { kind: 'ok' }
  return {
    kind: 'bypass',
    decision: String(recorded.decision),
    ...(recorded.path !== undefined ? { path: recorded.path } : {}),
    ...(recorded.ruleId !== undefined ? { ruleId: recorded.ruleId } : {}),
  }
}

/**
 * 受 hidden 规则保护、且**管辖这个工具**的字面前缀集合。
 *
 * 只取 hidden 规则：`deny` 模式的语义是「明确告诉 agent 这里不能碰」，路径本身不是秘密，
 * 结果里出现它是正常的；而 `hidden` 模式的承诺就是连名字都不透露——这才是要扫的。
 * 同理只取管辖该工具（未限定 tools，或 tools 里含它）的规则，避免把「只对 write 生效」
 * 的规则拿去扫 read 的结果。
 *
 * @param {import('./rules.js').RulesEngine | null} engine
 * @param {string} toolName
 * @returns {string[]}
 */
export function hiddenRootsFor(engine, toolName) {
  if (engine === null || engine === undefined) return []
  const tool = String(toolName ?? '')
  const roots = []
  for (const entry of engine.entries) {
    if (entry.mode !== 'hidden') continue
    if (entry.toolSet !== undefined && !entry.toolSet.has(tool)) continue
    for (const root of entry.textRoots()) {
      if (typeof root === 'string' && root !== '') roots.push(root)
    }
  }
  return roots
}

/** 取出结果里所有可扫描的文本片段（`content` 既可能是数组也可能是单串）。 */
export function textParts(content) {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const out = []
  for (const part of content) {
    if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') out.push(part.text)
  }
  return out
}

/** 转义正则元字符。 */
function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+*?.-]/g, String.raw`\$&`)
}

/**
 * 把受保护根编译成一个宽松匹配的正则：根里的分隔符按 `[\\/]+` 匹配，
 * 于是 `C:\vault` 也能认出结果文本里的 `C:/vault/x` 与转义形态 `C:\\vault\\x`
 * （与 `rules.textMentions` 同一套容忍度）。
 * @param {string[]} roots
 * @returns {RegExp | null}
 */
export function rootMatcher(roots) {
  const alternatives = []
  for (const root of roots) {
    const segments = ci(String(root)).split(/[\\/]+/).filter((segment) => segment !== '')
    if (segments.length === 0) continue
    alternatives.push(segments.map(escapeRegExp).join(String.raw`[\\/]+`))
  }
  if (alternatives.length === 0) return null
  // 长根优先：`C:\a\b` 先于 `C:\a` 命中，避免只脱敏掉前缀、把后缀留在原地。
  alternatives.sort((a, b) => b.length - a.length)
  return new RegExp(alternatives.join('|'), process.platform === 'win32' ? 'gi' : 'g')
}

/**
 * 结果里是否泄漏了受保护根。
 * @param {unknown} result
 * @param {string[]} roots
 * @returns {{kind: 'ok'} | {kind: 'leak', root: string, hits: number}}
 */
export function findLeak(result, roots) {
  if (result === null || result === undefined || typeof result !== 'object') return { kind: 'ok' }
  if (isExecuted(result) === false) {
    // 被拒绝的调用同样会走到 post-execute，但它的「结果」是我们自己写的拒绝文案，
    // 里面当然带着路径——那不是泄漏，是墙在按设计说话。
    return { kind: 'ok' }
  }
  const matcher = rootMatcher(roots)
  if (matcher === null) return { kind: 'ok' }
  for (const text of textParts(result.content)) {
    if (text.length > MAX_SCAN_CHARS) continue
    const source = ci(text)
    matcher.lastIndex = 0
    let hits = 0
    let first
    let m
    while ((m = matcher.exec(source)) !== null) {
      if (first === undefined) first = m[0]
      hits += 1
      if (m.index === matcher.lastIndex) matcher.lastIndex += 1 // 零宽防死循环
    }
    if (hits > 0) return { kind: 'leak', root: first, hits }
  }
  return { kind: 'ok' }
}

/** 命中根之后还要一起吃掉的后缀（同一路径 token 的剩余部分）。 */
const PATH_TAIL = /^[^"\s'<>|,;)\]}]*/

/**
 * 把文本里的受保护根替换成脱敏标记。
 *
 * 关键在于**整条路径一起脱敏**，而不是只替换根那一段：规则 `D:\keys` 命中文本里的
 * `D:\keys\id_ed25519` 时，只换掉 `D:\keys` 会留下 `\id_ed25519`——文件名依然泄漏，
 * 而 hidden 模式的承诺是「连路径名都不透露」。因此命中后继续吃到路径 token 的边界
 * （空白、引号、括号、逗号等）。
 *
 * @param {string} text
 * @param {string[]} roots
 * @param {string} [marker]
 * @returns {{text: string, hits: number}}
 */
export function redactText(text, roots, marker = DEFAULT_REDACTION_MARKER) {
  const matcher = rootMatcher(roots)
  if (matcher === null) return { text, hits: 0 }
  const source = ci(text)
  matcher.lastIndex = 0
  /** @type {Array<[number, number]>} */
  const spans = []
  let m
  while ((m = matcher.exec(source)) !== null) {
    const start = m.index
    let end = start + m[0].length
    if (m.index === matcher.lastIndex) matcher.lastIndex += 1 // 零宽防死循环
    // 已经落在上一条 span 里（根作为子串再次命中）→ 跳过，避免重叠导致文本重复
    const last = spans[spans.length - 1]
    if (last !== undefined && start < last[1]) continue
    const tail = PATH_TAIL.exec(source.slice(end))
    if (tail !== null) end += tail[0].length
    spans.push([start, end])
  }
  if (spans.length === 0) return { text, hits: 0 }
  let out = ''
  let cursor = 0
  for (const [start, end] of spans) {
    out += text.slice(cursor, start) + marker
    cursor = end
  }
  out += text.slice(cursor)
  return { text: out, hits: spans.length }
}

/**
 * 对结果内容整体脱敏（只动 text 片段，图片等非文本片段原样保留）。
 * @param {unknown} content
 * @param {string[]} roots
 * @param {string} [marker]
 * @returns {{content: unknown, hits: number} | null} 没有任何命中时返回 null（调用方据此不改结果）
 */
export function redactContent(content, roots, marker = DEFAULT_REDACTION_MARKER) {
  if (typeof content === 'string') {
    const result = redactText(content, roots, marker)
    return result.hits === 0 ? null : { content: result.text, hits: result.hits }
  }
  if (!Array.isArray(content)) return null
  let hits = 0
  let changed = false
  const next = content.map((part) => {
    if (part === null || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string') return part
    if (part.text.length > MAX_SCAN_CHARS) return part
    const result = redactText(part.text, roots, marker)
    if (result.hits === 0) return result.text === part.text ? part : { ...part, text: result.text }
    hits += result.hits
    changed = true
    return { ...part, text: result.text }
  })
  return changed ? { content: next, hits } : null
}

/**
 * 本次调用是否处于「已授权」范围（借出 / 审批通过），因此该根出现在结果里不算泄漏。
 *
 * 两个方向都算授权，理由不同：
 *  - 根在授权路径**之内**（借出了整棵树）→ 树里的根都不再是秘密；
 *  - 授权路径在根**之内**（人刚同意读这棵树里的某一个文件）→ 那条绝对路径本来就该出现在
 *    结果里。只认一个方向的话，「同意读 D:\keys\id_rsa」会立刻被自己的路径判成泄漏并脱敏，
 *    等于把刚批准的内容又抹掉，那才是真正的误报。
 * @param {{decision: string, path?: string} | undefined} recorded
 * @param {string} root
 * @returns {boolean}
 */
export function rootIsAuthorized(recorded, root) {
  if (recorded === undefined || recorded === null) return false
  if (!isAuthorizedDecision(recorded.decision)) return false
  if (typeof recorded.path !== 'string' || recorded.path === '') return true
  return insideOrEqual(recorded.path, root) || insideOrEqual(root, recorded.path)
}
