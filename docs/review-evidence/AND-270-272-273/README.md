# AND-270、AND-272、AND-273 审查证据

所有图片均使用虚构测试数据，不连接真实用户会话。

- Web：实际浏览器回归中的自动授权已通过状态。375×812 与 1440×900，浅色和深色各一张；大块授权提示已隐藏，运行状态仍可见。回归另行验证人工待授权、自动拒绝重试入口、提交后的隐藏、重试失败反馈，以及详情中授权记录消失时不会回退到旧列表记录。
- macOS：使用实际 `UnreadSessionCard` 和 `AgentSkillRow` 组件进行离屏渲染，检查多条目及长标题换行、逐 Agent 版本、成功/失败/同步中状态、失败原因和重试入口。两张图片属于组件级布局检查；完整菜单滚动、真实文件权限和后台心跳更新仍需安装后验收。

| 界面 | 浅色 | 深色 |
| --- | --- | --- |
| Web 桌面 | [desktop-light.png](desktop-light.png) | [desktop-dark.png](desktop-dark.png) |
| Web 手机 | [phone-light.png](phone-light.png) | [phone-dark.png](phone-dark.png) |
| macOS 菜单组件 | [macos-light.png](macos-light.png) | [macos-dark.png](macos-dark.png) |

验证结果：

- `npm run check`：通过。
- `npm run lint`：最终新增浏览器回归文件通过检查。
- `swift test --package-path apps/macos --scratch-path .build/macos --cache-path .build/swift-cache --config-path .build/swift-config --security-path .build/swift-security`：467 项测试，7 项按条件跳过，0 失败。
- `swift build --package-path apps/macos --scratch-path .build/macos --cache-path .build/swift-cache --config-path .build/swift-config --security-path .build/swift-security`：通过。
- `npx playwright test tests/ui/agent-approval-visibility.audit.spec.ts --project=audit`：通过，四种视口与主题均无横向溢出。
