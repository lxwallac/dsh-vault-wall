/**
 * `/wall` 控制台命令 —— 纯逻辑层（零 cordis / 零 schemastery 依赖），可整链路单测。
 *
 * v0.3 从 `src/index.js` 抽出：接线层只负责把宿主服务与状态门面注入进来，
 * 命令语义（含新增的 `test` / `export`）全部在这里，测试里用一个假 state 就能跑。
 *
 * state 门面（由 index.js 注入）：
 *   engine, source, sourceDetail, lastError, legacyFile, panic（可变）, allowRoots,
 *   borrow, audit, userRulesArr,
 *   settingsRead?(), applyUserRules(text, label), readLegacyText(file), writeFile?(file, text)
 *
 * 约定：handler 永不抛出 —— 任何内部异常都转成 `{ kind: 'error', text }`，
 * 免得一条写错的命令把命令管道打崩（0.2.31 的 `borrow add` 崩溃即此类）。
 *
 * v0.4 新增：`report`（护栏评估）、`lint`（规则体检）、`history` / `snapshot` / `rollback`
 * （可回滚），`test` 增补风险等级与 ask 行为预告。相应的 state 门面扩展为：
 *   version, metrics, streaks, history, historyFile, behaviour, homeDir, exists?()
 *   persistRules?(text)
 */

import fs from 'node:fs'
import { normalizeAbs } from './rules.js'
import { probeWall } from './wall-core.js'
import { toolRisk, describeRisk } from './risk.js'
import { buildReport, lintRules } from './report.js'

/** 简陋但够用的参数切词：支持双/单引号包裹（路径可含空格），其余按空白切。 */
export function splitArgs(input) {
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

/** 参数名是 `path` 的工具族（编辑器与搜索根）；其余按文件工具族的 `file_path` 处理。 */
const PATH_ARG_TOOLS = new Set(['str_replace_editor', 'glob', 'grep'])

/**
 * 按工具族拼出「形状正确」的合成调用，供 `/wall test` 试算：
 * shell/代码类工具把目标当作命令文本，其余按各自真实参数名传路径。
 * @param {string} tool
 * @param {string} target
 */
export function syntheticExec(tool, target) {
  if (tool === 'bash' || tool === 'pwsh') return { name: tool, arguments: { command: target } }
  if (tool === 'run_code') return { name: tool, arguments: { code: target } }
  if (tool === 'cordis_define') return { name: tool, arguments: { code: { host: target } } }
  if (PATH_ARG_TOOLS.has(tool)) return { name: tool, arguments: { path: target } }
  return { name: tool, arguments: { file_path: target } }
}

/** 一段规则命中的可读描述（mode/note/ask 专属字段）。 */
function describeEntry(entry) {
  if (entry === null || entry === undefined) return ''
  const parts = [`mode=${entry.mode}`]
  if (entry.note !== undefined) parts.push(`note=${entry.note}`)
  if (entry.mode === 'ask') {
    parts.push(`minRisk=${entry.minRisk}`)
    parts.push(`remember=${entry.remember === true}`)
    if (entry.remember === true) parts.push(`borrowTtlMs=${entry.borrowTtlMs}`)
  }
  return parts.join(' ')
}

/** ISO 时间；`0`/缺省显示为 `-`。 */
function iso(ts) {
  const value = Number(ts)
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : '-'
}

/**
 * 受保护路径拒绝写出的统一判定（export 与 snapshot 共用）。
 * `action` 参与文案：导出规则与导出**某条修订**是两件事，报错要说清是哪一件被拒了。
 */
function refuseProtected(state, absolute, action = '导出') {
  const hit = state.engine === null ? null : state.engine.matchPath(absolute)
  if (hit === null) return null
  return `拒绝${action}到受保护路径 ${JSON.stringify(absolute)}（命中规则 "${hit.id}"）：${action}会把规则写进保险区自身`
}

/** 注入的写函数（缺省走 fs）。 */
function writer(state) {
  return typeof state.writeFile === 'function' ? state.writeFile : (file, content) => fs.writeFileSync(file, content, 'utf8')
}

const USAGE = [
  'Usage: /wall <subcommand>',
  '  status                        墙状态（源、规则数、panic、借出、审计、指标）',
  '  rules                         列出当前生效规则（含自保护）',
  '  decisions [n]                 最近 n 条墙决策（默认 20）',
  '  test <绝对路径> [工具]        试算：这条路径现在会被怎么判（不消耗借出）',
  '  report                        护栏评估：拦截/放行分布、审批结果、验证发现、循环与死规则',
  '  lint                          规则体检：过宽、被遮蔽、工具名不可达、已知边界',
  '  export <文件绝对路径>         把当前用户规则导出为 JSON 到指定文件',
  '  history [n]                   规则修订历史（最近 n 条，默认 10）',
  '  snapshot <文件> [id]          把某条修订的规则全文写到文件（默认最新一条）',
  '  rollback <id|last|prev>       回滚到某条修订（记为新修订，历史永不改写）',
  '  reload                        从当前规则源重载',
  '  panic [on|off]                查看/切换熔断',
  '  borrow add <绝对路径> [--ttl <ms>] [--rw] | list | revoke <id> | clear',
].join('\n')

/**
 * `/wall` 命令处理器。
 * @param {object} state 见文件头 state 门面说明
 * @param {{ rawInput?: string, agent?: object }} invocation
 * @returns {{ kind: 'success'|'error', text: string }}
 */
export function handleWallCommand(state, invocation) {
  const fail = (text) => ({ kind: 'error', text })
  const ok = (text) => ({ kind: 'success', text })
  try {
    return dispatch(state, invocation, ok, fail)
  } catch (error) {
    return fail(`/wall 内部错误：${String(error?.message ?? error)}`)
  }
}

function dispatch(state, invocation, ok, fail) {
  const raw = String(invocation?.rawInput ?? '').trim()
  const tokens = splitArgs(raw)
  const sub = (tokens[0] ?? '').toLowerCase()
  const engineSize = state.engine === null ? 0 : state.engine.size

  switch (sub) {
    case 'status': {
      const snap = state.metrics === undefined ? null : state.metrics.snapshot()
      return ok([
        'Vault Wall status',
        `version: ${state.version ?? '?'}`,
        `engine: ${state.engine === null ? 'uninitialized' : `${engineSize} rule(s) active (incl. self-protection)`}`,
        `user rules: ${state.userRulesArr.length}`,
        `source: ${state.source}${state.sourceDetail !== '' ? ` (${state.sourceDetail})` : ''}`,
        ...(state.lastError !== '' ? [`last error: ${state.lastError}`] : []),
        `rules file (legacy): ${state.legacyFile}`,
        `panic: ${state.panic ? `ON (只允许 ${state.allowRoots.length} 个白名单根内路径)` : 'off'}`,
        `borrows: ${state.borrow.list(invocation?.agent).length}`,
        `history: ${state.history === undefined ? 'n/a' : `${state.history.size} revision(s)${state.historyFile ? ` → ${state.historyFile}` : '（仅内存）'}`}`,
        ...(snap === null ? [] : [`metrics: calls=${snap.total} denied=${state.metrics.deniedTotal()} allowed=${state.metrics.allowedTotal()} bypass=${snap.verify.bypass} leak=${snap.verify.leak} ask=${snap.approvals.asked}`]),
        ...(state.streaks === undefined ? [] : [`repeat-denials: threshold=${state.streaks.threshold} escalated=${state.streaks.escalatedCount()}`]),
        ...(state.behaviour === undefined ? [] : [`behaviour: onLeak=${state.behaviour.onLeak} autoPanicOnBypass=${state.behaviour.autoPanicOnBypass} repeatAction=${state.behaviour.repeatDenialAction}`]),
        `audit: ${state.audit.items.length} entries (cap ${state.audit.cap})${state.audit.filePath !== '' ? ` → ${state.audit.filePath}` : ''}`,
      ].join('\n'))
    }

    case 'rules':
      if (state.engine === null) return ok('No rules loaded.')
      return ok(state.engine.entries.map((entry) => {
        const tools = entry.toolSet === undefined ? 'all' : [...entry.toolSet].join(',')
        return `- [${entry.id}] ${describeEntry(entry)} tools=${tools} paths=${entry.specs.length}`
      }).join('\n'))

    case 'report': {
      if (state.metrics === undefined) return fail('/wall report 需要 metrics（宿主接线未注入）')
      const { lines } = buildReport({
        metrics: state.metrics,
        engine: state.engine,
        userRules: state.userRulesArr,
        streaks: state.streaks ?? null,
        history: state.history ?? null,
        audit: state.audit,
        config: state.behaviour ?? {},
        source: state.source,
        panic: state.panic,
      })
      return ok(lines.join('\n'))
    }

    case 'lint': {
      const findings = lintRules({
        rules: state.userRulesArr,
        engine: state.engine,
        exists: typeof state.exists === 'function' ? state.exists : null,
        homeDir: typeof state.homeDir === 'string' ? state.homeDir : '',
      })
      if (findings.length === 0) return ok(`规则体检通过：${state.userRulesArr.length} 条规则没有发现可疑项。`)
      const warn = findings.filter((f) => f.level === 'warn').length
      return ok([
        `规则体检：${findings.length} 条结论（warn ${warn} / info ${findings.length - warn}）`,
        ...findings.map((f) => `${f.level === 'warn' ? '[warn]' : '[info]'}${f.ruleId !== undefined ? ` [${f.ruleId}]` : ''} ${f.code}: ${f.message}`),
      ].join('\n'))
    }

    case 'decisions': {
      const n = tokens[1] === undefined ? 20 : Number.parseInt(tokens[1], 10)
      const limit = Number.isFinite(n) && n > 0 ? n : 20
      const rows = state.audit.list().slice(0, limit)
      if (rows.length === 0) return ok('No decisions recorded yet.')
      return ok(rows.map((r) => {
        const when = new Date(r.ts).toISOString()
        const who = r.agentLabel === undefined ? '' : ` ${r.agentLabel}`
        const detail = r.ruleId !== undefined ? ` rule=${r.ruleId}` : ''
        const risk = r.risk !== undefined ? ` risk=${r.risk}` : ''
        const pathPart = r.path !== undefined ? ` ${JSON.stringify(r.path)}` : ''
        return `${when}${who} ${r.tool} → ${r.decision}${pathPart}${detail}${risk}${r.reason !== undefined ? ` (${r.reason})` : ''}`
      }).join('\n'))
    }

    case 'test': {
      const target = tokens[1]
      if (target === undefined) return fail('Usage: /wall test <绝对路径> [工具名]')
      const absolute = normalizeAbs(target)
      if (absolute === '') return fail(`/wall test 需要绝对路径：${JSON.stringify(target)}`)
      const tool = (tokens[2] ?? 'read').toLowerCase()
      const risk = toolRisk(tool)
      const decision = probeWall(syntheticExec(tool, absolute), {
        engine: state.engine,
        panic: state.panic,
        allowRoots: state.allowRoots,
      })
      const entry = decision.ruleId === undefined || state.engine === null ? undefined : state.engine.byId.get(decision.ruleId)
      const lines = [
        `probe: ${tool} ${absolute}`,
        `risk: ${risk}（${describeRisk(risk)}）`,
        `decision: ${decision.decision}`,
      ]
      if (decision.ruleId !== undefined) lines.push(`rule: ${decision.ruleId} (${describeEntry(entry)})`)
      if (decision.reason !== undefined) lines.push(`agent 会看到: ${decision.reason}`)
      if (decision.decision === 'allow') lines.push(state.engine === null ? '（当前没有规则：全部放行）' : '（不命中任何规则，或 ask 规则的风险门槛高于该工具风险：放行）')
      if (decision.decision === 'ask') {
        lines.push(`（ask 规则：真跑起来会先经官方审批通道问人；通过后 ${entry?.remember === true ? `记一条 ${entry.borrowTtlMs}ms 借出` : '不记借出（一次一授权）'}。试算不弹窗。）`)
      }
      lines.push('（试算不消耗借出，也不改变任何状态）')
      return ok(lines.join('\n'))
    }

    case 'history': {
      if (state.history === undefined) return fail('/wall history 需要 history（宿主接线未注入）')
      const n = tokens[1] === undefined ? 10 : Number.parseInt(tokens[1], 10)
      const limit = Number.isFinite(n) && n > 0 ? n : 10
      const rows = state.history.list().slice(0, limit)
      if (rows.length === 0) return ok('还没有任何规则修订记录。')
      return ok([
        `规则修订 ${state.history.size} 条（最多显示 ${limit} 条，最新在前）${state.historyFile ? `；落盘 ${state.historyFile}` : '；仅内存（重启即失）'}`,
        ...rows.map((r) => `${r.current ? '*' : ' '} ${r.id} ${iso(r.ts)} ${r.source} ${r.hash} ${r.bytes}B${r.note !== undefined ? ` ${r.note}` : ''}`),
        '回滚：/wall rollback <id|last|prev>　导出某条：/wall snapshot <文件> [id]',
      ].join('\n'))
    }

    case 'snapshot': {
      const target = tokens[1]
      if (target === undefined) return fail('Usage: /wall snapshot <文件绝对路径> [id]')
      if (state.history === undefined) return fail('/wall snapshot 需要 history（宿主接线未注入）')
      const absolute = normalizeAbs(target)
      if (absolute === '') return fail(`/wall snapshot 需要绝对路径：${JSON.stringify(target)}`)
      const refusal = refuseProtected(state, absolute, '导出修订')
      if (refusal !== null) return fail(refusal)
      const revision = state.history.get(tokens[2] ?? 'last')
      if (revision === null) return fail(`没有找到修订 ${JSON.stringify(tokens[2] ?? 'last')}（用 /wall history 看清单）`)
      const text = revision.text === '' ? `${JSON.stringify({ version: 1, rules: [] }, null, 2)}\n` : revision.text
      try {
        writer(state)(absolute, text)
      } catch (error) {
        return fail(`写出失败：${String(error?.message ?? error)}`)
      }
      state.audit.push({ tool: 'system', decision: 'rules-snapshot', path: absolute, reason: `revision=${revision.id}` })
      return ok(`已把修订 ${revision.id}（${revision.hash}，${revision.bytes}B）写到 ${absolute}`)
    }

    case 'rollback': {
      if (state.history === undefined) return fail('/wall rollback 需要 history（宿主接线未注入）')
      const selector = tokens[1] ?? 'last'
      const revision = state.history.get(selector)
      if (revision === null) return fail(`没有找到修订 ${JSON.stringify(selector)}（用 /wall history 看清单）`)
      if (revision.id === state.history.latest()?.id) return ok(`修订 ${revision.id} 就是当前生效版本，无需回滚。`)
      state.applyUserRules(revision.text, 'rollback')
      if (state.lastError !== '') {
        return fail(`回滚失败：修订 ${revision.id} 的规则未通过校验 —— ${state.lastError}`)
      }
      const persisted = typeof state.persistRules === 'function' ? state.persistRules(revision.text) : { target: 'none' }
      const persistedText = persisted.target === 'settings'
        ? '已写回设置文档（watch 已生效）'
        : persisted.target === 'file'
          ? `已写回规则文件 ${state.legacyFile}`
          : persisted.target === 'failed'
            ? `⚠ 只改了内存：写回规则源失败（${persisted.error}）——重启后会回到旧规则`
            : '⚠ 只改了内存：当前规则源不可写（settings 与规则文件都不可用）——重启后会回到旧规则'
      state.audit.push({ tool: 'system', decision: 'rules-rollback', reason: `revision=${revision.id} target=${persisted.target}` })
      return ok([
        `已回滚到修订 ${revision.id}（${revision.hash}）：engine=${state.engine === null ? 0 : state.engine.size} rule(s)`,
        persistedText,
        '（历史永不改写：这次回滚本身已记为新修订，/wall history 可见）',
      ].join('\n'))
    }

    case 'export': {
      const target = tokens[1]
      if (target === undefined) return fail('Usage: /wall export <文件绝对路径>')
      const absolute = normalizeAbs(target)
      if (absolute === '') return fail(`/wall export 需要绝对路径：${JSON.stringify(target)}`)
      const refusal = refuseProtected(state, absolute, '导出')
      if (refusal !== null) return fail(refusal)
      const text = `${JSON.stringify({ version: 1, rules: state.userRulesArr }, null, 2)}\n`
      try {
        writer(state)(absolute, text)
      } catch (error) {
        return fail(`导出失败：${String(error?.message ?? error)}`)
      }
      state.audit.push({ tool: 'system', decision: 'rules-exported', path: absolute, reason: `rules=${state.userRulesArr.length}` })
      return ok(`已导出 ${state.userRulesArr.length} 条用户规则 → ${absolute}`)
    }

    case 'reload': {
      try {
        if (state.source === 'settings') {
          const value = state.settingsRead === undefined ? {} : state.settingsRead()
          state.applyUserRules(String(value?.rulesJson ?? ''), 'settings')
        } else {
          const text = state.readLegacyText(state.legacyFile)
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
        const grants = state.borrow.list(invocation?.agent)
        if (grants.length === 0) return ok('No active borrows for this agent.')
        return ok(grants.map((g) => `- ${g.id} ${g.mode} ${g.kind} ${g.path}${g.expiresAt !== undefined ? ` expires=${new Date(g.expiresAt).toISOString()}` : ''}${g.used ? ' used' : ''}`).join('\n'))
      }
      if (action === 'revoke') {
        const id = tokens[2]
        if (id === undefined) return fail('Usage: /wall borrow revoke <id>')
        return state.borrow.revoke(invocation?.agent, id)
          ? ok(`Revoked ${id}.`)
          : fail(`No borrow ${JSON.stringify(id)} for this agent.`)
      }
      if (action === 'clear') {
        for (const grant of state.borrow.list(invocation?.agent)) state.borrow.revoke(invocation?.agent, grant.id)
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
        // 0.2.31 及以前：无 agent 的调用会在这里抛 WeakMap TypeError（命令管道直接报错）。
        let grant
        try {
          grant = state.borrow.grant(invocation?.agent, { path: borrowPath, mode, kind: ttlMs === 0 ? 'once' : 'ttl', ttlMs })
        } catch (error) {
          return fail(`借出失败：${String(error?.message ?? error)}`)
        }
        return ok(`Borrowed ${grant.id}: ${grant.path} (${grant.mode}, ${grant.kind}) for this agent.`)
      }
      return fail('borrow 子命令: add <path> [--ttl <ms>] [--rw] | list | revoke <id> | clear')
    }

    case '':
    case 'help':
      return ok(USAGE)

    default:
      return fail(`未知子命令 ${JSON.stringify(tokens[0])}\n\n${USAGE}`)
  }
}

/** 供 index.js 注册的命令描述文本（与 USAGE 同步）。 */
export const WALL_COMMAND_HINT = 'status | rules | decisions [n] | test <path> [tool] | report | lint | export <file> | history [n] | snapshot <file> [id] | rollback <id|last|prev> | reload | panic [on|off] | borrow add <path> [--ttl <ms>] [--rw] | borrow list | borrow revoke <id>'
