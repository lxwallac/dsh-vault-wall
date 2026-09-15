import test from 'node:test'
import assert from 'node:assert/strict'
import {
  APPROVAL_OUTCOMES,
  approvalClass,
  askReason,
  approvalDenialReason,
  unapprovedDenialReason,
  askBorrowPath,
  ApprovalLedger,
} from '../src/ask.js'

test('ask：审批结果词表与宿主的 ApprovalOutcome 一致', () => {
  assert.deepEqual(APPROVAL_OUTCOMES, ['allowed-once', 'rejected', 'cancelled', 'unavailable'])
})

test('ask：只有 allowed-once 是放行，其余三种 fail-closed', () => {
  assert.equal(approvalClass('allowed-once'), 'granted')
  assert.equal(approvalClass('rejected'), 'rejected')
  assert.equal(approvalClass('cancelled'), 'cancelled')
  assert.equal(approvalClass('unavailable'), 'unavailable')
  // 非词表返回值（宿主契约里会被规范化成 unavailable）按最保守处理
  assert.equal(approvalClass('whatever'), 'unavailable')
  assert.equal(approvalClass(undefined), 'unavailable')
})

test('ask：审批弹窗文案写清路径、规则、工具与风险', () => {
  const reason = askReason({ tool: 'write', path: 'D:\\keys\\id_ed25519', risk: 'medium', entry: { id: 'personal-vault', note: '私钥' } })
  assert.match(reason, /D:\\keys\\id_ed25519/)
  assert.match(reason, /personal-vault/)
  assert.match(reason, /write/)
  assert.match(reason, /medium/)
  assert.match(reason, /私钥/)
})

test('ask：弹窗必须说明「同意之后会记住多少」', () => {
  const base = { tool: 'read', path: 'D:\\keys\\a', risk: 'low' }
  const remembered = askReason({ ...base, entry: { id: 'vault', remember: true, borrowTtlMs: 60000 } })
  assert.match(remembered, /60 秒内不再询问这条路径/)
  assert.match(remembered, /同目录其它文件仍会问/)
  assert.match(remembered, /\/wall borrow add/)

  const onceTtl = askReason({ ...base, entry: { id: 'vault', remember: true, borrowTtlMs: 0 } })
  assert.match(onceTtl, /只授权这一次，不记借出/)

  const never = askReason({ ...base, entry: { id: 'vault', remember: false } })
  assert.match(never, /每次触碰都要单独确认/)
  assert.equal(never.includes('秒内不再询问'), false)

  // 没写 remember 的（老规则/直接调用）不加这段，保持文案最小
  const plain = askReason({ ...base, entry: { id: 'vault' } })
  assert.equal(plain.includes('授权'), false)
})

test('ask：三种「没通过」的文案互不相同，且都要求别重试', () => {
  const info = { tool: 'read', path: 'C:\\vault\\a.txt', entry: { id: 'vault' } }
  const rejected = approvalDenialReason('rejected', info)
  const cancelled = approvalDenialReason('cancelled', info)
  const unavailable = approvalDenialReason('unavailable', info)
  for (const text of [rejected, cancelled, unavailable]) {
    assert.match(text, /C:\\vault\\a\.txt/)
    assert.match(text, /vault/)
    assert.match(text, /do not retry/i)
  }
  assert.notEqual(rejected, cancelled)
  assert.notEqual(rejected, unavailable)
  assert.notEqual(cancelled, unavailable)
  // 让模型能分辨「人说不」与「没人可问」
  assert.match(rejected, /the user rejected/i)
  assert.match(unavailable, /no approval channel/i)
  assert.match(cancelled, /cancelled/i)
})

test('ask：没人问过时的兜底文案点名审批门', () => {
  const text = unapprovedDenialReason({ tool: 'edit', path: 'C:\\vault\\x.txt', entry: { id: 'vault' } })
  assert.match(text, /approval-gated/)
  assert.match(text, /never approved/)
})

test('ask：借出路径取实际命中的那一条', () => {
  assert.equal(askBorrowPath({ path: 'C:\\vault\\x.txt' }), 'C:\\vault\\x.txt')
  assert.equal(askBorrowPath({}), '')
  assert.equal(askBorrowPath(undefined), '')
})

test('ask：审批台账按 exec 对象记账，互不串味', () => {
  const ledger = new ApprovalLedger()
  const execA = { name: 'read', arguments: {} }
  const execB = { name: 'read', arguments: {} }
  assert.equal(ledger.covers(execA, 'C:\\vault\\x.txt'), false)
  ledger.grant(execA, { paths: ['C:\\vault\\x.txt'], ruleIds: ['vault'], risk: 'low' })
  assert.equal(ledger.covers(execA, 'C:\\vault\\x.txt'), true)
  // 只同意了这一条路径：同一规则下的别的路径不算
  assert.equal(ledger.covers(execA, 'C:\\vault\\y.txt'), false)
  // 另一个调用对象没有记录
  assert.equal(ledger.covers(execB, 'C:\\vault\\x.txt'), false)
  assert.equal(ledger.peek(execB), undefined)
})

test('ask：台账在没有路径信息时不误伤（覆盖当次调用全部候选）', () => {
  const ledger = new ApprovalLedger()
  const exec = { name: 'bash', arguments: { command: 'echo x' } }
  ledger.grant(exec, { paths: [], ruleIds: ['vault'] })
  assert.equal(ledger.covers(exec, 'C:\\vault\\anything'), true)
  assert.equal(ledger.covers(exec, undefined), true)
})

test('ask：台账对非对象输入免疫（不抛、不放行）', () => {
  const ledger = new ApprovalLedger()
  assert.doesNotThrow(() => ledger.grant(null, { paths: ['x'] }))
  assert.equal(ledger.covers(null, 'x'), false)
  assert.equal(ledger.covers(undefined, 'x'), false)
})
