/**
 * 浏览器半「加载契约」测试（v0.3 新增）。
 *
 * 历史教训：这个插件在 0.2.x 反复出现「设置页整块空白」，根因都是**激活依赖 / 注册契约**
 * 出错（inject 列表带了宿主没有的服务、useScope seat 没每渲染调用一次、apply 期访问未注入服务）。
 * 那些问题在纯逻辑测试里看不见，只能在真实宿主里点开才发现。
 *
 * 这里用 vm + 桩 require 直接把 `browser/client.js` 跑一遍，守住不需要浏览器就能验证的部分：
 *   1. bundle 用 `id: 'dsh-vault-wall'` 自注册；
 *   2. 导出 apply/inject，且 inject **只**声明 slots 与 settingsScope
 *      （uiWorkspace 刻意不入列 —— 缺失时不阻塞激活，改为延迟轮询）；
 *   3. apply(ctx) 绑定 `vault-wall` 命名空间并注册 `settings.section`（id/order/label 正确）；
 *   4. section 注入的 seat 同时带 `hooks.scope` 与 `scope`，且是每次调用都返回新对象的普通函数
 *      （hook 顺序 / 空白分节的回归栅栏）。
 *
 * v0.4 追加：ask（人在回路）模式的表单是**新写出来的 UI**，最容易出的错是「页面上能选，
 * 存下去的字段却会让宿主引擎 fail-loud 拒绝」。因此这里额外做两件事（见文件末尾）：
 *   - 用探针把 `validateRules` / `RuleEditorModal` 取出来，直接驱动表单逻辑；
 *   - 用一棵可遍历的元素树把弹窗**渲染**出来，断言 ask 行确实出现、保存时确实只写 ask 字段。
 *
 * 真正的样式与交互仍以宿主实测为准；这里只保证「装配线」与「写出的字段形状」不会错。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const clientPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'browser', 'client.js')

/**
 * 在 vm 里执行真实 bundle，返回它交给 __ModuleLoader__.load 的 spec。
 * @param {{probe?: boolean}} [options] probe=true 时给 module.exports 挂一个 `__test` 门面，
 *   把闭包内部的校验/渲染函数暴露出来（只在测试里做，源码不动）。
 */
function loadBundle(options = {}) {
  let code = fs.readFileSync(clientPath, 'utf8')
  if (options.probe === true) {
    const anchor = '    return module.exports'
    assert.equal(code.split(anchor).length - 1, 1, 'bundle 结尾的 `return module.exports` 锚点必须唯一')
    code = code.replace(anchor, [
      '    module.exports.__test = {',
      '      validateRules: validateRules,',
      '      RuleEditorModal: RuleEditorModal,',
      '      MODE_META: MODE_META,',
      '      TOOL_OPTIONS: TOOL_OPTIONS,',
      '      RISK_OPTIONS: RISK_OPTIONS,',
      '    }',
      anchor,
    ].join('\n'))
  }
  let spec = null
  const sandbox = {
    console,
    // 与主战场一致：Windows 平台（绝对路径判定分支不同）
    navigator: { platform: 'Win32', userAgent: 'Win32' },
    window: {
      __ModuleLoader__: {
        load: (value) => { spec = value },
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'browser/client.js' })
  return spec
}

const reactStub = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}

const requireStub = (name) => {
  if (name === 'react') return reactStub
  return {} // ui primitives：本测试不渲染，只验证装配
}

test('bundle: 以 dsh-vault-wall 自注册并导出 apply/inject', () => {
  const spec = loadBundle()
  assert.ok(spec !== null, 'bundle 必须调用 window.__ModuleLoader__.load')
  assert.equal(spec.id, 'dsh-vault-wall')
  assert.equal(typeof spec.factory, 'function')

  const exports = spec.factory(requireStub)
  assert.equal(typeof exports.apply, 'function')
  // 注意：vm 里造出来的数组原型不是本 realm 的 Array.prototype，所以逐项比较。
  assert.equal(exports.inject.length, 2)
  assert.equal(exports.inject[0], 'slots')
  assert.equal(exports.inject[1], 'settingsScope')
})

test('bundle: apply 绑定 vault-wall 命名空间并注册 settings.section', () => {
  const exports = loadBundle().factory(requireStub)
  const registrations = []
  let boundOptions = null
  let injectedSlot = null

  const ctx = {
    settingsScope: {
      bind: (options) => {
        boundOptions = options
        return { namespace: options.namespace, mutate: async () => {}, getSnapshot: () => undefined }
      },
    },
    slots: {
      inject: (name, callback) => { injectedSlot = name; callback() },
      register: (config, component) => { registrations.push({ config, component }) },
    },
    get: () => undefined,
  }

  exports.apply(ctx)

  assert.equal(boundOptions.namespace, 'vault-wall')
  assert.equal(Object.keys(boundOptions).length, 1, 'bind 只应传 namespace')
  assert.equal(injectedSlot, 'settings.section')
  assert.equal(registrations.length, 1)
  const { config, component } = registrations[0]
  assert.equal(config.name, 'settings.section')
  assert.equal(config.id, 'vault-wall')
  assert.equal(config.order, 40)
  assert.equal(config.label, '保险区 Vault Wall')
  assert.equal(typeof component, 'function')
})

test('bundle: seat 注入同时带 hooks.scope 与 scope，且每次调用返回新对象', () => {
  const exports = loadBundle().factory(requireStub)
  let config = null
  const scope = { namespace: 'vault-wall' }
  exports.apply({
    settingsScope: { bind: () => scope },
    slots: { inject: (_name, cb) => cb(), register: (value) => { config = value } },
    get: () => undefined,
  })

  assert.equal(typeof config.inject, 'function')
  const first = config.inject({})
  const second = config.inject({})
  assert.equal(first.hooks.scope, scope)
  assert.equal(first.scope, scope)
  assert.notEqual(first, second, 'inject 必须每次返回新对象，避免宿主复用同一份 props 造成陈旧引用')
  assert.notEqual(first.hooks, second.hooks)
})

// ======================================================== v0.4：ask 模式的表单

/** 可遍历的元素树桩：createElement 记录 type/props/children，供测试走树。 */
function makeTreeReact() {
  return {
    // 注意：这里必须是普通函数 —— 箭头函数没有自己的 arguments，会把子节点全丢掉。
    createElement: function (type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.filter((child) => child !== null && child !== undefined && child !== false),
      }
    },
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
}

/** 取 bundle 的 `__test` 门面（内部函数），复用树桩 react。 */
function loadProbe() {
  let treeReact = null
  const requireProbe = (name) => {
    if (name === 'react') {
      treeReact = makeTreeReact()
      return treeReact
    }
    return {}
  }
  const exports = loadBundle({ probe: true }).factory(requireProbe)
  assert.ok(exports.__test !== undefined, '探针必须挂上 __test（bundle 结构变了就更新这里）')
  return exports.__test
}

/** 深度优先收集树里的所有文本节点。 */
function textsOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, out)
    return out
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) textsOf(child, out)
    // Modal 的 footer/description 等以 props 传进来，也要一起走
    for (const value of Object.values(node.props)) {
      if (value !== null && typeof value === 'object') textsOf(value, out)
    }
  }
  return out
}

/** 深度优先找第一个满足条件的节点（含以 props 传入的子树，如 Modal.footer）。 */
function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate)
      if (found !== null) return found
    }
    return null
  }
  const children = Array.isArray(node.children) ? node.children : []
  if (children.length > 0 && predicate(node)) return node
  // Modal 的 footer/description 等以 props 传进来，也要一起走
  const subs = children.concat(Object.values(node.props ?? {}).filter((value) => value !== null && typeof value === 'object'))
  for (const child of subs) {
    const found = findNode(child, predicate)
    if (found !== null) return found
  }
  return null
}

/** 渲染规则编辑弹窗，返回 { texts, clickSave }。 */
function renderEditor(probe, initial, existingIds = []) {
  let saved = null
  const tree = probe.RuleEditorModal({ initial, existingIds, onSave: (rule) => { saved = rule }, onCancel: () => {} })
  const saveButton = findNode(tree, (node) => node.props.variant === 'primary' && node.children.includes('保存'))
  assert.ok(saveButton !== null, '弹窗底部必须有「保存」按钮')
  return { tree, texts: textsOf(tree), clickSave: () => { saveButton.props.onClick(); return saved } }
}

const vaultPath = path.resolve('__vw_client_test_root__', 'vault')

test('ask：MODE_META 有「询问」档，且文案说明 fail-closed', () => {
  const probe = loadProbe()
  const meta = probe.MODE_META.ask
  assert.ok(meta !== undefined, 'MODE_META 必须有 ask（否则页面上的模式药丸会渲染成空）')
  assert.equal(meta.tag, '询问')
  assert.match(meta.desc, /fail-closed|拒绝/)
})

test('ask：工具清单与宿主 COVERED_TOOLS 一致（多写等于永不命中）', () => {
  const probe = loadProbe()
  for (const tool of ['str_replace_editor', 'run_code', 'cordis_define']) {
    assert.ok(probe.TOOL_OPTIONS.includes(tool), `${tool} 应可勾选`)
  }
  // 引擎看不见形状的工具名不该出现在清单里（勾了也不会命中，只会误导用户）
  assert.equal(probe.TOOL_OPTIONS.includes('mcp__github__create_issue'), false)
})

test('ask：validateRules 接受 ask 专属字段，并逐条拦住会 fail-loud 的写法', () => {
  const { validateRules } = loadProbe()
  const okRule = { id: 'ok', mode: 'ask', paths: [vaultPath], minRisk: 'high', remember: true, borrowTtlMs: 60000 }
  assert.equal(validateRules([okRule]), null)
  assert.equal(validateRules([{ id: 'a', mode: 'ask', paths: [vaultPath] }]), null, '三个字段都可缺省')

  const cases = [
    [{ id: 'x', mode: 'hidden', paths: [vaultPath], minRisk: 'low' }, /minRisk 只适用于 mode=ask/],
    [{ id: 'x', mode: 'deny', paths: [vaultPath], remember: false }, /remember 只适用于 mode=ask/],
    [{ id: 'x', mode: 'hidden', paths: [vaultPath], borrowTtlMs: 1000 }, /borrowTtlMs 只适用于 mode=ask/],
    [{ id: 'x', mode: 'ask', paths: [vaultPath], minRisk: 'critical' }, /minRisk 只能是/],
    [{ id: 'x', mode: 'ask', paths: [vaultPath], remember: 'yes' }, /remember 必须是布尔值/],
    [{ id: 'x', mode: 'ask', paths: [vaultPath], borrowTtlMs: -1 }, /borrowTtlMs 必须是非负数字/],
    [{ id: 'x', mode: 'panic', paths: [vaultPath] }, /mode 只能是 hidden \/ deny \/ ask/],
  ]
  for (const [rule, pattern] of cases) {
    const message = validateRules([rule])
    assert.ok(message !== null, `应被拦住：${JSON.stringify(rule)}`)
    assert.match(message, pattern)
    assert.match(message, /规则 x/, '报错要点名是哪条规则')
  }
})

test('ask：弹窗渲染出询问药丸与 ask 专属行，保存时写出三个字段', () => {
  const probe = loadProbe()
  const { texts, clickSave } = renderEditor(probe, { id: 'ask-rule', mode: 'ask', paths: [vaultPath] })
  for (const label of ['询问', '隐藏', '拒绝', '最低风险', '记住', '借出时长（秒）']) {
    assert.ok(texts.includes(label), `弹窗里应有「${label}」`)
  }
  for (const tag of ['低', '中', '高', '未识别']) {
    assert.ok(texts.includes(tag), `风险档应有「${tag}」`)
  }
  const rule = clickSave()
  assert.equal(rule.mode, 'ask')
  assert.equal(rule.minRisk, 'low')
  assert.equal(rule.remember, true)
  assert.equal(rule.borrowTtlMs, 600000, '默认 600 秒')
})

test('ask：remember=false 时不显示借出时长，也不写出 borrowTtlMs', () => {
  const probe = loadProbe()
  const { texts, clickSave } = renderEditor(probe, { id: 'once', mode: 'ask', paths: [vaultPath], remember: false, borrowTtlMs: 60000 })
  assert.equal(texts.includes('借出时长（秒）'), false)
  const rule = clickSave()
  assert.equal(rule.remember, false)
  assert.equal(rule.borrowTtlMs, undefined, 'remember=false 时不该写 borrowTtlMs（引擎会拒绝）')
})

test('ask：已存规则的 borrowTtlMs 会回填到秒输入框', () => {
  const probe = loadProbe()
  const { clickSave } = renderEditor(probe, { id: 'ttl', mode: 'ask', paths: [vaultPath], remember: true, borrowTtlMs: 90000 })
  assert.equal(clickSave().borrowTtlMs, 90000)
})

test('hidden/deny：不渲染 ask 行，也不写出 ask 字段', () => {
  const probe = loadProbe()
  for (const mode of ['hidden', 'deny']) {
    const { texts, clickSave } = renderEditor(probe, { id: 'plain', mode, paths: [vaultPath] })
    assert.equal(texts.includes('最低风险'), false, mode)
    assert.equal(texts.includes('记住'), false, mode)
    assert.ok(texts.includes(mode === 'deny' ? '拒绝' : '隐藏'))
    const rule = clickSave()
    assert.equal(rule.mode, mode)
    assert.equal(rule.minRisk, undefined)
    assert.equal(rule.remember, undefined)
    assert.equal(rule.borrowTtlMs, undefined)
  }
})
