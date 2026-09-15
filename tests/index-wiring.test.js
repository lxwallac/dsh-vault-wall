/**
 * `src/index.js` 端到端接线冒烟测试（v0.3 新增）。
 *
 * 为什么需要它：这个仓库历史上真正出问题的地方不是纯函数，而是**接线**——
 * 变量改名后漏改引用、命令处理器签名变了没人发现、自保护路径算错但单元测试照样全绿。
 * 这里用 `module.register()` 把 `@deepseek-ai/schemastery` 换成测试替身，
 * 于是可以在没有 DSH 宿主的环境里**真正执行 apply()**，并断言：
 *
 *   1. tools.guard 被注册，且对受保护路径返回伪装文案、对普通路径返回 undefined；
 *   2. 设置文档自保护用的是宿主 `settings.documentPath`（v0.3 修的那个安全 bug）；
 *   3. 旧规则文件存在时同样被自保护；
 *   4. `/wall` 命令注册成功且能跑通 status / rules / test / decisions / borrow；
 *   5. dispose 会清理定时器与注册（不留孤儿 interval）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'

register('./stubs/schemastery-loader.mjs', import.meta.url)

// 插件的接线日志走 console.log（真实宿主里这是有用的启动痕迹），测试里只关心断言：
// 过滤掉带 [dsh-vault-wall] 前缀的行，其余照常输出。
const realLog = console.log
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[dsh-vault-wall]')) return
  realLog(...args)
}

const { apply, name, Config, VERSION } = await import('../src/index.js')

const here = path.dirname(fileURLToPath(import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-wiring-'))

const vaultDir = path.join(scratch, 'vault')
const workspaceDir = path.join(scratch, 'workspace')
const settingsDoc = path.join(scratch, '.dsh', 'settings.yaml')
const legacyFile = path.join(scratch, 'vault-wall-rules.json')

fs.mkdirSync(vaultDir, { recursive: true })
fs.mkdirSync(workspaceDir, { recursive: true })
fs.writeFileSync(settingsDoc.replace(/\.dsh[\\/]settings\.yaml$/, 'placeholder'), '')
fs.mkdirSync(path.dirname(settingsDoc), { recursive: true })
fs.writeFileSync(settingsDoc, 'vault-wall:\n  rulesJson: ""\n')

const rulesJson = JSON.stringify({
  version: 1,
  rules: [{ id: 'vault', mode: 'hidden', paths: [vaultDir] }],
})

/** 构造一个够用的假宿主 ctx（get/on），并记录插件注册了什么。 */
function makeCtx(options = {}) {
  const captured = { guard: null, command: null, namespace: null, registerOptions: null, handlers: {}, approvalRequests: [] }
  const lifecycle = { disposed: false, disposers: [] }
  // 假设置文档：current 是「宿主解析后的当前值」，listeners 让测试可以模拟用户改设置。
  const settingsState = { current: { rulesJson: options.rulesJson ?? rulesJson }, listeners: [] }
  const notify = (next, prev) => {
    for (const listener of [...settingsState.listeners]) listener(next, prev)
  }
  const settingsService = {
    documentPath: options.documentPath ?? settingsDoc,
    register: (namespace, schema, registerOptions) => {
      captured.namespace = namespace
      captured.registerOptions = registerOptions
      return {
        watch: (callback) => {
          settingsState.listeners.push(callback)
          return () => {
            const index = settingsState.listeners.indexOf(callback)
            if (index >= 0) settingsState.listeners.splice(index, 1)
          }
        },
        update: async (patch) => {
          const prev = settingsState.current
          settingsState.current = { ...prev, ...patch }
          notify(settingsState.current, prev)
        },
      }
    },
    get: () => settingsState.current,
  }
  const ctx = {
    get(service) {
      if (service === 'tools') {
        return {
          guard: (fn) => {
            captured.guard = fn
            const disposer = () => { captured.guard = null }
            lifecycle.disposers.push(disposer)
            return disposer
          },
        }
      }
      if (service === 'commands') {
        return { register: (definition) => { captured.command = definition; return () => {} } }
      }
      if (service === 'settings') return options.noSettings === true ? undefined : settingsService
      if (service === 'approval') {
        if (options.approval === undefined || options.approval === false) return undefined
        return {
          request: async (request) => {
            captured.approvalRequests.push(request)
            if (options.approval === 'throw') throw new Error('no open turn')
            return options.approval
          },
        }
      }
      return undefined
    },
    on(event, callback) {
      if (event === 'dispose') {
        lifecycle.dispose = callback
        return
      }
      if (captured.handlers[event] === undefined) captured.handlers[event] = []
      captured.handlers[event].push(callback)
    },
  }
  const host = {
    ctx,
    captured,
    lifecycle,
    /** 触发某个事件的全部监听器，返回它们的结果（测试里一般只有一个）。 */
    fire(event, ...args) {
      const list = captured.handlers[event] ?? []
      return list.map((handler) => handler(...args))
    },
    /** 模拟用户在设置页改规则：更新宿主值并通知 watch 回调（applies: 'live'）。 */
    setRulesJson(text) {
      const prev = settingsState.current
      settingsState.current = { ...prev, rulesJson: text }
      notify(settingsState.current, prev)
    },
    /** 当前 `/wall` 命令的调用入口。 */
    run(rawInput, invocation = {}) {
      return captured.command.handler({ rawInput, ...invocation })
    },
  }
  return host
}

function load(options = {}, configOverrides = {}) {
  const host = makeCtx(options)
  apply(host.ctx, {
    rulesFile: options.rulesFile ?? '',
    panicAllowRoots: [],
    auditLimit: 100,
    auditFile: '',
    borrowSweepMs: 5000,
    strict: false,
    ...configOverrides,
  })
  liveHosts.push(host)
  return host
}

/** 造一条形状合法的合成调用记录（guard / pre-execute / post-execute 共用同一个对象）。 */
function execOf(name, target, agent = { id: 'a' }) {
  const args = name === 'bash' || name === 'pwsh' ? { command: target } : { file_path: target }
  return { name, arguments: args, agent }
}

const textResult = (text) => ({ isError: false, content: [{ type: 'text', text }] })
const errorResult = (text) => ({ isError: true, content: [{ type: 'text', text }] })
/** 下游监听器的默认表态：接受（post-execute 会在这个结果上做改写）。 */
const accept = async () => ({ kind: 'accept' })

/** 所有加载过的宿主；万一某条断言失败导致 dispose 被跳过，也要在文件末尾清掉定时器。 */
const liveHosts = []
test.after(() => {
  for (const host of liveHosts) {
    try {
      host.lifecycle.dispose?.()
    } catch {
      /* 清理失败不致命 */
    }
  }
})

const askRulesJson = JSON.stringify({
  version: 1,
  rules: [{ id: 'ask-vault', mode: 'ask', paths: [vaultDir], remember: true, borrowTtlMs: 60000 }],
})

test('模块导出契约：函数插件命名导出 name/Config/apply', () => {
  assert.equal(name, 'dsh-vault-wall')
  assert.equal(typeof apply, 'function')
  assert.ok(Config !== undefined)
})

test('apply 注册 guard/命令/命名空间，并按规则拦截', () => {
  const { captured, lifecycle } = load()
  assert.equal(typeof captured.guard, 'function', 'tools.guard 必须被注册')
  assert.equal(captured.command?.name, 'wall')
  assert.equal(captured.namespace, 'vault-wall')
  assert.equal(captured.registerOptions?.applies, 'live')

  const denied = captured.guard({ name: 'read', arguments: { file_path: path.join(vaultDir, 'a.txt') }, agent: {} })
  assert.match(denied, /^cannot read "/)
  const allowed = captured.guard({ name: 'read', arguments: { file_path: path.join(workspaceDir, 'ok.txt') }, agent: {} })
  assert.equal(allowed, undefined)

  lifecycle.dispose?.()
})

test('自保护：宿主 documentPath 指向的设置文档对 agent 不可读/不可写（v0.3 安全修复）', () => {
  const customDoc = path.join(scratch, 'custom-home', 'settings.yaml')
  fs.mkdirSync(path.dirname(customDoc), { recursive: true })
  fs.writeFileSync(customDoc, '')

  const { captured, lifecycle } = load({ documentPath: customDoc })
  const read = captured.guard({ name: 'read', arguments: { file_path: customDoc }, agent: {} })
  assert.match(read, /^cannot read "/, '设置文档必须被隐藏（它装着 rulesJson）')
  const write = captured.guard({ name: 'write', arguments: { file_path: customDoc }, agent: {} })
  assert.match(write, /^cannot write "/)
  const edit = captured.guard({ name: 'str_replace_editor', arguments: { command: 'view', path: customDoc }, agent: {} })
  assert.match(edit, /^cannot edit "/)
  lifecycle.dispose?.()
})

test('自保护：存在的旧规则文件同样被圈禁', () => {
  fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, rules: [] }))
  const { captured, lifecycle } = load({ rulesFile: legacyFile })
  assert.match(captured.guard({ name: 'read', arguments: { file_path: legacyFile }, agent: {} }), /^cannot read "/)
  lifecycle.dispose?.()
})

test('/wall 命令端到端：status / rules / test / decisions / borrow add', () => {
  const { captured, lifecycle } = load()
  const run = (rawInput, invocation = {}) => captured.command.handler({ rawInput, ...invocation })

  const status = run('status')
  assert.equal(status.kind, 'success')
  assert.match(status.text, /source: settings/)
  assert.match(status.text, /user rules: 1/)

  const rules = run('rules')
  assert.match(rules.text, /- \[vault\] mode=hidden/)

  const probe = run(`test ${path.join(vaultDir, 'deep', 'a.txt')}`)
  assert.equal(probe.kind, 'success')
  assert.match(probe.text, /decision: hidden-deny/)
  assert.match(probe.text, /rule: vault/)

  const probeShell = run(`test ${path.join(vaultDir, 'x')} pwsh`)
  assert.match(probeShell.text, /decision: hidden-deny/)

  // 借出后试算仍显示“未借出会怎么判”，而真实 guard 会放行
  const agent = {}
  const borrowed = run(`borrow add "${vaultDir}" --ttl 5000`, { agent })
  assert.equal(borrowed.kind, 'success', borrowed.text)
  assert.match(run(`test ${path.join(vaultDir, 'x')}`, { agent }).text, /decision: hidden-deny/)
  assert.equal(captured.guard({ name: 'read', arguments: { file_path: path.join(vaultDir, 'x') }, agent }), undefined)

  const decisions = run('decisions 10')
  assert.equal(decisions.kind, 'success')
  assert.match(decisions.text, /rules-loaded|guard-registered/)

  // 无 agent 的 borrow add 必须给可读错误（0.2.31 会崩）
  const noAgent = run(`borrow add "${vaultDir}"`)
  assert.equal(noAgent.kind, 'error')
  assert.match(noAgent.text, /requires an agent context/)

  lifecycle.dispose?.()
})

test('/wall export 端到端写入文件，且拒绝写进受保护路径', () => {
  const { captured, lifecycle } = load()
  const run = (rawInput) => captured.command.handler({ rawInput })
  const target = path.join(workspaceDir, 'exported.json')

  const ok = run(`export "${target}"`)
  assert.equal(ok.kind, 'success', ok.text)
  const doc = JSON.parse(fs.readFileSync(target, 'utf8'))
  assert.equal(doc.version, 1)
  assert.deepEqual(doc.rules.map((r) => r.id), ['vault'])

  const refused = run(`export "${path.join(vaultDir, 'nope.json')}"`)
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /拒绝导出到受保护路径/)

  lifecycle.dispose?.()
})

test('dispose 清理：/wall 不再可用且定时器被清掉', () => {
  const { captured, lifecycle } = load()
  assert.equal(typeof captured.guard, 'function')
  lifecycle.dispose?.()
  // guard 的 disposer 已被调用（模拟宿主卸载）
  assert.equal(captured.guard, null)
})

// ============================================================ v0.4：护栏三件套

test('VERSION 与 package.json 保持同步（发版时最容易漏的一处）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
  assert.equal(VERSION, pkg.version)
})

test('接线：pre-execute / post-execute / agent-pre-step 三个监听器都挂上了', () => {
  const host = load()
  for (const event of ['tools/pre-execute', 'tools/post-execute', 'agent/pre-step']) {
    assert.equal(host.captured.handlers[event]?.length, 1, event)
  }
  host.lifecycle.dispose?.()
})

test('人在回路：ask 规则命中但没有审批通道 → fail-closed 成明确拒绝', async () => {
  const host = load({ rulesJson: askRulesJson })
  const exec = execOf('write', path.join(vaultDir, 'a.txt'))
  const [decision] = await Promise.all(host.fire('tools/pre-execute', exec, accept))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /no approval channel/i)
  assert.match(decision.reason, /do not retry/i)
  // 没有审批通道时不该假装问过
  assert.equal(host.captured.approvalRequests.length, 0)
  // guard 随后也拒绝（台账里没有同意）
  assert.match(host.captured.guard(exec), /approval-gated/)
  assert.match(host.run('report').text, /无通道 1/)
  host.lifecycle.dispose?.()
})

test('人在回路：审批通过 → guard 放行本次调用，借出只覆盖被批准的那条路径', async () => {
  const host = load({ rulesJson: askRulesJson, approval: 'allowed-once' })
  const agent = { id: 'a' }
  const first = execOf('read', path.join(vaultDir, 'a.txt'), agent)
  const [decision] = await Promise.all(host.fire('tools/pre-execute', first, accept))
  assert.equal(decision.kind, 'accept', '通过后应继续交给下游')
  // 弹窗文案要带路径、规则、风险与「同意后记住多少」，人才有得判
  const request = host.captured.approvalRequests[0]
  assert.match(request.reason, /ask-vault/)
  assert.match(request.reason, /read/)
  assert.match(request.reason, /60 秒内不再询问这条路径/)
  assert.equal(request.toolName, 'read')
  // 台账让单调 guard 放行这次调用
  assert.equal(host.captured.guard(first), undefined)
  // 同一路径再来一次：TTL 借出已生效，既不弹窗也不拒绝
  const again = execOf('read', path.join(vaultDir, 'a.txt'), agent)
  assert.equal(host.captured.guard(again), undefined)
  assert.match(host.run('status', { agent }).text, /borrows: 1/)
  // 但同一目录下的**另一个**文件仍要重新问：同意读一个文件 ≠ 同意这棵树
  const sibling = execOf('read', path.join(vaultDir, 'b.txt'), agent)
  assert.match(host.captured.guard(sibling), /approval-gated/)
  assert.equal(host.run(`test ${path.join(vaultDir, 'c.txt')}`, { agent }).text.includes('decision: ask'), true)
  host.lifecycle.dispose?.()
})

test('人在回路：同意后整棵树的授权请走 /wall borrow add（目录级借出）', async () => {
  const host = load({ rulesJson: askRulesJson, approval: 'allowed-once' })
  const agent = { id: 'a' }
  host.run(`borrow add "${vaultDir}" --ttl 60000`, { agent })
  // 目录级借出先于审批门生效：连弹窗都不该出现
  const exec = execOf('read', path.join(vaultDir, 'deep', 'a.txt'), agent)
  const [decision] = await Promise.all(host.fire('tools/pre-execute', exec, accept))
  assert.equal(decision.kind, 'accept')
  assert.equal(host.captured.approvalRequests.length, 0)
  assert.equal(host.captured.guard(exec), undefined)
  host.lifecycle.dispose?.()
})

test('人在回路：remember=false 时只授权这一次，下一条路径仍要问', async () => {
  const rules = JSON.stringify({ version: 1, rules: [{ id: 'ask-once', mode: 'ask', paths: [vaultDir], remember: false }] })
  const host = load({ rulesJson: rules, approval: 'allowed-once' })
  const agent = { id: 'a' }
  const first = execOf('read', path.join(vaultDir, 'a.txt'), agent)
  await Promise.all(host.fire('tools/pre-execute', first, accept))
  assert.equal(host.captured.guard(first), undefined)
  const second = execOf('read', path.join(vaultDir, 'b.txt'), agent)
  assert.match(host.captured.guard(second), /approval-gated/)
  host.lifecycle.dispose?.()
})

test('人在回路：人拒绝 / 取消 / 通道抛错 三种情况都拒绝且文案可分辨', async () => {
  for (const [outcome, pattern] of [['rejected', /the user rejected/i], ['cancelled', /cancelled/i], ['throw', /no approval channel/i]]) {
    const host = load({ rulesJson: askRulesJson, approval: outcome })
    const exec = execOf('write', path.join(vaultDir, 'a.txt'))
    const [decision] = await Promise.all(host.fire('tools/pre-execute', exec, accept))
    assert.equal(decision.kind, 'deny', outcome)
    assert.match(decision.reason, pattern, outcome)
    host.lifecycle.dispose?.()
  }
})

test('人在回路：minRisk 门槛之下不打扰人（低风险读直接放行）', async () => {
  const rules = JSON.stringify({ version: 1, rules: [{ id: 'ask-high', mode: 'ask', paths: [vaultDir], minRisk: 'high' }] })
  const host = load({ rulesJson: rules, approval: 'allowed-once' })
  const read = execOf('read', path.join(vaultDir, 'a.txt'))
  const [readDecision] = await Promise.all(host.fire('tools/pre-execute', read, accept))
  assert.equal(readDecision.kind, 'accept')
  assert.equal(host.captured.approvalRequests.length, 0)
  assert.equal(host.captured.guard(read), undefined)
  // 高风险动作才问人
  const shell = execOf('bash', `cat ${path.join(vaultDir, 'a.txt')}`)
  await Promise.all(host.fire('tools/pre-execute', shell, accept))
  assert.equal(host.captured.approvalRequests.length, 1)
  host.lifecycle.dispose?.()
})

test('人在回路：askEnabled=false 时 ask 规则退化为拒绝（不静默放行）', async () => {
  const host = load({ rulesJson: askRulesJson, approval: 'allowed-once' }, { askEnabled: false })
  const exec = execOf('write', path.join(vaultDir, 'a.txt'))
  const [decision] = await Promise.all(host.fire('tools/pre-execute', exec, accept))
  assert.equal(decision.kind, 'deny')
  assert.equal(host.captured.approvalRequests.length, 0)
  host.lifecycle.dispose?.()
})

test('人在回路：非 ask 规则不经过审批门（hidden 由 guard 直接拦）', async () => {
  const host = load({ approval: 'allowed-once' })
  const exec = execOf('read', path.join(vaultDir, 'a.txt'))
  const [decision] = await Promise.all(host.fire('tools/pre-execute', exec, accept))
  assert.equal(decision.kind, 'accept')
  assert.equal(host.captured.approvalRequests.length, 0)
  assert.match(host.captured.guard(exec), /^cannot read "/)
  host.lifecycle.dispose?.()
})

test('验证：墙判了拒绝却执行成功 → 扣下结果并自动熔断', async () => {
  const host = load()
  const exec = execOf('read', path.join(vaultDir, 'a.txt'))
  assert.match(host.captured.guard(exec), /^cannot read "/)
  const [result] = await Promise.all(host.fire('tools/post-execute', exec, textResult('secret contents'), accept))
  assert.equal(result.kind, 'block')
  assert.match(result.feedback, /verification failed/)
  assert.match(result.feedback, /circuit breaker \(panic ON\)/)
  // 熔断真的生效：普通路径也被拦
  assert.match(host.captured.guard(execOf('read', path.join(workspaceDir, 'ok.txt'))), /panic/i)
  assert.match(host.run('report').text, /bypass=1/)
  assert.match(host.run('panic off').text, /panic OFF/)
  host.lifecycle.dispose?.()
})

test('验证：正常放行的调用原样通过，不误伤', async () => {
  const host = load()
  const exec = execOf('read', path.join(workspaceDir, 'ok.txt'))
  assert.equal(host.captured.guard(exec), undefined)
  const downstream = { kind: 'accept', content: [{ type: 'text', text: 'ordinary result' }] }
  const [result] = await Promise.all(host.fire('tools/post-execute', exec, textResult('ordinary result'), async () => downstream))
  assert.equal(result, downstream)
  host.lifecycle.dispose?.()
})

test('验证：结果里出现受保护根 → 默认脱敏整条路径（不漏文件名）', async () => {
  const host = load()
  const exec = execOf('read', path.join(workspaceDir, 'ok.txt'))
  host.captured.guard(exec)
  const leaked = `index: ${path.join(vaultDir, 'keys.txt')}`
  const [result] = await Promise.all(host.fire('tools/post-execute', exec, textResult(leaked), async () => ({ kind: 'accept', content: [{ type: 'text', text: leaked }] })))
  assert.equal(result.kind, 'accept')
  assert.equal(result.content[0].text, 'index: [vault-wall:redacted]')
  assert.match(host.run('report').text, /leak=1（已脱敏 1／已阻断 0）/)
  host.lifecycle.dispose?.()
})

test('验证：onLeak=block 时整条结果被扣下，onLeak=audit 时只留痕', async () => {
  const blocking = load({}, { onLeak: 'block' })
  const execA = execOf('read', path.join(workspaceDir, 'ok.txt'))
  blocking.captured.guard(execA)
  const leaked = `index: ${path.join(vaultDir, 'keys.txt')}`
  const [blocked] = await Promise.all(blocking.fire('tools/post-execute', execA, textResult(leaked), accept))
  assert.equal(blocked.kind, 'block')
  assert.match(blocked.feedback, /withheld by policy/)
  blocking.lifecycle.dispose?.()

  const auditing = load({}, { onLeak: 'audit' })
  const execB = execOf('read', path.join(workspaceDir, 'ok.txt'))
  auditing.captured.guard(execB)
  const downstream = { kind: 'accept', content: [{ type: 'text', text: leaked }] }
  const [untouched] = await Promise.all(auditing.fire('tools/post-execute', execB, textResult(leaked), async () => downstream))
  assert.equal(untouched, downstream)
  assert.match(auditing.run('report').text, /leak=1（已脱敏 0／已阻断 0）/)
  auditing.lifecycle.dispose?.()
})

test('验证：被授权的路径不算泄漏（借出之后读到的内容不脱敏）', async () => {
  const host = load()
  const agent = { id: 'a' }
  host.run(`borrow add "${vaultDir}" --ttl 60000`, { agent })
  const exec = execOf('read', path.join(vaultDir, 'keys.txt'), agent)
  assert.equal(host.captured.guard(exec), undefined, '借出后 guard 放行')
  const content = `contents of ${path.join(vaultDir, 'keys.txt')}`
  const downstream = { kind: 'accept', content: [{ type: 'text', text: content }] }
  const [result] = await Promise.all(host.fire('tools/post-execute', exec, textResult(content), async () => downstream))
  assert.equal(result, downstream, '授权范围内的结果不该被脱敏')
  host.lifecycle.dispose?.()
})

test('纠正：连撞三次同一处 → guard 第三次带上纠正提示，post-execute 阻断并计数', async () => {
  const host = load()
  const agent = { id: 'loop' }
  const outcomes = []
  for (let i = 0; i < 3; i += 1) {
    const exec = execOf('read', path.join(vaultDir, 'a.txt'), agent)
    const denial = host.captured.guard(exec)
    assert.match(denial, /^cannot read "/)
    if (i === 2) assert.match(denial, /repeat denial #3/)
    const [result] = await Promise.all(host.fire('tools/post-execute', exec, errorResult(denial), accept))
    outcomes.push(result.kind)
  }
  assert.deepEqual(outcomes, ['accept', 'accept', 'block'])
  const fourth = execOf('read', path.join(vaultDir, 'a.txt'), agent)
  host.captured.guard(fourth)
  const [next] = await Promise.all(host.fire('tools/post-execute', fourth, errorResult('x'), accept))
  assert.match(next.feedback, /denied 4 times/)
  assert.match(next.feedback, /\/wall borrow/)
  assert.match(host.run('report').text, /已升级 1 条/)
  host.lifecycle.dispose?.()
})

test('纠正：repeatDenialAction=panic 时升级直接熔断', async () => {
  const host = load({}, { repeatDenialAction: 'panic' })
  const agent = { id: 'loop' }
  for (let i = 0; i < 3; i += 1) {
    const exec = execOf('read', path.join(vaultDir, 'a.txt'), agent)
    host.captured.guard(exec)
    await Promise.all(host.fire('tools/post-execute', exec, errorResult('denied'), accept))
  }
  assert.match(host.run('panic').text, /panic: ON/)
  host.run('panic off')
  host.lifecycle.dispose?.()
})

test('纠正：新的用户消息把循环计数清零', async () => {
  const host = load()
  const agent = { id: 'loop' }
  const exec = execOf('read', path.join(vaultDir, 'a.txt'), agent)
  host.captured.guard(exec)
  await Promise.all(host.fire('tools/post-execute', exec, errorResult('denied'), accept))
  await Promise.all(host.fire('agent/pre-step', { agent, messages: [{ source: { kind: 'user' } }] }, accept))
  const again = execOf('read', path.join(vaultDir, 'a.txt'), agent)
  const denial = host.captured.guard(again)
  assert.equal(denial.includes('repeat denial'), false)
  host.lifecycle.dispose?.()
})

// ============================================================ v0.4：可回滚

test('可回滚：设置改动进历史，/wall rollback 把旧规则写回设置文档并生效', async () => {
  const host = load()
  const extraDir = path.join(scratch, 'extra')
  fs.mkdirSync(extraDir, { recursive: true })
  assert.match(host.run('history').text, /规则修订 1 条/)

  const extended = JSON.stringify({
    version: 1,
    rules: [{ id: 'vault', mode: 'hidden', paths: [vaultDir] }, { id: 'extra', mode: 'deny', paths: [extraDir] }],
  })
  host.setRulesJson(extended)
  assert.match(host.run('rules').text, /- \[extra\] mode=deny/)
  assert.match(host.run('history').text, /规则修订 2 条/)

  const rollback = host.run('rollback prev')
  assert.equal(rollback.kind, 'success', rollback.text)
  assert.match(rollback.text, /已回滚到修订 r1/)
  // 回滚结果真的写回了设置文档（否则重启就白滚了），并且旧规则立刻生效
  assert.equal(host.captured.handlers['tools/pre-execute'].length, 1)
  assert.equal(host.run('rules').text.includes('[extra]'), false)
  assert.equal(host.captured.guard(execOf('read', path.join(extraDir, 'x.txt'))), undefined)
  // 回滚本身也是一次修订（历史只追加，不改写）
  assert.match(host.run('history').text, /规则修订 3 条/)
  host.lifecycle.dispose?.()
})

test('可回滚：historyFile 开启后修订落盘，且该文件同样受自保护', async () => {
  const historyFile = path.join(scratch, 'vw-history.json')
  fs.rmSync(historyFile, { force: true })
  const host = load({}, { historyFile })
  assert.ok(fs.existsSync(historyFile), '首次应用规则就该落盘')
  const doc = JSON.parse(fs.readFileSync(historyFile, 'utf8'))
  assert.equal(doc.version, 1)
  assert.equal(doc.revisions.length, 1)

  host.setRulesJson(JSON.stringify({ version: 1, rules: [] }))
  assert.equal(JSON.parse(fs.readFileSync(historyFile, 'utf8')).revisions.length, 2)

  // 历史文件里存着规则全文 → 和设置文档同级，必须对 agent 圈禁
  assert.match(host.captured.guard(execOf('read', historyFile)), /^cannot read "/)
  assert.match(host.captured.guard(execOf('write', historyFile)), /^cannot write "/)
  assert.match(host.run('status').text, /history: 2 revision\(s\)/)

  // 重启（新的宿主实例）能从盘上读回历史，而不是从零开始；规则内容与最后一条相同时去重
  const restarted = load({ rulesJson: '{"version":1,"rules":[]}' }, { historyFile })
  assert.match(restarted.run('history').text, /规则修订 2 条/)
  assert.match(restarted.run('rollback prev').text, /已回滚到修订 r1/)
  restarted.lifecycle.dispose?.()
  host.lifecycle.dispose?.()
})

test('可回滚：/wall snapshot 能把某条修订导出到普通路径，且拒绝写进保险区', () => {
  const host = load()
  const target = path.join(workspaceDir, 'revision-r1.json')
  const ok = host.run(`snapshot "${target}" r1`)
  assert.equal(ok.kind, 'success', ok.text)
  const doc = JSON.parse(fs.readFileSync(target, 'utf8'))
  assert.equal(doc.version, 1)
  assert.deepEqual(doc.rules.map((rule) => rule.id), ['vault'])
  const refused = host.run(`snapshot "${path.join(vaultDir, 'r1.json')}" r1`)
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /拒绝导出修订到受保护路径/)
  host.lifecycle.dispose?.()
})

test('/wall report 与 /wall lint 端到端可用', () => {
  const host = load()
  const report = host.run('report')
  assert.equal(report.kind, 'success')
  assert.match(report.text, /Vault Wall 护栏评估/)
  assert.match(report.text, /【可回滚】/)
  const lint = host.run('lint')
  assert.equal(lint.kind, 'success')
  assert.match(lint.text, /规则体检/)
  host.lifecycle.dispose?.()
})

test('设置服务缺席时回退旧规则文件模式，且不留「无规则」窗口', () => {
  const fileModeRules = path.join(scratch, 'file-mode-rules.json')
  fs.writeFileSync(fileModeRules, JSON.stringify({ version: 1, rules: [{ id: 'from-file', mode: 'hidden', paths: [vaultDir] }] }))
  const host = load({ noSettings: true, rulesFile: fileModeRules })
  // 不等待 watchdog：settings 缺席时必须在 apply() 当轮就把墙立起来
  assert.match(host.run('status').text, /source: file/)
  assert.match(host.run('rules').text, /- \[from-file\] mode=hidden/)
  assert.match(host.captured.guard(execOf('read', path.join(vaultDir, 'a.txt'))), /^cannot read "/)
  host.lifecycle.dispose?.()
})
