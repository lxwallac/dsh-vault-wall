/**
 * 规则文档桥 —— 纯函数层（无 cordis / 无 fs）：
 *  - `parseRulesJson(text)`：把 settings 命名空间里的 JSON 文本 / 旧规则文件文本解析为“用户规则数组”；
 *  - `dshHomePath(env, home)` / `defaultSettingsDocPath(env, home)`：复刻宿主 @deepseek-ai/dsh-home-paths
 *    的解析顺序（配置 > `$DSH_HOME` > `~/.dsh`），**修正 0.2.31 的路径 bug**：
 *    旧实现用 `DSH_HOME || os.homedir()`，在未设 DSH_HOME 的默认环境算出
 *    `<home>/settings.yaml`，而宿主真实文档在 `<home>/.dsh/settings.yaml` ——
 *    自保护规则指向了不存在的路径，等于把「装着 rulesJson 的设置文档」敞开给 agent。
 *  - `selfPathsFor(...)`：计算需注入的自保护路径（规则文件、审计文件——agent 不得经工具读写它们）；
 *  - `assembleRawDoc(userRules, selfPaths)`：用户规则 + 自保护规则 → 一份可交给 RulesEngine 的原始文档。
 *
 * 自保护规则一律 hidden（not-found 伪装），避免“读规则文件被告知被规则拦”而暴露插件存在。
 */

import path from 'node:path'

/** 宿主 DSH 根目录名（与 @deepseek-ai/dsh-home-paths 的 DSH_HOME_DIR_NAME 一致）。 */
export const DSH_HOME_DIR_NAME = '.dsh'

/** `~` 前缀展开（宿主 expandHomePath 的等价最小实现）。 */
function expandHome(value, home) {
  const raw = String(value ?? '')
  if (raw === '~') return home
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(home, raw.slice(2))
  return raw
}

/**
 * 复刻宿主 dsh-home-paths 的解析顺序：显式配置路径 > `$DSH_HOME` > `~/.dsh`。
 * 空白/空的 `$DSH_HOME` 视为未设置（宿主同语义：空覆盖永不生效）。
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [home] - 用户主目录
 * @returns {string} 绝对路径
 */
export function dshHomePath(env = {}, home = '') {
  const fromEnv = expandHome(env.DSH_HOME, home).trim()
  if (fromEnv !== '') return path.resolve(fromEnv)
  return path.join(home, DSH_HOME_DIR_NAME)
}

/**
 * 设置文档的**默认**绝对路径：`<dsh home>/settings.yaml`。
 * 仅在拿不到 settings 服务、或服务未暴露 documentPath 时兜底；
 * 服务在线时应优先用 `settings.documentPath`（宿主自己解析，含 config.path 覆盖）。
 */
export function defaultSettingsDocPath(env = {}, home = '') {
  return path.join(dshHomePath(env, home), 'settings.yaml')
}

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

/**
 * 计算自保护路径列表（去重、去空、仅绝对路径）。
 * @param {object} [options]
 * @param {boolean} [options.settingsDocAuthoritative] - settingsDoc 是否来自宿主
 *   （`settings.documentPath`）：宿主自己解析过的真实文档路径，即使文件此刻还不存在也圈禁；
 *   而纯猜测的默认路径只在文件确实存在时才圈禁，避免保护一个不存在的假路径。
 */
export function selfPathsFor({
  legacyFile = '',
  legacyExists = false,
  auditPath = '',
  settingsDoc = '',
  settingsDocExists = false,
  settingsDocAuthoritative = false,
}) {
  const out = []
  const push = (value) => {
    const v = String(value ?? '').trim()
    if (v === '' || out.includes(v)) return
    out.push(v)
  }
  if (legacyExists && legacyFile !== '') push(legacyFile)
  push(auditPath)
  // 规则主源在官方设置文档里时，文档本身也要圈禁，防 agent 经工具改文档自改墙。
  if (settingsDoc !== '' && (settingsDocExists || settingsDocAuthoritative)) push(settingsDoc)
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
