import test from 'node:test'
import assert from 'node:assert/strict'
import { DenialStreaks, repeatNoticeText, escalationFeedback, DEFAULT_REPEAT_THRESHOLD } from '../src/correct.js'

/** 可推进的假时钟。 */
function clock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms) => { now += ms } }
}

test('correct：按 (agent, 规则, 路径) 分别计数', () => {
  const streaks = new DenialStreaks({ threshold: 3 })
  assert.deepEqual(streaks.note('agent#1', { path: 'C:\\vault\\a', ruleId: 'vault' }), { count: 1, escalated: false, threshold: 3, first: true })
  assert.equal(streaks.note('agent#1', { path: 'C:\\vault\\a', ruleId: 'vault' }).count, 2)
  // 换一条路径重新计数：agent 在探索若干不同位置不该被当成循环
  assert.equal(streaks.note('agent#1', { path: 'C:\\vault\\b', ruleId: 'vault' }).count, 1)
  // 换一个 agent 互不影响
  assert.equal(streaks.note('agent#2', { path: 'C:\\vault\\a', ruleId: 'vault' }).count, 1)
})

test('correct：达到阈值即升级，且升级标记粘住', () => {
  const streaks = new DenialStreaks({ threshold: 3 })
  const info = { path: 'C:\\vault\\a', ruleId: 'vault' }
  assert.equal(streaks.note('a', info).escalated, false)
  assert.equal(streaks.note('a', info).escalated, false)
  const third = streaks.note('a', info)
  assert.equal(third.count, 3)
  assert.equal(third.escalated, true)
  assert.equal(streaks.note('a', info).escalated, true)
  assert.equal(streaks.escalatedCount(), 1)
})

test('correct：threshold=0 表示关闭升级', () => {
  const streaks = new DenialStreaks({ threshold: 0 })
  for (let i = 0; i < 5; i += 1) {
    assert.equal(streaks.note('a', { path: 'p', ruleId: 'r' }).escalated, false)
  }
  assert.equal(streaks.threshold, 0)
  assert.equal(streaks.escalatedCount(), 0)
})

test('correct：peek 只看「再拒一次会是第几次」，不写状态', () => {
  const streaks = new DenialStreaks({ threshold: 3 })
  assert.deepEqual(streaks.peek('a', { path: 'p', ruleId: 'r' }), { count: 1, escalated: false, threshold: 3 })
  assert.deepEqual(streaks.peek('a', { path: 'p', ruleId: 'r' }), { count: 1, escalated: false, threshold: 3 })
  streaks.note('a', { path: 'p', ruleId: 'r' })
  assert.equal(streaks.peek('a', { path: 'p', ruleId: 'r' }).count, 2)
  // guard 用它把纠正指令写进「即将跨阈值」的那一次
  streaks.note('a', { path: 'p', ruleId: 'r' })
  assert.equal(streaks.peek('a', { path: 'p', ruleId: 'r' }).escalated, true)
})

test('correct：超过观察窗口的旧计数作废', () => {
  const c = clock()
  const streaks = new DenialStreaks({ threshold: 3, windowMs: 1000, now: c.now })
  streaks.note('a', { path: 'p', ruleId: 'r' })
  streaks.note('a', { path: 'p', ruleId: 'r' })
  c.advance(1001)
  assert.equal(streaks.peek('a', { path: 'p', ruleId: 'r' }).count, 1)
  assert.equal(streaks.note('a', { path: 'p', ruleId: 'r' }).count, 1)
})

test('correct：reset 清掉某个 agent 的计数（新用户消息）', () => {
  const streaks = new DenialStreaks({ threshold: 3 })
  streaks.note('a', { path: 'p', ruleId: 'r' })
  streaks.note('b', { path: 'p', ruleId: 'r' })
  assert.equal(streaks.reset('a'), 1)
  assert.equal(streaks.peek('a', { path: 'p', ruleId: 'r' }).count, 1)
  assert.equal(streaks.peek('b', { path: 'p', ruleId: 'r' }).count, 2)
  assert.equal(streaks.reset('nobody'), 0)
})

test('correct：sweep 清掉全部过期条目', () => {
  const c = clock()
  const streaks = new DenialStreaks({ threshold: 2, windowMs: 500, now: c.now })
  streaks.note('a', { path: 'p', ruleId: 'r' })
  streaks.note('b', { path: 'q', ruleId: 'r' })
  assert.equal(streaks.list().length, 2)
  c.advance(501)
  streaks.sweep()
  assert.equal(streaks.list().length, 0)
})

test('correct：计数表有上限，超限淘汰最久未触碰的条目', () => {
  const c = clock()
  const streaks = new DenialStreaks({ threshold: 3, cap: 2, now: c.now })
  streaks.note('a', { path: 'old', ruleId: 'r' })
  c.advance(10)
  streaks.note('a', { path: 'mid', ruleId: 'r' })
  c.advance(10)
  streaks.note('a', { path: 'new', ruleId: 'r' })
  const paths = streaks.list().map((row) => row.path).sort()
  assert.deepEqual(paths, ['mid', 'new'])
})

test('correct：默认阈值是 3，且 list 最新在前', () => {
  const c = clock()
  const streaks = new DenialStreaks({ now: c.now })
  assert.equal(streaks.threshold, DEFAULT_REPEAT_THRESHOLD)
  streaks.note('a', { path: 'p1', ruleId: 'r' })
  c.advance(5)
  streaks.note('a', { path: 'p2', ruleId: 'r' })
  assert.deepEqual(streaks.list().map((row) => row.path), ['p2', 'p1'])
})

test('correct：纠正文案要说清「这是策略决定、别再重试、去告诉用户」', () => {
  const notice = repeatNoticeText({ tool: 'read', path: 'C:\\vault\\a', ruleId: 'vault', count: 3, threshold: 3 })
  assert.match(notice, /repeat denial #3/)
  assert.match(notice, /policy decision, not a transient failure/)
  assert.match(notice, /Stop retrying/)
  assert.match(notice, /report to the user/)
})

test('correct：升级反馈点名次数、工具与规则，并给出出路', () => {
  const text = escalationFeedback({ tool: 'bash', path: 'C:\\vault', ruleId: 'vault', count: 4 })
  assert.match(text, /denied 4 times/)
  assert.match(text, /bash/)
  assert.match(text, /C:\\vault/)
  assert.match(text, /vault/)
  assert.match(text, /\/wall borrow/)
  assert.equal(text.includes('circuit breaker'), false)
})

test('correct：升级动作是 panic 时，文案里会说明熔断已触发', () => {
  const text = escalationFeedback({ tool: 'bash', path: 'C:\\vault', count: 3, action: 'panic' })
  assert.match(text, /circuit breaker/)
  assert.match(text, /\/wall panic off/)
})
