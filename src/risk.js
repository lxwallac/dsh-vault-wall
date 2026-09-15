/**
 * 工具风险评级（纯函数）—— 文章「执行层护栏」的**工具风险评级**：
 * 「根据操作是否可逆、权限等级、财务影响，为每个工具标注风险等级（低/中/高），
 *   高风险操作需额外审查或人工确认」。
 *
 * 评级只看**结构化事实**（工具身份），不看模型自由生成的文本——与文章
 * 「安全检查只看结构化数据，而不看模型自由生成的文本」一致：工具名由注册表决定，
 * 提示注入改不了它。
 *
 * 等级含义：
 *  - `low`    只读 / 只发现：观察世界，不改变世界，天然可枚举（read / glob / grep …）。
 *  - `medium` 改变既有内容：写文件、原地替换——可逆性一般（write / edit / str_replace_editor）。
 *  - `high`   任意执行 / 不可逆 / 可外发：shell、代码执行、动态定义插件、删除与移动
 *             （bash / pwsh / run_code / cordis_define / delete…）。一次调用可以做任何事。
 *  - `unknown` 未识别的工具（第三方 / MCP）：**按最保守处理**，排序最靠后。
 *
 * 排序刻意让 `unknown` 排在最末：文章要求「采用故障安全默认值，所有能力默认关闭，
 * 必须显式开放」。因此规则写 `minRisk: "medium"` 时，未识别的第三方工具同样会触发
 * 人工确认，而不是被当成低风险放行——这正是 v0.3 里「未识别工具默认放行」那条
 * 旁路的收敛方向（墙看不到形状的工具，至少要能被问一次）。
 *
 * 本模块零依赖、纯函数：同样的输入永远同样的输出，可直接单测。
 *
 * @module vault-wall/risk
 */

/** 全部风险等级，按松紧从低到高。 */
export const RISK_LEVELS = ['low', 'medium', 'high', 'unknown']

/**
 * 比较用秩：数字越大越危险。
 * `unknown` = 3（比 high 还靠后）：未识别的工具无法证明它安全，只能按最坏情况算。
 */
const RISK_RANK = { low: 0, medium: 1, high: 2, unknown: 3 }

/** 只读 / 只发现族：观察世界，不改变世界。 */
const LOW_RISK_TOOLS = new Set([
  'read',
  'read_image',
  'read_file',
  'read_many_files',
  'glob',
  'grep',
  'list_dir',
  'ls',
  'cat',
  'head',
  'tail',
  'web_search',
  'web_fetch',
  'read_page',
  'describe_image',
  'modlens_read_image',
])

/** 修改既有内容族：可逆性一般，但已经改动了世界。 */
const MEDIUM_RISK_TOOLS = new Set([
  'write',
  'write_file',
  'edit',
  'edit_file',
  'str_replace_editor',
  'apply_patch',
  'notebook_edit',
  'create_file',
])

/**
 * 任意执行 / 不可逆族。
 * 注意 `bash` / `pwsh` / `run_code` / `cordis_define` 是**开放式动作空间**：
 * 一次调用既能读也能写，还能删——所以按最高风险算，而不是按它「通常」做什么算。
 */
const HIGH_RISK_TOOLS = new Set([
  'bash',
  'pwsh',
  'shell',
  'exec',
  'run_code',
  'code_interpreter',
  'cordis_define',
  'delete_file',
  'delete',
  'remove',
  'rm',
  'rmdir',
  'move',
  'rename',
  'mv',
  'truncate',
  'deploy',
  'publish',
])

/**
 * 某个工具的风险等级。
 * @param {string} toolName 工具名（注册表里的名字，模型无法伪造）
 * @returns {'low'|'medium'|'high'|'unknown'}
 */
export function toolRisk(toolName) {
  const name = String(toolName ?? '').trim().toLowerCase()
  if (name === '') return 'unknown'
  if (LOW_RISK_TOOLS.has(name)) return 'low'
  if (MEDIUM_RISK_TOOLS.has(name)) return 'medium'
  if (HIGH_RISK_TOOLS.has(name)) return 'high'
  return 'unknown'
}

/**
 * 风险秩（比较用）。
 * @param {string} risk
 * @returns {number}
 */
export function riskRank(risk) {
  return RISK_RANK[String(risk ?? '')] ?? RISK_RANK.unknown
}

/**
 * `risk` 是否达到（或超过）门槛 `floor`。
 * 用于规则的 `minRisk`：只有达到门槛的调用才需要人工确认，低于门槛的直接放行。
 * 这正是文章思考题 7 的那种动态风险评估——同一个工具在特定参数/特定规则下变高风险时，
 * 用规则自己的门槛把它挑出来，而不必给工具整体打一个过粗的等级。
 * @param {string} risk
 * @param {string} floor
 * @returns {boolean}
 */
export function atLeastRisk(risk, floor) {
  return riskRank(risk) >= riskRank(floor)
}

/** 供 `/wall rules`、`/wall test`、审计与设置页共用的一行中文说明。 */
export function describeRisk(risk) {
  switch (risk) {
    case 'low':
      return '只读/只发现：观察世界，不改变世界'
    case 'medium':
      return '改变内容：写入/原地替换，可逆性一般'
    case 'high':
      return '任意执行/不可逆：shell、代码执行、删除或移动'
    default:
      return '未识别工具：按最保守处理（第三方/MCP 默认从严）'
  }
}
