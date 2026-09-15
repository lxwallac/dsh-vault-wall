import test from 'node:test'
import assert from 'node:assert/strict'
import { RuleHistory, HISTORY_VERSION, DEFAULT_HISTORY_LIMIT, shortHash } from '../src/history.js'

const RULES_A = JSON.stringify({ version: 1, rules: [{ id: 'a', mode: 'hidden', paths: ['C:\\vault'] }] })
const RULES_B = JSON.stringify({ version: 1, rules: [{ id: 'b', mode: 'deny', paths: ['C:\\other'] }] })

/** 可推进的假时钟。 */
function clock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms) => { now += ms } }
}

test('history：每次内容变化记一条修订，内容相同不记（避免灌水）', () => {
  const history = new RuleHistory()
  const first = history.record(RULES_A, { source: 'settings' })
  assert.equal(first.recorded, true)
  assert.equal(first.revision.id, 'r1')
  assert.equal(history.size, 1)
  const again = history.record(RULES_A, { source: 'settings' })
  assert.equal(again.recorded, false)
  assert.equal(again.revision.id, 'r1')
  assert.equal(history.size, 1)
  assert.equal(history.record(RULES_B, { source: 'settings' }).recorded, true)
  assert.equal(history.size, 2)
})

test('history：修订记录时间、来源、字节数与短哈希', () => {
  const c = clock()
  const history = new RuleHistory({ now: c.now })
  const { revision } = history.record(RULES_A, { source: 'rollback', note: '退回旧墙' })
  assert.equal(revision.ts, c.now())
  assert.equal(revision.source, 'rollback')
  assert.equal(revision.note, '退回旧墙')
  assert.equal(revision.hash, shortHash(RULES_A))
  assert.equal(revision.bytes, Buffer.byteLength(RULES_A, 'utf8'))
})

test('history：list 最新在前且不带全文，current 标记当前生效版本', () => {
  const c = clock()
  const history = new RuleHistory({ now: c.now })
  history.record(RULES_A, { source: 'settings' })
  c.advance(10)
  history.record(RULES_B, { source: 'settings' })
  const rows = history.list()
  assert.deepEqual(rows.map((row) => row.id), ['r2', 'r1'])
  assert.equal(rows[0].current, true)
  assert.equal(rows[1].current, false)
  assert.equal(rows[0].text, undefined)
})

test('history：get 支持 last / prev / id', () => {
  const history = new RuleHistory()
  assert.equal(history.get('last'), null)
  assert.equal(history.get('prev'), null)
  history.record(RULES_A, { source: 'settings' })
  history.record(RULES_B, { source: 'settings' })
  assert.equal(history.get('last').text, RULES_B)
  assert.equal(history.get('current').text, RULES_B)
  assert.equal(history.get('prev').text, RULES_A)
  assert.equal(history.get('r1').text, RULES_A)
  assert.equal(history.get('nope'), null)
  assert.equal(history.currentText(), RULES_B)
})

test('history：超出 limit 时丢弃最旧的修订', () => {
  const history = new RuleHistory({ limit: 2 })
  history.record('one', { source: 's' })
  history.record('two', { source: 's' })
  history.record('three', { source: 's' })
  assert.equal(history.size, 2)
  assert.deepEqual(history.list().map((row) => row.text === undefined), [true, true])
  assert.equal(history.get('prev').text, 'two')
  assert.equal(history.get('r1'), null)
})

test('history：默认保留条数来自常量', () => {
  const history = new RuleHistory()
  assert.equal(history.limit, DEFAULT_HISTORY_LIMIT)
})

test('history：toJSON/fromJSON 往返一致，且 id 序号继续递增', () => {
  const history = new RuleHistory()
  history.record(RULES_A, { source: 'settings' })
  history.record(RULES_B, { source: 'rollback', note: 'n' })
  const doc = JSON.parse(JSON.stringify(history.toJSON()))
  assert.equal(doc.version, HISTORY_VERSION)
  const restored = new RuleHistory()
  assert.equal(restored.fromJSON(doc), true)
  assert.equal(restored.size, 2)
  assert.equal(restored.currentText(), RULES_B)
  assert.equal(restored.latest().note, 'n')
  // 恢复后新记录的 id 不与历史冲突
  const next = restored.record('three', { source: 'settings' })
  assert.equal(next.revision.id, 'r3')
})

test('history：fromJSON 拒绝版本不符或结构不对的文档', () => {
  const history = new RuleHistory()
  assert.equal(history.fromJSON(null), false)
  assert.equal(history.fromJSON([]), false)
  assert.equal(history.fromJSON({ version: 99, revisions: [] }), false)
  assert.equal(history.fromJSON({ version: HISTORY_VERSION }), false)
  assert.equal(history.fromJSON({ version: HISTORY_VERSION, revisions: [{ text: 'x' }] }), true)
})

test('history：load 区分「文件不存在」与「文件损坏」', () => {
  const history = new RuleHistory()
  history.record(RULES_A, { source: 'settings' })
  const good = JSON.stringify(history.toJSON())
  assert.deepEqual(history.load('x.json', () => good), { loaded: true, error: '' })
  const missing = Object.assign(new Error('nope'), { code: 'ENOENT' })
  assert.deepEqual(new RuleHistory().load('x.json', () => { throw missing }), { loaded: false, error: '' })
  const broken = new RuleHistory().load('x.json', () => '{ not json')
  assert.equal(broken.loaded, false)
  assert.match(broken.error, /not valid JSON/)
  const wrongShape = new RuleHistory().load('x.json', () => '{"version":5}')
  assert.equal(wrongShape.loaded, false)
  assert.match(wrongShape.error, /unsupported history document/)
})

test('history：persist 写失败只回报错误，不抛', () => {
  const history = new RuleHistory()
  history.record(RULES_A, { source: 'settings' })
  let written = null
  const okResult = history.persist('rules-history.json', (file, text) => { written = { file, text } })
  assert.deepEqual(okResult, { written: true, error: '' })
  assert.equal(written.file, 'rules-history.json')
  assert.equal(JSON.parse(written.text).version, HISTORY_VERSION)
  const failResult = history.persist('rules-history.json', () => { throw new Error('disk full') })
  assert.equal(failResult.written, false)
  assert.match(failResult.error, /disk full/)
  // 未配置路径时什么也不做
  assert.deepEqual(history.persist('', () => { throw new Error('should not run') }), { written: false, error: '' })
})

test('history：shortHash 稳定且对内容敏感', () => {
  assert.equal(shortHash('abc'), shortHash('abc'))
  assert.notEqual(shortHash('abc'), shortHash('abd'))
  assert.match(shortHash('abc'), /^[0-9a-f]{8}$/)
})
