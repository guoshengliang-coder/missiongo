import {expect,it,vi} from "vitest";
import {catchUpStoredHistory} from "./agent-history-catchup";
import type {AgentSessionMessage} from "./types";
const message=(id:string):AgentSessionMessage=>({id,sourceId:id,role:"agent",text:id,occurredAt:"2026-11-09T02:00:00Z"});
it("fills a reconnect gap across stored pages without duplicating the displayed frontier",async()=>{
 const read=vi.fn().mockResolvedValueOnce({status:"ready",messages:[message("3"),message("4")],nextCursor:"stored:3"})
  .mockResolvedValueOnce({status:"ready",messages:[message("1"),message("2")],nextCursor:"source:not-requested"});
 expect((await catchUpStoredHistory("stored:5","agent:2",read)).map(m=>m.id)).toEqual(["3","4"]);
 expect(read.mock.calls.map(call=>call[0])).toEqual(["stored:5","stored:3"]);
});
it("never auto-requests unknown source history and rejects cycles or missing frontiers",async()=>{
 const read=vi.fn().mockResolvedValue({status:"ready",messages:[message("3")],nextCursor:"source:private"});
 await expect(catchUpStoredHistory("stored:4","agent:2",read)).rejects.toThrow();expect(read).toHaveBeenCalledOnce();
 read.mockResolvedValue({status:"ready",messages:[],nextCursor:"stored:4"});
 await expect(catchUpStoredHistory("stored:4","agent:2",read)).rejects.toThrow();
});
