import Foundation

/// The launch prompt lives on this machine, not on the server.
///
/// The server sends only item keys, the agent and the mode; what the session is
/// told to do is fixed here. That is the same boundary as the rest of the node
/// protocol (docs §20): a mistaken or compromised server can pick which items to
/// work on, but it cannot dictate instructions to an agent holding a checkout.
///
/// The business workflow is shared; client-specific workspace and plan-mode
/// instructions are supplied by each adapter.
public enum LaunchPrompt {
    public enum Client: Sendable { case claudeCode, codex, openCode }
    public enum ValidationError: Error, Equatable, LocalizedError {
        case emptyBatch
        case invalidItemKey(String)
        case invalidDispatchId(String)

        public var errorDescription: String? {
            switch self {
            case .emptyBatch:
                return "派单至少要带一个工作条目编号。"
            case let .invalidItemKey(key):
                return "不是合法的工作条目编号：\(JSONValues.quote(key))"
            case let .invalidDispatchId(id):
                return "不是合法的派单编号：\(JSONValues.quote(id))"
            }
        }
    }

    /// A work item key: product prefix plus a number, e.g. `AND-37`. The same as
    /// `^[A-Z][A-Z0-9]*-\d+$` in TypeScript, spelled with ASCII digits and `\z`
    /// because ICU's `\d` takes any Unicode digit and its `$` allows a trailing
    /// newline.
    static let itemKeyPattern = AnchoredPattern("[A-Z][A-Z0-9]*-[0-9]+")

    // The dispatch id is interpolated too, and only ever an opaque identifier.
    static let dispatchIdPattern = AnchoredPattern("[A-Za-z0-9_-]+")

    private static let researchGuidance = [
        "方案表达按复杂度组织：简单任务用短结论、改动要点、验证与授权边界；多对象或复杂任务按需分组和用表格，不强制长模板。先写推荐结论与本次审批范围，依据、文件定位和执行手续后置；每段一个主题。",
        "表格通常 2～4 列：改动用对象/变化/边界，条件用条件/行为，取舍用收益/成本与风险，验证用场景/预期结果/方法；长解释放表外。保留否定条件、兼容与权限限制，区分已核实、待复现和实施后验证。",
        "明确保留用户已定选择，特别是与推荐不同的选择；选择不等于批准。附带修复、新增范围和授权例外靠前列明。修订时先列本次变化与已有授权，再保留当前完整方案；不重复批准同一方案。",
        "向 request_plan_approval 提交的 plan/validation 必须保留已展示的结构与完整边界，不压成单段摘要；按接口限长先精简重复再展示审阅，不静默截断或改变已批准正文。计划模式中的普通进度、澄清和等待提示不是正式方案。",
        "收到开发任务后，先在已授权范围内调查代码、历史、契约、已有测试和运行证据，核对最新主线及相关部署版本；仍有可执行的调查步骤时继续，不把未批准改代码当作不能只读调研。",
        "先区分可自行查明的事实与产品取舍。只将产品偏好、风险接受、授权、外部依赖或确实无法自行取得的资料集中澄清；真正阻塞的问题及时提出，无待决问题不强凑选项。",
        "请求选择或批准前，提供已核实事实及出处、主要结论、推荐理由、备选成本与影响、剩余不确定性及验证方法；每个问题说明为何必须由用户决定。",
        "调查需要额外权限或环境时，说明具体动作与限制，单独申请调查授权；实施阶段才能验证的假设需标明并提出有边界的复现或实验计划，不冒充事实或用户决策。",
        "澄清与方案批准分开：填完选项、出现批准按钮、命令数量、耗时或自述已充分调研都不能证明调查完成。保留原有实施批准和权限边界，技术权限审查不代替方案批准。",
        "等待 CI 时先仅查询状态和结论，状态未变时适当降低频率；失败后再按需读取相关日志和错误片段。完整日志保留在本地文件或产物中，避免反复将完整任务列表和日志带回会话。",
    ]

    public static func isValidItemKey(_ key: String) -> Bool {
        return itemKeyPattern.matches(key)
    }

    /// Only item keys and the dispatch id are interpolated, and both are
    /// validated rather than escaped: these values also end up in the session
    /// name and in the process argv, so anything that is not a key has no
    /// legitimate reading and is rejected before a session starts.
    ///
    /// Plan comments are written only after approval, independently of native permissions.
    /// An explicitly selected Plan mode must be changed separately before writes.
    ///
    /// Items in `reworkItemKeys` get a paragraph saying they came back: read why
    /// on the item and start again from main, since the earlier branch was merged
    /// and removed. A rework key outside the batch is ignored, not trusted.
    public static func build(
        itemKeys: [String],
        dispatchId: String,
        mode: String? = nil,
        reworkItemKeys: [String] = [],
        client: Client = .claudeCode,
        worktreePath: String? = nil,
        freeSession: Bool = false
    ) throws -> String {
        if freeSession {
            guard itemKeys.isEmpty, dispatchIdPattern.matches(dispatchId) else {
                throw ValidationError.invalidDispatchId(dispatchId)
            }
            var lines = [
                "这是用户从 MissionGo 控制台发起的项目会话，不关联工作条目。",
                "本条是启动说明，用户首条消息将通过同一会话紧接着送达。现在只简短确认就绪，等待用户消息，不自行开始任务。",
                "后续按用户消息讨论或执行；不得自动创建、领取条目，不套用条目处理 Skill 的领取前提。",
                "本项目会话的派单身份为 \(JSONValues.quote(dispatchId))。仅当用户后来明确指定处理条目时，使用 missiongo skill 完整读取并遵守计划批准要求；领取时 claim_item 必须带 dispatchId: \(JSONValues.quote(dispatchId))，复用原项目会话，不要另行登记主动处理会话。",
                "读取并遵守当前项目规则；修改代码前创建独立 worktree，不直接修改主工作区。",
                "纯讨论查询直接答复；需求登记与条目创建按用户明确授权及创建规则执行，不要求先批准代码实施方案。开发任务先诊断澄清；需要审阅方案时给出方案和验证目标，已有明确实施授权直接沿用。用户明确指定处理工作条目时，沿用同一方案已有的人工批准，不强制再次点击按钮。所选原生权限模式、权限审批、push、merge 和发布授权仍须遵守。"
            ]
            lines += researchGuidance
            if let worktreePath { lines.append("本会话可写 worktree 路径（尚未创建）：\(JSONValues.quote(worktreePath))。遵守项目规则，不扩大到父目录。") }
            return lines.joined(separator: "\n")
        }
        if itemKeys.isEmpty {
            throw ValidationError.emptyBatch
        }
        for key in itemKeys where !itemKeyPattern.matches(key) {
            throw ValidationError.invalidItemKey(key)
        }
        if !dispatchIdPattern.matches(dispatchId) {
            throw ValidationError.invalidDispatchId(dispatchId)
        }

        var lines = [
            "使用 missiongo skill 处理这些工作条目：\(itemKeys.joined(separator: "、"))。",
            "",
            "本会话由 MissionGo 派单 \(dispatchId) 发起，上面列出的编号等同于用户给出的范围。",
            "领取时 claim_item 必须带 dispatchId: \(JSONValues.quote(dispatchId))，沿用本次派单会话；不要为本次派单另行登记主动处理会话。",
            "整批条目走一个分支和一个 PR，之后按 Skill 的规则推进条目状态。",
            "会话起在仓库主目录，动手改代码前先按仓库规则建独立 worktree，不要直接在主工作区修改。",
            "开始时先调用 get_current_account，核对 Skill 版本和本次连接的实际权限。实施前必须确认 canComment 为 true 且 writeTools 包含 claim_item；缺少权限时说明需要在哪个客户端完成授权，不得把已配置 MCP 当作拥有写权限，也不得跳过领取直接改代码。",
        ]
        lines += researchGuidance
        if client == .codex, let worktreePath {
            lines += [
                "本次 Codex 派单已为以下独立 worktree 路径配置写权限（JSON 字符串）：\(JSONValues.quote(worktreePath))。路径尚未创建。",
                "领取之后，先核对仓库规则；规则允许时在该精确路径用 git worktree add 创建独立分支，并在其中工作。路径已存在时先核实归属和未提交改动，不覆盖、不清理。",
                "如果仓库规则要求其他位置，先申请该精确目录的会话级写权限，确认生效后再修改；仅 cd 到目录不会改变沙箱。不要扩大到仓库父目录。",
            ]
        }
        let rework = itemKeys.filter { reworkItemKeys.contains($0) }
        if !rework.isEmpty {
            lines += [
                "",
                "其中 \(rework.joined(separator: "、")) 是返工：之前交付过，验证没有通过或完成后又被重新打开。先读条目时间线里最近一次退回的说明、评论和上一轮的 PR，弄清哪里没做好再动手。",
                "上一轮的分支通常已经合并并删除，从最新的 main 另开分支，不复用上一轮的分支和 worktree。",
            ]
        }
        do {
            lines += [
                "",
                "先完整读取条目并调查可核查事实，再集中澄清必要取舍。需要审阅方案时提出有依据的计划；同一方案与范围只批准一次，原生或 MissionGo 任一入口的明确人工批准均有效。",
                "领取记录任务归属，不要求方案批准或原生模式已生效；领取不等于获准实施。已有明确实施授权直接沿用，未获准实施的方案先等待批准。",
                "用户批准之后，将已批准的计划以结构化评论写到各条条目，在独立 worktree 中实施。原生批准由原生流程继续，Web 批准最多续办一次；新回合、权限变化或更换入口不重复要求批准。权限审查不代替方案批准。",
            ]
            if client == .claudeCode {
                lines.append("Claude Code 按所选原生权限模式从第一轮运行；方案审批不切换权限。仅当明确选择了原生 Plan 时，实施前才需另行退出 Plan；权限可写不代表方案已批准。")
            } else if client == .codex {
                lines.append("Codex 的自动审查仅处理技术权限请求；仍须等待用户明确批准方案后才能实施。")
            } else {
                lines.append("OpenCode 按所选原生 agent 从第一轮运行；方案审批不切换 agent。仅当明确选择了原生 plan 时，实施前才需另行切换 build；Build 不代表方案已批准。")
            }
        }
        return lines.joined(separator: "\n")
    }
}
