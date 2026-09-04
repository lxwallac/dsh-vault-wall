/**
 * 规则文档桥 —— 纯函数层（无 cordis / 无 fs）：
 *  - `parseRulesJson(text)`：把 settings 命名空间里的 JSON 文本 / 旧规则文件文本解析为“用户规则数组”；
 *  - `selfPathsFor(...)`：计算需注入的自保护路径（规则文件、审计文件——agent 不得经工具读写它们）；
 *  - `assembleRawDoc(userRules, selfPaths)`：用户规则 + 自保护规则 → 一份可交给 RulesEngine 的原始文档。
 *
 * 自保护规则一律 hidden（not-found 伪装），避免“读规则文件被告知被规则拦”而暴露插件存在。
 */

/** 解析规则 JSON 文本 → 用户规则数组。空串视为“没有规则”（[]）。结构/JSON 错误抛错。 */
export function parseRulesJson(text) {
  const raw = String(text ?? '')
  const trimmed = raw.trim()
  if (trimmed === '') return []
  let doc
  try {
    doc = JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`rules JSON is not valid: ${error.message}`)
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('rules JSON must be an object document')
  }
  if (doc.version !== undefined && doc.version !== 1) {
    throw new Error(`unsupported rules version ${JSON.stringify(doc.version)} — only version 1 is supported`)
  }
  if (!Array.isArray(doc.rules)) {
    throw new Error('rules JSON document requires a `rules` array')
  }
  return doc.rules
}

/** 计算自保护路径列表（去重、去空、仅绝对路径）。 */
export function selfPathsFor({ legacyFile = '', legacyExists = false, auditPath = '', settingsDoc = '', settingsDocExists = false }) {
  const out = []
  const push = (value) => {
    const v = String(value ?? '').trim()
    if (v === '' || out.includes(v)) return
    out.push(v)
  }
  if (legacyExists && legacyFile !== '') push(legacyFile)
  push(auditPath)
  // 规则主源在官方设置文档里时，文档本身也要圈禁，防 agent 经工具改文档自改墙。
  if (settingsDocExists && settingsDoc !== '') push(settingsDoc)
  return out
}

/**
 * 组装引擎原始文档：用户规则在前（保序），自保护规则在后。
 * 自保护路径 id 按顺序生成 `__self-<n>`，规则本身 mode=hidden、无 tools 限制。
 */
export function assembleRawDoc(userRules, selfPaths) {
  const rules = [...userRules]
  const seen = new Set(selfPaths)
  for (const p of seen) {
    rules.push({
      id: `__self-${rules.length + 1}`,
      mode: 'hidden',
      paths: [p],
      note: 'vault-wall self-protection: rules/audit files are off-limits to agent tools',
    })
  }
  return { version: 1, rules }
}
