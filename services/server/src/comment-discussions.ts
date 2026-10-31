import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CommentAudienceInput, CommentCandidate, CommentMention } from "@missiongo/domain";
import type { MissionGoStore } from "./store.js";
import type { WorkItemCommentSnapshot } from "./types.js";
import { AccountStore } from "./accounts-store.js";
import { invalidInput, notFound } from "./errors.js";

export const commentAudienceSchema = z.object({
  replyToCommentId: z.string().uuid().optional(),
  mentionAccountIds: z.array(z.string().min(1).max(200)).max(100).optional(),
  mentionTargets: z.array(z.enum(["proposer", "builder", "all"])).max(3).optional(),
});

/** Item-scoped directory: no global account directory or DingTalk IDs are exposed. */
export function commentCandidates(store: MissionGoStore, itemKey: string): CommentCandidate[] {
  const item = store.getWorkItem(itemKey), accounts = new AccountStore(store.database);
  const proposer = item.createdBy && item.createdBy.kind !== "sdk" ? item.createdBy.accountId : undefined;
  const eligible = accounts.listAccounts().filter(account => !account.disabledAt && accounts.allows(account,item.productId,"view"));
  const names = accounts.displayNames(eligible.map(account => account.id));
  return eligible.map(account => ({accountId:account.id,name:names.get(account.id) ?? account.email,
    isProposer:account.id === proposer,isBuilder:account.id === item.builderAccountId}));
}

export function resolveCommentAudience(store: MissionGoStore, itemKey: string, raw: CommentAudienceInput): {
  mentions: CommentMention[]; parent?: WorkItemCommentSnapshot; threadRootCommentId?: string;
} {
  const parsed = commentAudienceSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput("评论回复或 @ 接收人格式无效。");
  const input = parsed.data;
  const candidates = commentCandidates(store,itemKey);
  const ids = new Set(input.mentionAccountIds ?? []);
  for (const id of ids) if (!candidates.some(candidate => candidate.accountId === id)) throw invalidInput("@ 接收人已停用或没有本项目查看权限，请重新选择。");
  for (const target of input.mentionTargets ?? []) {
    for (const candidate of candidates) {
      if ((target === "all" || target === "proposer") && candidate.isProposer
        || (target === "all" || target === "builder") && candidate.isBuilder) ids.add(candidate.accountId);
    }
  }
  const mentions = candidates.filter(candidate => ids.has(candidate.accountId)).map(({accountId,name}) => ({accountId,name}));
  if (!input.replyToCommentId) return {mentions};
  const parent = store.listComments(itemKey,{includeWithdrawn:true}).find(comment => comment.id === input.replyToCommentId);
  if (!parent) throw notFound("Reply comment in this item");
  if (parent.withdrawnAt) throw invalidInput("这条评论已撤回，请选择其他评论回复。");
  return {mentions,parent,threadRootCommentId:parent.threadRootCommentId ?? parent.id};
}

/** Runs in the comment's transaction. Notifications are independent of verification switches. */
export function enqueueCommentNotifications(store: MissionGoStore, comment: WorkItemCommentSnapshot, parent?: WorkItemCommentSnapshot): void {
  const item = store.getWorkItem(comment.itemKey);
  const audience = new Set((comment.mentions ?? []).map(mention => mention.accountId));
  if (parent?.accountId) audience.add(parent.accountId);
  if (comment.accountId) audience.delete(comment.accountId);
  const insert = store.database.connection.prepare(`INSERT INTO dingtalk_notifications
    (id,item_id,comment_id,account_id,kind,status,next_at,created_at,updated_at)
    VALUES (?,?,?,?,'comment','queued',?,?,?)`);
  for (const accountId of audience) insert.run(randomUUID(),item.id,comment.id,accountId,comment.createdAt,comment.createdAt,comment.createdAt);
}
