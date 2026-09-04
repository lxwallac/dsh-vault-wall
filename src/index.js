/**
 * 保险区 Vault Wall —— 插件入口（薄接线层）。v0.2：规则主源迁移到官方设置命名空间。
 *
 * 决策逻辑全部在 `./wall-core.js`（纯函数）；规则文档解析/自保护注入在 `./doc-bridge.js`。
 * 本文件只做 cordis 接线：
 *  - 强制点：`ctx.tools.guard()`（单调，永不抛出）；服务就绪前由 watchdog 轮询重试；
 *  - **设置命名空间 `vault-wall`**：schema = `{ rulesJson: string }`（规则全文 JSON 编辑器）。
 *    · 解析值 = schema 默认（''）→ 组合 base（= 旧规则文件内容种子）→ 用户层覆盖；
 *    · `watch` 实时生效：用户在官方设置页保存即重建引擎，无需重启；
 *    · `ctx.settings` 缺席（无 settings-file provider 的环境）时回退旧规则文件模式；
 *  - **自保护**：引擎注入 hidden 规则——规则文件/审计文件对 agent 工具不可读不可写；
 *  - `/wall` 命令 + 审计 JSONL 落盘保持不变。
 *
 * 导出约定遵循官方函数插件：命名导出 name/Config/apply，无 default export。
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { RulesEngine } from './rules.js'
import { BorrowStore } from './borrow.js'
import { AuditRing } from './audit.js'
import { decideWall, compileAllowRoots } from './wall-core.js'
import { parseRulesJson, selfPathsFor, assembleRawDoc } from './doc-bridge.js'

export const name = 'dsh-vault-wall'

/** 插件配置（schemastery 校验）。v0.2 语义：settings 命名空间存在时它才是规则主源。 */
export const Config = z.object({
  /** 旧规则文件绝对路径：settings 不可用时的回退源，以及命名空间初始种子（base 层） */
  rulesFile: z.string().default(''),
  /** panic 熔断时的可见根白名单（绝对路径；为空则 panic 拒掉一切路径型工具调用） */
  panicAllowRoots: z.array(z.string()).default([]),
  /** 审计环形缓冲上限 */
  auditLimit: z.number().default(500),
  /** 审计 JSONL 落盘路径；空 = 仅内存（建议工作区外路径；会被自保护规则圈禁） */
  auditFile: z.string().default(''),
  /** 借出过期清理周期（ms） */
  borrowSweepMs: z.number().default(5000),
  /** 显式配置的 rulesFile 缺失/损坏时：true=加载期抛错，false=告警并以空墙继续 */
  strict: z.boolean().default(true),
})

export function defaultRulesPath() {
  return path.join(os.homedir(), '.dsh', 'vault-wall-rules.json')
}

/** 规则文件解析顺序：config.rulesFile > env DSH_VAULT_WALL_RULES > 默认路径。 */
export function resolveRulesFile(config) {
  if (typeof config.rulesFile === 'string' && config.rulesFile.trim().length > 0) return config.rulesFile.trim()
  const fromEnv = process.env.DSH_VAULT_WALL_RULES
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return defaultRulesPath()
}

/** 读旧规则文件文本；不存在返回空串，读失败按 strict 抛错或空串。 */
function readLegacyText(filePath, strict) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    if (strict) throw new Error(`vault-wall: cannot read rules file ${filePath}: ${error.message}`)
    return ''
  }
}

/** 简陋但够用的参数切词：支持双/单引号包裹（路径可含空格），其余按空白切。 */
function splitArgs(input) {
  const out = []
  const re = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g
  let m
  while ((m = re.exec(input)) !== null) {
    let token = m[0]
    if (token.length >= 2 && (token[0] === '"' || token[0] === "'")) token = token.slice(1, -1)
    out.push(token)
  }
  return out
}

/** /wall 命令处理器。 */
function handleWall(state, invocation) {
  const fail = (text) => ({ kind: 'error', text })
  const ok = (text) => ({ kind: 'success', text })
  const raw = String(invocation.rawInput ?? '').trim()
  const tokens = splitArgs(raw)
  const sub = (tokens[0] ?? '').toLowerCase()
  switch (sub) {
    case 'status':
      return ok([
        'Vault Wall status',
        `engine: ${state.engine === null ? 'uninitialized' : `${state.engine.size} rule(s) active (incl. self-protection)`}`,
        `source: ${state.source}${state.sourceDetail !== '' ? ` (${state.sourceDetail})` : ''}`,
        ...(state.lastError !== '' ? [`last error: ${state.lastError}`] : []),
        `rules file (legacy): ${state.legacyFile}`,
        `panic: ${state.panic ? 'ON (只允许 panicAllowRoots 内路径)' : 'off'}`,
        `borrows: ${state.borrow.list(invocation.agent).length}`,
        `audit: ${state.audit.items.length} entries (cap ${state.audit.cap})${state.audit.filePath !== '' ? ` → ${state.audit.filePath}` : ''}`,
      ].join('\n'))
    case 'rules':
      if (state.engine === null) return ok('No rules loaded.')
      return ok(state.engine.entries.map((entry) => {
        const tools = entry.toolSet === undefined ? 'all' : [...entry.toolSet].join(',')
        return `- [${entry.id}] mode=${entry.mode} tools=${tools}${entry.note ? ` note=${entry.note}` : ''}`
      }).join('\n'))
    case 'decisions': {
      const n = tokens[1] === undefined ? 20 : Number.parseInt(tokens[1], 10)
      const limit = Number.isFinite(n) && n > 0 ? n : 20
      const rows = state.audit.list().slice(0, limit)
      if (rows.length === 0) return ok('No decisions recorded yet.')
      return ok(rows.map((r) => {
        const when = new Date(r.ts).toISOString()
        const who = r.agentLabel === undefined ? '' : ` ${r.agentLabel}`
        const detail = r.ruleId !== undefined ? ` rule=${r.ruleId}` : ''
        const pathPart = r.path !== undefined ? ` ${JSON.stringify(r.path)}` : ''
        return `${when}${who} ${r.tool} → ${r.decision}${pathPart}${detail}${r.reason !== undefined ? ` (${r.reason})` : ''}`
      }).join('\n'))
    }
    case 'reload': {
      try {
        if (state.source === 'settings') {
          const value = state.settingsRead === undefined ? {} : state.settingsRead()
          state.applyUserRules(String(value?.rulesJson ?? ''), 'settings')
        } else {
          const text = readLegacyText(state.legacyFile, false)
          state.applyUserRules(text, 'file')
        }
        return ok(`Reloaded. source=${state.source} engine=${state.engine === null ? 0 : state.engine.size} rule(s)${state.lastError !== '' ? ` error=${state.lastError}` : ''}`)
      } catch (error) {
        return fail(String(error?.message ?? error))
      }
    }
    case 'panic': {
      const target = (tokens[1] ?? '').toLowerCase()
      if (target === 'on') {
        state.panic = true
        return ok('Vault Wall panic ON — 仅 panicAllowRoots 内的路径可触碰。')
      }
      if (target === 'off') {
        state.panic = false
        return ok('Vault Wall panic OFF.')
      }
      return ok(`panic: ${state.panic ? 'ON' : 'off'}`)
    }
    case 'borrow': {
      const action = (tokens[1] ?? '').toLowerCase()
      if (action === 'list') {
        const grants = state.borrow.list(invocation.agent)
        if (grants.length === 0) return ok('No active borrows for this agent.')
        return ok(grants.map((g) => `- ${g.id} ${g.mode} ${g.kind} ${g.path}${g.expiresAt !== undefined ? ` expires=${new Date(g.expiresAt).toISOString()}` : ''}${g.used ? ' used' : ''}`).join('\n'))
      }
      if (action === 'revoke') {
        const id = tokens[2]
        if (id === undefined) return fail('Usage: /wall borrow revoke <id>')
        return state.borrow.revoke(invocation.agent, id)
          ? ok(`Revoked ${id}.`)
          : fail(`No borrow ${JSON.stringify(id)} for this agent.`)
      }
      if (action === 'clear') {
        for (const grant of state.borrow.list(invocation.agent)) state.borrow.revoke(invocation.agent, grant.id)
        return ok('Cleared all borrows for this agent.')
      }
      if (action === 'add') {
        const rest = tokens.slice(2)
        let borrowPath
        let ttlMs = 60_000
        let mode = 'read'
        for (let i = 0; i < rest.length; i += 1) {
          const token = rest[i]
          if (token === '--ttl') {
            const value = Number(rest[i + 1])
            if (!Number.isFinite(value) || value < 0) return fail('--ttl requires a non-negative number of milliseconds')
            ttlMs = value
            i += 1
          } else if (token === '--rw') {
            mode = 'read-write'
          } else if (borrowPath === undefined) {
            borrowPath = token
          } else {
            return fail(`Unexpected argument ${JSON.stringify(token)}`)
          }
        }
        if (borrowPath === undefined) return fail('Usage: /wall borrow add <absolute-path> [--ttl <ms>] [--rw]')
        const grant = state.borrow.grant(invocation.agent, { path: borrowPath, mode, kind: ttlMs === 0 ? 'once' : 'ttl', ttlMs })
        return ok(`Borrowed ${grant.id}: ${grant.path} (${grant.mode}, ${grant.kind}) for this agent.`)
      }
      return fail('borrow 子命令: add <path> [--ttl <ms>] [--rw] | list | revoke <id> | clear')
    }
    default:
      return fail('Usage: /wall status | rules | decisions [n] | reload | panic [on|off] | borrow add <path> [--ttl <ms>] [--rw] | borrow list | borrow revoke <id>')
  }
}

/**
 * 插件装载。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {InstanceType<typeof Config>} config
 */
export function apply(ctx, config) {
  const legacyFile = resolveRulesFile(config)
  const auditPath = typeof config.auditFile === 'string' ? config.auditFile : ''
  const state = {
    panic: false,
    engine: null,
    userRulesArr: [],
    source: 'none',
    sourceDetail: '',
    lastError: '',
    legacyFile,
    auditPath,
    borrow: new BorrowStore(),
    audit: new AuditRing(config.auditLimit ?? 500, auditPath),
    agentSeq: 0,
    agentLabels: new WeakMap(),
    agentLabel: (agent) => {
      if (agent === undefined || agent === null) return undefined
      let label = state.agentLabels.get(agent)
      if (label === undefined) {
        label = `agent#${++state.agentSeq}`
        state.agentLabels.set(agent, label)
      }
      return label
    },
    guardAttached: false,
    commandAttached: false,
    settingsAttached: false,
    settingsFailed: false,
    settingsRead: undefined,
    applyUserRules(text, sourceLabel) {
      let rules
      try {
        rules = parseRulesJson(text)
        // 先用“纯用户规则”校验（id 重复、字段结构等），保证报错不指向自保护规则。
        new RulesEngine({ version: 1, rules })
      } catch (error) {
        const message = String(error?.message ?? error)
        state.lastError = message
        state.audit.push({ tool: 'system', decision: 'rules-invalid', reason: message })
        console.warn(`[dsh-vault-wall] rules invalid (keeping last good engine): ${message}`)
        if (state.engine === null) {
          state.userRulesArr = []
          state.engine = new RulesEngine(assembleRawDoc([], state.selfPaths()))
          state.source = sourceLabel
        }
        return
      }
      state.userRulesArr = rules
      state.engine = new RulesEngine(assembleRawDoc(rules, state.selfPaths()))
      state.source = sourceLabel
      state.lastError = ''
      state.audit.push({ tool: 'system', decision: 'rules-loaded', reason: `rules=${rules.length} engine=${state.engine.size}` })
      console.log(`[dsh-vault-wall] rules loaded from ${sourceLabel}: ${rules.length} user rule(s), ${state.engine.size} total (incl self-protection)`)
    },
    selfPaths() {
      const settingsHome = process.env.DSH_HOME || os.homedir()
      const settingsDoc = path.join(settingsHome, 'settings.yaml')
      return selfPathsFor({
        legacyFile: state.legacyFile,
        legacyExists: fs.existsSync(state.legacyFile),
        auditPath: state.auditPath,
        settingsDoc,
        settingsDocExists: state.settingsAttached && fs.existsSync(settingsDoc),
      })
    },
  }

  const log = (...args) => console.log('[dsh-vault-wall]', ...args)

  // 显式 rulesFile 且 strict 时预检存在性（fail-loud，见 Config 注释）。
  if (typeof config.rulesFile === 'string' && config.rulesFile.trim() !== '' && !fs.existsSync(state.legacyFile) && config.strict) {
    throw new Error(`vault-wall: rules file not found: ${state.legacyFile}`)
  }

  const disposers = []
  const allowRoots = compileAllowRoots(config.panicAllowRoots)

  const guard = (exec) => {
    try {
      const decision = decideWall(exec, {
        engine: state.engine,
        panic: state.panic,
        allowRoots,
        borrow: state.borrow,
      })
      state.audit.push({
        tool: decision.tool,
        decision: decision.decision,
        path: decision.path,
        ruleId: decision.ruleId,
        reason: decision.reason,
        agentLabel: state.agentLabel(exec.agent),
      })
      return decision.decision === 'allow' ? undefined : decision.reason
    } catch (error) {
      // guard 绝不抛出：内部异常退化为放行并留痕 —— 墙宁可漏，不可打崩工具管道。
      try {
        state.audit.push({ tool: exec.name, decision: 'internal-error', reason: String(error?.message ?? error), agentLabel: state.agentLabel(exec.agent) })
      } catch {
        /* audit 不可用时不追加 */
      }
      return undefined
    }
  }

  /** 尝试挂 guard；tools 服务未就绪返回 false（由 watchdog 轮询重试）。 */
  const attachGuard = () => {
    if (state.guardAttached) return true
    const tools = ctx.get('tools')
    if (tools !== undefined && typeof tools.guard === 'function') {
      disposers.push(tools.guard(guard))
      state.guardAttached = true
      state.audit.push({ tool: 'system', decision: 'guard-registered', reason: `engine=${state.engine === null ? 0 : state.engine.size}` })
      log('guard registered (monotonic, after tools/pre-execute)')
      return true
    }
    return false
  }

  /** 尝试注册 /wall 命令；commands 服务未就绪返回 false。 */
  const attachCommands = () => {
    if (state.commandAttached) return true
    const commands = ctx.get('commands')
    if (commands !== undefined && typeof commands.register === 'function') {
      commands.register({
        name: 'wall',
        description: '保险区 Vault Wall 控制台：状态/规则/决策/借出/熔断',
        input: { hint: 'status | rules | decisions [n] | reload | panic [on|off] | borrow add <path> [--ttl <ms>] [--rw] | borrow list | borrow revoke <id>' },
        handler: (invocation) => handleWall(state, invocation),
      })
      state.commandAttached = true
      state.audit.push({ tool: 'system', decision: 'command-registered' })
      log('/wall command registered')
      return true
    }
    return false
  }

  /**
   * 尝试把「保险区规则」注册为官方设置命名空间 `vault-wall`（schema = rulesJson 文本编辑器）。
   * 解析值 = '' → 组合 base（旧规则文件内容种子）→ 用户层覆盖；用户保存即实时重建引擎。
   */
  const attachSettings = () => {
    if (state.settingsAttached) return true
    if (state.settingsFailed) return false
    const settings = ctx.get('settings')
    if (settings === undefined || typeof settings.register !== 'function') return false
    state.settingsFailed = true // 只尝试一次注册；失败即回退旧文件模式
    try {
      const seed = readLegacyText(state.legacyFile, false)
      const schema = z.object({ rulesJson: z.string().default('') })
      const scope = settings.register('vault-wall', schema, { base: { rulesJson: seed }, applies: 'live' })
      state.settingsRead = () => {
        const current = settings.get('vault-wall')
        return current && typeof current === 'object' ? current : {}
      }
      const disposeWatch = scope.watch((next, prev) => {
        if (next === undefined || prev === undefined) return
        if (next.rulesJson !== prev.rulesJson) {
          state.applyUserRules(String(next.rulesJson ?? ''), 'settings')
        }
      })
      disposers.push(disposeWatch)
      state.settingsAttached = true
      state.applyUserRules(String(state.settingsRead().rulesJson ?? ''), 'settings')
      state.audit.push({ tool: 'system', decision: 'settings-registered', reason: `seed=${seed === '' ? 'empty' : 'legacy-file'}` })
      log('settings namespace "vault-wall" registered (rulesJson editor, live apply)')
      return true
    } catch (error) {
      state.settingsFailed = true
      log(`settings namespace registration failed (falling back to rules file): ${error?.message ?? error}`)
      return false
    }
  }

  attachGuard()
  attachCommands()
  attachSettings()

  const attachStartedAt = Date.now()
  const watchdog = setInterval(() => {
    const guardOk = attachGuard()
    const commandOk = attachCommands()
    const settingsOk = state.settingsAttached || attachSettings()
    const attached = guardOk && commandOk && (settingsOk || state.settingsFailed)
    const deadline = Date.now() - attachStartedAt > 60_000
    if (attached || deadline) {
      clearInterval(watchdog)
      if (!state.guardAttached) {
        state.audit.push({ tool: 'system', decision: 'guard-unavailable', reason: 'tools service never became available' })
        log('tools service unavailable — wall NOT enforced')
      }
      if (!state.commandAttached) {
        log('commands service unavailable — /wall disabled')
      }
      if (!state.settingsAttached) {
        // settings 服务缺席（无 settings-file provider 的环境）：回退旧规则文件模式。
        state.applyUserRules(readLegacyText(state.legacyFile, false), 'file')
        state.sourceDetail = state.legacyFile
        log('settings service unavailable — using legacy rules file mode')
      } else {
        state.sourceDetail = 'settings doc "vault-wall".rulesJson'
      }
    }
  }, 250)

  const sweepMs = Math.max(250, Number(config.borrowSweepMs) || 5000)
  const sweeper = setInterval(() => {
    try {
      state.borrow.sweep()
    } catch {
      /* 清理失败不致命 */
    }
  }, sweepMs)

  ctx.on('dispose', () => {
    clearInterval(watchdog)
    clearInterval(sweeper)
    for (const disposer of disposers) {
      try {
        disposer()
      } catch {
        /* 反注册失败不致命 */
      }
    }
  })
}
