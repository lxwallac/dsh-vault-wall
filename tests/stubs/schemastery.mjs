/**
 * 测试用最小 schemastery 替身：只需要支持 `z.object({...})` 与链式
 * `.default()/.min()/.max()/.optional()`，让 `src/index.js` 能在没有 DSH 宿主的
 * 环境里被真正 import 并 apply（真正的校验行为不在这里验证）。
 */

function chain() {
  const api = {
    default: () => api,
    optional: () => api,
    min: () => api,
    max: () => api,
    natural: () => api,
  }
  return api
}

export default {
  object: () => chain(),
  string: () => chain(),
  number: () => chain(),
  boolean: () => chain(),
  array: () => chain(),
  union: () => chain(),
}
