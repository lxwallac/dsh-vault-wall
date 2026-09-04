import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { RulesEngine, normalizeAbs, insideOrEqual, textMentions, ci } from '../src/rules.js'

const SEP = path.sep
const base = path.resolve('__vw_test_root__')

function dir(segments) {
  return path.join(base, ...segments)
}

function engineWith(rules) {
  return new RulesEngine({ version: 1, rules })
}

test('normalizeAbs: 只接受绝对路径，统一分隔符', () => {
  assert.equal(normalizeAbs('relative/path'), '')
  assert.equal(normalizeAbs(''), '')
  assert.equal(normalizeAbs(base), path.normalize(base))
})

test('insideOrEqual: 目录树包含与兄弟隔离', () => {
  const root = dir(['secret'])
  assert.equal(insideOrEqual(root, dir(['secret', 'a.txt'])), true)
  assert.equal(insideOrEqual(root, root), true)
  assert.equal(insideOrEqual(root, dir(['secret2', 'a.txt'])), false)
  assert.equal(insideOrEqual(root, dir(['other'])), false)
})

test('引擎：目录树命中、文件精确命中、glob 段内命中', () => {
  const engine = engineWith([
    { id: 'tree', paths: [dir(['secret-box'])] },
    { id: 'file', paths: [dir(['keys', 'id_ed25519'])] },
    { id: 'logs', paths: [`${dir(['logs'])}${SEP}*.log`] },
  ])
  assert.ok(engine.matchPath(dir(['secret-box', 'x', 'y.txt'])))
  assert.equal(engine.matchPath(dir(['secret-box2', 'x'])), null)
  assert.ok(engine.matchPath(dir(['keys', 'id_ed25519'])))
  assert.equal(engine.matchPath(dir(['keys', 'other'])), null)
  assert.ok(engine.matchPath(dir(['logs', 'a.log'])))
  assert.equal(engine.matchPath(dir(['logs', 'nested', 'a.log'])), null, '段内 * 不跨分隔符')
})

test('引擎：/** 树标记等价于整树', () => {
  const engine = engineWith([{ id: 'vault', paths: [`${dir(['vault'])}${SEP}**`] }])
  assert.ok(engine.matchPath(dir(['vault', 'deep', 'deeper', 'f'])))
})

test('引擎：工具白名单过滤', () => {
  const engine = engineWith([
    { id: 'readonly-vault', paths: [dir(['vault'])], tools: ['read', 'glob', 'grep'] },
  ])
  assert.ok(engine.matchPath(dir(['vault', 'a'])))
  // matchPath 本身不看工具；工具过滤发生在守卫层（governingEntry）。这里只保证字段存在。
  assert.deepEqual([...engine.byId.get('readonly-vault').toolSet], ['read', 'glob', 'grep'])
})

test('引擎：非法文档 fail-loud', () => {
  assert.throws(() => new RulesEngine({ version: 2, rules: [] }), /unsupported rules version/)
  assert.throws(() => new RulesEngine({ version: 1, rules: [{ paths: [dir(['x'])] }] }), /non-empty string `id`/)
  assert.throws(() => new RulesEngine({ version: 1, rules: [{ id: 'a' }] }), /non-empty `paths`/)
  assert.throws(() => new RulesEngine({ version: 1, rules: [{ id: 'a', paths: [dir(['x'])], mode: 'loud' }] }), /mode must be/)
  assert.throws(() => new RulesEngine({ version: 1, rules: [{ id: 'a', paths: ['relative/x'] }] }), /absolute path/)
  assert.throws(() => new RulesEngine({ version: 1, rules: [{ id: 'a', paths: [dir(['x'])], tools: [] }] }), /non-empty string array/)
  assert.throws(() => new RulesEngine({ version: 1, rules: [{ id: 'dup', paths: [dir(['a'])] }, { id: 'dup', paths: [dir(['b'])] }] }), /duplicate rule id/)
  assert.throws(() => new RulesEngine({ version: 1, rules: [{ id: 'a', paths: [`${base}${SEP}q?.txt`] }] }), /unsupported glob/)
})

test('textMentions: 词边界防误伤（Windows 路径在 win32 下大小写不敏感）', () => {
  const root = String.raw`D:\keys`
  assert.equal(textMentions('cat ' + String.raw`D:\keys\id_ed25519`, root), true)
  assert.equal(textMentions('Get-Content ' + String.raw`D:\keys\a.txt`, root), true)
  assert.equal(textMentions('Remove-Item ' + String.raw`D:\keys2\b`, root), false, 'D:\keys2 不应命中 D:\keys')
  if (process.platform === 'win32') {
    assert.equal(textMentions('dir ' + String.raw`d:\KEYS\sub`, root), true, 'win32 大小写不敏感')
  }
})

test('ci: Windows 折叠大小写，其他平台保持', () => {
  if (process.platform === 'win32') assert.equal(ci('A\\B'), ci('a\\b'))
  else assert.notEqual(ci('A'), ci('a'))
})
