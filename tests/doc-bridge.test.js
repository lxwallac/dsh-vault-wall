import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { parseRulesJson, selfPathsFor, assembleRawDoc, dshHomePath, defaultSettingsDocPath } from '../src/doc-bridge.js'

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

test('dshHomePath: 复刻宿主解析顺序（$DSH_HOME > ~/.dsh），空白视为未设置', () => {
  const home = path.join('C:', 'Users', 'demo')
  assert.equal(dshHomePath({}, home), path.join(home, '.dsh'))
  assert.equal(dshHomePath({ DSH_HOME: '   ' }, home), path.join(home, '.dsh'))
  assert.equal(dshHomePath({ DSH_HOME: path.join('D:', 'dsh-home') }, home), path.join('D:', 'dsh-home'))
  // `~` 前缀展开（宿主 expandHomePath 同语义）
  assert.equal(dshHomePath({ DSH_HOME: '~/alt' }, home), path.join(home, 'alt'))
  assert.equal(dshHomePath({ DSH_HOME: '~' }, home), home)
})

test('defaultSettingsDocPath: 默认落在 <dsh home>/settings.yaml（而不是 <home>/settings.yaml）', () => {
  const home = path.join('C:', 'Users', 'demo')
  assert.equal(defaultSettingsDocPath({}, home), path.join(home, '.dsh', 'settings.yaml'))
  // 0.2.31 的 bug 形状：绝不能再返回主目录根下的 settings.yaml
  assert.notEqual(defaultSettingsDocPath({}, home), path.join(home, 'settings.yaml'))
})

test('selfPathsFor: 宿主给出的权威文档路径即使尚不存在也圈禁', () => {
  const list = selfPathsFor({
    auditPath: '',
    settingsDoc: 'C:\\Users\\demo\\.dsh\\settings.yaml',
    settingsDocExists: false,
    settingsDocAuthoritative: true,
  })
  assert.deepEqual(list, ['C:\\Users\\demo\\.dsh\\settings.yaml'])
  // 猜测路径（非权威）仍要求文件存在，避免保护一个不存在的假路径
  const guessed = selfPathsFor({ auditPath: '', settingsDoc: 'C:\\Users\\demo\\.dsh\\settings.yaml', settingsDocExists: false })
  assert.deepEqual(guessed, [])
})
