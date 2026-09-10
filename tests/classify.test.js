import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyToolArgs, absolutePathTokens } from '../src/classify.js'

test('classifyToolArgs: 路径型工具的 file_path', () => {
  for (const name of ['read', 'read_image', 'write', 'edit']) {
    assert.deepEqual(
      classifyToolArgs({ name, arguments: { file_path: 'C:\\vault\\a.txt' } }),
      [{ kind: 'path', path: 'C:\\vault\\a.txt' }],
    )
  }
})

test('classifyToolArgs: 搜索根工具的 path', () => {
  for (const name of ['glob', 'grep']) {
    assert.deepEqual(
      classifyToolArgs({ name, arguments: { path: '/vault', pattern: '**' } }),
      [{ kind: 'path', path: '/vault' }],
    )
  }
})

test('classifyToolArgs: shell 工具取命令文本', () => {
  for (const name of ['bash', 'pwsh']) {
    assert.deepEqual(
      classifyToolArgs({ name, arguments: { command: 'cat /vault/a' } }),
      [{ kind: 'command', text: 'cat /vault/a' }],
    )
  }
})

test('classifyToolArgs: 未知工具/空参数默认放行（返回空）', () => {
  assert.deepEqual(classifyToolArgs({ name: 'mcp__filesystem__read', arguments: { path: '/x' } }), [])
  assert.deepEqual(classifyToolArgs({ name: 'read', arguments: null }), [])
  assert.deepEqual(classifyToolArgs({ name: 'read' }), [])
  assert.deepEqual(classifyToolArgs({ name: 'read', arguments: { file_path: '   ' } }), [])
})

test('classifyToolArgs: str_replace_editor 取 path（v0.3 新增覆盖）', () => {
  assert.deepEqual(
    classifyToolArgs({ name: 'str_replace_editor', arguments: { command: 'view', path: 'C:\\vault\\a.txt' } }),
    [{ kind: 'path', path: 'C:\\vault\\a.txt' }],
  )
})

test('classifyToolArgs: 代码执行工具按文本处理（run_code / cordis_define）', () => {
  assert.deepEqual(
    classifyToolArgs({ name: 'run_code', arguments: { code: 'await tools.read({ file_path: "C:\\\\vault\\\\a" })', description: 'x' } }),
    [{ kind: 'command', text: 'await tools.read({ file_path: "C:\\\\vault\\\\a" })' }],
  )
  const define = classifyToolArgs({
    name: 'cordis_define',
    arguments: { plugin: { kind: 'new', idPrefix: 'demo' }, name: 'n', purpose: 'p', code: { host: 'read("C:\\\\vault\\\\a")', client: '' } },
  })
  assert.deepEqual(define, [{ kind: 'command', text: 'read("C:\\\\vault\\\\a")' }])
  // 两个半区都有源码时都给出来（client 半空串按“无内容”跳过）
  const both = classifyToolArgs({ name: 'cordis_define', arguments: { code: { host: 'host()', client: 'client()' } } })
  assert.deepEqual(both, [{ kind: 'command', text: 'host()' }, { kind: 'command', text: 'client()' }])
  // 字段缺失/非字符串一律返回空，不误伤
  assert.deepEqual(classifyToolArgs({ name: 'run_code', arguments: {} }), [])
  assert.deepEqual(classifyToolArgs({ name: 'cordis_define', arguments: { code: null } }), [])
})

test('absolutePathTokens: 抽取 Windows/POSIX/UNC 形态的绝对路径', () => {
  const text = String.raw`Copy-Item C:\Users\a\f.txt D:\dst && ssh host "ls /etc/hosts" && net use \\server\share`
  const tokens = absolutePathTokens(text)
  assert.ok(tokens.includes(String.raw`C:\Users\a\f.txt`))
  assert.ok(tokens.includes(String.raw`D:\dst`))
  assert.ok(tokens.includes('/etc/hosts'))
  assert.ok(tokens.some((t) => t.startsWith(String.raw`\\server`)))
  assert.equal(tokens.includes('/'), false)
})
