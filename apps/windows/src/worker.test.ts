import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API } from "../../node/src/api.js";
import { loadConfig, saveConfig } from "../../node/src/storage.js";

const temporary=realpathSync(mkdtempSync(join(tmpdir(),"mg-worker-test-"))),root=join(temporary,"state");
let handle:typeof import("./worker.js").handleDesktopRequest;
beforeAll(async()=>{
  vi.stubEnv("MISSIONGO_NODE_HOME",root);
  handle=(await import("./worker.js")).handleDesktopRequest;
});
beforeEach(()=>saveConfig(root,{installationId:"fixture",server:"https://missiongo.example.com",token:"synthetic-original",nodeId:"original",name:"original",agents:{}}));
afterEach(()=>vi.restoreAllMocks());
afterAll(()=>{vi.unstubAllEnvs();rmSync(temporary,{recursive:true,force:true});});

it.each(["logout","replacement"])("does not restore stale credentials when rename completes after %s",async(action)=>{
  let finish!:()=>void;
  vi.spyOn(API.prototype,"call").mockImplementation(()=>new Promise(resolve=>{finish=()=>resolve({});}));
  const pending=handle({method:"rename",name:"late name"});
  if(action === "logout")await handle({method:"logout"});
  else saveConfig(root,{...loadConfig(root),token:"synthetic-new",nodeId:"replacement",name:"replacement",agents:{codex:{}}});
  finish();
  await expect(pending).rejects.toThrow("登录状态已变化");
  const current=loadConfig(root);
  expect(current.token).toBe(action === "logout" ? undefined:"synthetic-new");
  if(action === "replacement")expect(current).toMatchObject({nodeId:"replacement",name:"replacement",agents:{codex:{}}});
},30_000);

it("saves a confirmed rename without replacing configuration edited while the request was pending",async()=>{
  let finish!:()=>void;
  vi.spyOn(API.prototype,"call").mockImplementation(()=>new Promise(resolve=>{finish=()=>resolve({});}));
  const pending=handle({method:"rename",name:"confirmed"});
  saveConfig(root,{...loadConfig(root),agents:{codex:{}},managedExecutionEnabled:true});
  finish();await pending;
  expect(loadConfig(root)).toMatchObject({name:"confirmed",agents:{codex:{}},managedExecutionEnabled:true});
},30_000);
