import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AuditRing } from '../src/audit.js'

test('AuditRing: 开启落盘时逐条 JSONL 追加', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-audit-'))
  const file = path.join(dir, 'audit.jsonl')
  try {
    const ring = new AuditRing(100, file)
    ring.push({ tool: 'read', decision: 'hidden-deny', path: 'C:\\vault\\a', ruleId: 'r1', agentLabel: 'agent#1' })
    ring.push({ tool: 'bash', decision: 'borrow-allow', path: 'C:\\vault' })
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0])
    assert.equal(first.decision, 'hidden-deny')
    assert.equal(first.agentLabel, 'agent#1')
    assert.equal(ring.filePath, file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('AuditRing: 落盘目标不可写时静默降级为内存（仅首次告警）', () => {
  const badPath = path.join(os.tmpdir(), `vw-no-such-dir-${Date.now()}`, 'audit.jsonl')
  const ring = new AuditRing(10, badPath)
  ring.push({ tool: 'read', decision: 'hidden-deny' })
  assert.equal(ring.items.length, 1)
})
