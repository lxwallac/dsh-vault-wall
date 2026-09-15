import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { RulesEngine } from '../src/rules.js'
import {
  isExecuted,
  verifyBypass,
  hiddenRootsFor,
  findLeak,
  redactText,
  redactContent,
  rootIsAuthorized,
  rootMatcher,
  textParts,
  DEFAULT_REDACTION_MARKER,
} from '../src/verify.js'

const base = path.resolve('__vw_verify_test_root__')
const vault = path.join(base, 'vault')
const other = path.join(base, 'other')
const secretFile = path.join(base, 'secret.conf')

const engine = new RulesEngine({
  version: 1,
  rules: [
    { id: 'vault', mode: 'hidden', paths: [vault] },
    { id: 'only-write', mode: 'hidden', paths: [secretFile], tools: ['write', 'edit'] },
    { id: 'visible-denial', mode: 'deny', paths: [other] },
  ],
})

const textResult = (text) => ({ isError: false, content: [{ type: 'text', text }] })
const errorResult = (text) => ({ isError: true, content: [{ type: 'text', text }] })

test('verify：isExecuted 只看 isError 字段（结构化事实）', () => {
  assert.equal(isExecuted(textResult('x')), true)
  assert.equal(isExecuted(errorResult('x')), false)
  assert.equal(isExecuted(undefined), false)
  assert.equal(isExecuted(null), false)
  assert.equal(isExecuted('nope'), false)
})

test('verify：墙判拒绝却执行成功 → bypass', () => {
  const check = verifyBypass({ decision: 'hidden-deny', path: vault, ruleId: 'vault' }, textResult('内容'))
  assert.equal(check.kind, 'bypass')
  assert.equal(check.decision, 'hidden-deny')
  assert.equal(check.ruleId, 'vault')
})

test('verify：拒绝类决策全部纳入 bypass 判定（含 ask 与 panic-deny）', () => {
  for (const decision of ['hidden-deny', 'deny', 'ask', 'panic-deny']) {
    assert.equal(verifyBypass({ decision }, textResult('x')).kind, 'bypass', decision)
  }
})

test('verify：被拒绝的调用得到的是错误结果，不算 bypass', () => {
  assert.equal(verifyBypass({ decision: 'hidden-deny' }, errorResult('Error: cannot read ...')).kind, 'ok')
})

test('verify：放行类决策与无记录时都不报 bypass', () => {
  for (const decision of ['allow', 'borrow-allow', 'ask-approved']) {
    assert.equal(verifyBypass({ decision }, textResult('x')).kind, 'ok', decision)
  }
  assert.equal(verifyBypass(undefined, textResult('x')).kind, 'ok')
})

test('verify：受保护根只取 hidden 规则、且只取管辖该工具的规则', () => {
  const forRead = hiddenRootsFor(engine, 'read')
  assert.ok(forRead.includes(vault))
  // only-write 只限定 write/edit，read 的结果不该拿它去扫
  assert.equal(forRead.includes(secretFile), false)
  // deny 模式的路径不是秘密，不进泄漏扫描
  assert.equal(forRead.includes(other), false)
  const forWrite = hiddenRootsFor(engine, 'write')
  assert.ok(forWrite.includes(secretFile))
  assert.deepEqual(hiddenRootsFor(null, 'read'), [])
})

test('verify：结果里出现受保护根 → leak；被拒绝的结果不算', () => {
  const roots = hiddenRootsFor(engine, 'read')
  assert.equal(findLeak(textResult(`see ${path.join(vault, 'a.txt')} here`), roots).kind, 'leak')
  assert.equal(findLeak(textResult('nothing to see'), roots).kind, 'ok')
  assert.equal(findLeak(errorResult(`Error: cannot read "${vault}"`), roots).kind, 'ok')
  assert.equal(findLeak(textResult('x'), []).kind, 'ok')
})

test('verify：leak 统计命中次数', () => {
  const roots = hiddenRootsFor(engine, 'read')
  const found = findLeak(textResult(`${vault} and again ${vault}`), roots)
  assert.equal(found.kind, 'leak')
  assert.equal(found.hits, 2)
})

test('verify：分隔符与转义形态都能认出（C:/ 与 C:\\\\）', () => {
  const roots = [vault]
  assert.equal(findLeak(textResult(vault.replace(/\\/g, '/') + '/a.txt'), roots).kind, 'leak')
  assert.equal(findLeak(textResult(vault.replace(/\\/g, '\\\\') + '\\\\a.txt'), roots).kind, 'leak')
})

test('verify：rootMatcher 长根优先，避免只脱敏掉短前缀', () => {
  const matcher = rootMatcher([path.join(base, 'a'), path.join(base, 'a', 'deep')])
  assert.ok(matcher !== null)
  assert.equal(matcher.test(path.join(base, 'a', 'deep', 'x.txt')), true)
  assert.equal(rootMatcher([]), null)
  assert.equal(rootMatcher(['']), null)
})

test('verify：redactText 替换全部命中并保留原文大小写结构', () => {
  const target = path.join(vault, 'a.txt')
  const { text, hits } = redactText(`before ${target} after ${target}`, [vault])
  assert.equal(hits, 2)
  assert.equal(text, `before ${DEFAULT_REDACTION_MARKER} after ${DEFAULT_REDACTION_MARKER}`)
  assert.equal(redactText('clean', [vault]).hits, 0)
})

test('verify：redactContent 只动文本片段，图片等原样保留；无命中返回 null', () => {
  const content = [
    { type: 'text', text: `path ${vault}` },
    { type: 'image', source: { type: 'base64', data: 'AAAA' } },
  ]
  const redacted = redactContent(content, [vault])
  assert.ok(redacted !== null)
  assert.equal(redacted.content[0].text, `path ${DEFAULT_REDACTION_MARKER}`)
  assert.deepEqual(redacted.content[1], content[1])
  assert.equal(redactContent(content, [path.join(base, 'nowhere')]), null)
  assert.equal(redactContent(undefined, [vault]), null)
})

test('verify：redactContent 支持纯字符串内容', () => {
  const redacted = redactContent(`p=${vault}`, [vault])
  assert.ok(redacted !== null)
  assert.equal(redacted.content, `p=${DEFAULT_REDACTION_MARKER}`)
})

test('verify：授权范围内的根不算泄漏，范围外仍然算', () => {
  const inner = path.join(vault, 'a.txt')
  // 借出的是整个 vault 树 → 里面的根都在授权范围内
  assert.equal(rootIsAuthorized({ decision: 'borrow-allow', path: vault }, inner), true)
  // 借出的只是一个文件 → 它自己算授权，树里别的不算
  assert.equal(rootIsAuthorized({ decision: 'ask-approved', path: inner }, inner), true)
  assert.equal(rootIsAuthorized({ decision: 'ask-approved', path: inner }, path.join(vault, 'b.txt')), false)
  // 拒绝类决策不构成授权
  assert.equal(rootIsAuthorized({ decision: 'hidden-deny', path: vault }, inner), false)
  assert.equal(rootIsAuthorized(undefined, inner), false)
})

test('verify：textParts 只收文本片段', () => {
  assert.deepEqual(textParts('raw'), ['raw'])
  assert.deepEqual(textParts([{ type: 'text', text: 'a' }, { type: 'image' }, 'nope']), ['a'])
  assert.deepEqual(textParts(undefined), [])
})
