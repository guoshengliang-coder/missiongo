import type { AgentSession } from "./types";
type Reports=NonNullable<AgentSession["progressReports"]>;

/** Apply a server-ordered range without moving already cached records ahead of
 * their older prefix. A live window may reset the cursor into a cached range;
 * concatenating [page, cache] would move the overlapping page to the very front.
 * beforeId is the exclusive server anchor for an older page; absent it, the
 * incoming range is the latest window. No timestamps are invented for ties. */
export function mergeProgressReports(existing:Reports,incoming:Reports,beforeId?:string):Reports {
  const boundary=beforeId===undefined?existing.length:existing.findIndex(report=>report.id===beforeId);
  const anchor=boundary<0?existing.length:boundary;
  const prefix=existing.slice(0,anchor),suffix=existing.slice(anchor);
  const indexes=new Map(prefix.map((report,index)=>[report.id,index]));
  const shared=incoming.find(report=>indexes.has(report.id));
  const split=shared?indexes.get(shared.id)!:prefix.length;
  const values=new Map([...existing,...incoming].map(report=>[report.id,report]));
  const order=new Set([...prefix.slice(0,split),...incoming,...prefix.slice(split),...suffix].map(report=>report.id));
  return [...order].map(id=>values.get(id)!);
}
