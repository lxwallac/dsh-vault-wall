import test from 'node:test'
import assert from 'node:assert/strict'
import { RISK_LEVELS, toolRisk, riskRank, atLeastRisk, describeRisk } from '../src/risk.js'

test('risk：只读族判 low', () => {
  for (const tool of ['read', 'read_image', 'glob', 'grep', 'web_search']) {
    assert.equal(toolRisk(tool), 'low', tool)
  }
})

test('risk：写入族判 medium', () => {
  for (const tool of ['write', 'edit', 'str_replace_editor', 'apply_patch']) {
    assert.equal(toolRisk(tool), 'medium', tool)
  }
})

test('risk：开放动作空间与不可逆族判 high', () => {
  for (const tool of ['bash', 'pwsh', 'run_code', 'cordis_define', 'delete_file', 'rm']) {
    assert.equal(toolRisk(tool), 'high', tool)
  }
})

test('risk：未识别工具判 unknown（第三方/MCP 从严）', () => {
  assert.equal(toolRisk('mcp__github__create_issue'), 'unknown')
  assert.equal(toolRisk('some_vendor_tool'), 'unknown')
  assert.equal(toolRisk(''), 'unknown')
  assert.equal(toolRisk(undefined), 'unknown')
})

test('risk：工具名大小写与空白容错', () => {
  assert.equal(toolRisk('READ'), 'low')
  assert.equal(toolRisk('  Bash  '), 'high')
})

test('risk：unknown 的秩高于 high（故障安全默认值）', () => {
  assert.ok(riskRank('unknown') > riskRank('high'))
  assert.ok(riskRank('high') > riskRank('medium'))
  assert.ok(riskRank('medium') > riskRank('low'))
  assert.equal(riskRank('nonsense'), riskRank('unknown'))
})

test('risk：atLeastRisk 严格按秩比较', () => {
  assert.equal(atLeastRisk('low', 'low'), true)
  assert.equal(atLeastRisk('medium', 'medium'), true)
  assert.equal(atLeastRisk('low', 'medium'), false)
  assert.equal(atLeastRisk('high', 'medium'), true)
  // unknown 达到任何门槛：无法证明它安全，只能按最坏情况算。
  assert.equal(atLeastRisk('unknown', 'high'), true)
  assert.equal(atLeastRisk('low', 'unknown'), false)
})

test('risk：每个等级都有非空中文说明', () => {
  for (const level of RISK_LEVELS) {
    assert.equal(typeof describeRisk(level), 'string')
    assert.ok(describeRisk(level).length > 0, level)
  }
})
