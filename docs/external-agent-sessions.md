# 外部 Agent 会话

用户直接在 Agent 客户端要求处理条目时，`claim_item.session` 或 `register_agent_session` 建立一条外部处理记录。同一账号、OAuth 客户端、Agent 类型和稳定引用会合并为同一条记录，可关联多条用户指定的条目。MCP 进展、条目状态和原生运行状态各自独立。

## 支持范围

| 客户端 | 进展上报 | 原生消息与 Web 文字回复 | 前提 |
| --- | --- | --- | --- |
| Codex | 支持 | 支持 | 已确认原生 ID，选定节点的 Codex 控制通道能访问该会话 |
| OpenCode | 支持 | 支持 | 已确认原生 ID，会话运行在该节点已登记的同一共享服务 |
| 普通 Claude Code CLI | 支持 | 暂不支持 | 现有控制器依赖 MissionGo 专用宿主，不能接管任意 CLI |
| tracking、其他 Agent | 支持 | 暂不支持 | 跟踪 UUID 不构成原生 ID |

Codex CLI 若不在选定控制通道可访问的运行时中，连接保持不可用，不会另起会话冒充接管。OpenCode 普通 TUI 的临时服务也不能与已登记共享服务混用。需升级包含此外部同步协议的 MissionGo macOS 客户端；旧客户端不拉取外部绑定。

## 使用流程

1. Agent 按 Skill 领取用户指定条目，传入可信原生 ID 和 `refKind: native`。不能取得 ID 时只登记 tracking，不扫描其它聊天猜匹配。
2. 用户在 Web 控制台打开记录，点击「同步原生会话」，选择会话所在节点。这会同步该会话可见的用户、Agent、计划与提问消息，包括已存在的消息；不枚举或导入其它会话正文。
3. 节点首次成功读取该 ID 后才开放文字回复。同步失败、节点离线或撤销、全部条目完成、记录归档或权限不足时不可回复。
4. 回复经过 queued → delivering → delivered。网络错误或节点重启使交付无法确认时进入 delivery_unknown；先在原客户端核实，再确认「已收到」或「未收到」。不会自动重发；确认未收到也不会创建新回复。
5. 断开保留已同步历史。归档、断开只停止 MissionGo 同步，不关闭或归档原客户端会话，不创建派单、占用派单执行名额或改变条目状态。存在待交付或未确认回复时，先取消或确认才能归档、断开或更换节点。

当前不开放附件、模式或模型变更、远程停止，也不接入外部 Codex 会话的权限审批控制；权限批准仍在原客户端操作。原生消息不能替代条目结局评论或发布核验。

## 接口与权限

- `PUT /api/v1/agent-sessions/:id/native-connection`，正文 `{ nodeId }`：连接当前账号所属节点，只允许 Codex、OpenCode native 记录，检查全部关联产品 operate、ai 权限。
- `DELETE /api/v1/agent-sessions/:id/native-connection`：停止同步，递增绑定代次，使旧同步请求失效。
- 原有 detail、list、commands、cancel、resolve-delivery、read、archive 入口兼容外部记录，仍检查全部关联产品权限。归档不发送来源归档命令。
- 新节点通过 `X-MissionGo-External-Sessions: 1` 和进程级 `X-MissionGo-External-Worker` 拉取精确绑定。快照另带 `X-MissionGo-External-Generation`，服务端核对绑定代次、节点所有权和当前产品权限。旧客户端不收到此类记录。
- 回复预留持久化 worker 身份。worker 变更或预留超时转为交付待确认，防止重启后重发。节点不能直接把未预留回复标为成功。

原生连接不新增 MCP 控制工具，不提供任意字段更新、命令执行或会话发现接口。消息按 sourceId 更新，保留省略的历史；重复快照不推进未读时钟。
