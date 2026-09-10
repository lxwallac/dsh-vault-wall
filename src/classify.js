/**
 * 工具调用 → 候选路径 的分类器（纯函数）。
 *
 * 覆盖官方核心文件/发现/shell/代码执行工具族，按参数名提取路径：
 *   read / read_image / write / edit   → args.file_path
 *   str_replace_editor                 → args.path（v0.3 新增：官方另一套编辑器工具，此前完全没被墙看到）
 *   glob / grep                        → args.path（搜索根）
 *   bash / pwsh                        → args.command（文本，交给文本启发式）
 *   run_code                           → args.code（程序文本，v0.3 新增）
 *   cordis_define                      → args.code.host / args.code.client（动态插件源码文本，v0.3 新增）
 *
 * 代码执行类工具按**文本**处理：绝对路径 token 会过文本启发式与 panic 白名单，
 * 但不会做 AST 分析——拼接构造的路径仍可绕过（见 README「边界」）。
 *
 * 未识别的工具默认放行（保守、不误伤），这是刻意取舍：只拦“已知工具形状的参数”，
 * 覆盖面矩阵与边界见 README。所有提取都是纯字符串运算，不触碰文件系统。
 */

const FILE_PATH_TOOLS = new Set(['read', 'read_image', 'write', 'edit'])
const SEARCH_ROOT_TOOLS = new Set(['glob', 'grep'])
const COMMAND_TOOLS = new Set(['bash', 'pwsh'])
/** 用 `path` 参数定位目标的编辑器工具（与 file_path 族同义，仅参数名不同）。 */
const PATH_ARG_TOOLS = new Set(['str_replace_editor'])
/** 参数里带可执行/可求值文本的工具：按命令文本启发式扫描。 */
const CODE_TOOLS = new Set(['run_code', 'cordis_define'])
/** 每个代码工具里承载源码文本的字段路径（一层或两层）。 */
const CODE_FIELDS = {
  run_code: [['code']],
  cordis_define: [['code', 'host'], ['code', 'client']],
}

/** 读取 record 上的一条字段路径；非字符串返回 undefined。 */
function readStringField(record, fieldPath) {
  let node = record
  for (const key of fieldPath) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[key]
  }
  return typeof node === 'string' && node.trim().length > 0 ? node : undefined
}

/**
 * @param {{ name: string, arguments: unknown }} exec - tools/pre-execute / guard 的调用视图
 * @returns {Array<{kind: 'path', path: string} | {kind: 'command', text: string}>}
 */
export function classifyToolArgs(exec) {
  const name = String(exec?.name ?? '')
  const args = exec?.arguments
  const record = (args === null || typeof args !== 'object' || Array.isArray(args)) ? {} : args

  if (FILE_PATH_TOOLS.has(name)) {
    const filePath = record.file_path
    if (typeof filePath === 'string' && filePath.trim().length > 0) {
      return [{ kind: 'path', path: filePath }]
    }
    return []
  }

  if (PATH_ARG_TOOLS.has(name)) {
    const toolPath = record.path
    if (typeof toolPath === 'string' && toolPath.trim().length > 0) {
      return [{ kind: 'path', path: toolPath }]
    }
    return []
  }

  if (SEARCH_ROOT_TOOLS.has(name)) {
    const searchPath = record.path
    if (typeof searchPath === 'string' && searchPath.trim().length > 0) {
      return [{ kind: 'path', path: searchPath }]
    }
    return []
  }

  if (COMMAND_TOOLS.has(name)) {
    const command = record.command
    if (typeof command === 'string' && command.trim().length > 0) {
      return [{ kind: 'command', text: command }]
    }
    return []
  }

  if (CODE_TOOLS.has(name)) {
    const fields = CODE_FIELDS[name] ?? []
    const candidates = []
    for (const fieldPath of fields) {
      const text = readStringField(record, fieldPath)
      if (text !== undefined) candidates.push({ kind: 'command', text })
    }
    return candidates
  }

  return []
}

/** 从命令文本里抽出形如绝对路径的 token（含 Windows 盘符/UNC 与 POSIX 绝对路径）。 */
export function absolutePathTokens(text) {
  const value = String(text ?? '')
  const tokens = []
  const re = /(?:[A-Za-z]:[\\/][^\s"'<>|]*|\\\\[^\s"'<>|]+|\/(?!\/)[^\s"'<>|]+)/g
  let m
  while ((m = re.exec(value)) !== null) {
    tokens.push(m[0])
  }
  return tokens
}
