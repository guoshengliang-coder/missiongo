# AND-409 界面验证

隔离 UI fixture 的合成任务，无生产条目、凭据或实际节点路径。截图来自 `agent-handoff.audit.spec.ts`；表单处于大字号压力档，375×812 触控和 1440×900 桌面的明暗主题分别保存。

- [手机浅色](phone-light.png)、[手机深色](phone-dark.png)
- [桌面浅色](desktop-light.png)、[桌面深色](desktop-dark.png)

6 项交接用例通过，另覆盖 320px、三档字号、原生嵌套停止核实、Esc 草稿保护、503 保留输入、提交期间禁用、保存后保持处理中及关闭焦点恢复。37 项共用入口回归通过，覆盖明确方案离线审批、停止核实、新会话、派单默认配置及原项目会话。

共用 `Modal`、`ExecutionStopNotice`、`DispatchDialog`、`Select` 和批准提示条；未新增 CSS 或扩大样式豁免。截图用于查看排版，交互和授权结果以自动化断言为准；真实设备停止和原客户端加载续接仍须人工验证。

详情页新增接手按钮，因此同步五档视口、明暗主题共 10 张 Linux 视觉基线。基线通过显式 [CI 快照生成任务](https://github.com/guoshengliang-coder/missiongo/actions/runs/42048049645) 生成，逐张核对实际图及差异：新增按钮使执行区与下方内容下移，顶部操作栏、固定评论栏和横向边界保持正常。队列、列表基线未改动。
