/**
 * 保险区 Vault Wall —— 插件入口（薄接线层）。v0.2：规则主源迁移到官方设置命名空间。
 *
 * 决策逻辑全部在 `./wall-core.js`（纯函数）；规则文档解析/自保护注入在 `./doc-bridge.js`；
 * `/wall` 命令语义在 `./console.js`（纯逻辑，可单测）。本文件只做 cordis 接线：
 *  - 强制点：`ctx.tools.guard()`（单调，永不抛出）；服务就绪前由 watchdog 轮询重试；
 *  - **设置命名空间 `vault-wall`**：schema = `{ rulesJson: string }`（规则全文 JSON 编辑器）。
 *    · 解析值 = schema 默认（''）→ 组合 base（= 旧规则文件内容种子）→ 用户层覆盖；
 *    · `watch` 实时生效：用户在官方设置页保存即重建引擎，无需重启；
 *    · `ctx.settings` 缺席（无 settings-file provider 的环境）时回退旧规则文件模式；
 *  - **自保护**：引擎注入 hidden 规则——规则文件/审计文件/设置文档对 agent 工具不可读不可写。
 *    v0.3 修正：设置文档路径优先取宿主 `settings.documentPath`（宿主解析，含 config.path 覆盖），
 *    兜底才用 `<dsh home>/settings.yaml`（`$DSH_HOME` → `~/.dsh`，见 doc-bridge.js）；
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
import { parseRulesJson, selfPathsFor, assembleRawDoc, defaultSettingsDocPath } from './doc-bridge.js'
import { handleWallCommand, WALL_COMMAND_HINT } from './console.js'

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

/** 参数切词与 `/wall` 命令语义都在 `./console.js`（纯逻辑、可单测），本文件只做接线。 */

/**
 * 插件装载。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {InstanceType<typeof Config>} config
 */
export function apply(ctx, config) {
  const legacyFile = resolveRulesFile(config)
  const auditPath = typeof config.auditFile === 'string' ? config.auditFile : ''
  const allowRoots = compileAllowRoots(config.panicAllowRoots)
  /** 设置文档兜底路径（`$DSH_HOME` → `~/.dsh`）；服务在线时会被 documentPath 覆盖。 */
  const fallbackSettingsDoc = defaultSettingsDocPath(process.env, os.homedir())
  const state = {
    panic: false,
    engine: null,
    userRulesArr: [],
    source: 'none',
    sourceDetail: '',
    lastError: '',
    legacyFile,
    auditPath,
    allowRoots,
    /** settings.documentPath 读到的真实文档路径（权威）；'' 表示尚未拿到。 */
    settingsDocPath: '',
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
      // 权威优先：宿主 settings 服务在线时用它的 documentPath（含 config.path 覆盖）；
      // 否则退回默认 `<dsh home>/settings.yaml`。修正 0.2.31 的 `DSH_HOME || homedir` 路径错。
      const authoritative = state.settingsDocPath
      const settingsDoc = authoritative !== '' ? authoritative : fallbackSettingsDoc
      return selfPathsFor({
        legacyFile: state.legacyFile,
        legacyExists: fs.existsSync(state.legacyFile),
        auditPath: state.auditPath,
        settingsDoc,
        settingsDocExists: fs.existsSync(settingsDoc),
        settingsDocAuthoritative: authoritative !== '',
      })
    },
    readLegacyText(file) {
      return readLegacyText(file, false)
    },
    writeFile(file, text) {
      fs.writeFileSync(file, text, 'utf8')
    },
  }

  const log = (...args) => console.log('[dsh-vault-wall]', ...args)

  // 显式 rulesFile 且 strict 时预检存在性（fail-loud，见 Config 注释）。
  if (typeof config.rulesFile === 'string' && config.rulesFile.trim() !== '' && !fs.existsSync(state.legacyFile) && config.strict) {
    throw new Error(`vault-wall: rules file not found: ${state.legacyFile}`)
  }

  const disposers = []

  const guard = (exec) => {
    try {
      const decision = decideWall(exec, {
        engine: state.engine,
        panic: state.panic,
        allowRoots: state.allowRoots,
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
        description: '保险区 Vault Wall 控制台：状态/规则/决策/试算/借出/熔断',
        input: { hint: WALL_COMMAND_HINT },
        handler: (invocation) => handleWallCommand(state, invocation),
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
      // 宿主自己解析过的文档路径（含 config.path 覆盖）才是自保护该圈的那个文件。
      // 读不到就退回默认 `<dsh home>/settings.yaml`；两者都不阻塞注册。
      try {
        const docPath = settings.documentPath
        if (typeof docPath === 'string' && docPath.trim() !== '') {
          state.settingsDocPath = path.resolve(docPath.trim())
        }
      } catch (error) {
        log(`settings.documentPath unavailable: ${error?.message ?? error}`)
      }
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
        state.sourceDetail = state.settingsDocPath !== ''
          ? `settings doc "vault-wall".rulesJson @ ${state.settingsDocPath}`
          : 'settings doc "vault-wall".rulesJson'
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
