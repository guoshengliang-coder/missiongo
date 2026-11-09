# 发布期间的连接状态（AND-418）

升级提示只依据独立于 Web/Server 容器的宿主状态文件，不将普通网络错误或任意 503 当作发布。
Web 轮询 `/release-status.json`（前台每 5 秒、恢复前台立即查询、请求 5 秒超时），协议为：

```json
{"version":1,"phase":"upgrading","expiresAt":1890000000000,"release":"source-commit"}
```

`phase` 为 `idle`、`upgrading` 或 `failed`；`expiresAt` 为毫秒 UTC 时间，非 idle 状态最长有效期 15 分钟。
发布脚本使用 10 分钟期限。状态过期或中断显示可关闭的恢复未确认提示，不无限阻塞，也不自动重放写请求。
升级时保留页面、文字和附件草稿，健康确认后仅重新查询。版本检查仍沿用原有草稿保护。

## 首次安装（需要生产配置授权）

本 PR 仅交付文件；不要把合并等同于宿主已配置。由已获授权的发布者：

1. 在宿主建立专用、非 release 快照内的目录（默认 `/var/lib/missiongo-release-status`），只允许发布账号通过 sudo 更新，nginx 只读。
2. 将 `deploy/release-status/wait.html`、`wait.js`、`wait.css` 安装到该目录，写入初始 `status.json`：`{"version":1,"phase":"idle","expiresAt":0,"release":"initial"}`。文件以 0644 供 nginx 读取，不放凭据、主机路径、命令或内部日志。
3. 复制 `deploy/nginx-release-status.conf` 到宿主专用配置，替换目录占位符，在已有 HTTPS server 内 include；在原应用 `location /` 添加 `proxy_intercept_errors on;`。先备份原配置，运行 `nginx -t`，成功后 reload。保留原 TLS、安全头、MCP 和下载路由。不要替换整份站点配置。
4. 公开核对状态 JSON、三个兜底静态文件及 `Cache-Control: no-store`，确认路径不经过应用容器。兜底页用独立外部脚本和样式，CSP 不需要 unsafe-inline。应用代理 502/503/504 的首次加载可显示该页：有有效升级信号才提示升级，否则明确连接失败。
5. 在当前合并代码的 worktree 运行 `node scripts/enable-release-status.mjs` 只读检查完整补丁，再经授权执行同命令 `--apply`。安装器会先核实完整组合改动，再补齐缺失的计时依赖并接入状态切换，无需分开运行多个安装器。它在共用 OS 发布锁内备份并原子修改本机共用 deploy 脚本，保留 CI、覆盖、签名和目标规则；不修改生产服务器。自定义目录通过发布环境 `MISSIONGO_RELEASE_STATUS_DIRECTORY` 指定。
6. 之后仍统一使用 `missiongo-release plan/check/deploy --candidates <完整清单>`。不能改用仓库脚本绕过统一入口。安装器拒绝不认识的共享脚本版本，不猜测修改。

## 发布顺序与失败边界

全部候选覆盖、CI、账本、备份检查保持。先 `docker compose build`，此时旧服务仍运行；切换前写入随机 idle 探针并从公网核对原样读回，防止错误路由或缓存。探针失败不切换。随后写 upgrading，预留 10 秒通知窗口，再 `up -d --no-build --wait --wait-timeout 180`。公网 health 的提交必须与本次一致，才写 idle。下载与候选发布对账仍由后续既有流程负责；idle 只说明 API 恢复，不说明所有产物交付。

失败 trap 写 failed，不覆盖原始退出码或发布计时。SSH 断开导致失败状态写入失败时，期限会释放客户端阻塞。没有后台进程持续续期；超时后不宣称已恢复。不要为了消除提示将未健康的服务手工标为 idle。

Web 已加载页用公共 Modal，首次加载用宿主兜底页。Android 已加载页共用 Web 交互，首次 main-frame GET 网络/HTTP 失败独立查询宿主状态，只有有效 upgrading 才显示原生等待；恢复后仅重试该失败 GET。Activity 销毁或新页面加载后旧响应无效。Android 原生处理需要新 APK，不能用 Web 发布代替。

## 验证

脚本测试验证 trap、原始退出码、无状态路由时拒绝切换与共享安装器幂等；本地 nginx 实验验证上游停服后状态和兜底资源仍可读。UI 测试覆盖升级、失败、过期、普通断网、草稿、恢复和写请求不重放；Android JVM 测试覆盖信号边界。真实 Android 设备、首次安装的宿主配置及真实生产发布仍需在授权后验证，不能以模拟结果冒充。

## 失败诊断与重新检查（AND-479）

v1 兼容增加可选 `failure: {stage, reason, occurredAt}`。stage 仅接受 `restart`、`health`；reason 仅接受 `restart_check_failed`、`health_timeout`、`health_unavailable`、`health_mismatch`、`health_invalid`、`unknown`。occurredAt 为毫秒 UTC 时间。客户端忽略未知诊断，保留旧协议中性的未知原因说明；不直接展示服务端自由文本。诊断发生时间无效或明显超前时同样忽略。

重启命令非零只证明重启检查未通过，不能推断特定容器超时。公网健康请求确实返回超时码时才记录 `health_timeout`；读取失败、无效响应和提交不匹配分别记录。失败 trap 不输出原始日志、命令、凭据或路径，不改变原退出码。idle 只说明服务 API 恢复，不代表所有产物发布。

Web 查询结果独立于最后可信的发布状态：短暂查询失败保留未过期状态，过期后释放阻塞；重新检查去重且显示加载与结果，恢复后只刷新查询。恢复通知复用 toast。草稿仅在当前页保留，不暗示已提交或永久保存。宿主首次加载和 Android 仅重新尝试原失败 GET；重新检查本身不刷新页面，只有可信恢复条件或显式重连才重新加载，不重放 API mutation。

仓库保留受审阅的旧 v1 发布 block，用于共享安装器识别已安装版本并执行窄范围迁移。未知/部分安装仍拒绝，覆盖、CI、锁、计时及退出码门禁不变。合并后仍需发布者授权执行共享安装器并更新宿主 `wait.js` 等资源；仅发布 Web 或 APK 不会自动替换这些宿主文件。本地开发和测试不执行本机共享工具的 `--apply` 或生产宿主更新。
