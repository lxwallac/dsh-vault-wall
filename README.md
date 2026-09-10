# dsh-vault-wall（保险区 Vault Wall）

让 DSH（DeepSeek Harness）的 agent **感知不到、无法操作**你指定敏感路径的客户端插件：
命中规则的路径对 agent 伪装为不存在（not-found），或明确拒绝；规则数据、审计与配置自身也在保护之内。

> 使用前请核对与当前安装版本（见 `package.json`）一致；本文档随功能迭代维护。
> 变更历史见 [CHANGELOG.md](CHANGELOG.md)。

## 功能

- **隐藏模式**：对 agent 装作不存在——读取 / 列出 / 触碰一律 not-found，连路径名都不透露。
- **拒绝模式**：直接报错并注明该处受规则保护，agent 会知道自己不该碰这里。
- **工具范围**：可把规则限定到指定 exec 工具（read / write / edit / read_image / glob / grep / bash / pwsh /
  str_replace_editor / run_code / cordis_define），或对全部工具生效。
- 每条规则支持多条**绝对路径**（可精确到单文件，或一个目录整树）。
- **通配**：段内 `*`；v0.3 起支持整段 `**`（任意层目录，含零层），例如 `C:\work\repo\**\.env`
  同时圈住仓库根与深层子目录里的 `.env`。
- **命令试算** `/wall test <绝对路径> [工具]`：保存前先看这条路径会被怎么判，且不消耗借出、不改状态。
- **规则导出** `/wall export <文件>`：把当前用户规则导出成 JSON（拒绝写进受保护路径）。
- 规则保存在宿主设置文档的 `vault-wall` 命名空间（`rulesJson`），在设置页改动即保存、即时生效。
- 自我防护：规则文件 / 审计 / 设置文档对该 agent 隐藏，会话内无法自改墙、也无法偷看审计。
- 设置页：官方「设置 → 保险区 Vault Wall」分节（新增 / 编辑 / 以 JSON 编辑），web profile 下可用。

## 目录

- `browser/client.js` — 客户端插件：设置页 UI（规则卡片、编辑弹窗、JSON 视图、目录浏览）
- `src/` — 宿主侧逻辑（规则解析、工具拦截、自我防护、`/wall` 命令）
- `tests/` — 测试（`npm test`）
- `samples/` — 示例规则与用法（见 `samples/README.md`）

## 安装（给使用者）

**前提（重要，先说清楚）**

本插件是 **DSH（DeepSeek Harness）的插件**，运行离不开 DSH 宿主，而不是一个独立程序：

- 宿主侧（`src/`）依赖 DSH 提供的 cordis 运行时与 `settings` / `tools` 等服务；
- 设置页 UI（`browser/client.js`）需要 DSH **内置 Web 设置前端**的注入（`window.__DSH_BOOT__` 由 dsh web 提供）。

当前**实测过的宿主是 DSH Desktop（web profile，内嵌宿主包 0.1.2-alpha.1）**，插件安装 CLI 在 Desktop 的 `host-commands` 里。

**官方源码版"普通 dsh"（预期可用，未实测）**：官方仓库 deepseek-ai/deepseek-harness 的
`apps/cli`（npm 包 `@deepseek-ai/dsh`，终端启动、浏览器访问 Web 交互）提供与本插件所用完全相同的宿主缝：
`settings.section` 插槽、`settingsScope.bind`、`window.__ModuleLoader__.load`、`uiWorkspace` / `ui-primitives`
（源码内嵌包版本 0.1.2-alpha.5，仅比 Desktop 高一档 alpha 补丁）。在该环境跑通 monorepo 构建后，
用同一条 `dsh plugin ... add dsh-vault-wall` 安装即可；因未在该环境实测，界面细节以实际表现为准。

因此请按以下顺序准备：
1. 装有 DSH 宿主：**DSH Desktop**（已实测）或**官方源码版 dsh**（`apps/cli`，需先构建 monorepo）；
2. 启动过一次，确认有可用 profile（如 `web`）；
3. 插件装进该 profile 后**重启 dsh** 生效。

任选一种来源安装（在 DSH Desktop 环境里执行，`<profile>` 换成你的 profile 名）：

```text
# A) 从 npm 装（机器能直连 registry 时最方便）
dsh plugin --profile <profile> add dsh-vault-wall
dsh plugin --profile <profile> add dsh-vault-wall@0.3.0        # 锁版本

# B) 从 GitHub Release 下载的 tgz 装（推荐给国内/镜像不稳定的机器）
#    先在 https://github.com/lxwallac/dsh-vault-wall/releases 下载
#    dsh-vault-wall-<version>.tgz，然后：
dsh plugin --profile <profile> add ./dsh-vault-wall-0.3.0.tgz

# C) 直接按 URL 装（同上，免下载）
dsh plugin --profile <profile> add https://github.com/lxwallac/dsh-vault-wall/releases/download/v0.3.0/dsh-vault-wall-0.3.0.tgz
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

## `/wall` 控制台命令

在会话里输入 `/wall`（子命令一览），或直接：

```text
/wall status                           # 源、规则数、panic、借出、审计容量
/wall rules                            # 当前生效规则（含自保护条目）
/wall decisions 30                     # 最近 30 条墙决策（谁、什么工具、命中哪条规则）
/wall test C:\work\repo\**\.env read    # 试算：现在会被判成什么（不消耗借出、不改状态）
/wall export D:\backup\vault-rules.json # 导出用户规则 JSON（拒绝写进受保护路径）
/wall reload                           # 从当前规则源重载
/wall panic on | off                   # 紧急熔断：除 panicAllowRoots 外一律拒绝
/wall borrow add C:\Users\you\secret-box --ttl 60000 --rw   # 临时借出（本 agent）
/wall borrow list | revoke <id> | clear
```

`test` 会按工具族自动拼出正确的调用形状（文件工具用 `file_path`、搜索/编辑器用 `path`、
shell 与代码执行工具走命令文本），并打印命中规则与 agent 会看到的错误文案。

## 规则结构（设置页内 JSON / 保存格式）

```jsonc
{
  "version": 1,
  "rules": [
    {
      "id": "personal-vault",              // 必填，规则 id
      "mode": "hidden",                    // hidden = 伪装不存在 | deny = 明确拒绝
      "paths": [
        "C:\\Users\\you\\secret-box",      // 绝对路径：单文件或目录整树
        "C:\\work\\repo\\**\\.env"         // 整段 ** = 任意层目录（含零层），v0.3 起支持
      ],
      "tools": ["read", "grep"],           // 省略 = 全部工具
      "note": "可选说明"
    }
  ]
}
```

支持的路径写法：绝对路径（等于或位于其下）、目录整树（写目录本身或 `...\dir\**`）、段内 `*`
（不跨分隔符）、整段 `**`（跨任意层）。`?` 与 `[abc]` 会 fail-loud 报错，不会静默放行。
更多可直接粘贴的例子见 `samples/rules.example.json`。

## 覆盖的工具与已知边界

- **路径参数族**：`read` / `read_image` / `write` / `edit`（`file_path`），
  `str_replace_editor`（`path`，v0.3 新增覆盖），`glob` / `grep`（搜索根 `path`）。
- **文本族**（按命令/源码文本启发式扫描绝对路径）：`bash` / `pwsh`（`command`），
  `run_code`（`code`）、`cordis_define`（`code.host` / `code.client`）——v0.3 新增覆盖。
  文本匹配容忍分隔符变体：规则 `D:\keys` 能认出命令里的 `D:/keys/x` 与转义形态 `D:\\keys\\x`。
- **祖先递归聚合**：`glob` / `grep` 指向保护区祖先目录时会被拦（否则递归会把内容读出来）；
  shell/代码文本里出现递归标记（`-r` / `-Recurse` / `/s` / `rg` 等）且提到祖先目录同样拦。
- **未识别的工具默认放行**：只拦"已知工具形状的参数"，这会让 MCP 等第三方工具成为旁路——
  需要覆盖时请把工具名与参数形状提 issue。

## 边界（重要）

- 这是**策略围栏，不是内核边界**：保证"内容不可达 / 触碰被伪装"，不保证"平铺列举父目录时目录名完全不可见"；
- shell / 代码文本按启发式匹配，可被拼接、变量间接引用、动态构造绕过——防"手滑/惯性触碰"，非恶意对抗；
- 中段 `**` 规则只保证**直接触碰命中文件**被拦；在祖先目录上做递归聚合时无法穷举深度（globs 的固有边界）；
- 真正的读侧隐身需要 OS 层（独立账户/ACL、加密容器等）配合。
