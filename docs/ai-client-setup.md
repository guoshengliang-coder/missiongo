# AI 客户端接入说明

服务端配置 `MCP_API_TOKEN` 后，MissionGo 会在 `/mcp` 提供带鉴权的 Streamable HTTP MCP 端点。当前工具支持按需读取条目、查看附件和回写分析，不提供 SQL、任意修改条目、领取任务或自动处理能力。

真实服务地址和 Token 必须只保存在本地配置中。下面全部使用示例值。

## 服务端配置

生成一个强随机、可撤销的 Token，并写入服务端未被 Git 跟踪的 `.env`：

```dotenv
MCP_API_TOKEN=replace-with-a-long-random-token
```

从互联网访问时，必须先通过 HTTPS 反向代理暴露服务。不要直接公开开发端口。

## Codex

在启动 Codex 的本地环境中设置 Token：

```bash
export MISSIONGO_MCP_TOKEN="replace-with-your-local-token"
```

将下面的配置加入本机 `~/.codex/config.toml`，或未被 Git 跟踪的项目级 `.codex/config.toml`：

```toml
[mcp_servers.missiongo]
url = "https://missiongo.example.com/mcp"
bearer_token_env_var = "MISSIONGO_MCP_TOKEN"
enabled_tools = [
  "list_products",
  "list_components",
  "list_items",
  "get_item_context",
  "get_item_timeline",
  "get_attachment",
  "append_analysis",
]
default_tools_approval_mode = "writes"
```

把仓库中的 [`skills/missiongo`](../skills/missiongo) 安装或链接到本机 Codex Skill 目录。之后可以直接这样说：

> 分析 MissionGo 条目 HG-12，把结论回写到条目中，不要修改代码。

## Claude Code

Claude Code 支持带请求头的 HTTP MCP 服务。如果部署地址属于隐私信息，请只把配置保存在本地：

```json
{
  "mcpServers": {
    "missiongo": {
      "type": "http",
      "url": "https://missiongo.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MISSIONGO_MCP_TOKEN}"
      }
    }
  }
}
```

启动 Claude Code 前先设置 `MISSIONGO_MCP_TOKEN`。不要把 Token 明文写进 `.mcp.json`，也不要提交真实的私有服务地址。

## Hermes 和其他 MCP 客户端

选择客户端的 Streamable HTTP 传输方式，并填写：

- URL：`https://missiongo.example.com/mcp`
- 请求头：`Authorization: Bearer <本地 Token>`
- 工具：允许使用 Codex 示例中列出的七个工具

如果客户端支持可复用指令或 Skill，请使用 [`skills/missiongo/SKILL.md`](../skills/missiongo/SKILL.md) 中的工作流。MCP 配置负责提供数据访问，Skill 负责约束安全的分析流程。

## 当前可用工具

- `list_products`、`list_components`、`list_items`：查找产品、组件和工作条目。
- `get_item_context`：读取完整结构化上下文，包括设备、版本信息和附件元数据。
- `get_item_timeline`：分页读取历史事件。
- `get_attachment`：分页读取日志；小型图片可以直接交给 AI 查看；视频和大型图片暂时只返回元数据。
- `append_analysis`：把结论、依据和风险写入时间线，不改变条目状态。重复使用同一个幂等键时会返回原结果，不会创建重复记录。
