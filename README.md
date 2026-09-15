# dsh-vault-wall（保险区 Vault Wall）

让 DSH（DeepSeek Harness）的 agent **感知不到、无法操作**你指定敏感路径的客户端插件：
命中规则的路径对 agent 伪装为不存在（not-found），或明确拒绝，或**先问过你**；规则数据、审计、
历史与配置自身也在保护之内。v0.4 按 Harness 的五要素（上下文 / 工具接口 / 约束 / 验证 / 纠正）
补齐了护栏的后三格：**人在回路审批、执行后验证、循环纠正**，以及**可回滚的规则修订**。

> 使用前请核对与当前安装版本（见 `package.json`）一致；本文档随功能迭代维护。
> 变更历史见 [CHANGELOG.md](CHANGELOG.md)。

## 功能

- **隐藏模式**：对 agent 装作不存在——读取 / 列出 / 触碰一律 not-found，连路径名都不透露。
- **拒绝模式**：直接报错并注明该处受规则保护，agent 会知道自己不该碰这里。
- **询问模式（人在回路，v0.4）**：命中后**不直接拒绝**，而是通过官方审批通道弹出确认框（见
  `dsh-client-ui-approval`），把「路径 + 规则 + 工具 + 风险等级」摆给你；你点「允许」这一次才放行。
  三种「没通过」都有各自文案，并明确要求模型**不要重试**：人拒绝 / 取消 / **没有可用审批通道**。
  没有审批通道时 ask 规则 **fail-closed** 成明确拒绝——绝不静默放行。
  - `minRisk`：风险低于门槛的工具调用直接放行、不打扰你（默认 `low`，即任何命中都问）。
  - `remember` / `borrowTtlMs`：同意一次后记一条 TTL 借出（默认 10 分钟），**只覆盖被批准的那一条
    路径**；要授权整棵目录用 `/wall borrow add <目录>`（弹窗文案里会告诉你这一点）。
- **工具风险评级（v0.4）**：内置 `low`（只读：read / glob / grep / web_* …）、`medium`（写入：
  write / edit / str_replace_editor …）、`high`（任意执行/不可逆：bash / pwsh / run_code /
  cordis_define …）；**未识别的工具按 `unknown` 处理，秩高于 high**——第三方/MCP 工具默认从严。
- **执行后验证（v0.4）**：每次调用结束后做两层核对，两条的可信度不同：
  1. **授权一致性（结构化，可信）**：拿 guard/审批门**当时真正做出的决策**比对结果——判了拒绝却执行
     成功 = 墙被绕过，立刻扣下结果并发审计；`autoPanicOnBypass` 还会顺手拉闸熔断。这条专治插件内部
     异常时「宁可漏，不可打崩工具管道」的 fail-open 缺口。
  2. **泄漏扫描（文本启发式，尽力而为）**：结果里出现受保护根时按 `onLeak` 处理——`redact`（默认，
     把**整条路径**换成 `[vault-wall:redacted]`）、`audit`（只留痕，不动内容）、`block`（整条结果转为
     错误）。已授权的路径不算泄漏。
- **循环纠正（v0.4）**：同一 agent 反复撞同一处（默认 3 次）时，guard 的拒绝文案会追加「这是策略决定，
  不是临时故障，别再重试」的纠正提示，post-execute 则把该次结果整条换成纠正文案；`repeatDenialAction`
  可选 `notice`（默认）或 `panic`（直接熔断）。收到新的用户消息时计数清零。
- **护栏评估 `/wall report`（v0.4）**：把「拦截/放行次数、审批结果、bypass 与泄漏、重复触墙排行、
  从未命中的规则、规则修订」打成一页，结尾给建议动作。护栏本身也在此处自证。
- **规则体检 `/wall lint`（v0.4）**：过宽（覆盖主目录）、被前一条同模式规则遮蔽、路径不存在、
  重复路径、中段 `**` 的已知边界、`tools` 里写了本插件看不见形状的工具名、`deny` 会暴露墙的存在、
  ask 的通道前提/风险门槛/remember——逐条给出结论与建议。
- **可回滚 `/wall history` / `snapshot` / `rollback`（v0.4）**：每次成功应用的规则都记一条修订
  （内容相同不重复记），可用 `historyFile` 落盘跨重启保留；回滚只追加、永不改写历史，并且必须
  **写回规则源**才算数（写不回去会明确告诉你「只改了内存，重启会回到旧规则」）。
- **工具范围**：可把规则限定到指定 exec 工具（read / write / edit / read_image / glob / grep / bash / pwsh /
  str_replace_editor / run_code / cordis_define），或对全部工具生效。
- 每条规则支持多条**绝对路径**（可精确到单文件，或一个目录整树）。
- **通配**：段内 `*`；v0.3 起支持整段 `**`（任意层目录，含零层），例如 `C:\work\repo\**\.env`
  同时圈住仓库根与深层子目录里的 `.env`。
- **命令试算** `/wall test <绝对路径> [工具]`：保存前先看这条路径会被怎么判（含风险等级与 ask 的
  行为预告），且不消耗借出、不改状态。
- **规则导出** `/wall export <文件>`：把当前用户规则导出成 JSON（拒绝写进受保护路径）。
- 规则保存在宿主设置文档的 `vault-wall` 命名空间（`rulesJson`），在设置页改动即保存、即时生效。
- 自我防护：规则文件 / 审计 / 设置文档 / **规则历史文件**对该 agent 隐藏，会话内无法自改墙、也无法偷看审计。
- 设置页：官方「设置 → 保险区 Vault Wall」分节（新增 / 编辑 / 以 JSON 编辑），web profile 下可用；
  询问模式的最低风险 / 记住 / 借出时长都在编辑弹窗里（字段只在 `ask` 模式下出现，避免写出引擎会
  fail-loud 拒绝的组合）。

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
dsh plugin --profile <profile> add dsh-vault-wall@0.4.0        # 锁版本

# B) 从 GitHub Release 下载的 tgz 装（推荐给国内/镜像不稳定的机器）
#    先在 https://github.com/lxwallac/dsh-vault-wall/releases 下载
#    dsh-vault-wall-<version>.tgz，然后：
dsh plugin --profile <profile> add ./dsh-vault-wall-0.4.0.tgz

# C) 直接按 URL 装（同上，免下载）
dsh plugin --profile <profile> add https://github.com/lxwallac/dsh-vault-wall/releases/download/v0.4.0/dsh-vault-wall-0.4.0.tgz
```

> 提示：DSH 的 `plugin` 命令底层转发 pnpm；若你的网络默认走 npmmirror 等镜像，
> 包名方式可能遇到"镜像未同步/重试"，此时用 B/C（tgz / URL）最稳。
> 安装输出末尾的 `ERR_PNPM_IGNORED_BUILDS` 与"pnpm failed"退出码是已知噪音，不影响安装结果
> （以 `node_modules/dsh-vault-wall/package.json` 的版本号为准）。

装完重启 DSH，到「设置 → 保险区 Vault Wall」添加规则。

## 开发 / 维护（给贡献者）

```text
npm test          # 运行单元测试（node --test，每个测试文件一个子进程）
npm run test:local # 等价物，但把全部测试文件放进同一个进程顺序执行（不 fork）
npm pack          # 本地打 tgz（文件名 dsh-vault-wall-<version>.tgz）

# 发布新版本（先改 package.json 的 version）
npm publish       # 推到 npm：https://www.npmjs.com/package/dsh-vault-wall
gh release create v<version> dsh-vault-wall-<version>.tgz --repo lxwallac/dsh-vault-wall
git tag v<version> && git push origin v<version>
```

> `npm test` 的底层是 `node --test`，它会为**每个测试文件 fork 一个子进程**并用管道回收输出。
> 在受限环境里（文件沙箱、部分容器 / CI 安全策略）创建带命名管道的子进程会被拒绝
> （`spawn EPERM`），一条用例都跑不起来；`npm run test:local` 用 `node:test` 的编程式 `run()`
> 在**同一进程内**顺序执行同一份清单，完全不 fork，作为受限环境的等价通道。
> 日常与 CI 用 `npm test` 即可。

- 源码：https://github.com/lxwallac/dsh-vault-wall （MIT，见 LICENSE）

## `/wall` 控制台命令

在会话里输入 `/wall`（子命令一览），或直接：

```text
/wall status                           # 源、规则数、panic、借出、审计、指标、历史
/wall rules                            # 当前生效规则（含自保护条目与 ask 字段）
/wall decisions 30                     # 最近 30 条墙决策（谁、什么工具、命中哪条规则、风险等级）
/wall test C:\work\repo\**\.env read    # 试算：现在会被判成什么（不消耗借出、不改状态）
/wall report                           # 护栏评估：拦截/放行、审批、验证发现、循环、死规则、建议动作
/wall lint                             # 规则体检：过宽、遮蔽、不可达工具名、已知边界
/wall export D:\backup\vault-rules.json # 导出用户规则 JSON（拒绝写进受保护路径）
/wall history 10                       # 规则修订历史（最新在前；historyFile 开启时跨重启保留）
/wall snapshot D:\backup\r1.json r1     # 把某条修订的规则全文写到文件（默认最新一条）
/wall rollback prev                    # 回滚到上一条修订（写回规则源，并记为新修订）
/wall reload                           # 从当前规则源重载
/wall panic on | off                   # 紧急熔断：除 panicAllowRoots 外一律拒绝
/wall borrow add C:\Users\you\secret-box --ttl 60000 --rw   # 临时借出（本 agent）
/wall borrow list | revoke <id> | clear
```

`test` 会按工具族自动拼出正确的调用形状（文件工具用 `file_path`、搜索/编辑器用 `path`、
shell 与代码执行工具走命令文本），并打印风险等级、命中规则与 agent 会看到的错误文案；
命中 ask 规则时还会预告「真跑起来会先弹窗问人，通过后记多久的借出」。

## 配置（宿主侧）

插件配置在 profile 的 `cordis.patch.yml`（`dsh-vault-wall` 那一行的 `config`）里给出，全部有默认值：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `rulesFile` | `~/.dsh/vault-wall-rules.json` | 旧规则文件（无 settings 服务时的规则源；也作为 settings 的种子） |
| `panicAllowRoots` | `[]` | 熔断（panic）期间仍允许的路径根 |
| `auditLimit` | `500` | 审计环形缓冲条数 |
| `auditFile` | `''` | 审计 JSONL 落盘路径；空 = 仅内存（**建议放在工作区外**，它会被自保护圈禁） |
| `borrowSweepMs` | `5000` | 借出过期清理周期 |
| `strict` | `true` | 显式配置的 `rulesFile` 缺失/损坏时：抛错 vs 告警后继续 |
| `onLeak` | `'redact'` | 结果里出现受保护根时：`audit` / `redact` / `block` |
| `leakMarker` | `'[vault-wall:redacted]'` | 脱敏标记文本 |
| `autoPanicOnBypass` | `true` | 检出「墙判拒绝却执行成功」时自动熔断 |
| `repeatDenialThreshold` | `3` | 同一处被拒多少次后升级纠正；`0` = 关闭 |
| `repeatDenialAction` | `'notice'` | 升级动作：`notice` / `panic` |
| `askEnabled` | `true` | ask 规则总开关；关掉即全部 fail-closed 为拒绝 |
| `askBorrowTtlMs` | `600000` | ask 审批通过后的默认借出时长 |
| `historyLimit` | `20` | 内存中保留的规则修订条数 |
| `historyFile` | `''` | 修订历史落盘路径；空 = 仅内存（重启即失） |

## 规则结构（设置页内 JSON / 保存格式）

```jsonc
{
  "version": 1,
  "rules": [
    {
      "id": "personal-vault",              // 必填，规则 id
      "mode": "hidden",                    // hidden = 伪装不存在 | deny = 明确拒绝 | ask = 先问过你
      "paths": [
        "C:\\Users\\you\\secret-box",      // 绝对路径：单文件或目录整树
        "C:\\work\\repo\\**\\.env"         // 整段 ** = 任意层目录（含零层），v0.3 起支持
      ],
      "tools": ["read", "grep"],           // 省略 = 全部工具
      "note": "可选说明"
    },
    {
      "id": "keys-ask",                    // v0.4：人在回路
      "mode": "ask",
      "paths": ["D:\\keys"],
      "minRisk": "medium",                 // low | medium | high | unknown（默认 low）
      "remember": true,                    // 同意一次后记一条 TTL 借出（默认 true）
      "borrowTtlMs": 600000                // 借出时长，0 = 一次一授权（默认 600000）
    }
  ]
}
```

`minRisk` / `remember` / `borrowTtlMs` **只对 `ask` 规则有效**：写在 `hidden` / `deny` 上会 fail-loud
报错（设置页也会在保存前拦下），不会静默忽略——写错的护栏等于没有护栏。

支持的路径写法：绝对路径（等于或位于其下）、目录整树（写目录本身或 `...\dir\**`）、段内 `*`
（不跨分隔符）、整段 `**`（跨任意层）。`?` 与 `[abc]` 会 fail-loud 报错，不会静默放行。
更多可直接粘贴的例子见 `samples/rules.example.json`。

## 覆盖的工具与已知边界

- **路径参数族**：`read` / `read_image` / `write` / `edit`（`file_path`），
  `str_replace_editor`（`path`），`glob` / `grep`（搜索根 `path`）。
- **文本族**（按命令/源码文本启发式扫描绝对路径）：`bash` / `pwsh`（`command`），
  `run_code`（`code`）、`cordis_define`（`code.host` / `code.client`）。
  文本匹配容忍分隔符变体：规则 `D:\keys` 能认出命令里的 `D:/keys/x` 与转义形态 `D:\\keys\\x`。
- **祖先递归聚合**：`glob` / `grep` 指向保护区祖先目录时会被拦（否则递归会把内容读出来）；
  shell/代码文本里出现递归标记（`-r` / `-Recurse` / `/s` / `rg` 等）且提到祖先目录同样拦。
- **未识别的工具不再默认放行（v0.4 收紧）**：风险评级把未列名工具判为 `unknown`，其秩**高于
  `high`**，因此在 `minRisk` 门槛判断与 `/wall report` 里都按最保守处理。但这只是「风险评级从严」，
  不代替参数覆盖：只拦"已知工具形状的参数"，MCP 等第三方工具**仍可能成为旁路**——需要覆盖时请把
  工具名与参数形状提 issue。

## 边界（重要）

- 这是**策略围栏，不是内核边界**：保证"内容不可达 / 触碰被伪装"，不保证"平铺列举父目录时目录名完全不可见"；
- shell / 代码文本按启发式匹配，可被拼接、变量间接引用、动态构造绕过——防"手滑/惯性触碰"，非恶意对抗；
- 中段 `**` 规则只保证**直接触碰命中文件**被拦；在祖先目录上做递归聚合时无法穷举深度（globs 的固有边界）；
- **泄漏扫描是文本启发式**：认得出路径串，认不出「文件内容被读出来后换了名字」；真正的读侧隐身
  仍需要 OS 层（独立账户/ACL、加密容器等）配合。
- **审批的可靠性依赖宿主**：`ask` 依赖官方审批通道（`ctx.get('approval')`）与一个打开的 turn。
  通道缺失、审批抛错、你取消，都按拒绝处理（fail-closed），不会退化成放行。
- **验证与纠正都有代价**：脱敏会改写工具结果（可切 `onLeak: 'audit'` 只留痕）；`verify-bypass`
  自动熔断会把墙收窄到白名单根，需要你 `/wall panic off` 才恢复。
