/**
 * Node loader 钩子：把 `@deepseek-ai/schemastery` 解析到测试替身，
 * 使 `src/index.js` 可以在没有宿主运行时（也就没有该 peer 依赖）的环境里被加载。
 * 只影响显式 `module.register()` 了本钩子的测试进程。
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/schemastery') {
    return { url: new URL('./schemastery.mjs', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
