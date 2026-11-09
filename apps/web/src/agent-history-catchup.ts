import type { AgentHistoryPage, AgentSessionMessage } from "./types";
export const historyMessageKey=(message:AgentSessionMessage)=>`${message.role}:${message.sourceId||message.id}`;
/** Fill only a gap after an already displayed frontier. Never request unknown
 * source history automatically; stored cursors read server-held messages only. */
export async function catchUpStoredHistory(cursor:string|undefined,frontier:string,
 load:(cursor:string)=>Promise<AgentHistoryPage>):Promise<readonly AgentSessionMessage[]> {
 let next=cursor;const pages: (readonly AgentSessionMessage[])[]=[];const visited=new Set<string>();
 while(next?.startsWith("stored:")&&!visited.has(next)) {
  visited.add(next);
  const page=await load(next);
  if(page.status!=="ready")throw new Error("Stored history unavailable");
  const boundary=page.messages.findIndex(message=>historyMessageKey(message)===frontier);
  pages.push(page.messages.slice(boundary<0?0:boundary+1));
  if(boundary>=0)return pages.reverse().flat();
  next=page.nextCursor;
 }
 throw new Error("The displayed history frontier could not be recovered");
}
