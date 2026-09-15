# 样例规则（samples）

这些文件是**可直接粘贴的规则文档**，用来做起点。用法：

1. 打开 DSH →「设置 → 保险区 Vault Wall」；
2. 点「以 JSON 编辑」，把文件内容整段粘进去，点「解析并应用到列表」；
3. 回到列表页点「保存更改」——保存即刻生效，不用重启。

或者把内容作为 `rulesJson` 直接写进设置文档的 `vault-wall` 命名空间；旧规则文件模式下也可以
把文件放到规则文件路径（默认 `~/.dsh/vault-wall-rules.json`）。

## 文件

| 文件 | 说明 |
| --- | --- |
| `rules.example.json` | 五条典型规则的合集：目录整树 / 单文件 / 跨层 `**` / `deny` 只读 / 工具限定 / **ask 人在回路**（记借出与一次一授权各一条） |

## 写规则时的几个要点

- **路径必须绝对**：`C:\...`、`\\server\share\...`（Windows）或 `/home/you/...`（POSIX）。相对路径会被引擎 fail-loud 拒绝。
- **目录整树**：写目录本身即可（`C:\Users\you\secret-box` 圈住整棵树），也可以显式写 `...\secret-box\**`。
- **段内 `*`**：只匹配一段内的字符，不跨分隔符（`C:\logs\*.log` 不会命中 `C:\logs\nested\a.log`）。
- **跨层 `**`（v0.3 新增）**：整段 `**` 表示**任意层目录（含零层）**，例如
  `C:\work\repo\**\.env` 会同时命中 `C:\work\repo\.env` 与 `C:\work\repo\a\b\.env`。
- **`?` 与 `[abc]` 不支持**：写了会直接报错（宁可报错也不静默放行）。
- **`tools` 省略 = 全部工具**；写了就只对该清单里的工具生效（可用来做「只读归档」这类半开规则）。
- **`mode`**：`hidden` = 伪装不存在（连路径名都不透露）；`deny` = 明确报错并点名规则；
  `ask` = **先弹窗问你**（v0.4）。
- **`minRisk` / `remember` / `borrowTtlMs` 只对 `ask` 有效**：写在 `hidden` / `deny` 上会 fail-loud
  报错（设置页也会在保存前拦下）。

## ask（人在回路）怎么用

```jsonc
{
  "id": "keys-ask",
  "mode": "ask",
  "paths": ["D:\\keys"],
  "minRisk": "medium",     // low | medium | high | unknown（默认 low）
  "remember": true,        // 同意一次后记一条 TTL 借出（默认 true）
  "borrowTtlMs": 600000    // 借出时长；0 = 一次一授权（默认 600000 = 10 分钟）
}
```

要点（都是刻意的取舍）：

- **问的是你，不是模型自己**：审批走官方审批通道（`dsh-client-ui-approval`），弹窗里会写清
  「哪条路径、哪条规则、什么工具、什么风险等级」。没有可用审批通道时 **fail-closed 成明确拒绝**，
  不会静默放行。
- **`minRisk` 决定要不要打扰你**：只读族是 `low`，写入族是 `medium`，shell / 代码执行是 `high`，
  **未识别的工具（第三方 / MCP）算 `unknown`，比 `high` 更严**。`minRisk: "medium"` 的效果是
  「读不打扰、写和执行才问」。
- **借出只覆盖被批准的那一条路径**：同意读 `D:\keys\a.txt` 不等于同意整棵 `D:\keys`（同目录的
  `b.txt` 会再问一次）。要目录级授权，用 `/wall borrow add "D:\keys" --ttl 600000`。
- **`remember: false` 或 `borrowTtlMs: 0`**：一次一授权，每次都问。
- 想整体关掉询问（例如无人值守会话）：把宿主配置 `askEnabled` 设为 `false`，此时 ask 规则一律
  按明确拒绝处理——**不会**悄悄变成放行。

## 先试算，再保存

不确定一条路径会不会被拦？保存前用 `/wall test <绝对路径> [工具名]` 试算：

```text
/wall test C:\work\repo\a\b\.env read
```

它会告诉你这条路径当前会被判成 `allow` / `hidden-deny` / `deny` / `ask`（以及命中哪条规则、
该工具的风险等级），并且**不会消耗任何借出、不改变任何状态**。规则本身有疑问时用 `/wall lint`
做体检（过宽、被遮蔽、路径不存在、工具名不可达……），事后想复盘用 `/wall report`。

改坏了也不怕：每次保存都会记一条修订，`/wall history` 看清单、`/wall rollback prev` 退回上一条
（回滚会写回规则源并记为新修订）。想让修订跨重启保留，把宿主配置 `historyFile` 指到一个
**工作区之外**的路径（它和设置文档一样会被自保护圈禁）。
