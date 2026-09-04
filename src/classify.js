/**
 * 工具调用 → 候选路径 的分类器（纯函数）。
 *
 * v1 只覆盖官方核心文件/发现/shell 工具族，按参数名提取路径：
 *   read / read_image / write / edit   → args.file_path
 *   glob / grep                        → args.path（搜索根）
 *   bash / pwsh                        → args.command（文本，交给文本启发式）
 *
 * 未识别的工具默认放行（保守、不误伤），这是刻意取舍：v1 只拦“官方形状的路径参数”，
 * 覆盖面矩阵与边界见 README。所有提取都是纯字符串运算，不触碰文件系统。
 */

const FILE_PATH_TOOLS = new Set(['read', 'read_image', 'write', 'edit'])
const SEARCH_ROOT_TOOLS = new Set(['glob', 'grep'])
const COMMAND_TOOLS = new Set(['bash', 'pwsh'])

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
