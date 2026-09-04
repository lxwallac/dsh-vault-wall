import test from 'node:test'
import assert from 'node:assert/strict'
import { AuditRing } from '../src/audit.js'

test('AuditRing: 记录、上限裁剪、最新在前', () => {
  const ring = new AuditRing(3)
  ring.push({ tool: 'read', decision: 'hidden-deny', path: 'C:\\vault\\a', ruleId: 'r1' })
  ring.push({ tool: 'bash', decision: 'borrow-allow', path: 'C:\\vault' })
  ring.push({ tool: 'grep', decision: 'hidden-deny' })
  ring.push({ tool: 'write', decision: 'deny', ruleId: 'r2' })
  const list = ring.list()
  assert.equal(list.length, 3)
  assert.equal(list[0].tool, 'write')
  assert.equal(list[2].tool, 'bash')
  assert.equal(list[2].ruleId, undefined)
})

test('AuditRing: cap 非法值回退到 500', () => {
  assert.equal(new AuditRing('abc').cap, 500)
  assert.equal(new AuditRing(0).cap, 1)
  assert.equal(new AuditRing(999999).cap, 10000)
})
