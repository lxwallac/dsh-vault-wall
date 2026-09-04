/**
 * 临时借出（Borrow）存储 —— 纯逻辑，可注入时钟以便测试。
 *
 * 语义：
 *  - 借出绑定到“agent 对象身份 × 绝对路径树”（路径树内全部命中都放行）；
 *  - `once`：第一次放行后即消耗（不管命中的是树里哪个文件）；
 *  - `ttl`：存活到 expiresAt，超时后由 allow/sweep 惰性清除；
 *  - `mode: read` 只放行读/搜索族工具（read/read_image/glob/grep）；
 *    write/edit 与 bash/pwsh（命令文本命中可能借道写文件）仍被拦；
 *    `mode: read-write` 放行一切。
 *
 * 借出仅存在于进程内：会话/进程重启即失效（与官方已观察状态“不跨会话持久化”一致）。
 */

import { normalizeAbs, insideOrEqual } from './rules.js'

const WRITE_TOOLS = new Set(['write', 'edit'])
const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const isWriteTool = (name) => WRITE_TOOLS.has(name)
const isShellTool = (name) => SHELL_TOOLS.has(name)

let nextId = 1

export class BorrowStore {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] - 可注入时钟（默认 Date.now）
   */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now
    /** @type {WeakMap<object, Map<string, object>>} */
    this.agents = new WeakMap()
    /** WeakMap 不可遍历，自维护 map 注册表供 sweep() 全量清理（空 map 保留无害）。 */
    this.maps = []
  }

  _map(agent) {
    let map = this.agents.get(agent)
    if (map === undefined) {
      map = new Map()
      this.agents.set(agent, map)
      this.maps.push(map)
    }
    return map
  }

  /**
   * 为某个 agent 借出一条路径树。
   * @param {object} agent
   * @param {{path: string, mode?: 'read'|'read-write', kind?: 'once'|'ttl', ttlMs?: number, note?: string}} options
   */
  grant(agent, { path, mode = 'read', kind = 'ttl', ttlMs = 60_000, note } = {}) {
    const abs = normalizeAbs(path)
    if (abs === '') throw new Error('vault-wall: borrow requires an absolute path')
    if (mode !== 'read' && mode !== 'read-write') {
      throw new Error(`vault-wall: borrow mode must be \`read\` or \`read-write\`, got ${JSON.stringify(mode)}`)
    }
    if (kind !== 'once' && kind !== 'ttl') {
      throw new Error(`vault-wall: borrow kind must be \`once\` or \`ttl\`, got ${JSON.stringify(kind)}`)
    }
    if (kind === 'ttl' && (!Number.isFinite(ttlMs) || ttlMs < 0)) {
      throw new Error(`vault-wall: borrow ttlMs must be a non-negative number, got ${JSON.stringify(ttlMs)}`)
    }
    const now = this.now()
    const grant = {
      id: `b${nextId++}`,
      path: abs,
      mode,
      kind,
      note: typeof note === 'string' && note.length > 0 ? note : undefined,
      createdAt: now,
      used: false,
      expiresAt: kind === 'ttl' ? now + ttlMs : undefined,
    }
    this._map(agent).set(grant.id, grant)
    return grant
  }

  /**
   * 放行判定：命中 agent 的一条活跃借出则返回 true；`once` 借出会被消耗。
   * 顺带惰性清理过期与已消耗的条目。
   * @param {object | undefined} agent
   * @param {string} targetAbs
   * @param {string} toolName
   */
  allow(agent, targetAbs, toolName) {
    if (agent === undefined || agent === null) return false
    const map = this._map(agent)
    if (map.size === 0) return false
    const now = this.now()
    for (const [id, grant] of [...map]) {
      if (grant.kind === 'ttl' && grant.expiresAt <= now) {
        map.delete(id)
        continue
      }
      if (grant.used) {
        map.delete(id)
        continue
      }
      if (!insideOrEqual(grant.path, targetAbs)) continue
      // read 模式只放行读/搜索族工具：write/edit 是显式写；bash/pwsh 的命令文本命中
      // 可能是 `>`/`Set-Content` 之类的写，read 借出不背书（要 shell 读写请用 read-write）。
      if (grant.mode === 'read' && (isWriteTool(toolName) || isShellTool(toolName))) continue
      if (grant.kind === 'once') grant.used = true
      return true
    }
    return false
  }

  /** 撤销一条借出；返回是否真的存在并删除。 */
  revoke(agent, id) {
    const map = this.agents.get(agent)
    return map === undefined ? false : map.delete(id)
  }

  /** 某 agent 当前（含未清理的过期项）借出列表。 */
  list(agent) {
    const map = this.agents.get(agent)
    return map === undefined ? [] : [...map.values()]
  }

  /** 全量清理过期与已消耗条目（由定时器周期性调用）。 */
  sweep() {
    const now = this.now()
    for (const map of this.maps) {
      for (const [id, grant] of [...map]) {
        if ((grant.kind === 'ttl' && grant.expiresAt <= now) || grant.used) map.delete(id)
      }
    }
  }
}
