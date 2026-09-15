# 演示：agent 撞上 Vault Wall 时，双方各自看到什么

下面是**真实输出**——跑的是 `src/index.js` 的真实代码路径（`tools/pre-execute` 审批门 → 单调
`guard()` → `/wall` 命令处理器），审批通道用桩代替弹窗。只把临时目录简写成
`C:\keys` / `C:\wallet` / `C:\archive` 方便阅读。抓取方式见文末。

规则（设置页「以 JSON 编辑」里粘贴，或写进规则文件）：

```jsonc
{
  "version": 1,
  "rules": [
    { "id": "keys",       "mode": "hidden", "paths": ["C:\\keys"] },
    { "id": "archive-ro", "mode": "deny",   "paths": ["C:\\archive"], "tools": ["write", "edit", "bash"] },
    { "id": "wallet-ask", "mode": "ask",    "paths": ["C:\\wallet"],
      "minRisk": "medium", "remember": true, "borrowTtlMs": 600000 }
  ]
}
```

---

## ① hidden：agent 想读私钥 → not-found

```text
agent:  read("C:\keys\id_ed25519")
Error: cannot read "C:\keys\id_ed25519": not found
```

伪装成「文件不存在」。agent 拿不到内容，也不会知道这里有一道墙——它会自己换个思路（这正是我们要的：
**不是跟模型讲道理，而是让它无从下手**）。

## ② deny：agent 想删归档目录 → 明确点名规则

```text
agent:  bash('rm -rf "C:\archive"')
Error: [vault-wall] access to "C:\archive" is denied by rule "archive-ro"
```

`deny` 会说清「这里受保护、哪条规则」，适合「你可以知道有墙，但别碰」的场景（例如归档只读：
读取不受影响，写入被拦）。

## ③ ask：agent 想写你的钱包 → 弹窗问你

先在弹窗里把「路径 + 规则 + 工具 + 风险」摆清楚（**这是你在界面上看到的原文**）：

```text
[vault-wall] "C:\wallet\balance.csv" 受规则保护（规则 "wallet-ask"），agent 想用 `write` 触碰它
（风险：medium／改变内容：写入/原地替换，可逆性一般）。允许这一次吗？
（同意后 600 秒内不再询问这条路径，同目录其它文件仍会问；要授权整棵目录请用 /wall borrow add <目录>）
```

**你点「允许」** → 这次放行，并记一条 TTL 借出（`/wall borrow list` 看得见、随时可 revoke）：

```text
agent:  write("C:\wallet\balance.csv")   → 正常执行，未拦截

/wall borrow list
- b1 read-write ttl C:\wallet\balance.csv expires=2026-09-15T09:20:48Z
```

同一 agent 在 10 分钟内再碰**同一条路径**不会再问（弹窗次数仍是 1 次）；同目录的其它文件仍会问。

**你点「拒绝」** → 明确拒绝，并要求模型别重试：

```text
Error: [vault-wall] the user rejected write access to "C:\wallet\balance.csv" (rule "wallet-ask").
The decision is final for this session step: do not retry this call. Report to the user that the
request was denied and ask how they want to proceed.
```

**宿主没有审批通道**（无人值守会话）→ 一样是拒绝，**绝不静默放行**：

```text
Error: [vault-wall] write access to "C:\wallet\balance.csv" (rule "wallet-ask") requires user approval,
but no approval channel is available in this session, so it is denied. Do not retry: tell the user
this action needs an interactive session (or a pre-granted borrow) instead.
```

### 「只读不打扰」是怎么来的

同一条 `wallet-ask` 规则下，`read` 属于 low 风险、低于 `minRisk: medium`，所以**不弹窗**：

```text
agent:  read("C:\wallet\balance.csv")   → 正常返回，未弹窗
```

风险评级表：`read` / `glob` / `grep` 等只读工具 = `low`；`write` / `edit` / `str_replace_editor` = `medium`；
`bash` / `pwsh` / `run_code` / `cordis_define` = `high`；**没见过的工具（MCP/第三方）= `unknown`，比 high 更严**。
门槛以上才问——这就是「读随便读，写要问我」。

## ④ 事后自证：`/wall report`

护栏本身也要能被检查。打了上面这些调用之后：

```text
Vault Wall 护栏评估（文章 Harness 五要素：约束 / 验证 / 纠正）
时间窗口: 2026-09-15T09:10:48Z → 2026-09-15T09:10:48Z　规则源: settings　panic: off

【约束】工具调用 4 次：拦截 2 次（50.0%），放行 1 次，审批门命中 0 次
  判决分布: allow=1　hidden-deny=1　deny=1　ask-unavailable=1

【人在回路】问人 1 次：通过 0　人拒 0　取消 0　无通道 1
  ⚠ 有 1 次因**没有可用审批者**而 fail-closed 成拒绝：ask 规则在这个会话里退化成了硬拒绝。

【验证】授权一致性: bypass=0（>0 表示墙判了拒绝却仍执行成功，必须查）　泄漏扫描: leak=0（已脱敏 0／已阻断 0）

【纠正】重复触墙（同一 agent × 同一规则 × 同一路径）: 记录 0 条，其中已升级 0 条
```

注意最后两行：**墙会自己报告「有没有被绕过」「有没有把结果里的敏感路径漏出去」**，而不是只报「拦了多少」。
`bypass` 一旦大于 0，说明某个判了拒绝的调用居然执行成功了——那是最该马上查的信号（默认还会自动熔断）。

## ⑤ 保存前先试算：`/wall test`

```text
/wall test C:\wallet\balance.csv write
probe: write C:\wallet\balance.csv
risk: medium（改变内容：写入/原地替换，可逆性一般）
decision: ask
rule: wallet-ask (mode=ask minRisk=medium remember=true borrowTtlMs=600000)
agent 会看到: [vault-wall] "C:\wallet\balance.csv" (rule "wallet-ask") is approval-gated: this call was
never approved by the user, so it is denied.
（ask 规则：真跑起来会先经官方审批通道问人；通过后 记一条 600000ms 借出。试算不弹窗。）
（试算不消耗借出，也不改变任何状态）
```

## 这些输出是怎么来的

```text
# 与 tests/index-wiring.test.js 同款：假宿主 + 桩审批通道，真实执行 apply()
node tests/index-wiring.test.js      # 断言版（213 个测试里的一部分）
npm test                             # 全部测试
```

测试里覆盖了本文档提到的每一条路径（hidden / deny / ask 通过 / ask 人拒 / ask 无通道 /
minRisk 门槛 / TTL 借出 / 授权一致性校验 / 泄漏脱敏 / 重复触墙升级 / 回滚），
所以这份演示不会随着代码演进悄悄失真。

## 想录 GIF 的话（20–40 秒足够）

本仓库暂时没有演示 GIF。要录一支的话，建议脚本：

1. 设置页里粘贴上面的规则 JSON → 保存（2 秒）；
2. 对 agent 说「读一下 C:\keys\id_ed25519」→ 看它得到 not-found（5 秒）；
3. 说「把 C:\archive 清空」→ 看它得到 denied by rule "archive-ro"（5 秒）；
4. 说「往 C:\wallet\balance.csv 里追加一行」→ **弹窗出现**，镜头停在弹窗上看清
   「路径 + 规则 + 风险」→ 点「允许」（8 秒）；
5. 说「再写一次同样的文件」→ 直接通过、不再弹窗（4 秒）；
6. `/wall report` 收尾（5 秒）。

录好的文件放到 `docs/demo.gif`，README 首屏已经留好位置（把注释里的 `<img>` 打开即可）。
