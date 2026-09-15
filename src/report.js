/**
 * 护栏评估 —— `/wall report`（事后体检）与 `/wall lint`（保存前体检）。
 *
 * 文章对护栏评估的要求是**双向**的：
 *   「护栏评估不能只测试『应当拒绝的请求是否被拦截』，还要测试『明确允许的请求是否
 *     能够正常完成』。」并且「护栏也存在另一类失败：**误拒绝**」。
 * 所以这里既统计「拦住了多少次」，也统计三种「墙可能做过头了」的信号：
 * 从未命中的规则、被反复撞击的同一位置、以及审批通道缺席导致的退化为硬拒绝。
 *
 * `lint` 面向**还没保存**的规则：路径过宽（可能把工作区自己也圈进去 → 大面积误拒绝）、
 * 规则被前一条遮蔽（引擎取第一条命中，后写的不会生效）、`tools` 写了本插件看不见形状的
 * 工具名（那条限定永不命中）、中段 `**` 的已知边界——都在这里提前说清楚。
 *
 * 两个函数都是纯函数（`exists` 由调用方注入，便于测试），零 cordis 依赖。
 *
 * @module vault-wall/report
 */

import { normalizeAbs, insideOrEqual, ci } from './rules.js'
import { COVERED_TOOLS } from './classify.js'
import { describeRisk } from './risk.js'

/** 一条 lint 结论。`level: 'warn'` 值得改；`'info'` 只是提醒你确认这是有意的。 */
function finding(level, code, message, ruleId) {
  return { level, code, message, ...(ruleId !== undefined ? { ruleId } : {}) }
}

/** 路径规格是否含整段 `**`（跨层通配）。 */
function hasSegmentDoubleStar(spec) {
  return /(^|[\\/])\*\*([\\/]|$)/.test(String(spec))
}

/** 路径规格是否以整段 `**` 结尾（整树标记，不是中段通配）。 */
function endsWithTreeMarker(spec) {
  return /[\\/]\*\*$/.test(String(spec).replace(/[\\/]+$/, ''))
}

/**
 * 规则体检（保存前）。
 * @param {object} options
 * @param {Array<object>} options.rules 用户规则数组（原始 JSON 形态）
 * @param {import('./rules.js').RulesEngine | null} [options.engine] 已编译引擎（用于遮蔽判定）
 * @param {(abs: string) => boolean} [options.exists] 路径存在性探测（注入，便于测试）；不传则跳过该项
 * @param {string} [options.homeDir] 用户主目录（用于判定「过宽」）
 * @returns {Array<{level: 'warn'|'info', code: string, message: string, ruleId?: string}>}
 */
export function lintRules({ rules = [], engine = null, exists = null, homeDir = '' } = {}) {
  const out = []
  const home = normalizeAbs(homeDir)
  const seenPaths = new Map()

  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i] ?? {}
    const id = typeof rule.id === 'string' ? rule.id : `#${i + 1}`
    const paths = Array.isArray(rule.paths) ? rule.paths : []
    const entry = engine !== null && engine.entries[i] !== undefined ? engine.entries[i] : null

    for (const spec of paths) {
      const abs = normalizeAbs(spec)
      if (abs === '') continue

      // 1) 过宽：覆盖了主目录本身或它的祖先（含盘根）——等于把用户自己的东西也圈进去。
      if (home !== '' && insideOrEqual(abs, home)) {
        out.push(finding('warn', 'over-broad', `路径 ${JSON.stringify(spec)} 覆盖了主目录 ${JSON.stringify(home)} 或其上层：会大面积触发误拒绝，建议收到具体子目录/文件。`, id))
      }

      // 2) 中段 ** 的已知边界（直接触碰会拦，祖先目录上的递归聚合拦不住）。
      if (hasSegmentDoubleStar(spec) && !endsWithTreeMarker(spec)) {
        out.push(finding('info', 'mid-segment-doublestar', `路径 ${JSON.stringify(spec)} 用了中段 **：只保证直接触碰命中文件时被拦；在祖先目录上做递归聚合无法穷举深度（glob 的固有边界）。`, id))
      }

      // 3) 路径目前不存在：规则照样生效，但值得确认不是打错字。
      if (typeof exists === 'function') {
        let present = true
        try {
          present = exists(abs)
        } catch {
          present = true
        }
        if (!present) {
          out.push(finding('info', 'missing-path', `路径 ${JSON.stringify(spec)} 当前不存在（规则仍然生效；确认一下是不是写错了位置）。`, id))
        }
      }

      // 4) 同一条路径写在多条规则里：只有第一条会命中，后面的同 mode 规则是死代码。
      const previous = seenPaths.get(ci(abs))
      if (previous !== undefined && previous !== id) {
        out.push(finding('info', 'duplicate-path', `路径 ${JSON.stringify(spec)} 已经出现在规则 "${previous}" 里：引擎取第一条命中，本条可能不会生效。`, id))
      } else if (previous === undefined) {
        seenPaths.set(ci(abs), id)
      }
    }

    // 5) 被前一条规则遮蔽（引擎按文件顺序取第一条命中）。
    if (entry !== null && entry.specs.length > 0 && paths.length > 0) {
      for (let j = 0; j < i; j += 1) {
        const earlier = engine.entries[j]
        if (earlier === undefined) continue
        if (earlier.mode !== entry.mode) continue
        if (earlier.match(paths[0])) {
          out.push(finding('warn', 'shadowed', `规则被 "${earlier.id}" 遮蔽：它的路径已覆盖 ${JSON.stringify(paths[0])}，引擎取第一条命中，因此本规则不会先被选中。`, id))
          break
        }
      }
    }

    // 6) tools 写成本插件看不见形状的工具名 → 那条限定永不命中。
    if (Array.isArray(rule.tools)) {
      for (const tool of rule.tools) {
        if (typeof tool !== 'string') continue
        if (!COVERED_TOOLS.has(tool)) {
          out.push(finding('warn', 'uncovered-tool', `tools 里的 ${JSON.stringify(tool)} 不在本插件能识别形状的工具族内：该限定等于永不命中（未识别的工具默认放行，见 README「已知边界」）。`, id))
        }
      }
    }

    // 7) deny 模式会点名规则 —— 等于告诉 agent 这里有一道墙。
    if (rule.mode === 'deny') {
      out.push(finding('info', 'deny-reveals', `规则使用 deny 模式：拒绝文案会点名规则 id，agent 会知道自己碰到了一道墙（要完全隐身请用 hidden）。`, id))
    }

    // 8) ask 模式的两个前提。
    if (rule.mode === 'ask') {
      out.push(finding('info', 'ask-channel', `规则使用 ask 模式（人在回路）：需要宿主提供审批通道；没有可用审批者时会 fail-closed 成明确拒绝（不会静默放行）。`, id))
      if (rule.minRisk !== undefined && rule.minRisk !== 'low') {
        out.push(finding('info', 'ask-risk-floor', `minRisk=${rule.minRisk}：风险低于该门槛的工具调用会直接放行、不打扰你（${describeRisk(rule.minRisk)}）。`, id))
      }
      if (rule.remember === false) {
        out.push(finding('info', 'ask-no-remember', `remember=false：每一次触碰受保护路径都会重新弹审批。`, id))
      }
    }
  }

  return out
}

/** 百分比（一位小数）。 */
function pct(part, whole) {
  if (whole <= 0) return '0.0%'
  return `${((part / whole) * 100).toFixed(1)}%`
}

function iso(ts) {
  return ts > 0 ? new Date(ts).toISOString() : '-'
}

/**
 * 事后体检报告。
 * @param {object} options
 * @param {import('./metrics.js').Metrics} options.metrics
 * @param {import('./rules.js').RulesEngine | null} options.engine
 * @param {Array<object>} options.userRules 用户规则（原始 JSON 形态）
 * @param {import('./correct.js').DenialStreaks} [options.streaks]
 * @param {import('./history.js').RuleHistory} [options.history]
 * @param {object} [options.audit] 审计环形缓冲（`AuditRing`）
 * @param {object} [options.config] 生效配置摘要
 * @param {string} [options.source]
 * @param {boolean} [options.panic]
 * @returns {{lines: string[], summary: object}}
 */
export function buildReport({ metrics, engine = null, userRules = [], streaks = null, history = null, audit = null, config = {}, source = '', panic = false } = {}) {
  const snap = metrics.snapshot()
  const denied = metrics.deniedTotal()
  const allowed = metrics.allowedTotal()
  const lines = []
  const summary = { verdict: 'ok', actions: [] }

  lines.push('Vault Wall 护栏评估（文章 Harness 五要素：约束 / 验证 / 纠正）')
  lines.push(`时间窗口: ${iso(snap.firstTs)} → ${iso(snap.lastTs)}　规则源: ${source || '-'}　panic: ${panic ? 'ON' : 'off'}`)
  lines.push('')

  // ---- 约束：拦得住吗？ ----
  lines.push(`【约束】工具调用 ${snap.total} 次：拦截 ${denied} 次（${pct(denied, snap.total)}），放行 ${allowed} 次，审批门命中 ${metrics.byDecision.ask ?? 0} 次`)
  const decisionRows = Object.entries(snap.byDecision)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind}=${count}`)
  lines.push(`  判决分布: ${decisionRows.length === 0 ? '（还没有任何决策记录）' : decisionRows.join('　')}`)
  lines.push('')

  // ---- 人在回路：审批通道在不在？ ----
  const approvals = snap.approvals
  if (approvals.asked > 0 || (metrics.byDecision.ask ?? 0) > 0) {
    lines.push(`【人在回路】问人 ${approvals.asked} 次：通过 ${approvals.granted}　人拒 ${approvals.rejected}　取消 ${approvals.cancelled}　无通道 ${approvals.unavailable}`)
    if (approvals.unavailable > 0) {
      lines.push(`  ⚠ 有 ${approvals.unavailable} 次因**没有可用审批者**而 fail-closed 成拒绝：ask 规则在这个会话里退化成了硬拒绝。`)
      summary.actions.push('ask 规则遇到「无审批通道」：确认宿主是否有审批 UI，或改用 borrow 预授权。')
    }
    lines.push('')
  }

  // ---- 验证：墙自己被绕过过吗？ ----
  const verify = snap.verify
  lines.push(`【验证】授权一致性: bypass=${verify.bypass}（>0 表示墙判了拒绝却仍执行成功，必须查）　泄漏扫描: leak=${verify.leak}（已脱敏 ${verify.leakRedacted}／已阻断 ${verify.leakBlocked}）`)
  if ((metrics.byDecision['internal-error'] ?? 0) > 0) {
    lines.push(`  ⚠ 墙内部异常 ${metrics.byDecision['internal-error']} 次：guard 的兜底是「宁可漏，不可打崩工具管道」，这些调用当时是**放行**的。`)
    summary.verdict = 'attention'
    summary.actions.push('存在 guard 内部异常：查看 /wall decisions 里的 internal-error 明细。')
  }
  if (verify.bypass > 0) {
    lines.push('  ⚠ 检出 bypass：把 /wall decisions 里对应记录与当次工具参数一起看，这是墙的缺陷而非模型的问题。')
    summary.verdict = 'attention'
    summary.actions.push('存在 verify-bypass：墙出现过「判拒绝但仍然执行成功」，请按上方线索定位。')
  }
  if (verify.leak > 0) lines.push('  提示：泄漏计数偏高说明有规则的保护面没盖住实际读取路径（或存在误报，见 onLeak 配置）。')
  lines.push('')

  // ---- 纠正：有没有陷在循环里？ ----
  const loops = streaks === null ? [] : streaks.list()
  const escalated = loops.filter((row) => row.escalated)
  lines.push(`【纠正】重复触墙（同一 agent × 同一规则 × 同一路径）: 记录 ${loops.length} 条，其中已升级 ${escalated.length} 条`)
  for (const row of escalated.slice(0, 5)) {
    lines.push(`  - ${row.agentKey} ×${row.count}　rule=${row.ruleId ?? '-'}　path=${row.path ?? '-'}　tool=${row.tool ?? '-'}`)
  }
  if (escalated.length > 0) {
    lines.push('  这些位置 agent 反复撞：多半是它认为那里本该可达（任务描述或上下文让它这么以为）。要么把规则放宽，要么把任务说清楚。')
    summary.actions.push('存在重复触墙循环：检查这些规则是否过宽（误拒绝），或把「该处不可用」写进任务说明。')
  }
  lines.push('')

  // ---- 规则有效性：有没有死规则？ ----
  const hits = new Map(snap.byRule.map((row) => [row.ruleId, row]))
  const never = userRules.map((rule) => (typeof rule?.id === 'string' ? rule.id : '')).filter((id) => id !== '' && (hits.get(id)?.total ?? 0) === 0)
  lines.push(`【规则】用户规则 ${userRules.length} 条；当前生效 ${engine === null ? 0 : engine.size} 条（含自保护）`)
  const top = snap.byRule.filter((row) => row.ruleId !== '' && row.total > 0).slice(0, 5)
  if (top.length > 0) {
    lines.push('  活跃规则（按拦截次数）:')
    for (const row of top) lines.push(`    - ${row.ruleId}: 拦截 ${row.denied} / 命中 ${row.total}`)
  }
  if (never.length > 0) {
    lines.push(`  从未命中的规则 ${never.length} 条: ${never.join(', ')}`)
    lines.push('    从未命中可能是好事（那处确实没被碰过），也可能是路径写错/写宽/已被遮蔽——用 /wall lint 与 /wall test 确认。')
  }
  lines.push('')

  if (history !== null) {
    lines.push(`【可回滚】规则修订 ${history.size} 条；最近一次: ${history.latest() === null ? '-' : `${history.latest().id} @ ${iso(history.latest().ts)} (${history.latest().source})`}　回滚：/wall rollback last`)
    lines.push('')
  }

  lines.push('【生效配置】' + Object.entries(config).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('　'))
  if (audit !== null) lines.push(`【明细】审计 ${audit.items.length} 条（上限 ${audit.cap}）${audit.filePath !== '' ? ` → ${audit.filePath}` : '（仅内存）'}　最近明细：/wall decisions`)

  if (summary.actions.length === 0) {
    lines.push('')
    lines.push('结论：暂无异常信号。护栏的两个方向都还没有反例——被拦的都拦住了，被放行的没有反复回头撞墙。')
  } else {
    lines.push('')
    lines.push('建议动作:')
    for (const action of summary.actions) lines.push(`  - ${action}`)
  }

  return { lines, summary }
}
