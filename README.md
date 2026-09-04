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

## 安装

```text
# 在项目目录生成 tgz 后安装进某 profile（重启 DSH 生效）
npm pack
dsh plugin --profile <profile> add dsh-vault-wall-<version>.tgz
```

重启后到「设置 → 保险区 Vault Wall」添加规则。

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
