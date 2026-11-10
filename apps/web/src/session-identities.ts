interface SessionIdentity { id:string; agentSessionId?:string; relatedSessionIds?:string[] }
export interface SessionIdentityPage { sessions: SessionIdentity[] }
function membership(page: SessionIdentityPage | undefined) {
  const result=new Map<string,string>();
  for(const session of page?.sessions??[]) {
    const ids=[...new Set([session.id,...(session.agentSessionId?[session.agentSessionId]:[]),...(session.relatedSessionIds??[])])].sort();
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
