/**
 * `/wall` 控制台命令测试（v0.3 起命令语义独立在 src/console.js，纯逻辑可直接单测）。
 *
 * 覆盖：status / rules / decisions / test（试算）/ export（导出）/ reload / panic / borrow，
 * 以及两条回归：
 *  - 0.2.31 的 `borrow add` 无 agent 崩溃（WeakMap TypeError）现在必须变成可读错误；
 *  - handler 面对任何内部异常都不得抛出（命令管道不能被一条坏命令打崩）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { RulesEngine } from '../src/rules.js'
import { BorrowStore } from '../src/borrow.js'
import { AuditRing } from '../src/audit.js'
import { assembleRawDoc } from '../src/doc-bridge.js'
import { handleWallCommand, splitArgs, syntheticExec } from '../src/console.js'

const base = path.resolve('__vw_console_test_root__')
const vault = path.join(base, 'vault')
const workspace = path.join(base, 'workspace')
const denyFile = path.join(base, 'secret.conf')

function makeState(overrides = {}) {
  const engine = new RulesEngine(assembleRawDoc([
    { id: 'vault', mode: 'hidden', paths: [vault] },
    { id: 'deny-file', mode: 'deny', paths: [denyFile] },
  ], []))
  const state = {
    engine,
    userRulesArr: [
      { id: 'vault', mode: 'hidden', paths: [vault] },
      { id: 'deny-file', mode: 'deny', paths: [denyFile] },
    ],
    source: 'settings',
    sourceDetail: 'settings doc "vault-wall".rulesJson',
    lastError: '',
    legacyFile: path.join(base, 'rules.json'),
    panic: false,
    allowRoots: [],
    borrow: new BorrowStore(),
    audit: new AuditRing(50, ''),
    settingsRead: () => ({ rulesJson: '{"version":1,"rules":[]}' }),
    applyUserRules: (text, label) => { state.applied = { text, label } },
    readLegacyText: () => '{"version":1,"rules":[]}',
    writeFile: (file, text) => { state.written = { file, text } },
  }
  return Object.assign(state, overrides)
}

const run = (state, rawInput, invocation = {}) => handleWallCommand(state, { rawInput, ...invocation })

test('splitArgs: 引号包裹的路径（含空格）保持整体', () => {
  assert.deepEqual(splitArgs('test "C:\\a b\\c.txt" grep'), ['test', 'C:\\a b\\c.txt', 'grep'])
  assert.deepEqual(splitArgs("add 'C:\\x' --rw"), ['add', 'C:\\x', '--rw'])
})

test('syntheticExec: 按工具族给出正确参数形状', () => {
  assert.deepEqual(syntheticExec('read', 'C:\\a'), { name: 'read', arguments: { file_path: 'C:\\a' } })
  assert.deepEqual(syntheticExec('str_replace_editor', 'C:\\a'), { name: 'str_replace_editor', arguments: { path: 'C:\\a' } })
  assert.deepEqual(syntheticExec('bash', 'cat C:\\a'), { name: 'bash', arguments: { command: 'cat C:\\a' } })
  assert.deepEqual(syntheticExec('run_code', 'x'), { name: 'run_code', arguments: { code: 'x' } })
  assert.deepEqual(syntheticExec('cordis_define', 'x'), { name: 'cordis_define', arguments: { code: { host: 'x' } } })
  assert.deepEqual(syntheticExec('write', 'C:\\a'), { name: 'write', arguments: { file_path: 'C:\\a' } })
})

test('status: 报告规则数、来源、panic、借出与审计容量', () => {
  const state = makeState()
  state.audit.push({ tool: 'read', decision: 'hidden-deny' })
  const res = run(state, 'status')
  assert.equal(res.kind, 'success')
  assert.match(res.text, /engine: 2 rule\(s\) active/)
  assert.match(res.text, /user rules: 2/)
  assert.match(res.text, /source: settings/)
  assert.match(res.text, /panic: off/)
  assert.match(res.text, /audit: 1 entries \(cap 50\)/)
})

test('rules: 列出规则 id/模式/工具范围', () => {
  const res = run(makeState(), 'rules')
  assert.equal(res.kind, 'success')
  assert.match(res.text, /- \[vault\] mode=hidden tools=all/)
  assert.match(res.text, /- \[deny-file\] mode=deny tools=all/)
})

test('decisions: 最新在前并带路径与规则', () => {
  const state = makeState()
  state.audit.push({ tool: 'read', decision: 'hidden-deny', path: path.join(vault, 'a'), ruleId: 'vault' })
  const res = run(state, 'decisions 5')
  assert.equal(res.kind, 'success')
  assert.match(res.text, /read → hidden-deny/)
  assert.match(res.text, /rule=vault/)
  assert.equal(run(makeState(), 'decisions').text, 'No decisions recorded yet.')
})

test('test: 试算 hidden / deny / allow 三种结论', () => {
  const state = makeState()
  const hidden = run(state, `test ${path.join(vault, 'deep', 'a.txt')}`)
  assert.equal(hidden.kind, 'success')
  assert.match(hidden.text, /decision: hidden-deny/)
  assert.match(hidden.text, /rule: vault/)
  assert.match(hidden.text, /agent 会看到: cannot read/)

  const denied = run(state, `test ${denyFile}`)
  assert.match(denied.text, /decision: deny/)
  assert.match(denied.text, /denied by rule "deny-file"/)

  const allowed = run(state, `test ${path.join(workspace, 'ok.txt')} write`)
  assert.match(allowed.text, /decision: allow/)
  assert.match(allowed.text, /不命中任何规则/)
})

test('test: 试算不消耗借出（once 借出试算后仍可用）', () => {
  const state = makeState()
  const agent = { id: 'a' }
  const grant = state.borrow.grant(agent, { path: vault, kind: 'once' })
  const probed = run(state, `test ${path.join(vault, 'a.txt')}`, { agent })
  assert.match(probed.text, /decision: hidden-deny/)
  const grants = state.borrow.list(agent)
  assert.equal(grants.length, 1)
  assert.equal(grants[0].used, false)
  assert.equal(grant.kind, 'once')
})

test('test: panic 开启时按白名单判定；相对路径报错', () => {
  const state = makeState({ panic: true, allowRoots: [workspace] })
  assert.match(run(state, `test ${path.join(workspace, 'ok.txt')}`).text, /decision: allow/)
  assert.match(run(state, `test ${path.join(vault, 'a.txt')}`).text, /decision: panic-deny/)
  const bad = run(state, 'test relative/path')
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /需要绝对路径/)
  const missing = run(state, 'test')
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /Usage: \/wall test/)
})

test('export: 写出用户规则 JSON（不含自保护规则）', () => {
  const state = makeState()
  const target = path.join(workspace, 'exported.json')
  const res = run(state, `export "${target}"`)
  assert.equal(res.kind, 'success')
  assert.match(res.text, /已导出 2 条用户规则/)
  assert.equal(state.written.file, target)
  const doc = JSON.parse(state.written.text)
  assert.equal(doc.version, 1)
  assert.deepEqual(doc.rules.map((r) => r.id), ['vault', 'deny-file'])
})

test('export: 拒绝写进受保护路径、拒绝相对路径、写失败转成错误文本', () => {
  const protectedTarget = path.join(vault, 'rules-backup.json')
  const refused = run(makeState(), `export "${protectedTarget}"`)
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /拒绝导出到受保护路径/)
  assert.match(refused.text, /"vault"/)

  const relative = run(makeState(), 'export backup.json')
  assert.equal(relative.kind, 'error')
  assert.match(relative.text, /需要绝对路径/)

  const failing = makeState({ writeFile: () => { throw new Error('EACCES: denied') } })
  const failed = run(failing, `export "${path.join(workspace, 'x.json')}"`)
  assert.equal(failed.kind, 'error')
  assert.match(failed.text, /导出失败：EACCES/)
})

test('borrow: 有 agent 时正常借出，list/revoke/clear 可用', () => {
  const state = makeState()
  const agent = { id: 'a' }
  const added = run(state, `borrow add "${vault}" --ttl 5000`, { agent })
  assert.equal(added.kind, 'success')
  assert.match(added.text, /Borrowed b\d+/)
  const listed = run(state, 'borrow list', { agent })
  assert.match(listed.text, /read ttl/)
  const id = state.borrow.list(agent)[0].id
  assert.match(run(state, `borrow revoke ${id}`, { agent }).text, /Revoked/)
  assert.equal(run(state, 'borrow list', { agent }).text, 'No active borrows for this agent.')
  assert.equal(run(state, 'borrow revoke b999', { agent }).kind, 'error')
})

test('borrow: --ttl 0 表示一次性借出；--rw 表示读写', () => {
  const state = makeState()
  const agent = { id: 'a' }
  run(state, `borrow add "${vault}" --ttl 0 --rw`, { agent })
  const grant = state.borrow.list(agent)[0]
  assert.equal(grant.kind, 'once')
  assert.equal(grant.mode, 'read-write')
})

test('回归 v0.3：无 agent 的 borrow add 返回可读错误而不是崩溃', () => {
  const state = makeState()
  const res = run(state, `borrow add "${vault}"`)
  assert.equal(res.kind, 'error')
  assert.match(res.text, /borrow grant requires an agent context/)
  assert.equal(state.borrow.list(undefined).length, 0)
})

test('borrow: 非法 ttl / 多余参数 / 缺路径都给用法错误', () => {
  const state = makeState()
  const agent = { id: 'a' }
  assert.match(run(state, `borrow add "${vault}" --ttl -5`, { agent }).text, /--ttl requires/)
  assert.match(run(state, `borrow add "${vault}" extra`, { agent }).text, /Unexpected argument/)
  assert.match(run(state, 'borrow add', { agent }).text, /Usage: \/wall borrow add/)
})

test('reload: 按当前来源重载（settings 读 settings，file 读规则文件）', () => {
  const fromSettings = makeState()
  const resA = run(fromSettings, 'reload')
  assert.equal(resA.kind, 'success')
  assert.equal(fromSettings.applied.label, 'settings')
  assert.match(resA.text, /Reloaded\. source=settings/)

  const fromFile = makeState({ source: 'file' })
  run(fromFile, 'reload')
  assert.equal(fromFile.applied.label, 'file')
  assert.equal(fromFile.applied.text, '{"version":1,"rules":[]}')
})

test('panic: 开/关与查询', () => {
  const state = makeState()
  assert.match(run(state, 'panic').text, /panic: off/)
  assert.match(run(state, 'panic on').text, /panic ON/)
  assert.equal(state.panic, true)
  assert.match(run(state, 'panic').text, /panic: ON/)
  assert.match(run(state, 'panic off').text, /panic OFF/)
  assert.equal(state.panic, false)
})

test('未知子命令与 help 都给出用法', () => {
  const bad = run(makeState(), 'nonsense')
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /未知子命令 "nonsense"/)
  assert.match(bad.text, /Usage: \/wall <subcommand>/)
  for (const sub of ['', 'help']) {
    const res = run(makeState(), sub)
    assert.equal(res.kind, 'success')
    assert.match(res.text, /test <绝对路径> \[工具\]/)
  }
})

test('handler 永不抛出：依赖抛异常也转成错误文本', () => {
  const state = makeState({
    borrow: { list: () => { throw new Error('borrow store broken') } },
  })
  const res = run(state, 'status')
  assert.equal(res.kind, 'error')
  assert.match(res.text, /\/wall 内部错误：borrow store broken/)
})
