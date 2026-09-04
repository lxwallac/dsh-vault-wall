import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRulesJson, selfPathsFor, assembleRawDoc } from '../src/doc-bridge.js'

test('parseRulesJson: 空串视为无规则', () => {
  assert.deepEqual(parseRulesJson(''), [])
  assert.deepEqual(parseRulesJson('   \n '), [])
})

test('parseRulesJson: 合法文档返回 rules 数组', () => {
  const rules = parseRulesJson(JSON.stringify({ version: 1, rules: [{ id: 'a', mode: 'hidden', paths: ['C:\\v'] }] }))
  assert.equal(rules.length, 1)
  assert.equal(rules[0].id, 'a')
})

test('parseRulesJson: 非法输入抛错（不静默放行）', () => {
  assert.throws(() => parseRulesJson('{ not json'), /not valid/)
  assert.throws(() => parseRulesJson('42'), /must be an object/)
  assert.throws(() => parseRulesJson('{"version":2,"rules":[]}'), /unsupported rules version/)
  assert.throws(() => parseRulesJson('{"rules":{}}'), /requires a `rules` array/)
})

test('selfPathsFor: 去重并按 exists 标志取舍', () => {
  const list = selfPathsFor({ legacyFile: 'C:\\a\\rules.json', legacyExists: true, auditPath: 'C:\\a\\rules.json' })
  assert.deepEqual(list, ['C:\\a\\rules.json'])
  const none = selfPathsFor({ legacyFile: 'C:\\a\\rules.json', legacyExists: false, auditPath: '' })
  assert.deepEqual(none, [])
})

test('selfPathsFor: settings 文档存在时一并圈禁', () => {
  const list = selfPathsFor({ legacyFile: 'C:\\a\\rules.json', legacyExists: true, auditPath: '', settingsDoc: 'C:\\a\\settings.yaml', settingsDocExists: true })
  assert.deepEqual(list, ['C:\\a\\rules.json', 'C:\\a\\settings.yaml'])
  const absent = selfPathsFor({ auditPath: '', settingsDoc: 'C:\\a\\settings.yaml', settingsDocExists: false })
  assert.deepEqual(absent, [])
})

test('assembleRawDoc: 用户规则保序 + 注入 hidden 自保护规则且不改原数组', () => {
  const user = [{ id: 'a', mode: 'hidden', paths: ['C:\\v'] }]
  const raw = assembleRawDoc(user, ['C:\\r.json', 'C:\\a.jsonl'])
  assert.equal(raw.rules.length, 3)
  assert.equal(raw.rules[0], user[0])
  assert.equal(raw.rules[1].id, '__self-2')
  assert.equal(raw.rules[1].mode, 'hidden')
  assert.equal(raw.rules[1].paths[0], 'C:\\r.json')
  assert.equal(raw.rules[2].id, '__self-3')
  assert.equal(user.length, 1)
  // 自保护路径去重
  const dup = assembleRawDoc([], ['C:\\x', 'C:\\x'])
  assert.equal(dup.rules.length, 1)
})
