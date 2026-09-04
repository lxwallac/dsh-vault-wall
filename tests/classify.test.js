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

test('absolutePathTokens: 抽取 Windows/POSIX/UNC 形态的绝对路径', () => {
  const text = String.raw`Copy-Item C:\Users\a\f.txt D:\dst && ssh host "ls /etc/hosts" && net use \\server\share`
  const tokens = absolutePathTokens(text)
  assert.ok(tokens.includes(String.raw`C:\Users\a\f.txt`))
  assert.ok(tokens.includes(String.raw`D:\dst`))
  assert.ok(tokens.includes('/etc/hosts'))
  assert.ok(tokens.some((t) => t.startsWith(String.raw`\\server`)))
  assert.equal(tokens.includes('/'), false)
})
