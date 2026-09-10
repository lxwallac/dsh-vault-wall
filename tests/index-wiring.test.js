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

const { apply, name, Config } = await import('../src/index.js')

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
  const captured = { guard: null, command: null, namespace: null, registerOptions: null }
  const lifecycle = { disposed: false, disposers: [] }
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
      if (service === 'settings') {
        return {
          documentPath: options.documentPath ?? settingsDoc,
          register: (namespace, schema, registerOptions) => {
            captured.namespace = namespace
            captured.registerOptions = registerOptions
            return { watch: () => () => {} }
          },
          get: () => ({ rulesJson: options.rulesJson ?? rulesJson }),
        }
      }
      return undefined
    },
    on(event, callback) {
      if (event === 'dispose') lifecycle.dispose = callback
    },
  }
  return { ctx, captured, lifecycle }
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
  return host
}

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
