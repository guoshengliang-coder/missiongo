import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";

test("installed verify entry uses only its configured verifier, never deploy or target overrides",t=>{
  const dir=mkdtempSync(join(tmpdir(),"mg-verify-entry-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const root=join(dir,"checkout"),config=join(dir,"config/missiongo"),tools=join(config,"release-tools"),bin=join(dir,"bin"),marker=join(dir,"verify.json");
  for(const p of [join(root,"scripts"),tools,bin])mkdirSync(p,{recursive:true});
  writeFileSync(join(root,"product.json"),"{}");writeFileSync(join(root,"scripts/deploy.sh"),"do not execute");
  const entry=join(dir,"missiongo-release");copyFileSync(new URL("./missiongo-release.py",import.meta.url),entry);
  copyFileSync(new URL("./release-lock.py",import.meta.url),join(tools,"release-lock.py"));
  copyFileSync(new URL("./release_coverage_options.py",import.meta.url),join(tools,"release_coverage_options.py"));
  writeFileSync(join(bin,"git"),`#!${process.execPath}\nif(process.argv.slice(2).join(' ')==='rev-parse --show-toplevel'){console.log(process.cwd());}else process.exit(77);\n`,{mode:0o700});
  writeFileSync(join(tools,"release-verify.mjs"),`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2)));\n`);
  writeFileSync(join(config,"release-local.json"),JSON.stringify({host:"documented-fixture",currentLink:"/fixture/current",downloadsDir:"/fixture/downloads",origin:"https://fixture.invalid"}));
  const run=(...args)=>spawnSync("python3",[entry,"verify",...args],{cwd:root,encoding:"utf8",env:{PATH:`${bin}:${process.env.PATH}`,XDG_CONFIG_HOME:join(dir,"config"),HOME:dir}});
  for(const option of ["--host","--skip-ci-check","--allow-dirty"]){const r=run(option,"override");assert.notEqual(r.status,0);assert.equal(existsSync(marker),false);}
  const result=run("--receipt","original.json","--candidates","full.json","--output","fresh.json");assert.equal(result.status,0,result.stderr);
  const args=JSON.parse(readFileSync(marker));assert(args.includes("documented-fixture"));assert(args.includes("/fixture/current"));assert(args.includes("original.json"));assert(!args.includes("deploy"));
});
