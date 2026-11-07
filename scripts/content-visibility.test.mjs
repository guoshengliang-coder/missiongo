import {readFileSync} from 'node:fs';
import {strict as assert} from 'node:assert';
import {test} from 'node:test';
const read = path => readFileSync(new URL('../'+path,import.meta.url),'utf8');
test('Node and macOS ship the same final-answer visibility rule',()=>{
 const node=read('apps/node/src/prompt.ts');
 const mac=read('apps/macos/Sources/MissionGoNodeCore/LaunchPrompt.swift');
 const rule=node.match(/"(输出可见性规范 v3：[^"\n]+)"/)?.[1];
 assert.ok(rule);assert.ok(mac.includes(rule));
 for(const text of [node,mac,read('skills/missiongo/SKILL.md')]) {
  assert.ok(text.includes('final_answer'));
  assert.ok(!text.includes('最终答复只简短说明等待状态'));
  assert.ok(!text.includes('优先放在最终答复'));
 }
});
test('review and tool guidance do not treat progress or tool output as final delivery',()=>{
 const mcp=read('services/server/src/mcp.ts');
 for(const marker of ['planOutputContract: { version: 4','Web registration can precede final_answer display','Tool output alone is not final delivery','Display plan unchanged in final_answer']) assert.ok(mcp.includes(marker),marker);
 const guidance=read('services/server/src/review-content.ts');
 for(const marker of ['pending questions and options','verification gaps and deliverable links','if confirmation remains unresolved']) assert.ok(guidance.includes(marker),marker);
});

test('all generation entry points preserve structured single-item summaries',()=>{
 const node=read('apps/node/src/prompt.ts');
 const rule=node.match(/"(摘要结构规范 v1：[^"\n]+)"/)?.[1];
 assert.ok(rule);
 for(const path of ['apps/macos/Sources/MissionGoNodeCore/LaunchPrompt.swift','skills/missiongo/SKILL.md']) assert.ok(read(path).includes(rule),path);
 assert.ok(!node.includes('单条 150–300 字'));
 const mcp=read('services/server/src/mcp.ts');
 assert.ok(mcp.includes('guidance: PLAN_SUMMARY_STRUCTURE_GUIDANCE'));
 assert.ok(mcp.includes('description:PLAN_SUMMARY_STRUCTURE_GUIDANCE'));
 assert.ok(mcp.includes('max(6000).describe(PLAN_SUMMARY_STRUCTURE_GUIDANCE)'));
});
