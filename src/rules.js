/**
 * 纯规则引擎（无任何 DSH/Node 平台依赖，仅用 node:path）。
 *
 * 职责：
 *  - 解析并校验规则文件 JSON（fail-loud：坏规则在加载期抛错，绝不静默放行）；
 *  - 把每条规则编译成可判定的路径谓词（目录树包含 / 单文件 / glob）；
 *  - 提供 `matchPath()` 判定一个绝对路径是否落在某个隔离区内。
 *
 * 设计约束（详见 README「安全边界」）：
 *  - 只接受绝对路径；相对路径在 v1 不支持（守卫点拿不到可靠 cwd 语义）。
 *  - 匹配是纯词法 + path.relative 包含判断，不做 fs 访问（避免 TOCTOU 与 I/O 开销）；
 *    符号链接别名不在 v1 能力内。
 *  - Windows 上路径大小写不敏感；分隔符统一为平台分隔符后再比较。
 */

import path from 'node:path'

const SEP = path.sep

/** Windows 上路径比较大小写不敏感，其余平台敏感。 */
export function ci(value) {
  return process.platform === 'win32' ? String(value).toLowerCase() : String(value)
}

/** 统一分隔符并按平台规范化绝对路径；非绝对路径返回空串（v1 不支持相对路径）。 */
export function normalizeAbs(spec) {
  const raw = String(spec ?? '').trim()
  if (raw.length === 0) return ''
  const unified = raw.replace(/[\\/]+/g, SEP)
  if (!path.isAbsolute(unified)) return ''
  return path.normalize(unified)
}

/** 规范化后的 target 是否等于 root 或位于 root 之下（词法包含，不做 fs 解析）。 */
export function insideOrEqual(root, target) {
  const r = normalizeAbs(root)
  const t = normalizeAbs(target)
  if (r === '' || t === '') return false
  const cr = ci(r)
  const ct = ci(t)
  if (cr === ct) return true
  const rel = path.relative(r, t)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 转义正则特殊字符。 */
function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, String.raw`\$&`)
}

/** 判断一条路径规格里是否含 glob 元字符。 */
function hasGlob(value) {
  return /[*?[\]]/.test(value)
}

/**
 * 解析一条路径规格（已 normalize 的绝对路径字符串）为匹配器。
 * 规则：
 *  - 以 `<sep>**` 结尾 → 该目录整棵树；
 *  - 段内 `*` → 该段内任意字符（不跨分隔符）；
 *  - `?` 与 `[...]` 字符类在 v1 不支持，直接 fail-loud；
 *  - 否则 → 等于或位于其下（既能圈目录树，也能圈单个文件）。
 */
export function compileSpec(spec) {
  const abs = normalizeAbs(spec)
  if (abs === '') throw new Error(`vault-wall: path spec must be an absolute path: ${JSON.stringify(spec)}`)

  const doubleStar = SEP + '**'
  if (abs.endsWith(doubleStar)) {
    const root = abs.slice(0, -doubleStar.length)
    return { kind: 'tree', root }
  }

  if (hasGlob(abs)) {
    if (/[?[\]]/.test(abs)) {
      throw new Error(`vault-wall: unsupported glob in ${JSON.stringify(spec)} — v1 supports only \`*\` within a segment and a trailing \`${SEP}**\` tree marker`)
    }
    const withinSegment = `[^${escapeRegExp(SEP)}]*`
    // 逐字符构建：`*` → 段内通配；其余字符转义。不可先整体转义再替换（会把 `*` 一起转义掉）。
    let source = '^'
    for (const ch of abs) {
      source += ch === '*' ? withinSegment : escapeRegExp(ch)
    }
    source += '$'
    const literalPrefix = abs.slice(0, abs.indexOf('*'))
    return { kind: 'glob', prefix: literalPrefix, regex: new RegExp(source, process.platform === 'win32' ? 'i' : '') }
  }

  return { kind: 'path', abs }
}

/** 编译后的单条规则。 */
function compileRule(rule, index) {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new Error(`vault-wall: rule #${index} must be an object`)
  }
  const { id, paths, mode = 'hidden', tools, note } = rule
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`vault-wall: rule #${index} requires a non-empty string \`id\``)
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error(`vault-wall: rule ${JSON.stringify(id)} requires a non-empty \`paths\` array`)
  }
  if (mode !== 'hidden' && mode !== 'deny') {
    throw new Error(`vault-wall: rule ${JSON.stringify(id)}: mode must be \`hidden\` or \`deny\`, got ${JSON.stringify(mode)}`)
  }
  let toolSet
  if (tools !== undefined) {
    if (!Array.isArray(tools) || tools.length === 0 || tools.some((t) => typeof t !== 'string')) {
      throw new Error(`vault-wall: rule ${JSON.stringify(id)}: \`tools\` must be a non-empty string array`)
    }
    toolSet = new Set(tools)
  }
  const specs = paths.map((p) => compileSpec(p))
  return {
    id,
    note: typeof note === 'string' ? note : undefined,
    mode,
    toolSet,
    specs,
    match(targetAbs) {
      const t = normalizeAbs(targetAbs)
      if (t === '') return false
      for (const spec of specs) {
        if (spec.kind === 'tree') {
          if (insideOrEqual(spec.root, t)) return true
        } else if (spec.kind === 'path') {
          if (insideOrEqual(spec.abs, t)) return true
        } else if (spec.regex.test(ci(t))) {
          return true
        }
      }
      return false
    },
    /** 该规则在“命令文本扫描”里可用的字面前缀（不含 glob 段）。 */
    textRoots() {
      const roots = []
      for (const spec of specs) {
        if (spec.kind === 'tree') roots.push(spec.root)
        else if (spec.kind === 'path') roots.push(spec.abs)
        else roots.push(spec.prefix)
      }
      return roots
    },
  }
}

/**
 * 校验整份规则文档并返回引擎实例。任何结构/取值问题都在这里抛出（fail-closed）。
 * @param {unknown} raw - JSON.parse 之后的值
 * @returns {RulesEngine}
 */
export class RulesEngine {
  constructor(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('vault-wall: rules document must be a JSON object')
    }
    if (raw.version !== 1) {
      throw new Error(`vault-wall: unsupported rules version ${JSON.stringify(raw.version)} — only version 1 is supported`)
    }
    if (!Array.isArray(raw.rules)) {
      throw new Error('vault-wall: rules document requires a \`rules\` array')
    }
    const entries = raw.rules.map(compileRule)
    const byId = new Map()
    for (const entry of entries) {
      if (byId.has(entry.id)) throw new Error(`vault-wall: duplicate rule id ${JSON.stringify(entry.id)}`)
      byId.set(entry.id, entry)
    }
    this.entries = entries
    this.byId = byId
    this.raw = raw
  }

  get size() {
    return this.entries.length
  }

  /** 命中路径的**第一条**规则（文件顺序），无则 null。 */
  matchPath(targetAbs) {
    for (const entry of this.entries) {
      if (entry.match(targetAbs)) return entry
    }
    return null
  }

  /** 供命令文本启发式扫描使用的全部字面前缀。 */
  allTextRoots() {
    return this.entries.flatMap((entry) => entry.textRoots())
  }
}

/**
 * 判断一段命令文本是否“提到”某个受保护根（文本级启发式，v1 专用，见 README 限制）。
 * 要求命中前是词边界、命中后是路径边界，降低 `D:\keys2` 误伤 `D:\keys` 的概率。
 */
export function textMentions(textValue, rootAbs) {
  const text = String(textValue ?? '')
  const root = normalizeAbs(rootAbs)
  if (text.length === 0 || root === '') return false
  const cText = ci(text)
  const cRoot = ci(root)
  const boundary = (index) => {
    if (index < 0) return false
    const prev = index === 0 ? '' : cText[index - 1]
    const next = index + cRoot.length
    const after = next >= cText.length ? '' : cText[next]
    // 词边界只以字母/数字/下划线为准：`\`、`/`、`-`、`.`、`:` 都不构成断词，
    // 因此 `D:\keys\a`（后随 `\`）是命中，而 `D:\keys2`（后随 `2`）不是。
    const wordish = /[A-Za-z0-9_]/
    return !wordish.test(prev) && !wordish.test(after)
  }
  let from = 0
  for (;;) {
    const at = cText.indexOf(cRoot, from)
    if (at < 0) return false
    if (boundary(at)) return true
    from = at + 1
  }
}
