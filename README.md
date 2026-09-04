# dsh-vault-wall（保险区 Vault Wall）

让 DSH（DeepSeek Harness）的 agent **感知不到、无法操作**你指定敏感路径的客户端插件：
命中规则的路径对 agent 伪装为不存在（not-found），或明确拒绝；规则数据、审计与配置自身也在保护之内。

> 使用前请核对与当前安装版本（见 `package.json`）一致；本文档随功能迭代维护。

## 功能

- **隐藏模式**：对 agent 装作不存在——读取 / 列出 / 触碰一律 not-found，连路径名都不透露。
- **拒绝模式**：直接报错并注明该处受规则保护，agent 会知道自己不该碰这里。
- **工具范围**：可把规则限定到指定 exec 工具（read / write / edit / read_image / glob / grep / bash / pwsh），或对全部工具生效。
- 每条规则支持多条**绝对路径**（可精确到单文件，或一个目录整树）。
- 规则保存在宿主设置文档的 `vault-wall` 命名空间（`rulesJson`），在设置页改动即保存、即时生效。
- 自我防护：规则文件 / 审计 / 设置文档对该 agent 隐藏，会话内无法自改墙、也无法偷看审计。
- 设置页：官方「设置 → 保险区 Vault Wall」分节（新增 / 编辑 / 以 JSON 编辑），web profile 下可用。

## 目录

- `browser/client.js` — 客户端插件：设置页 UI（规则卡片、编辑弹窗、JSON 视图、目录浏览）
- `src/` — 宿主侧逻辑（规则解析、工具拦截、自我防护）
- `tests/` — 测试（`npm test`）
- `samples/` — 示例

## 安装（给使用者）

**前提（重要，先说清楚）**

本插件是 **DSH（DeepSeek Harness）的插件**，运行离不开 DSH 宿主，而不是一个独立程序：

- 宿主侧（`src/`）依赖 DSH 提供的 cordis 运行时与 `settings` / `tools` 等服务；
- 设置页 UI（`browser/client.js`）需要 DSH **内置 Web 设置前端**的注入（`window.__DSH_BOOT__` 由 dsh web 提供）。

当前**验证过的宿主是 DSH Desktop（web profile）**；插件安装 CLI 也在 Desktop 的 `host-commands` 里。
**未安装 Desktop 的"裸 DSH 运行时"未经验证、不作承诺**——如果将来出现不依赖 Desktop 的独立 DSH 发行版，
届时需确认其是否带 dsh plugin CLI、settings 服务与 Web 前端注入后再安装本插件。

因此请按以下顺序准备：
1. 安装 **DSH Desktop** 并启动过一次，确认有可用 profile（如 `web`）；
2. 插件装进该 profile 后**重启 DSH** 生效。

任选一种来源安装（在 DSH Desktop 环境里执行，`<profile>` 换成你的 profile 名）：

```text
# A) 从 npm 装（机器能直连 registry 时最方便）
dsh plugin --profile <profile> add dsh-vault-wall
dsh plugin --profile <profile> add dsh-vault-wall@0.2.24        # 锁版本

# B) 从 GitHub Release 下载的 tgz 装（推荐给国内/镜像不稳定的机器）
#    先在 https://github.com/lxwallac/dsh-vault-wall/releases 下载
#    dsh-vault-wall-<version>.tgz，然后：
dsh plugin --profile <profile> add ./dsh-vault-wall-0.2.24.tgz

# C) 直接按 URL 装（同上，免下载）
dsh plugin --profile <profile> add https://github.com/lxwallac/dsh-vault-wall/releases/download/v0.2.24/dsh-vault-wall-0.2.24.tgz
```

> 提示：DSH 的 `plugin` 命令底层转发 pnpm；若你的网络默认走 npmmirror 等镜像，
> 包名方式可能遇到"镜像未同步/重试"，此时用 B/C（tgz / URL）最稳。
> 安装输出末尾的 `ERR_PNPM_IGNORED_BUILDS` 与"pnpm failed"退出码是已知噪音，不影响安装结果
> （以 `node_modules/dsh-vault-wall/package.json` 的版本号为准）。

装完重启 DSH，到「设置 → 保险区 Vault Wall」添加规则。

## 开发 / 维护（给贡献者）

```text
npm test          # 运行单元测试
npm pack          # 本地打 tgz（文件名 dsh-vault-wall-<version>.tgz）

# 发布新版本（先改 package.json 的 version）
npm publish       # 推到 npm：https://www.npmjs.com/package/dsh-vault-wall
gh release create v<version> dsh-vault-wall-<version>.tgz --repo lxwallac/dsh-vault-wall
git tag v<version> && git push origin v<version>
```

- 源码：https://github.com/lxwallac/dsh-vault-wall （MIT，见 LICENSE）

## 规则结构（设置页内 JSON / 保存格式）

```jsonc
{
  "version": 1,
  "rules": [
    {
      "id": "personal-vault",              // 必填，规则 id
      "mode": "hidden",                    // hidden = 伪装不存在 | deny = 明确拒绝
      "paths": [
        "C:\\Users\\you\\secret-box"       // 绝对路径：单文件或目录整树
      ],
      "tools": ["read", "grep"],           // 省略 = 全部工具
      "note": "可选说明"
    }
  ]
}
```

## 边界（重要）

- 这是**策略围栏，不是内核边界**：保证"内容不可达 / 触碰被伪装"，不保证"平铺列举父目录时目录名完全不可见"；
- shell 命令按文本启发式匹配，可被拼接/间接引用绕过——防"手滑/惯性触碰"，非恶意对抗；
- 真正的读侧隐身需要 OS 层（独立账户/ACL、加密容器等）配合。
