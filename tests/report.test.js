import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { RulesEngine } from '../src/rules.js'
import { lintRules, buildReport } from '../src/report.js'
import { Metrics } from '../src/metrics.js'
import { DenialStreaks } from '../src/correct.js'
import { RuleHistory } from '../src/history.js'

const home = path.resolve('__vw_report_home__')
const vault = path.join(home, 'secret-box')
const nested = path.join(vault, 'deep')
const other = path.resolve('__vw_report_other__')

const codes = (findings) => findings.map((f) => f.code)

test('lint：过宽路径（覆盖主目录或其上层）判 warn', () => {
  const findings = lintRules({ rules: [{ id: 'too-wide', mode: 'hidden', paths: [home] }], homeDir: home })
  assert.ok(codes(findings).includes('over-broad'))
  assert.equal(findings.find((f) => f.code === 'over-broad').level, 'warn')
  // 具体子目录不算过宽
  const ok = lintRules({ rules: [{ id: 'narrow', mode: 'hidden', paths: [vault] }], homeDir: home })
  assert.equal(codes(ok).includes('over-broad'), false)
})

test('lint：路径当前不存在时给出 info（可能是打错字）', () => {
  const findings = lintRules({
    rules: [{ id: 'ghost', mode: 'hidden', paths: [vault, other] }],
    homeDir: home,
    exists: (abs) => abs !== other,
  })
  const missing = findings.filter((f) => f.code === 'missing-path')
  assert.equal(missing.length, 1)
  assert.equal(missing[0].level, 'info')
  assert.match(missing[0].message, /__vw_report_other__/)
})

test('lint：中段 ** 提示已知边界，整树 ** 不提示', () => {
  const rules = [
    { id: 'mid', mode: 'hidden', paths: ['C:\\work\\repo\\**\\.env'] },
    { id: 'tree', mode: 'hidden', paths: ['C:\\work\\repo\\credentials\\**'] },
  ]
  const findings = lintRules({ rules, homeDir: home })
  const mid = findings.filter((f) => f.code === 'mid-segment-doublestar')
  assert.equal(mid.length, 1)
  assert.equal(mid[0].ruleId, 'mid')
})

test('lint：同一条路径写在多条规则里会提示（引擎取第一条命中）', () => {
  const rules = [
    { id: 'first', mode: 'hidden', paths: [vault] },
    { id: 'second', mode: 'hidden', paths: [vault] },
  ]
  const findings = lintRules({ rules, homeDir: home })
  const dup = findings.filter((f) => f.code === 'duplicate-path')
  assert.equal(dup.length, 1)
  assert.equal(dup[0].ruleId, 'second')
})

test('lint：被前一条同 mode 规则遮蔽时判 warn', () => {
  const rules = [
    { id: 'wide', mode: 'hidden', paths: [vault] },
    { id: 'narrow', mode: 'hidden', paths: [nested] },
  ]
  const engine = new RulesEngine({ version: 1, rules })
  const findings = lintRules({ rules, engine, homeDir: home })
  const shadowed = findings.filter((f) => f.code === 'shadowed')
  assert.equal(shadowed.length, 1)
  assert.equal(shadowed[0].level, 'warn')
  assert.equal(shadowed[0].ruleId, 'narrow')
  assert.match(shadowed[0].message, /wide/)
  // mode 不同则不算遮蔽（两条都该生效）
  const mixed = [
    { id: 'wide', mode: 'deny', paths: [vault] },
    { id: 'narrow', mode: 'hidden', paths: [nested] },
  ]
  const mixedFindings = lintRules({ rules: mixed, engine: new RulesEngine({ version: 1, rules: mixed }), homeDir: home })
  assert.equal(codes(mixedFindings).includes('shadowed'), false)
})

test('lint：tools 写了本插件看不见形状的工具名 → warn（限定永不命中）', () => {
  const rules = [{ id: 'mcp', mode: 'hidden', paths: [vault], tools: ['read', 'mcp__github__create_issue'] }]
  const findings = lintRules({ rules, homeDir: home })
  const uncovered = findings.filter((f) => f.code === 'uncovered-tool')
  assert.equal(uncovered.length, 1)
  assert.match(uncovered[0].message, /mcp__github__create_issue/)
  // 覆盖面内的工具名不报
  const okRules = [{ id: 'ok', mode: 'hidden', paths: [vault], tools: ['read', 'run_code', 'cordis_define', 'str_replace_editor'] }]
  assert.equal(codes(lintRules({ rules: okRules, homeDir: home })).includes('uncovered-tool'), false)
})

test('lint：deny 模式提示会暴露墙的存在', () => {
  const findings = lintRules({ rules: [{ id: 'd', mode: 'deny', paths: [vault] }], homeDir: home })
  assert.ok(codes(findings).includes('deny-reveals'))
})

test('lint：ask 模式提示审批通道前提、风险门槛与 remember', () => {
  const findings = lintRules({
    rules: [
      { id: 'a1', mode: 'ask', paths: [vault] },
      { id: 'a2', mode: 'ask', paths: [other], minRisk: 'high', remember: false },
    ],
    homeDir: home,
  })
  assert.equal(findings.filter((f) => f.code === 'ask-channel').length, 2)
  assert.equal(findings.filter((f) => f.code === 'ask-risk-floor').length, 1)
  assert.equal(findings.filter((f) => f.code === 'ask-no-remember').length, 1)
})

test('lint：干净规则不产生 warn', () => {
  const rules = [{ id: 'clean', mode: 'hidden', paths: [vault], note: 'ok' }]
  const findings = lintRules({ rules, engine: new RulesEngine({ version: 1, rules }), homeDir: home })
  assert.equal(findings.filter((f) => f.level === 'warn').length, 0)
})

// ---------------------------------------------------------------- buildReport

function reportFixture() {
  const metrics = new Metrics()
  metrics.record({ tool: 'read', decision: 'allow', risk: 'low' })
  metrics.record({ tool: 'read', decision: 'hidden-deny', ruleId: 'vault', risk: 'low' })
  metrics.record({ tool: 'write', decision: 'ask', ruleId: 'ask-rule', risk: 'medium' })
  metrics.record({ tool: 'write', decision: 'ask-approved', ruleId: 'ask-rule', risk: 'medium' })
  metrics.recordApproval('granted')
  const streaks = new DenialStreaks({ threshold: 3 })
  for (let i = 0; i < 3; i += 1) streaks.note('agent#1', { tool: 'read', path: vault, ruleId: 'vault' })
  const history = new RuleHistory()
  history.record('{"version":1,"rules":[]}', { source: 'settings' })
  return {
    metrics,
    streaks,
    history,
    engine: new RulesEngine({
      version: 1,
      rules: [
        { id: 'vault', mode: 'hidden', paths: [vault] },
        { id: 'ask-rule', mode: 'ask', paths: [other] },
        { id: 'never-hit', mode: 'hidden', paths: [nested] },
      ],
    }),
    userRules: [
      { id: 'vault', mode: 'hidden', paths: [vault] },
      { id: 'ask-rule', mode: 'ask', paths: [other] },
      { id: 'never-hit', mode: 'hidden', paths: [nested] },
    ],
  }
}

test('report：覆盖约束/人在回路/验证/纠正/规则/可回滚六个小节', () => {
  const fixture = reportFixture()
  const { lines } = buildReport({ ...fixture, source: 'settings', panic: false, config: { onLeak: 'redact' } })
  const text = lines.join('\n')
  for (const section of ['【约束】', '【人在回路】', '【验证】', '【纠正】', '【规则】', '【可回滚】', '【生效配置】']) {
    assert.ok(text.includes(section), section)
  }
  // 「允许的请求是否能正常完成」也要有反例统计：ask 未被同意同样算拦截
  assert.match(text, /拦截 2 次（50\.0%）/)
  assert.match(text, /放行 2 次/)
  assert.match(text, /bypass=0/)
  assert.match(text, /通过 1/)
})

test('report：点出从未命中的规则（可能是死规则）', () => {
  const fixture = reportFixture()
  const { lines } = buildReport(fixture)
  const text = lines.join('\n')
  assert.match(text, /从未命中的规则 1 条: never-hit/)
})

test('report：复核循环与升级会被列出来，并给出建议', () => {
  const fixture = reportFixture()
  const { lines, summary } = buildReport(fixture)
  const text = lines.join('\n')
  assert.match(text, /已升级 1 条/)
  assert.match(text, /agent#1 ×3/)
  assert.ok(summary.actions.some((a) => a.includes('重复触墙循环')))
})

test('report：无审批通道时把 ask 退化成硬拒绝这件事说清楚', () => {
  const fixture = reportFixture()
  fixture.metrics.recordApproval('unavailable')
  const { lines, summary } = buildReport(fixture)
  const text = lines.join('\n')
  assert.match(text, /无通道 1/)
  assert.match(text, /退化成了硬拒绝/)
  assert.ok(summary.actions.some((a) => a.includes('无审批通道')))
})

test('report：guard 内部异常与 verify-bypass 会拉响警报并影响结论', () => {
  const fixture = reportFixture()
  fixture.metrics.record({ tool: 'read', decision: 'internal-error' })
  fixture.metrics.recordVerify('bypass')
  const { lines, summary } = buildReport(fixture)
  const text = lines.join('\n')
  assert.match(text, /墙内部异常 1 次/)
  assert.match(text, /bypass=1/)
  assert.equal(summary.verdict, 'attention')
  assert.ok(summary.actions.some((a) => a.includes('verify-bypass')))
})

test('report：零记录时不崩，且如实说没有反例', () => {
  const { lines, summary } = buildReport({ metrics: new Metrics(), engine: null, userRules: [] })
  const text = lines.join('\n')
  assert.match(text, /还没有任何决策记录/)
  assert.match(text, /暂无异常信号/)
  assert.deepEqual(summary.actions, [])
})

test('report：审计容量与落盘路径会被带出来', () => {
  const { lines } = buildReport({
    metrics: new Metrics(),
    engine: null,
    userRules: [],
    audit: { items: new Array(3).fill({}), cap: 10, filePath: 'D:\\logs\\vw.jsonl' },
  })
  const text = lines.join('\n')
  assert.match(text, /审计 3 条（上限 10）/)
  assert.match(text, /D:\\logs\\vw\.jsonl/)
})
