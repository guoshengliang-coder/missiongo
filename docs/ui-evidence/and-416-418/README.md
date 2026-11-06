# AND-416 / AND-417 / AND-418 验证记录

截图来自隔离 UI fixture，2026-11-06；没有真实用户、工作条目正文或生产数据。375×812 为触控，1440×900 为桌面；浅色与深色各一组。授权详情已展开，输入区保留未发送草稿；升级提示复用公共 Modal。预期变化是授权决定直接提交、升级期间显示等待而非通用错误；未更新既有视觉基线。

| 尺寸 / 主题 | 授权等待 | 升级等待 |
| --- | --- | --- |
| 375×812 浅色 | [截图](permission-375-light.png) | [截图](upgrade-375-light.png) |
| 375×812 深色 | [截图](permission-375-dark.png) | [截图](upgrade-375-dark.png) |
| 1440×900 浅色 | [截图](permission-1440-light.png) | [截图](upgrade-1440-light.png) |
| 1440×900 深色 | [截图](permission-1440-dark.png) | [截图](upgrade-1440-dark.png) |

## 自动验证

- `npm run check`：通过，包括脚本、领域、Web、节点、服务端测试、类型及构建；样式基线无新增豁免。
- `and-416-418.audit.spec.ts`：25 个场景通过。覆盖 Claude/OpenCode、当前与已发布的 keyless macOS Claude、控制台与条目内会话、375px/桌面、明暗、三档字号；第一次提交失败后可重试、双击只发一次决定、绑定原请求 ID、文字草稿保留。归档、恢复、归档深链、真实缺失及重新选择清除错误；升级正常结束/失败/过期、首次加载兜底、普通故障不冒充升级、恢复不重放写请求。
- `agent-approval-visibility.audit.spec.ts`、`agent-question-scroll.audit.spec.ts`、`plan-approval.audit.spec.ts`：48 个既有回归通过，包括 Codex、MCP 确认、320px/812×375 短高度、普通问题与表单的选择后发送、方案批准一次及历史只读。
- 发布脚本及安装器回归通过；实际本地 nginx 实验中，上游不可用时独立状态与兜底 HTML/JS/CSS 仍可访问。成功/失败/中断保留原始退出码，缺失或缓存的状态路由不允许切换，健康提交不匹配不结束升级。
- Android `:missiongo-android-app:testDebugUnitTest :missiongo-android-app:assembleDebug` 通过；边界测试覆盖版本、期限及失败信号。仅构建调试 APK，没有发布安装包。

## 共用实现与限制

`AgentSessionQuestions` / `PermissionQuestion` 覆盖两处会话入口；领域 helper 与服务端列表共享请求身份识别，推送 attention 分类不改。升级复用 `Modal` 和既有主题令牌，原生及首次加载分别使用平台等待页和宿主独立兜底。归档判定为单条、批量及深链的公共读取判断；本轮浏览器直接操作覆盖单条、恢复及深链，批量沿用同一列表判定，未额外宣称独立批量端到端验收。

真实 Android 设备及生产发布未验证；宿主路由、静态文件及共享发布脚本安装需另有生产/本机配置授权。完整安装顺序见 [发布状态说明](../../release-status.md)。条目仍在处理中，PR 合并及完整产物发布前不推进开发完成/待验证，更不代替人工验收。
