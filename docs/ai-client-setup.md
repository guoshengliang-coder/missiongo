# AI 客户端接入说明

当前开放两件事：按编号完整读取 MissionGo 条目，以及在条目上发表评论。目标是让 AI 收到“查看 HG-8”后，可以读取条目正文、分类字段、组件、环境、完整时间线、全部日志和图片，再把实际读取范围明确告诉用户；收到“分析 HG-8 并写回结论”后，把结论作为评论追加到条目上。

评论之外的写入不开放：AI 不修改条目内容与字段、不创建或删除条目、不撤回评论、不领取任务、不修改状态、不自动处理。

写入需要两个条件同时满足——服务端开启写入档位，且用户在登录页授予写入权限。任一不满足时 AI 只能读取，`get_current_account` 会明确告知。

真实服务地址、账号和授权只能保存在服务器或 AI 客户端的安全存储中，不能提交到 Git。下面均为示例值。

## 组成

接入需要两个部分：

1. **MissionGo Skill**：告诉 AI 何时读取、必须读取哪些信息、怎样核对完整性。
2. **MissionGo MCP**：向 AI 提供经过鉴权的数据工具，以及在授权后可用的评论写入工具。

只安装 Skill 而不配置 MCP，AI 知道流程但拿不到数据；只配置 MCP 而不安装 Skill，AI 能调用工具，但不一定会自动读完时间线和附件。

## 安装 Skill

部署后的 Skill 固定地址为：

```text
https://missiongo.example.com/downloads/missiongo-skill/SKILL.md
```

Codex 用户级安装示例：

```bash
mkdir -p ~/.codex/skills/missiongo
curl -fsSL "https://missiongo.example.com/downloads/missiongo-skill/SKILL.md" \
  -o ~/.codex/skills/missiongo/SKILL.md
```

也可以把仓库中的 [`skills/missiongo/SKILL.md`](../skills/missiongo/SKILL.md) 复制到 AI 客户端支持的 Skill 目录。不同客户端的目录和重载方式可能不同，应以该客户端当前文档为准；Skill 内容本身保持为一个可移植的 `SKILL.md`。

安装或更新后，需要重新开始一次 AI 会话，让客户端重新发现 Skill。

## 保持 Skill 最新

Skill 内含工具名、字段名和分页规则，这些与服务端契约绑定。过期的本地副本不会报错，AI 会按旧
流程读完并照常报告“读取完整”，因此需要一个显式的版本检查。

`get_current_account` 会返回服务端期望的 Skill 版本，Skill 会与自身 frontmatter 中的 `version`
比对。不一致时**不影响读取**，AI 会照常读完，但会在读取状态旁声明本 Skill 可能已过期并给出更新
地址。看到该提示时，用同一条命令重新下载覆盖即可：

```bash
curl -fsSL "https://missiongo.example.com/downloads/missiongo-skill/SKILL.md" \
  -o ~/.codex/skills/missiongo/SKILL.md
```

该地址始终返回当前部署对应的版本，并禁用缓存，所以不需要清理中间缓存。覆盖后重新开始一次
AI 会话。

## 配置 MCP

MCP 使用 Streamable HTTP，路径为 `/mcp`，并通过 OAuth 连接现有 MissionGo 账号。从互联网访问时必须经过 HTTPS。第一次连接会打开 MissionGo 登录页；账号密码只交给 MissionGo 服务端验证，不会传给 AI。验证成功后，AI 客户端保存限时授权，服务端在每次读取时继续校验账号及其产品权限。

### Codex

把下面配置加入本机 `~/.codex/config.toml`，或未被 Git 跟踪的项目级 `.codex/config.toml`：

```toml
[mcp_servers.missiongo]
url = "https://missiongo.example.com/mcp"
enabled_tools = [
  "get_current_account",
  "list_products",
  "list_components",
  "list_items",
  "get_item_context",
  "get_item_timeline",
  "get_attachment",
  # 只在需要 AI 回写评论时加入；不加则连接保持只读。
  "append_comment",
]
default_tools_approval_mode = "approve"
```

然后执行首次连接：

```bash
codex mcp login missiongo --scopes missiongo:read
```

需要 AI 回写评论时改为：

```bash
codex mcp login missiongo --scopes "missiongo:read missiongo:write"
```

登录页会列出本次申请的权限。写入权限只允许发表评论，不允许修改条目内容、创建或删除条目、撤回评论或修改状态。

浏览器会打开 MissionGo 登录页。登录成功后重新开始一次 AI 会话，让客户端重新发现连接和 Skill。

### Claude Code 和其他 MCP 客户端

选择支持 OAuth 的 Streamable HTTP 传输，并配置：

- URL：`https://missiongo.example.com/mcp`
- 授权范围：只读接入用 `missiongo:read`；需要回写评论时用 `missiongo:read missiongo:write`
- 允许工具：只允许本页列出的工具。不需要回写时不要放行 `append_comment`

如果客户端不支持标准 OAuth 登录，当前阶段不要把账号密码写入客户端配置或 AI 对话；应改用支持 OAuth 的客户端。

## 验收

接入完成后，用一个同时包含正文、图片和日志的测试条目验证：

> 查看 MissionGo 的 HG-8，先完整读取，不要分析或修改。

合格结果必须满足：

- AI 自动触发 MissionGo Skill，并调用 `get_item_context`。
- AI 先调用 `get_current_account`；未连接时先完成 MissionGo 登录验证。
- 若时间线被截断，AI 会继续翻页直到结束。
- 每张图片都实际读取，每份日志都分页读完。
- 视频当前只读取元数据，AI 会明确说没有查看视频内容。
- AI 会报告“读取完整”或“读取部分”，并列出任何失败项。
- MissionGo 条目、时间线和状态没有任何新增或变化。

开启写入后，再用一句验证回写：

> 分析 MissionGo 的 HG-8，并把结论写回条目。

合格结果必须满足：

- AI 先完成完整读取，再写入；不会在读完之前下结论。
- 写入前把要写的内容复述给你确认。
- 条目上出现一条 AI 评论，正文、分类字段和状态都没有变化。
- 你可以在 Web 上撤回这条评论；撤回后 AI 重新读取时不再看到它。
- 未授予写入权限时，AI 说明当前连接不能回写，而不是反复重试。
- Skill 版本与服务端一致时，输出中不出现过期提示。

版本提示需要单独手工验证一次：把本地 SKILL.md 的 frontmatter `version` 临时改成 `0.0.1`，
重新开始会话并读取同一条目，确认 AI 仍然完整读完，且在读取状态旁声明 Skill 可能已过期并给出
更新地址；随后重新下载覆盖，确认提示消失。

## 当前边界

- 图片会由服务端转换成适合 AI 查看、最长边不超过 2048 像素的预览；原始文件的名称、类型和大小仍会保留。
- 日志每次最多读取 64 KiB，Skill 会根据 `nextOffsetBytes` 自动翻页。
- 视频内容暂不交给 AI，只提供编号、名称、格式、大小和时间；视频抽帧或理解放到后续阶段。
- 不提供任意 SQL、任意字段修改、写回分析、任务领取、状态变更或自动扫描队列。
- 列表、条目详情、时间线和附件都会执行同一套产品权限校验，不能通过猜测编号绕过。
