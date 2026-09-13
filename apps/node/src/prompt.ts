/**
 * The launch prompt lives on this machine, not on the server.
 *
 * The server sends only item keys, the agent and the mode; what the session is
 * told to do is fixed here. That is the same boundary as the rest of the node
 * protocol (docs §20): a mistaken or compromised server can pick which items to
 * work on, but it cannot dictate instructions to an agent holding a checkout.
 */

/** A work item key: product prefix plus a number, e.g. `AND-37`. */
export const ITEM_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

// The dispatch id is interpolated too, and only ever an opaque identifier.
const DISPATCH_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type LaunchPromptInput = {
  itemKeys: readonly string[];
  dispatchId: string;
};

/**
 * Only item keys and the dispatch id are interpolated, and both are validated
 * rather than escaped: these values also end up in the session name and in the
 * process argv, so anything that is not a key has no legitimate reading and is
 * rejected before a session starts.
 */
export function buildLaunchPrompt(input: LaunchPromptInput): string {
  if (input.itemKeys.length === 0) {
    throw new Error("派单至少要带一个工作条目编号。");
  }
  for (const key of input.itemKeys) {
    if (!ITEM_KEY_PATTERN.test(key)) {
      throw new Error(`不是合法的工作条目编号：${JSON.stringify(key)}`);
    }
  }
  if (!DISPATCH_ID_PATTERN.test(input.dispatchId)) {
    throw new Error(`不是合法的派单编号：${JSON.stringify(input.dispatchId)}`);
  }

  return [
    `使用 missiongo skill 处理这些工作条目：${input.itemKeys.join("、")}。`,
    "",
    `本会话由 MissionGo 派单 ${input.dispatchId} 发起，上面列出的编号等同于用户给出的范围。`,
    "整批条目走一个分支和一个 PR，之后按 Skill 的规则推进条目状态。",
    "会话起在仓库主目录，动手改代码前先按仓库规则建独立 worktree，不要直接在主工作区修改。",
  ].join("\n");
}
