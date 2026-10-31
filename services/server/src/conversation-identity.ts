export interface ConversationIdentity {
  id: string;
  agent: string;
  ref: string | null;
  node: string | null;
  isolated?: boolean | number;
}

/** Use the same native-identity boundary for display and automatic archiving. */
export function conversationIdentityGroups<T extends ConversationIdentity>(identities: readonly T[]): T[][] {
  const nodes = new Map<string, Set<string>>();
  for (const identity of identities) {
    if (!identity.ref || identity.isolated) continue;
    const key = JSON.stringify([identity.agent, identity.ref]);
    if (identity.node) nodes.set(key, new Set([...(nodes.get(key) ?? []), identity.node]));
  }
  const groups = new Map<string, T[]>();
  for (const identity of identities) {
    const nativeKey = JSON.stringify([identity.agent, identity.ref]);
    const knownNodes = nodes.get(nativeKey) ?? new Set<string>();
    const node = identity.node ?? (knownNodes.size === 1 ? [...knownNodes][0] : null);
    // An unbound ID cannot pick between different nodes carrying that ID.
    const key = !identity.ref || identity.isolated || (!identity.node && knownNodes.size > 1)
      ? identity.id : JSON.stringify([nativeKey, node]);
    groups.set(key, [...(groups.get(key) ?? []), identity]);
  }
  return [...groups.values()];
}
