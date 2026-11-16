# macOS CI runner

`macos-build` 固定使用标准托管标签 `macos-15-intel`。GitHub 当前将 `macos-15` 指向 arm64；2026-11-16 的主线构建在分配 runner 前被 abandoned，定向重跑再次未能开始，任务注释明确指出 ARM 托管容量不足。

官方标签说明：https://docs.github.com/en/actions/reference/runners/github-hosted-runners

保留现有全部 Swift 测试、watchdog、步骤与任务超时、诊断和 required-check 聚合，不接受 cancelled/abandoned 结果。原应用构建仍通过 `--arch arm64 --arch x86_64` 生成通用产物；Swift 缓存键包含架构、系统、编译器和 SDK，Intel 与 ARM 缓存保持隔离。

该选择改变云端原生测试的执行架构。ARM 原生运行结果须作为独立证据记录，不能从 Intel CI 或双架构编译推断；本次集成补充本机 ARM 的完整 Swift 测试。真实 GUI、跨版本安装与签名升级仍按各交付原有验证范围处理。该修复不发布或安装 macOS 客户端，也不配置付费 larger runner。

Intel 执行还暴露更新状态布局测试的宽度断言失败：浅色主题首次窄窗文档宽 390、可用区宽 375，而后续深色主题可正确收缩。单独显式 tiling 的一轮 CI 仍失败，本机 macOS 26 未复现原失败。测试在 tiling、layout、display 后允许原生渲染周期继续执行，等待宽度收敛最多一秒，再执行原断言；显式覆盖 legacy/overlay，保留原文档宽度、窗口尺寸和滚动可达性要求。前后几何记录用于 macOS 15 CI 核实，若仍不收敛则继续失败，不能据本机通过宣称该平台问题已解决。产品视图与字号不因该测试补修改变。
