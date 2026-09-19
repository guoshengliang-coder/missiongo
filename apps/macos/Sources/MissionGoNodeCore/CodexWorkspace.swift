import Foundation

/// Reserve a single sibling path without creating a directory or Git branch.
/// The full dispatch id prevents concurrent batches and rework sharing a tree.
public enum CodexWorkspace {
    public static func worktreePath(repoPath: String, dispatchId: String) throws -> String {
        guard LaunchPrompt.dispatchIdPattern.matches(dispatchId), dispatchId.utf8.count <= 100 else {
            throw LaunchPrompt.ValidationError.invalidDispatchId(dispatchId)
        }
        guard Paths.isAbsolute(repoPath) else { throw LaunchError("仓库路径必须是绝对路径。") }
        let repo = URL(fileURLWithPath: repoPath).standardizedFileURL.resolvingSymlinksInPath()
        guard repo.path != "/" else { throw LaunchError("不能把文件系统根目录作为派单仓库。") }
        let path = repo.deletingLastPathComponent().appendingPathComponent("missiongo-\(dispatchId)").path
        guard path != repo.path else { throw LaunchError("独立 worktree 不能与主仓库相同。") }
        // Existing paths may contain someone else's work or resolve through a
        // symlink. Never grant them access merely because their name matches.
        if (try? FileManager.default.attributesOfItem(atPath: path)) != nil {
            throw LaunchError("派单 worktree 路径已存在：\(path)。请核对已有任务与修改，不会覆盖或清理该目录。")
        }
        return path
    }
}
