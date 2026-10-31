/** Symbolic recipients are resolved by the server at comment creation time. */
export type CommentMentionTarget = "proposer" | "builder" | "all";
export interface CommentAudienceInput {
  readonly replyToCommentId?: string | undefined;
  readonly mentionAccountIds?: readonly string[] | undefined;
  readonly mentionTargets?: readonly CommentMentionTarget[] | undefined;
}
export interface CommentMention {
  readonly accountId: string;
  readonly name: string;
}
export interface CommentDiscussion {
  readonly replyToCommentId?: string | undefined;
  readonly threadRootCommentId?: string;
  readonly mentions?: readonly CommentMention[];
}
export interface CommentCandidate extends CommentMention {
  readonly isProposer: boolean;
  readonly isBuilder: boolean;
}
