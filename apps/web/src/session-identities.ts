export interface SessionIdentity { id:string; agentSessionId?:string; dispatchId?:string; relatedSessionIds?:readonly string[] }

/** Only explicit server associations may resolve an old route to a live row. */
export function sessionRouteIds(session: Pick<SessionIdentity, "id" | "dispatchId" | "relatedSessionIds">): string[] {
  return [...new Set([session.id, ...(session.relatedSessionIds ?? []),
    ...(session.dispatchId ? [`dispatch:${session.dispatchId}`] : [])])];
}
export interface SessionIdentityPage { sessions: SessionIdentity[] }
function membership(page: SessionIdentityPage | undefined) {
  const result=new Map<string,string>();
  for(const session of page?.sessions??[]) {
    const ids=[...new Set([...sessionRouteIds(session),...(session.agentSessionId?[session.agentSessionId]:[])])].sort();
    const signature=JSON.stringify([session.id,session.agentSessionId,ids]);
    for(const id of ids)result.set(id,signature);
  }
  return result;
}
/** Membership and canonical-channel changes affect both old and new IDs.
 * Message/activity-only list updates do not invalidate every transcript. */
export function changedSessionIdentities(before: SessionIdentityPage | undefined, after: SessionIdentityPage | undefined) {
  const old=membership(before),next=membership(after);
  return new Set([...old.keys(),...next.keys()].filter(id=>old.get(id)!==next.get(id)));
}
