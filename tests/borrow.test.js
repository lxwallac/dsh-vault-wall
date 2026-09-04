import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { BorrowStore } from '../src/borrow.js'

const base = path.resolve('__vw_borrow_test__')
const vault = path.join(base, 'vault')

function makeAgent(name) {
  return { id: name }
}

function fakeClock() {
  let now = 0
  return { now: () => now, advance: (ms) => { now += ms } }
}

test('ttl 借出：到期前放行，到期后拒绝', () => {
  const clock = fakeClock()
  const store = new BorrowStore({ now: clock.now })
  const agent = makeAgent('a')
  store.grant(agent, { path: vault, mode: 'read', kind: 'ttl', ttlMs: 100 })
  assert.equal(store.allow(agent, path.join(vault, 'a.txt'), 'read'), true)
  clock.advance(101)
  assert.equal(store.allow(agent, path.join(vault, 'a.txt'), 'read'), false)
})

test('once 借出：只放行一次', () => {
  const clock = fakeClock()
  const store = new BorrowStore({ now: clock.now })
  const agent = makeAgent('a')
  store.grant(agent, { path: vault, kind: 'once' })
  const target = path.join(vault, 'f.txt')
  assert.equal(store.allow(agent, target, 'read'), true)
  assert.equal(store.allow(agent, target, 'read'), false)
})

test('read 模式不放行 write/edit/bash/pwsh；read-write 放行', () => {
  const clock = fakeClock()
  const store = new BorrowStore({ now: clock.now })
  const agent = makeAgent('a')
  store.grant(agent, { path: vault, mode: 'read', kind: 'ttl', ttlMs: 1000 })
  assert.equal(store.allow(agent, path.join(vault, 'x'), 'write'), false)
  assert.equal(store.allow(agent, path.join(vault, 'x'), 'edit'), false)
  assert.equal(store.allow(agent, path.join(vault, 'x'), 'bash'), false)
  assert.equal(store.allow(agent, path.join(vault, 'x'), 'pwsh'), false)
  assert.equal(store.allow(agent, path.join(vault, 'x'), 'read'), true)
  store.grant(agent, { path: vault, mode: 'read-write', kind: 'ttl', ttlMs: 1000 })
  assert.equal(store.allow(agent, path.join(vault, 'x'), 'write'), true)
  assert.equal(store.allow(agent, path.join(vault, 'x'), 'bash'), true)
})

test('只对借出树内的路径放行；树外兄弟不受影响', () => {
  const clock = fakeClock()
  const store = new BorrowStore({ now: clock.now })
  const agent = makeAgent('a')
  store.grant(agent, { path: vault, kind: 'ttl', ttlMs: 1000 })
  assert.equal(store.allow(agent, path.join(base, 'vault2', 'x'), 'read'), false)
})

test('无 agent / revoke / list / sweep', () => {
  const clock = fakeClock()
  const store = new BorrowStore({ now: clock.now })
  const agent = makeAgent('a')
  assert.equal(store.allow(undefined, path.join(vault, 'x'), 'read'), false)
  const grant = store.grant(agent, { path: vault, kind: 'ttl', ttlMs: 50 })
  assert.equal(store.revoke(agent, 'nope'), false)
  assert.equal(store.revoke(agent, grant.id), true)
  assert.deepEqual(store.list(agent), [])
  store.grant(agent, { path: vault, kind: 'ttl', ttlMs: 10 })
  clock.advance(11)
  assert.equal(store.list(agent).length, 1, 'list 返回未清理项')
  store.sweep()
  assert.deepEqual(store.list(agent), [], 'sweep 清除过期')
})

test('非法参数 fail-loud', () => {
  const store = new BorrowStore()
  const agent = makeAgent('a')
  assert.throws(() => store.grant(agent, { path: 'relative', kind: 'ttl' }), /absolute path/)
  assert.throws(() => store.grant(agent, { path: vault, mode: 'x' }), /mode must be/)
  assert.throws(() => store.grant(agent, { path: vault, kind: 'x' }), /kind must be/)
  assert.throws(() => store.grant(agent, { path: vault, kind: 'ttl', ttlMs: -1 }), /ttlMs/)
})
