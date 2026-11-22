import {expect, test} from "vitest";
import {readinessIsCurrent, writerFailure} from "./agent-writer-recovery";
import type {AgentSession, AgentSessionCommand} from "./types";
const command = {kind:"message",status:"failed",createdAt:"2026-11-22T01:00:00Z",error:"Codex 拒绝 thread/resume: already has an active writer"} as AgentSessionCommand;
const request="2026-11-22T01:01:00.200Z",now=Date.parse("2026-11-22T01:01:01Z");
const session={status:"idle",canReply:true,turnState:{replyReadiness:{state:"ready",checkedAt:"2026-11-22T01:01:00.500Z"}}} as AgentSession;
test("only definite failed sends receive writer recovery, never ambiguous delivery",()=>{
 expect(writerFailure(command)).toBe(true);
 expect(writerFailure({...command,status:"delivery_unknown"})).toBe(false);
 expect(writerFailure({...command,kind:"interrupt"})).toBe(false);
 expect(writerFailure({...command,error:"connection closed"})).toBe(false);
});
test("idle status alone cannot prove write readiness",()=>{
 expect(readinessIsCurrent({...session,turnState:{}},command,request,now)).toBe(false);
 expect(readinessIsCurrent(session,command,request,now)).toBe(true);
 for(const state of ["occupied","unknown"] as const)expect(readinessIsCurrent({...session,turnState:{replyReadiness:{state,checkedAt:request}}},command,request,now)).toBe(false);
});
test("checks must be fresh, after the request, bound to an allowed idle session",()=>{
 for(const checkedAt of ["2026-11-22T01:00:59Z","2026-11-22T01:02:00Z"])expect(readinessIsCurrent({...session,turnState:{replyReadiness:{state:"ready",checkedAt}}},command,request,now)).toBe(false);
 expect(readinessIsCurrent(session,command,request,now+30_000)).toBe(false);
 expect(readinessIsCurrent({...session,canReply:false},command,request,now)).toBe(false);
 expect(readinessIsCurrent({...session,status:"unavailable"},command,request,now)).toBe(false);
 expect(readinessIsCurrent({...session,archivedAt:request},command,request,now)).toBe(false);
 expect(readinessIsCurrent({...session,turnState:{...session.turnState,turnActive:true}},command,request,now)).toBe(false);
});
