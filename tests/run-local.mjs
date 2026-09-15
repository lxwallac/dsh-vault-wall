/**
 * 单进程测试运行器 —— `npm test` 的无子进程等价物。
 *
 * 为什么需要它：`node --test <files>` 会为**每个测试文件 fork 一个子进程**，并用管道
 * 回收其输出。在受限环境里（DSH 的文件沙箱、部分容器 / CI 的安全策略）创建带命名管道的
 * 子进程会被拒绝（`spawn EPERM`），于是 `npm test` 一条用例都跑不了。这里改用
 * `node:test` 的编程式 `run()`，把所有测试文件放进**同一个进程**顺序执行，完全不 fork。
 *
 * 与 `npm test` 的差异（有意为之，不是缺陷）：
 *  - 没有按文件隔离：一个文件里的顶层副作用会留在进程里（本仓库的测试各自用独立的
 *    临时目录与假宿主，互不干扰；`index-wiring` 注册的 schemastery loader 钩子只拦截
 *    该包名，对其他文件无影响，因此它排在最后）；
 *  - 失败时会强制 `process.exit(1)`：单进程下任何一个测试遗留的定时器都会让进程不退出
 *    （而「测试失败 → 跳过 dispose → 遗留定时器」正是最容易出现的组合）。
 */

import { run } from 'node:test'
import { spec } from 'node:test/reporters'

/** 与 package.json 的 `test` 脚本保持同一份清单与顺序。 */
export const TEST_FILES = [
  'tests/rules.test.js',
  'tests/classify.test.js',
  'tests/borrow.test.js',
  'tests/audit.test.js',
  'tests/audit-file.test.js',
  'tests/wall-core.test.js',
  'tests/risk.test.js',
  'tests/ask.test.js',
  'tests/verify.test.js',
  'tests/correct.test.js',
  'tests/metrics.test.js',
  'tests/history.test.js',
  'tests/report.test.js',
  'tests/doc-bridge.test.js',
  'tests/console.test.js',
  'tests/client-bundle.test.js',
  'tests/index-wiring.test.js',
]

let failed = 0
const failures = []
const stream = run({ files: TEST_FILES, isolation: 'none', concurrency: 1, watch: false })

stream.on('test:fail', (data) => {
  failed += 1
  failures.push(data?.name ?? data?.data?.name ?? '(unknown)')
})

stream.compose(new spec()).pipe(process.stdout)

// 显式收尾：单进程 + 有测试失败时可能残留定时器（失败的用例跳过 dispose 就会这样），
// 因此不依赖事件循环自然排空。
await new Promise((resolve) => stream.on('end', resolve))
if (failed > 0) console.error(`vault-wall test:local: ${failed} failing test(s):\n  - ${failures.join('\n  - ')}`)
process.exit(failed > 0 ? 1 : 0)
