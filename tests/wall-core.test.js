import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { RulesEngine } from '../src/rules.js'
import { BorrowStore } from '../src/borrow.js'
import { decideWall, compileAllowRoots } from '../src/wall-core.js'

const base = path.resolve('__vw_wall_test_root__')
const vault = path.join(base, 'vault')
const workspace = path.join(base, 'workspace')
const other = path.join(base, 'other')
const secretFile = path.join(base, 'secret.conf')

const engine = new RulesEngine({
  version: 1,
  rules: [
    { id: 'vault', mode: 'hidden', paths: [vault] },
    { id: 'deny-file', mode: 'deny', paths: [secretFile] },
  ],
})

function stateOf(overrides = {}) {
  return {
    engine,
    panic: false,
    allowRoots: [],
    borrow: new BorrowStore(),
    ...overrides,
  }
}

function exec(name, args, agent = { id: 'a' }) {
  return { name, arguments: args, agent }
}

test('hidden：隔离目录内 read 返回 not-found 伪装', () => {
  const target = path.join(vault, 'deep', 'a.txt')
  const decision = decideWall(exec('read', { file_path: target }), stateOf())
  assert.equal(decision.decision, 'hidden-deny')
  assert.match(decision.reason, /^cannot read "/)
  assert.match(decision.reason, /not found$/)
  assert.equal(decision.ruleId, 'vault')
})

test('hidden：隔离目录外放行', () => {
  const decision = decideWall(exec('read', { file_path: path.join(workspace, 'ok.txt') }), stateOf())
  assert.equal(decision.decision, 'allow')
})

test('deny：规则明示拒绝并点名规则', () => {
  const decision = decideWall(exec('read', { file_path: secretFile }), stateOf())
  assert.equal(decision.decision, 'deny')
  assert.match(decision.reason, /\[vault-wall\] access to .* is denied by rule "deny-file"/)
})

test('工具族文案：glob/grep/write/edit 各自伪装风格', () => {
  const cases = [
    ['glob', { path: vault }, /no files matched under .*path does not exist/],
    ['grep', { path: vault }, /cannot search .*path does not exist/],
    ['write', { file_path: path.join(vault, 'x.txt') }, /cannot write .*directory does not exist/],
    ['edit', { file_path: path.join(vault, 'x.txt') }, /cannot edit .*not found/],
  ]
  for (const [name, args, pattern] of cases) {
    const decision = decideWall(exec(name, args), stateOf())
    assert.equal(decision.decision, 'hidden-deny', name)
    assert.match(decision.reason, pattern, name)
  }
})

test('命令文本启发式：bash 提到隔离根被拦；未提到放行', () => {
  const hit = decideWall(exec('bash', { command: `cat "${path.join(vault, 'x.txt')}"` }), stateOf())
  assert.equal(hit.decision, 'hidden-deny')
  const pass = decideWall(exec('pwsh', { command: 'Get-ChildItem .' }), stateOf())
  assert.equal(pass.decision, 'allow')
})

test('借出 once：首放行、次拒绝（副作用消耗）', () => {
  const agent = { id: 'a' } // 同一会话里 exec.agent 是同一实例；测试须复用同一对象
  const borrow = new BorrowStore()
  borrow.grant(agent, { path: vault, kind: 'once' })
  const first = decideWall(exec('read', { file_path: path.join(vault, 'a.txt') }, agent), stateOf({ borrow }))
  assert.equal(first.decision, 'borrow-allow')
  const second = decideWall(exec('read', { file_path: path.join(vault, 'b.txt') }, agent), stateOf({ borrow }))
  assert.equal(second.decision, 'hidden-deny')
})

test('read 借出不背书 bash（可借道写文件）；read-write 才放行', () => {
  const agent = { id: 'a' }
  const borrow = new BorrowStore()
  borrow.grant(agent, { path: vault, mode: 'read', kind: 'ttl', ttlMs: 10_000 })
  const shellDenied = decideWall(exec('bash', { command: `cat "${path.join(vault, 'x')}"` }, agent), stateOf({ borrow }))
  assert.equal(shellDenied.decision, 'hidden-deny')
  const fileRead = decideWall(exec('read', { file_path: path.join(vault, 'x') }, agent), stateOf({ borrow }))
  assert.equal(fileRead.decision, 'borrow-allow')
  borrow.grant(agent, { path: vault, mode: 'read-write', kind: 'ttl', ttlMs: 10_000 })
  const shellAllowed = decideWall(exec('bash', { command: `cat "${path.join(vault, 'x')}"` }, agent), stateOf({ borrow }))
  assert.equal(shellAllowed.decision, 'borrow-allow')
})

test('panic：可见根外路径与命令 token 被拒，根内放行', () => {
  const allowRoots = compileAllowRoots([workspace])
  const outside = decideWall(exec('read', { file_path: path.join(other, 'x') }), stateOf({ panic: true, allowRoots }))
  assert.equal(outside.decision, 'panic-deny')
  assert.match(outside.reason, /panic:/)
  const inside = decideWall(exec('read', { file_path: path.join(workspace, 'x') }), stateOf({ panic: true, allowRoots }))
  assert.equal(inside.decision, 'allow')
  const cmdBad = decideWall(exec('bash', { command: `type "${path.join(other, 'x')}"` }), stateOf({ panic: true, allowRoots }))
  assert.equal(cmdBad.decision, 'panic-deny')
  const cmdOk = decideWall(exec('bash', { command: 'dir .' }), stateOf({ panic: true, allowRoots }))
  assert.equal(cmdOk.decision, 'allow')
})

test('未知工具与相对路径默认放行（保守，不误伤）', () => {
  const unknown = decideWall(exec('mcp__fs__read', { path: path.join(vault, 'x') }), stateOf())
  assert.equal(unknown.decision, 'allow')
  const relative = decideWall(exec('read', { file_path: path.join('..', 'escape', 'x') }), stateOf())
  assert.equal(relative.decision, 'allow')
})

test('空引擎（无规则文件）时全部放行', () => {
  const empty = stateOf({ engine: null })
  assert.equal(decideWall(exec('read', { file_path: path.join(vault, 'x') }), empty).decision, 'allow')
})

test('祖先递归穿透防护：grep/glob 指向含保护区的父目录被伪装拦下', () => {
  const demo = path.join(base, 'demo')
  const demoVault = path.join(demo, 'vault')
  const demoOther = path.join(demo, 'other') // 无保护区分支，不应误伤
  const engine2 = new RulesEngine({
    version: 1,
    rules: [{ id: 'dv', mode: 'hidden', paths: [demoVault] }],
  })
  const st = stateOf({ engine: engine2 })
  const grepHit = decideWall(exec('grep', { path: demo, pattern: 'x' }), st)
  assert.equal(grepHit.decision, 'hidden-deny')
  assert.match(grepHit.reason, /^cannot search .*path does not exist$/)
  const globHit = decideWall(exec('glob', { path: demo }), st)
  assert.equal(globHit.decision, 'hidden-deny')
  // 递归聚合指向“不含保护区”的分支：正常放行
  const otherOk = decideWall(exec('grep', { path: demoOther, pattern: 'x' }), st)
  assert.equal(otherOk.decision, 'allow')
  // 非递归聚合的单点工具（read 目录）在祖先上不被祖先规则拦（存在性可见，内容仍不可达）
  const readDir = decideWall(exec('read', { file_path: demo }), st)
  assert.equal(readDir.decision, 'allow')
})

test('祖先递归穿透防护：shell 带递归标记且提到父目录被拦；平铺列举放行', () => {
  const demo = path.join(base, 'demo')
  const demoVault = path.join(demo, 'vault')
  const engine2 = new RulesEngine({
    version: 1,
    rules: [{ id: 'dv', mode: 'hidden', paths: [demoVault] }],
  })
  const st = stateOf({ engine: engine2 })
  const rec = decideWall(exec('pwsh', { command: `Get-ChildItem -Recurse "${demo}"` }), st)
  assert.equal(rec.decision, 'hidden-deny')
  const flat = decideWall(exec('pwsh', { command: `Get-ChildItem "${demo}"` }), st)
  assert.equal(flat.decision, 'allow')
  const safe = decideWall(exec('pwsh', { command: `Get-ChildItem -Recurse "${path.join(demo, 'other')}"` }), st)
  assert.equal(safe.decision, 'allow')
})
