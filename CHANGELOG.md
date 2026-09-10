# 变更日志（CHANGELOG）

版本号遵循语义化版本；`0.2.x` 的历史细节见 git 提交记录（`git log --oneline`）。

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
