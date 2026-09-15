/**
 * 保险区 Vault Wall —— 插件入口（薄接线层）。v0.4：补齐 Harness 五要素。
 *
 * 决策逻辑全部在纯函数模块里，本文件只做 cordis 接线：
 *  - **约束**：`ctx.tools.guard()`（单调，永不抛出）——hidden / deny / panic / 借出；
 *  - **人在回路**：`tools/pre-execute` 审批门——`mode: "ask"` 的规则经官方审批通道
 *    （`ctx.approval`，弹在用户界面上）问人，通过后把同意记进台账并（可选）借出，
 *    guard 据此放行。审批门跑在 guard **之前**，而 guard 是单调守卫、只能拒绝不能放行，
 *    所以「问过人并且人说了可以」必须先被记下来——这也是为什么需要一份台账；
 *  - **验证**：`tools/post-execute` 两层校验——结构化校验（墙判了拒绝却执行成功 =
 *    被绕过，guard 唯一的 fail-open 缺口由它事后兜住）、文本启发式（结果里出现受保护
 *    根 → 记审计并默认脱敏）；
 *  - **纠正**：重复触墙计数与升级（跨越阈值时把停止指令写进错误文案；再往后把结果
 *    替换成纯纠正反馈，必要时熔断）；
 *  - **可回滚**：每次规则成功应用都记一条修订，`/wall rollback` 一步退回；
 *  - **设置命名空间 `vault-wall`**：schema = `{ rulesJson: string }`（规则全文 JSON 编辑器）。
 *    · 解析值 = schema 默认（''）→ 组合 base（= 旧规则文件内容种子）→ 用户层覆盖；
 *    · `watch` 实时生效：用户在官方设置页保存即重建引擎，无需重启；
 *    · `ctx.settings` 缺席（无 settings-file provider 的环境）时回退旧规则文件模式；
 *  - **自保护**：引擎注入 hidden 规则——规则文件/审计文件/历史文件/设置文档对 agent 不可读不可写。
 *    设置文档路径优先取宿主 `settings.documentPath`（宿主解析，含 config.path 覆盖），
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
import { decideWall, compileAllowRoots, isWallDenial } from './wall-core.js'
import { parseRulesJson, selfPathsFor, assembleRawDoc, defaultSettingsDocPath } from './doc-bridge.js'
import { handleWallCommand, WALL_COMMAND_HINT } from './console.js'
import { toolRisk } from './risk.js'
import { ApprovalLedger, approvalClass, approvalDenialReason, askReason } from './ask.js'
import { verifyBypass, findLeak, redactContent, hiddenRootsFor, rootIsAuthorized, DEFAULT_REDACTION_MARKER } from './verify.js'
import { DenialStreaks, repeatNoticeText, escalationFeedback } from './correct.js'
import { Metrics } from './metrics.js'
import { RuleHistory, DEFAULT_HISTORY_LIMIT } from './history.js'

export const name = 'dsh-vault-wall'

/**
 * 插件版本。刻意与 `package.json` 的 version 手工同步：`/wall status` 要把「你正在跑的
 * 到底是哪一版」摆出来（README 第 6 行也要求使用者核对版本），而 ESM 直接 import JSON
 * 需要断言语法、测试替身里又会破功，所以用常量 + 一条断言两者一致的测试来兜。
 */
export const VERSION = '0.4.0'

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

  // ---- v0.4：验证与纠正 ----
  /** 结果里出现受保护根时的处置：audit=只记审计｜redact=脱敏（默认）｜block=整条结果转为错误 */
  onLeak: z.union(['audit', 'redact', 'block']).default('redact'),
  /** 脱敏标记 */
  leakMarker: z.string().default(DEFAULT_REDACTION_MARKER),
  /** 检出「墙判拒绝却执行成功」时是否自动熔断（默认开：这类绕过不该等用户发现） */
  autoPanicOnBypass: z.boolean().default(true),
  /** 同一个 agent 在同一处受保护路径上被拒多少次后升级纠正；0 = 关闭 */
  repeatDenialThreshold: z.number().default(3),
  /** 升级动作：notice=只投放纠正指令｜panic=并触发熔断 */
  repeatDenialAction: z.union(['notice', 'panic']).default('notice'),

  // ---- v0.4：人在回路 ----
  /** ask 规则的总开关；关掉后 ask 规则一律 fail-closed 为明确拒绝 */
  askEnabled: z.boolean().default(true),
  /** ask 审批通过后借出的默认时长（ms）；规则可用 borrowTtlMs 覆盖 */
  askBorrowTtlMs: z.number().default(10 * 60 * 1000),

  // ---- v0.4：可回滚 ----
  /** 内存中保留的规则修订条数 */
  historyLimit: z.number().default(DEFAULT_HISTORY_LIMIT),
  /** 规则修订历史落盘路径；空 = 仅内存（重启即失）。会被自保护规则圈禁 */
  historyFile: z.string().default(''),
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

/** 审批通过后的借出模式：只读族给 read，其余（含未识别工具）给 read-write。 */
function borrowModeFor(toolName) {
  return toolRisk(toolName) === 'low' ? 'read' : 'read-write'
}

/**
 * 插件装载。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {InstanceType<typeof Config>} config
 */
export function apply(ctx, config) {
  const legacyFile = resolveRulesFile(config)
  const auditPath = typeof config.auditFile === 'string' ? config.auditFile : ''
  const historyFile = typeof config.historyFile === 'string' ? config.historyFile : ''
  const allowRoots = compileAllowRoots(config.panicAllowRoots)
  /** 设置文档兜底路径（`$DSH_HOME` → `~/.dsh`）；服务在线时会被 documentPath 覆盖。 */
  const fallbackSettingsDoc = defaultSettingsDocPath(process.env, os.homedir())
  const behaviour = {
    onLeak: config.onLeak ?? 'redact',
    leakMarker: typeof config.leakMarker === 'string' && config.leakMarker !== '' ? config.leakMarker : DEFAULT_REDACTION_MARKER,
    autoPanicOnBypass: config.autoPanicOnBypass !== false,
    repeatDenialThreshold: Number.isFinite(Number(config.repeatDenialThreshold)) ? Number(config.repeatDenialThreshold) : 3,
    repeatDenialAction: config.repeatDenialAction === 'panic' ? 'panic' : 'notice',
    askEnabled: config.askEnabled !== false,
    askBorrowTtlMs: Number.isFinite(Number(config.askBorrowTtlMs)) ? Number(config.askBorrowTtlMs) : 10 * 60 * 1000,
  }
  const state = {
    version: VERSION,
    panic: false,
    engine: null,
    userRulesArr: [],
    source: 'none',
    sourceDetail: '',
    lastError: '',
    legacyFile,
    auditPath,
    historyFile,
    allowRoots,
    behaviour,
    homeDir: os.homedir(),
    /** settings.documentPath 读到的真实文档路径（权威）；'' 表示尚未拿到。 */
    settingsDocPath: '',
    borrow: new BorrowStore(),
    audit: new AuditRing(config.auditLimit ?? 500, auditPath),
    metrics: new Metrics(),
    streaks: new DenialStreaks({ threshold: behaviour.repeatDenialThreshold }),
    history: new RuleHistory({ limit: config.historyLimit ?? DEFAULT_HISTORY_LIMIT }),
    ledger: new ApprovalLedger(),
    /** exec → 墙当时做出的决策（post-execute 验证据此比对，而不是此刻重算）。 */
    decisions: new WeakMap(),
    /** 已经过审批门的 exec（同一个 exec 不重复弹窗）。 */
    gated: new WeakSet(),
    /** settings 命名空间的写入口（服务在线时注入），供 `/wall rollback` 写回规则源。 */
    settingsUpdate: null,
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
      // 只增不改：每次成功应用都留一条修订（内容没变则不记），供 `/wall rollback` 退回。
      const recorded = state.history.record(String(text ?? ''), { source: sourceLabel })
      if (state.historyFile !== '') {
        const persisted = state.history.persist(state.historyFile, (file, content) => fs.writeFileSync(file, content, 'utf8'))
        if (!persisted.written && persisted.error !== '') {
          console.warn(`[dsh-vault-wall] history file write failed: ${persisted.error}`)
        }
      }
      state.audit.push({ tool: 'system', decision: 'rules-loaded', reason: `rules=${rules.length} engine=${state.engine.size} revision=${recorded.revision === null ? '-' : recorded.revision.id}${recorded.recorded ? '' : ' (unchanged)'}` })
      console.log(`[dsh-vault-wall] rules loaded from ${sourceLabel}: ${rules.length} user rule(s), ${state.engine.size} total (incl self-protection), revision ${recorded.revision === null ? '-' : recorded.revision.id}`)
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
        historyPath: state.historyFile,
        historyExists: state.historyFile !== '' && fs.existsSync(state.historyFile),
        historyAuthoritative: state.historyFile !== '',
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
    exists(file) {
      try {
        return fs.existsSync(file)
      } catch {
        return true
      }
    },
    /**
     * 把回滚后的规则写回**当前规则源**（`/wall rollback` 用）。
     * settings 在线时写设置文档的用户层（watch 会自动再应用一次，幂等）；
     * 否则写旧规则文件。两者都不可用时如实回报「只改了内存」。
     */
    persistRules(text) {
      if (typeof state.settingsUpdate === 'function') {
        try {
          const pending = state.settingsUpdate({ rulesJson: text })
          if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') {
            pending.catch((error) => console.warn(`[dsh-vault-wall] settings write failed: ${error?.message ?? error}`))
          }
          return { target: 'settings' }
        } catch (error) {
          return { target: 'failed', error: String(error?.message ?? error) }
        }
      }
      if (state.legacyFile !== '') {
        try {
          fs.writeFileSync(state.legacyFile, text, 'utf8')
          return { target: 'file' }
        } catch (error) {
          return { target: 'failed', error: String(error?.message ?? error) }
        }
      }
      return { target: 'none' }
    },
  }

  const log = (...args) => console.log('[dsh-vault-wall]', ...args)
  const agentKeyOf = (exec) => state.agentLabel(exec?.agent) ?? 'no-agent'

  /** 记一条审计 + 指标（两个都对异常免疫：审计写盘失败不该影响判决）。 */
  const note = (entry) => {
    try {
      state.audit.push(entry)
    } catch {
      /* 审计不可用时不追加 */
    }
    try {
      state.metrics.record({
        tool: entry.tool,
        decision: entry.decision,
        ruleId: entry.ruleId,
        risk: entry.risk,
        agentLabel: entry.agentLabel,
      })
      state.metrics.noteAgent(entry.agentLabel)
    } catch {
      /* 指标不可用时不追加 */
    }
  }

  // 显式 rulesFile 且 strict 时预检存在性（fail-loud，见 Config 注释）。
  if (typeof config.rulesFile === 'string' && config.rulesFile.trim() !== '' && !fs.existsSync(state.legacyFile) && config.strict) {
    throw new Error(`vault-wall: rules file not found: ${state.legacyFile}`)
  }

  // 历史文件先读进来（读不到就当空历史，不算错误）。
  if (historyFile !== '') {
    const loaded = state.history.load(historyFile, (file) => fs.readFileSync(file, 'utf8'))
    if (loaded.error !== '') log(`history file ignored: ${loaded.error}`)
    else if (loaded.loaded) log(`history loaded: ${state.history.size} revision(s) from ${historyFile}`)
  }

  const disposers = []

  /**
   * 单调守卫（约束层）：审批门之后的最后一道闸。
   * - `ask` 决策在这里等于**拒绝**：审批门只有拿到 `allowed-once` 才会把同意记进台账，
   *   因此「台账里没有」就意味着没人同意过（审批门没挂上、内部出错、或调用方绕过了它）。
   * - 拒绝时如果这个 (agent, 规则, 路径) 已经反复被拒，就把纠正指令直接写进错误文案：
   *   错误结果正是模型下一次决策的输入，停止指令因此出现在它正要重试的那一刻。
   */
  const guard = (exec) => {
    try {
      const decision = decideWall(exec, {
        engine: state.engine,
        panic: state.panic,
        allowRoots: state.allowRoots,
        borrow: state.borrow,
        approved: state.ledger,
      })
      const risk = toolRisk(exec.name)
      const agentLabel = agentKeyOf(exec)
      if (exec !== null && typeof exec === 'object') {
        state.decisions.set(exec, { decision: decision.decision, path: decision.path, ruleId: decision.ruleId, risk })
      }
      if (decision.decision === 'allow' || decision.decision === 'borrow-allow' || decision.decision === 'ask-approved') {
        note({ tool: decision.tool, decision: decision.decision, path: decision.path, ruleId: decision.ruleId, risk, agentLabel })
        return undefined
      }
      const base = decision.reason ?? `[vault-wall] ${decision.tool} on "${decision.path ?? '?'}" is denied`
      const peek = state.streaks.peek(agentLabel, { path: decision.path, ruleId: decision.ruleId })
      const reason = peek.escalated
        ? `${base} ${repeatNoticeText({ tool: decision.tool, path: decision.path, ruleId: decision.ruleId, count: peek.count, threshold: peek.threshold })}`
        : base
      note({ tool: decision.tool, decision: decision.decision, path: decision.path, ruleId: decision.ruleId, risk, reason: base, agentLabel })
      return reason
    } catch (error) {
      // guard 绝不抛出：内部异常退化为放行并留痕 —— 墙宁可漏，不可打崩工具管道。
      // 这个 fail-open 缺口由 post-execute 的授权一致性校验在事后兜住（检出即熔断）。
      note({ tool: exec?.name, decision: 'internal-error', reason: String(error?.message ?? error), agentLabel: agentKeyOf(exec) })
      return undefined
    }
  }

  /**
   * 审批门（人在回路 / 约束层）：只在规则判 `ask` 时介入，其余一律 `next()` 交给后面的
   * guard。审批由宿主的审批通道执行（用户界面上的弹窗），不是问模型自己——文章强调
   * 高风险操作的复核必须来自「上下文之外」的机制。
   *
   * 为什么**不**直接返回 `{ kind: 'ask', reason }` 让宿主代问（宿主确实支持，见
   * `dsh-tools` 的 `serviceAsk`）：那条路径在「用户同意」后返回 `{kind:'allow'}`，
   * 随后宿主照常咨询单调 guard（`decision.kind === 'allow' ? this.guardReason(exec) : …`）；
   * 而我们的 guard 对同一条 ask 规则仍会判 `ask`（台账里没有同意记录）→ **用户刚点的
   * 「允许」会被自己的墙否掉**。所以审批必须在这里自己做，并在 guard 之前把同意写进
   * `ApprovalLedger`（按 exec 对象记账），让单调 guard 看得到。
   *
   * 三种非放行结果（人拒绝 / 取消 / 无通道）分别给出不同文案且都要求别重试——错误文案
   * 本身就是一次纠偏（纠正层的一半）。
   */
  const askGate = async (exec, next) => {
    try {
      if (exec === null || typeof exec !== 'object') return await next()
      if (state.gated.has(exec)) return await next()
      state.gated.add(exec)
      const dry = decideWall(exec, {
        engine: state.engine,
        panic: state.panic,
        allowRoots: state.allowRoots,
        borrow: state.borrow,
        approved: state.ledger,
        dryRun: true,
      })
      if (dry.decision !== 'ask') return await next()

      const entry = dry.ruleId !== undefined && state.engine !== null ? state.engine.byId.get(dry.ruleId) : undefined
      const risk = toolRisk(exec.name)
      const agentLabel = agentKeyOf(exec)
      const info = { tool: dry.tool, path: dry.path, entry }
      const deny = (cls, decision) => {
        note({ tool: dry.tool, decision, path: dry.path, ruleId: dry.ruleId, risk, reason: cls, agentLabel })
        return { kind: 'deny', reason: approvalDenialReason(cls, info) }
      }

      if (behaviour.askEnabled !== true) {
        note({ tool: dry.tool, decision: 'ask', path: dry.path, ruleId: dry.ruleId, risk, reason: 'ask disabled by config', agentLabel })
        return { kind: 'deny', reason: approvalDenialReason('unavailable', info) }
      }
      const approval = ctx.get('approval')
      if (approval === undefined || typeof approval.request !== 'function') {
        state.metrics.recordApproval('unavailable')
        return deny('unavailable', 'ask-unavailable')
      }
      if (exec.agent === undefined || exec.agent === null) {
        state.metrics.recordApproval('unavailable')
        return deny('unavailable', 'ask-unavailable')
      }

      let outcome
      try {
        outcome = await approval.request({
          agent: exec.agent,
          toolName: exec.name,
          callId: exec.callId,
          reason: askReason({ tool: dry.tool, path: dry.path, risk, entry }),
          signal: exec.signal,
        })
      } catch (error) {
        // 审批通道抛错（例如不在一个打开的 turn 里）—— fail-closed，绝不放行。
        state.metrics.recordApproval('unavailable')
        state.audit.push({ tool: dry.tool, decision: 'ask-error', path: dry.path, ruleId: dry.ruleId, risk, reason: String(error?.message ?? error), agentLabel })
        return { kind: 'deny', reason: approvalDenialReason('unavailable', info) }
      }

      const cls = approvalClass(outcome)
      state.metrics.recordApproval(cls)
      if (cls !== 'granted') return deny(cls, `ask-${cls}`)

      // 通过：记台账（guard 据此放行这次调用），并按规则决定要不要顺手借出。
      state.ledger.grant(exec, {
        paths: typeof dry.path === 'string' && dry.path !== '' ? [dry.path] : [],
        ruleIds: [dry.ruleId],
        risk,
      })
      let detail = 'no-borrow'
      const remember = entry?.remember === true
      const ttl = Number.isFinite(Number(entry?.borrowTtlMs)) ? Number(entry.borrowTtlMs) : behaviour.askBorrowTtlMs
      if (remember && ttl > 0 && typeof dry.path === 'string' && dry.path !== '') {
        try {
          const grant = state.borrow.grant(exec.agent, {
            path: dry.path,
            mode: borrowModeFor(exec.name),
            kind: 'ttl',
            ttlMs: ttl,
            note: `ask-approved rule=${dry.ruleId ?? '-'}`,
          })
          detail = `borrow=${grant.id} ttl=${ttl}ms mode=${grant.mode}`
        } catch (error) {
          detail = `borrow-failed: ${String(error?.message ?? error)}`
        }
      } else if (remember && ttl <= 0) {
        detail = 'no-borrow (borrowTtlMs=0: 一次一授权)'
      }
      note({ tool: dry.tool, decision: 'ask-approved', path: dry.path, ruleId: dry.ruleId, risk, reason: detail, agentLabel })
      return await next()
    } catch (error) {
      // 与 guard 同一取舍：审批门内部异常不打断工具管道，交给 guard 兜（ask 决策会在
      // guard 处因“台账里没有同意”而 fail-closed），并留痕供 /wall report 发现。
      try {
        note({ tool: exec?.name, decision: 'internal-error', reason: `ask-gate: ${String(error?.message ?? error)}`, agentLabel: agentKeyOf(exec) })
      } catch {
        /* 留痕失败不致命 */
      }
      return await next()
    }
  }

  /**
   * 执行后处理（验证层 + 纠正层）。永远先 `next()` 让下游表态，再按需要改写/阻断，
   * 因此它的存在不会让别的 post-execute 监听器少跑一次。
   */
  const postExecute = async (exec, result, next) => {
    const recorded = exec !== null && typeof exec === 'object' ? state.decisions.get(exec) : undefined
    const agentLabel = agentKeyOf(exec)
    let bypass = null
    let leak = null
    let escalation = null

    try {
      // --- 验证 1：结构化（可信）——墙判了拒绝，这次调用却执行成功了？ ---
      const check = verifyBypass(recorded, result)
      if (check.kind === 'bypass') bypass = check
      // --- 验证 2：文本启发式（尽力而为）——结果里出现了受保护根 ---
      else if (state.engine !== null) {
        const scoped = hiddenRootsFor(state.engine, exec?.name).filter((root) => !rootIsAuthorized(recorded, root))
        if (scoped.length > 0) {
          const found = findLeak(result, scoped)
          if (found.kind === 'leak') leak = { root: found.root, hits: found.hits, roots: scoped }
        }
      }
      // --- 纠正：累计「同一 agent 反复撞同一处」的次数 ---
      if (recorded !== undefined && isWallDenial(recorded.decision)) {
        const streak = state.streaks.note(agentLabel, { tool: exec?.name, path: recorded.path, ruleId: recorded.ruleId, decision: recorded.decision })
        if (streak.escalated) {
          escalation = { count: streak.count, threshold: streak.threshold, path: recorded.path, ruleId: recorded.ruleId }
          state.metrics.recordEscalation()
          state.audit.push({ tool: exec?.name, decision: 'repeat-escalation', path: recorded.path, ruleId: recorded.ruleId, reason: `count=${streak.count}/${streak.threshold}`, agentLabel })
        }
      }
    } catch (error) {
      // 验证层自身出错绝不拖垮工具结果：留痕后退化为“没有发现”。
      try {
        note({ tool: exec?.name, decision: 'internal-error', reason: `verify: ${String(error?.message ?? error)}`, agentLabel })
      } catch {
        /* 留痕失败不致命 */
      }
      bypass = null
      leak = null
    }

    const downstream = await next()
    /** 阻断时保留下游已经挂上的附加上下文，不吞掉别人的贡献。 */
    const blockWith = (feedback) => (downstream.additionalContexts === undefined
      ? { kind: 'block', feedback }
      : { kind: 'block', feedback, additionalContexts: downstream.additionalContexts })

    if (bypass !== null) {
      state.metrics.recordVerify('bypass')
      state.audit.push({
        tool: exec?.name,
        decision: 'verify-bypass',
        path: bypass.path,
        ruleId: bypass.ruleId,
        reason: `wall decided ${bypass.decision} but the call executed`,
        agentLabel,
      })
      let panicNote = ''
      if (behaviour.autoPanicOnBypass && state.panic !== true) {
        state.panic = true
        panicNote = ' The wall has tripped its circuit breaker (panic ON): only allowlisted roots are reachable until the user runs `/wall panic off`.'
        state.audit.push({ tool: 'system', decision: 'panic-trip', reason: `auto: verify-bypass on ${exec?.name ?? '?'}` })
      }
      return blockWith(`[vault-wall] verification failed: this call was denied by the wall (${bypass.decision}) yet its result came back as a success, so the result is withheld.${panicNote} Do not retry: report this to the user — it is a defect in the wall, not in the request.`)
    }

    if (leak !== null) {
      const mode = behaviour.onLeak
      if (mode === 'block') {
        state.metrics.recordVerify('leak', { blocked: true })
        state.audit.push({ tool: exec?.name, decision: 'verify-leak', path: leak.root, reason: `hits=${leak.hits} action=block`, agentLabel })
        return blockWith(`[vault-wall] the result referenced a protected path ("${leak.root}"), so the whole result is withheld by policy. Do not attempt to recover the content through another tool: this location is off-limits. Continue with what you already have, or report to the user.`)
      }
      if (mode === 'redact' && downstream.kind === 'accept' && !Object.hasOwn(downstream, 'value')) {
        const source = downstream.content ?? result?.content ?? result?.value
        const redacted = redactContent(source, leak.roots, behaviour.leakMarker)
        if (redacted !== null) {
          state.metrics.recordVerify('leak', { redacted: true })
          state.audit.push({ tool: exec?.name, decision: 'verify-leak', path: leak.root, reason: `hits=${leak.hits} action=redact`, agentLabel })
          return { ...downstream, content: redacted.content }
        }
      }
      state.metrics.recordVerify('leak')
      state.audit.push({ tool: exec?.name, decision: 'verify-leak', path: leak.root, reason: `hits=${leak.hits} action=${mode}`, agentLabel })
    }

    if (escalation !== null) {
      let panicNote = ''
      if (behaviour.repeatDenialAction === 'panic' && state.panic !== true) {
        state.panic = true
        panicNote = ' The wall has also tripped its circuit breaker (panic ON) until the user runs `/wall panic off`.'
        state.audit.push({ tool: 'system', decision: 'panic-trip', reason: `auto: repeat-denial on "${escalation.path ?? '?'}"` })
      }
      const feedback = escalationFeedback({
        tool: exec?.name,
        path: escalation.path,
        ruleId: escalation.ruleId,
        count: escalation.count,
        action: behaviour.repeatDenialAction === 'panic' ? 'panic' : 'notice',
      })
      // 该次调用的结果本来就是拒绝错误，把它换成一整段纠正指令不会丢信息，
      // 却能让模型看到的结果里只剩「停下来」这一条线索。
      return blockWith(`${feedback}${panicNote}`)
    }

    return downstream
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
        description: '保险区 Vault Wall 控制台：状态/规则/决策/试算/评估/历史/借出/熔断',
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
      // 写入口：`/wall rollback` 把回滚后的规则写回设置文档的用户层。
      if (typeof scope.update === 'function') state.settingsUpdate = (patch) => scope.update(patch)
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

  // ---- v0.4 事件接线：审批门（pre-execute）、验证与纠正（post-execute）、循环清零（pre-step）----
  ctx.on('tools/pre-execute', (exec, next) => askGate(exec, next))
  ctx.on('tools/post-execute', (exec, result, next) => postExecute(exec, result, next))
  ctx.on('agent/pre-step', ({ agent, messages } = {}, next) => {
    try {
      // 新的用户消息 = 全新指令，不该被当成循环（与官方 repeat-tool-reminder 同一取舍）。
      if (Array.isArray(messages) && messages.some((message) => message?.source?.kind === 'user')) {
        state.streaks.reset(state.agentLabel(agent) ?? 'no-agent')
      }
    } catch {
      /* 清零失败不致命 */
    }
    return next()
  })

  attachGuard()
  attachCommands()
  attachSettings()

  // 故障安全默认值：settings 服务这一轮就没就绪时，**立刻**用旧规则文件兜底，
  // 而不是空转到 watchdog 的 60s 截止。engine === null 期间 guard 对任何路径都返回
  // undefined —— 那等于墙在启动后的 60 秒里根本没立起来，而这条窗口纯属等待造成的。
  // 宿主稍后提供 settings 时，watchdog 会按 settings 内容重新应用（内容相同则历史去重）。
  if (!state.settingsAttached && !state.settingsFailed) {
    state.applyUserRules(readLegacyText(state.legacyFile, false), 'file')
    state.sourceDetail = state.legacyFile
  }

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
    try {
      state.streaks.sweep()
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
