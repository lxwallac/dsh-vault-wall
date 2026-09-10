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
 * 真正的渲染仍以宿主实测为准；这里只保证「装配线」不会再次把整块页面熄灭。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const clientPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'browser', 'client.js')

/** 在 vm 里执行真实 bundle，返回它交给 __ModuleLoader__.load 的 spec。 */
function loadBundle() {
  const code = fs.readFileSync(clientPath, 'utf8')
  let spec = null
  const sandbox = {
    console,
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
