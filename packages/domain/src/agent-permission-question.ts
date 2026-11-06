/** Existing question-channel permission identity, including older macOS Claude cards. */
export function permissionQuestionKey(agentKind: string, sourceId: string | undefined, question: {
  readonly key?: string; readonly header?: string; readonly options?: readonly string[];
  readonly multiSelect?: boolean; readonly custom?: boolean; readonly kind?: string;
}): string | undefined {
  if (!["claude_code", "opencode"].includes(agentKind) || !question.options?.length
    || question.multiSelect || question.custom || question.kind) return undefined;
  if (question.key && /^授权请求 [^\s:]{1,200}$/.test(question.key)) return question.key;
  if (agentKind === "claude_code" && question.header === "授权请求" && sourceId?.startsWith("permission-")
    && /^[^\s:]{1,200}$/.test(sourceId.slice(11))) return `授权请求 ${sourceId.slice(11)}`;
  return undefined;
}

export function hasPendingPermissionQuestion(agentKind: string, messages: readonly {
  readonly sourceId?: string; readonly questions?: readonly {
    readonly key?: string; readonly header?: string; readonly options?: readonly string[];
    readonly multiSelect?: boolean; readonly custom?: boolean; readonly kind?: string;
    readonly answered?: string; readonly withdrawn?: boolean;
  }[];
}[]): boolean {
  return messages.some(message => message.questions?.some(question => question.answered === undefined
    && !question.withdrawn && permissionQuestionKey(agentKind, message.sourceId, question) !== undefined));
}
