# AND-479 / AND-480 / AND-481 / AND-482 实施与验证

本批按固定版本方案实施，单分支保留全部修复；本记录不表示已经创建 PR、合并、发布或人工验收。

## 行为变化

| 条目 | 实施结果 | 共用实现与边界 |
|---|---|---|
| AND-482 | 同意更新后保留原窗口，展示下载、校验、安装、失败处理及重启；长说明在进度之后滚动，底部操作常驻 | ClientUpdateWindowController / ClientUpdateView 观察既有 AppModel；保留取消代际隔离、包校验、安全等待及立即重启确认 |
| AND-481 | 条目来源会话一次返回原详情，列表来源保留列表层；宽窄切换、刷新、前进后退不增加虚假列表层 | 原 App 路由、BackButton、Android 深度桥接；返回恢复焦点及阅读位置；页面上层保留文字/附件草稿，不承诺刷新持久恢复 |
| AND-480 | 展开内容在原两个控件下方独立出现，控件宽度和横向位置不受正文影响 | 控制台与条目面板共用 AgentRunDetails；原生 details / aria-controls；停止权限不变 |
| AND-479 | v1 增加可选受限诊断，明确检查失败、过期、查询异常及恢复；重新检查有进行中和结果 | ReleaseNotice / Modal / toast、宿主兜底、Android 原生入口；不显示任意原文，不重放 mutation |

附带的同范围补修：返回条目会卸载控制台，因此将文字、附件和附件错误草稿提升至当前页状态，换账号清除；发布 block 的变化同时补了共享安装器对已知旧版的窄范围迁移，不放行未知版本。

## 实现文件

- macOS：AppModel.swift、ClientUpdateWindow.swift、SignedInView.swift、UpdateLifecycleTests.swift。
- Web 导航与草稿：App.tsx、navigation.ts、agent-session-console.tsx。
- 共用展开：agent-session-feedback.tsx、styles.css。
- 服务更新：release-status.ts、ReleaseNotice.tsx、i18n.tsx、release-status.test.ts。
- 发布集成：deploy.sh、release-status.sh、enable-release-status.mjs、受审阅的 release-status-v1.block.sh、release-status.test.mjs。
- 宿主兜底：deploy/release-status/wait.js。
- Android：MainActivity.kt、ReleaseAvailability.kt、strings.xml、ReleaseAvailabilityTest.kt。
- UI 回归：and-479-481.audit.spec.ts、and-427-session-controls.audit.spec.ts、and-416-418.audit.spec.ts。
- 设计与部署边界同步到 design-system.md、release-status.md。

## 验证结果

| 验证 | 结果 | 说明 |
|---|---|---|
| npm run check | 通过 | lint、身份、平台契约、迁移、样式、测试、类型检查与生产构建；脚本172项，工作区106/645/9/59/1382通过，服务端2项原有跳过 |
| npm run check:ui-contracts | 通过 | 沿用共享浮层/菜单契约；不扩大样式豁免 |
| swift test --package-path apps/macos | 通过 | 首轮全套749项执行，8项原有跳过，无失败；当时已包含新的窗口实现 |
| 最终 UpdateLifecycleTests 定向 | 8项通过 | 包含新增的窗口关闭/取消与同一窗口生命周期、长说明、390/640宽度、明暗实际渲染；已查看最终图片 |
| Android App testDebugUnitTest / assembleDebug | 通过 | 14项单测，无跳过；包含失败/过期/旧协议与白名单诊断；仅本地调试构建，未安装 |
| AND-416/418 与最初新增 UI 专项 | 32项通过 | 原权限/归档、更新、首次加载、恢复、草稿和重复写入保护 |
| 设置、共享浮层与会话反馈复查 | 19项通过 | agent-settings-compact、overlay-history、and-371-session-feedback；其余同批新增用例已在最终专项重新执行 |
| 最终 AND-427 + AND-479/481 | 14项全部通过 | 7档宽度、三档字号、明暗/触控；展开前后几何；来源返回/焦点/刷新/前进后退；查询去重、恢复 toast 可见、未知诊断隐藏、兜底版本核验 |
| git diff --check | 通过 | 无补丁空白错误 |

本地 UI 使用独立端口和临时数据库，不读取生产用户数据。涉及时间的用例固定时钟，并统一 Node 模拟状态期限与浏览器时钟；兜底语言固定为中文。开发过程曾出现旧测试时间不一致、控制台卸载丢草稿与编辑期间热更新干扰，均保留断言、修正实现或测试条件后复测，不靠删除测试或放宽阈值通过。

macOS 截图使用真实 AppKit/SwiftUI 窗口和离线注入服务；先给原生绘制周期完成再截图，避免缓存图层未绘制被误当产品效果。图片为测试状态，更新目标是虚构版本，未真实替换应用。

## 集成与发布前置

- 实施与交付前均核对 origin/main，基线为 4010bc0e11368254a0653200b053936619313ff7，无相关主线漂移。主工作区和其他 worktree 未修改。
- 预期产物：AND-482 为 macosApp；AND-480、AND-481 为 web；AND-479 为 web、androidApp。最终发布按完整候选及真实 diff 核定。
- AND-479 还需发布者安装更新后的共享发布 block、宿主兜底静态文件；本次未运行共享工具 --apply、未改宿主配置、未操作生产。
- 本地提交不等于集成。没有核实合并时，四条保持处理中；所有必需产物及部署前置具备实际证据后才能交到待验证。人工验收由人完成。

## 尚未证明的场景

真实 macOS 跨版本安装、签名/Gatekeeper及权限恢复、活动节点等待后重启、Android实体机WebView/系统返回和生产更新失败/恢复仍待核验。未在生产制造故障。历史重启检查失败的具体底层原因没有被本次证据证明，提示修复不等于底层故障已根治。公开清单读取不证明用户设备已安装新版本。

## AND-480 用户审阅后的文案与对齐补修

用户要求移除可见“运行详情”，以箭头提示开合；右侧“停止当前回合”缩为“停止”；下方诊断区域与状态卡片左对齐。按本次明确要求落实，沿用原获批范围，未再次请求批准。

- 共用 AgentRunDetails 只显示状态与箭头，展开用途放在summary可访问名称中；停止视觉短文案独立于无障碍名称，确认仍说明当前回合。
- 原操作行与展开正文采用同一左边缘。320px单栏三档字号保持同行，展开前后宽度、位置稳定；521px极窄双栏容器保留正常换行，不缩小字号或点击区。
- 修改文件：agent-session-feedback.tsx、agent-session-console.tsx、i18n.tsx、styles.css、and-427-session-controls.audit.spec.ts，以及本记录与设计规范。停止权限、请求与确认、其余三个条目实现不变。
- 完整npm run check通过；最终可访问名称调整后lint、typecheck及check:styles通过。AND-371共用反馈7项通过；最终AND-427六项全部通过，覆盖7档视口、三档字号、明暗与触控，新增视觉文案、左对齐、手机同行及面板入口断言。
- 初轮测试用innerText检查视觉隐藏文本，随后将展开说明直接放到aria-label；几何复查确认521px双栏容器窄于手机单栏，因此同行断言按现行单栏/双栏契约区分，同时保留所有宽度的左对齐、无溢出与展开稳定断言。
- 新截图替代旧AND-480三张；先前15图图册的AND-480部分为上一版文案，不作为本轮最终证据。真实WebView仍待发布后验证，未推送、合并或发布。

## AND-480 对齐关系纠正

上一轮把用户要求误解为整组操作靠界面左侧。本轮按用户明确澄清恢复“运行中＋停止”作为整体居中，仅下方详情块的左边缘与居中后的运行状态卡片对齐；短文案保持。本文此前关于左边缘的描述均以本段的相对关系为准，旧靠左截图不再是当前效果。

共用组件使用对称网格空白固定操作组居中，展开正文从操作组所在列开始延展；正文内容不撑宽或推动操作组。新增独立几何断言检查操作组中心、详情左边缘与开合稳定性，防止把相对左对齐再次误做为界面左对齐。停止权限、确认与请求不变。

完整npm run check通过；AND-427六项通过，覆盖七档视口、三档字号、明暗与触控。已查看320px大字号和1440px截图。共享反馈回归另外复查；真实WebView和生产发布尚未验证。本轮仍仅在原分支追加本地提交。

## AND-480 详情块独立居中、按内容收宽

用户进一步选择灰色详情框自身全局居中，宽度只取内容所需空间，不再从状态卡片向右铺满。该选择替代上一节的相对左对齐要求；上方“运行中＋停止”继续整体居中，短文案和操作语义保持。

共用组件恢复纵向居中容器，灰色区域使用内容宽度并限制最大宽度；短内容收窄，长内容换行。测试相应改为独立验证操作组居中、详情框居中、短内容没有拉满、长连续诊断不溢出，以及开合不推动操作组。控制台与条目内面板共用，无新增权限或样式豁免。完整检查与专项结果见本轮完成评论。真实WebView尚未验证，未推送、合并或发布；本轮新截图替代上一版相对左对齐截图。
