# 变更日志（CHANGELOG）

版本号遵循语义化版本；`0.2.x` 的历史细节见 git 提交记录（`git log --oneline`）。

## v0.4.0

按《AI Agent 入门》第一章的 Harness 模型（`约束 / 验证 / 纠正` + 工具风险评级 + 人在回路）
补齐护栏的后半段。v0.3 的墙只会「拦」，v0.4 会**问人、事后核对、纠正循环、并且改得回来**。

### 新增内容

- **询问模式 `mode: "ask"`（人在回路）**
  命中后不直接拒绝，而是通过官方审批通道（`ctx.get('approval')`）弹出确认框，把「路径 + 规则 id +
  工具 + 风险等级 + 规则备注」摆给用户；只有 `allowed-once` 才放行。复核来自**上下文之外**的用户，
  而不是问模型自己。
  - 三种「没通过」各有独立文案且都要求**不要重试**：人拒绝 / 取消 / 无可用审批通道；
  - 通道缺失、通道抛错、无 agent 上下文一律 **fail-closed** 成明确拒绝（绝不静默放行）；
  - 事后兜底：`ask` 决策若未在审批台账里留下同意记录（门没挂上/内部异常/被绕过 pre-execute），
    guard 一律按「没人问过」拒绝。
  - 实现取舍：**没有**改走宿主的 `{kind:'ask'}`（`dsh-tools` 的 `serviceAsk`）。那条路径在用户
    同意后返回 `allow` 并继续咨询单调 guard，而 guard 对同一条 ask 规则仍会判 `ask`，
    等于用户刚点的「允许」被自己的墙否掉；因此审批在 pre-execute 门里自己做，并在 guard 之前把
    同意写进按 exec 记账的审批台账。
- **`minRisk` / `remember` / `borrowTtlMs`（仅 ask 规则）**
  风险门槛（低于门槛的工具调用直接放行，不打扰人）、同意后记一条 TTL 借出（默认 10 分钟）、
  借出时长（`0` = 一次一授权）。**借出只覆盖被批准的那一条路径**——同意读一个文件不等于同意整棵树；
  要目录级授权用 `/wall borrow add <目录>`（弹窗文案里明确告知）。写在非 ask 规则上会 fail-loud。
- **工具风险评级 `src/risk.js`**：`low`（只读）/ `medium`（写入）/ `high`（任意执行、不可逆），
  **未识别工具 = `unknown`，秩高于 `high`**（第三方/MCP 默认从严，故障安全默认值）。
- **执行后验证 `src/verify.js`（`tools/post-execute`）**
  1. **授权一致性校验（结构化，可信）**：比对 guard/审批门**当时真正做出的决策**与执行结果——
     判了拒绝却执行成功即 `verify-bypass`，扣下结果、记审计；`autoPanicOnBypass`（默认开）顺手熔断。
     这条正好补上 v0.3 唯一的 fail-open 缺口（guard 内部异常时放行）；
  2. **泄漏扫描（文本启发式，尽力而为）**：结果里出现受保护根时按 `onLeak` 处理——`redact`（默认，
     **整条路径**一起脱敏，不漏文件名）/ `audit` / `block`。已授权的路径不算泄漏。
- **循环纠正 `src/correct.js`**：同一 agent × 同一规则 × 同一路径的重复触墙计数（默认 3 次，
  5 分钟窗口）触发纠正——guard 的拒绝文案追加「这是策略决定、不是临时故障、别再重试、去告诉用户」，
  `tools/post-execute` 把该次结果整条换成纠正文案（可选 `repeatDenialAction: 'panic'` 直接熔断）。
  收到新的用户消息即清零（与官方 repeat-tool-reminder 同一取舍）。
- **护栏评估 `/wall report`**：一页给出拦截/放行与占比、判决分布、审批结果、bypass 与泄漏、
  重复触墙排行、从未命中的规则、规则修订、生效配置，并给出建议动作。
- **规则体检 `/wall lint`**：过宽（覆盖主目录）、被前一条同模式规则遮蔽、路径不存在、重复路径、
  中段 `**` 的已知边界、`tools` 里写了引擎看不见形状的工具名、`deny` 会暴露墙的存在、
  ask 的通道/门槛/remember——逐条结论（warn/info）与建议。
- **可回滚的规则修订 `/wall history` / `snapshot` / `rollback`**
  每次成功应用规则都记一条修订（内容相同去重，只增不改），`historyFile` 可落盘跨重启保留；
  回滚会**写回规则源**（settings 命名空间或规则文件）并在写不回去时明确说「只改了内存，重启会回到
  旧规则」，回滚本身也记为新修订。
- **`/wall test` / `status` / `decisions` 增补**：试算打印风险等级与 ask 行为预告；状态页显示版本、
  指标、循环计数、行为开关、历史；决策列表带 `risk=`。
- **设置页 UI（`browser/client.js`）**：新增「询问」模式药丸与 ask 专属表单行（最低风险 / 记住 /
  借出时长），校验与宿主引擎口径对齐（非 ask 规则带上 ask 字段会被页面拦下）；工具清单补齐
  `str_replace_editor` / `run_code` / `cordis_define`。
- **`npm run test:local`**：`node --test` 会为每个测试文件 fork 子进程，在受限环境（文件沙箱、
  部分容器/CI）会被 `spawn EPERM` 拒绝；这个脚本用 `node:test` 的编程式 `run()` 在同一进程内
  顺序执行同一份清单，作为等价通道。
- **测试从 81 个增加到 204 个**：新增 `tests/risk|ask|verify|correct|metrics|history|report.test.js`，
  并扩充 `rules` / `borrow` / `wall-core` / `console` / `client-bundle` / `index-wiring`
  （含「VERSION 必须等于 package.json version」这条发版栅栏）。客户端测试新增探针渲染：
  直接渲染规则编辑弹窗，断言 ask 行出现、保存时只写 ask 字段。

### 修复的 Bug

- **脱敏只换掉了根路径，文件名仍然泄漏**：规则 `D:\keys` 命中结果里的 `D:\keys\id_ed25519` 时，
  旧实现只替换 `D:\keys`，留下 `\id_ed25519`。现在整条路径 token 一起脱敏。
- **已授权路径被自己判成泄漏**：同意读取 `D:\keys\id_rsa` 后，结果里出现该路径会被泄漏扫描命中并被
  脱敏（等于把刚批准的内容抹掉）。授权判定现在两个方向都算授权。
- **无 settings 服务时墙有 60 秒的「无规则」窗口**：`apply()` 早先把旧规则文件的回退放在 watchdog
  的 60s 截止处，期间 `engine === null` 而 guard 对所有路径放行。现在 settings 服务缺席时当轮即用
  旧规则文件兜底。
- **审计丢失 `risk` 字段**：`AuditRing.push` 只保留白名单字段，`/wall decisions` 读到的 `risk`
  永远为空。现在 `risk` 与 `approval` 一并落审计。
- **`isWindowsHost()` 与注释不符**：注释说「拿不到 UA 就按 Windows 判」，实现却会返回 `false`，
  导致无 `navigator` 的环境把 `C:\...` 判成非法路径。

### 兼容性

- `version: 1` 规则文档格式**向后兼容**：v0.3 的 `hidden` / `deny` 规则照常工作，`ask` 与三个新字段
  是可选项；v0.3 写的规则文件、settings 文档无需迁移。
- 行为变化（有意为之）：未识别工具的风险按 `unknown`（高于 `high`）计入 ask 门槛与报告；
  新增的 `tools/pre-execute`、`tools/post-execute`、`agent/pre-step` 三个监听器在默认配置下即生效。
  不需要验证/纠正时可关：`onLeak: 'audit'`、`autoPanicOnBypass: false`、
  `repeatDenialThreshold: 0`、`askEnabled: false`。

## v0.3.0

### 修复的 Bug

- **自保护路径算错，设置文档实际敞开**（安全相关）
  插件用 `process.env.DSH_HOME || os.homedir()` 拼设置文档路径，在未设 `DSH_HOME` 的默认环境里
  得到 `<home>/settings.yaml`；而宿主（`@deepseek-ai/dsh-home-paths`）解析的是 `<home>/.dsh/settings.yaml`。
  结果是自保护规则指向了一个不存在的路径，**装着 `rulesJson` 的真设置文档没有被告警保护**——
  agent 可以直接读/改它，从而看清并改写这道墙。
  现在：优先使用宿主自己解析的 `settings.documentPath`（含 `config.path` 覆盖），
  兜底才按 `$DSH_HOME` → `~/.dsh` 的正确顺序推导，并支持 `~` 展开。

- **`/wall borrow add` 在无 agent 上下文时崩溃**
  `BorrowStore.grant(undefined, ...)` 触发 `TypeError: Invalid value used as weak map key`，
  异常会直接冲出命令处理器。现在改为可读错误 `borrow grant requires an agent context`，
  且 `/wall` 处理器对任何内部异常都转成 `{ kind: 'error' }` 文本，绝不抛出。

- **界面显示"已保存并生效"但引擎其实拒绝了规则**
  设置页只校验"路径非空"，相对路径、`?`/`[]` 等非法通配都能存进设置文档；宿主引擎随后
  fail-loud 并保留上一份规则，页面却仍显示保存成功。现在浏览器侧的校验与宿主引擎口径对齐
  （绝对路径、通配符、mode、tools、id 去重），不合法就地报错、不写入。

- **`rulesJson` 的 version 被静默忽略**
  粘贴 `version: 2` 的文档时界面照常当规则用，保存后还会被悄悄改写成 `version: 1`。
  现在直接提示只支持 version 1。

- **文案错误**：新增规则弹窗标题显示英文 `add`、编辑时显示"编辑文件"；按钮写"新增文件"。
  统一改为"新增规则 / 编辑规则"。

- **目录浏览的默认起点写死 `C:\`**：非 Windows 宿主（官方 dsh 在 macOS/Linux）打开「浏览」会
  从一个不存在的盘符开始。现在按平台取 `C:\` 或 `/`（已有路径时仍优先从其父目录开始）。

### 新增内容

- **跨层通配 `**`**：整段 `**` 表示任意层目录（含零层），`C:\work\repo\**\.env` 一次圈住
  仓库根与任意深度子目录里的 `.env`（此前只能逐个深度写规则）。
  另外容忍末尾多余的路径分隔符：`…\dir\**\` 与 `…\dir\` 都按整树处理（此前会变成一个永远匹配不上的正则）。
- **`/wall test <绝对路径> [工具]`**：保存前试算——按工具族拼出正确参数形状，打印判决、
  命中规则与 agent 会看到的文案；不消耗借出、不改变任何状态。
- **`/wall export <文件>`**：把用户规则导出为 JSON，拒绝写进受保护路径（避免把规则写进保险区自身）。
- **扩大工具覆盖**：新增 `str_replace_editor`（`path` 参数）作为路径族；
  `run_code`（`code`）与 `cordis_define`（`code.host` / `code.client`）作为文本族纳入启发式扫描。
- **文本匹配容忍分隔符变体**：规则 `D:\keys` 现在能认出 `D:/keys/x` 与转义形态 `D:\\keys\\x`
  （此前代码/JSON 文本里的转义路径是常见绕过形态）。
- **`/wall status` 增补**：用户规则条数、panic 白名单根数量。
- **`samples/README.md`** 与更新后的 `samples/rules.example.json`（整树 / 单文件 / 跨层 `**` /
  `deny` 只读 / 工具限定各一例）。
- **测试从 41 个增加到 81 个**，并新增三类此前缺失的回归栅栏：
  - `tests/console.test.js`：`/wall` 命令语义（含上面两条崩溃/假成功回归）；
  - `tests/client-bundle.test.js`：用 vm 加载真实 `browser/client.js`，守住"激活依赖只声明
    slots + settingsScope""seat 每次调用返回新对象"这类曾导致**设置页整块空白**的装配错误；
  - `tests/index-wiring.test.js`：用 loader 钩子替换 `schemastery` 后**真的执行 `apply()`**，
    端到端验证 guard 注册、设置文档自保护（上面那个安全修复）、`/wall` 命令与 dispose 清理。

### 内部重构

- `/wall` 命令语义从 `src/index.js` 抽到纯逻辑模块 `src/console.js`（零 cordis 依赖，可直接单测）；
  `src/index.js` 只保留接线。
- `decideWall` 的借出参数变为可选，新增 `probeWall()` 用于无副作用的试算。
- `src/doc-bridge.js` 新增 `dshHomePath()` / `defaultSettingsDocPath()`，复刻宿主 home 解析顺序。

### 兼容性

- 规则文档格式不变（仍是 `version: 1`），既有规则无需迁移；`0.2.x` 的规则文件模式仍作为
  `settings` 服务缺席时的回退路径保留。
