import test from 'node:test'
import assert from 'node:assert/strict'
import { Metrics, DECISION_KINDS } from '../src/metrics.js'

test('metrics：按决策累计总量与拦截/放行总数', () => {
  const metrics = new Metrics()
  metrics.record({ tool: 'read', decision: 'allow', risk: 'low' })
  metrics.record({ tool: 'read', decision: 'hidden-deny', ruleId: 'vault', risk: 'low' })
  metrics.record({ tool: 'bash', decision: 'deny', ruleId: 'secrets', risk: 'high' })
  metrics.record({ tool: 'read', decision: 'borrow-allow', ruleId: 'vault', risk: 'low' })
  metrics.record({ tool: 'write', decision: 'ask', ruleId: 'vault', risk: 'medium' })
  metrics.record({ tool: 'write', decision: 'ask-approved', ruleId: 'vault', risk: 'medium' })
  metrics.record({ tool: 'pwsh', decision: 'panic-deny', risk: 'high' })
  assert.equal(metrics.total, 7)
  // ask 也算拦截：没人同意就不能执行
  assert.equal(metrics.deniedTotal(), 4)
  assert.equal(metrics.allowedTotal(), 3)
})

test('metrics：按工具与规则分别统计，并可排序取榜', () => {
  const metrics = new Metrics()
  metrics.record({ tool: 'read', decision: 'hidden-deny', ruleId: 'vault' })
  metrics.record({ tool: 'read', decision: 'hidden-deny', ruleId: 'vault' })
  metrics.record({ tool: 'bash', decision: 'deny', ruleId: 'secrets' })
  metrics.record({ tool: 'glob', decision: 'allow' })
  const tools = metrics.toolHits()
  assert.equal(tools[0].tool, 'read')
  assert.equal(tools[0].total, 2)
  assert.equal(tools[0].denied, 2)
  const rules = metrics.ruleHits()
  assert.equal(rules[0].ruleId, 'vault')
  assert.equal(rules[0].denied, 2)
  assert.equal(rules.find((row) => row.ruleId === 'secrets').denied, 1)
})

test('metrics：审批结果与验证发现各自计数', () => {
  const metrics = new Metrics()
  metrics.recordApproval('granted')
  metrics.recordApproval('rejected')
  metrics.recordApproval('unavailable')
  assert.deepEqual(metrics.approvals, { asked: 3, granted: 1, rejected: 1, cancelled: 0, unavailable: 1 })
  metrics.recordVerify('bypass')
  metrics.recordVerify('leak', { redacted: true })
  metrics.recordVerify('leak', { blocked: true })
  assert.deepEqual(metrics.verify, { bypass: 1, leak: 2, leakRedacted: 1, leakBlocked: 1 })
})

test('metrics：未经词表的决策名也会被计数（不丢事实）', () => {
  const metrics = new Metrics()
  metrics.record({ tool: 'x', decision: 'ask-cancelled' })
  assert.equal(metrics.byDecision['ask-cancelled'], 1)
})

test('metrics：升级事件与 agent 计数', () => {
  const metrics = new Metrics()
  metrics.recordEscalation()
  metrics.recordEscalation()
  assert.equal(metrics.byDecision['repeat-escalation'], 2)
  metrics.noteAgent('agent#1')
  metrics.noteAgent('agent#1')
  metrics.noteAgent('agent#2')
  metrics.noteAgent(undefined)
  assert.equal(metrics.agents, 2)
})

test('metrics：键数量有上限，超出并入 (other)（内存有界）', () => {
  const metrics = new Metrics({ keyCap: 2 })
  for (const tool of ['a', 'b', 'c', 'd']) metrics.record({ tool, decision: 'allow' })
  const tools = metrics.toolHits()
  assert.equal(tools.length, 3) // a, b, (other)
  const other = tools.find((row) => row.tool === '(other)')
  assert.equal(other.total, 2)
})

test('metrics：snapshot 可序列化，且字段齐全', () => {
  const metrics = new Metrics()
  metrics.record({ tool: 'read', decision: 'allow' })
  const snap = metrics.snapshot()
  assert.equal(snap.total, 1)
  assert.equal(typeof snap.byDecision, 'object')
  assert.ok(Array.isArray(snap.byTool))
  assert.ok(Array.isArray(snap.byRule))
  assert.ok(snap.firstTs > 0 && snap.lastTs >= snap.firstTs)
  assert.doesNotThrow(() => JSON.stringify(snap))
})

test('metrics：所有词表内的决策种类初始为 0（报告不会读到 undefined）', () => {
  const metrics = new Metrics()
  for (const kind of DECISION_KINDS) assert.equal(metrics.byDecision[kind], 0, kind)
})
