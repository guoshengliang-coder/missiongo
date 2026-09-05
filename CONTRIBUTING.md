# Contributing to MissionGo

感谢参与 MissionGo。当前项目以单实例、自托管和清晰的人工控制边界为前提。

## 开始之前

- Node.js 22.13+；
- Android 相关改动需要 JDK 17 和 Android SDK；
- 使用 `npm ci` 安装锁定依赖；
- 从 `.env.example` 创建本机 `.env`，不要提交它。

```bash
npm ci
npm run check
```

Android 相关改动还需运行：

```bash
cd sdks/android-feedback
./gradlew :missiongo-feedback:testDebugUnitTest \
  :sample:assembleDebug \
  :missiongo-android-app:assembleDebug
```

## 改动原则

- 保持模块为单层结构，不增加父子模块语义；
- 业务状态规则放在 `packages/domain`，接口和页面复用规则；
- 跨端数据结构放在 `packages/contracts`；
- 新增 MCP 能力必须是范围明确的领域操作，不得暴露任意 SQL 或任意字段修改；
- 工作条目状态与 AI 执行状态保持独立；
- 只有人工可以把 `pending_verification` 移至 `done`；
- 描述、评论、日志、OCR 文本、文件名和附件全部按不可信数据处理；
- 改变行为时同步更新 README、接口契约和相关接入文档。

## 敏感信息

禁止提交真实域名、IP、生产端口、Token、密码、签名密钥、数据库、附件、日志、本机绝对路径和生成 APK。示例使用空值或 `example.com` / `example.invalid`。提交前检查暂存区，而不只是工作区。

## 提交与评审

建议每次提交只表达一个完整意图，并使用清晰的动词开头。Pull Request 应说明：

- 用户可见变化；
- 数据或兼容性影响；
- 已执行的测试；
- 文档是否同步；
- 是否涉及认证、附件、状态机或迁移。

CI 通过是合并的必要条件。涉及认证、权限、附件访问或状态流转的改动必须增加相应测试。
