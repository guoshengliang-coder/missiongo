#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const cell=value=>String(value??"—").replaceAll("|","\\|").replace(/[\r\n]/g," ");
export function renderPerformanceReport(report) {
 if(!report||!Array.isArray(report.rows)||report.rows.length>30000||!Array.isArray(report.coverage))throw new Error("Invalid bounded performance report");
 const rows=report.rows;
 const count=stage=>rows.filter(r=>r.stage===stage).reduce((n,r)=>n+r.n,0);
 const waits=rows.filter(r=>r.timed>0&&Number.isFinite(r.total)).sort((a,b)=>b.total/b.timed-a.total/a.timed).slice(0,5);
 const times=report.coverage.map(c=>c.minute).filter(Number.isFinite).sort((a,b)=>a-b);
 const format=value=>Number.isFinite(value)?new Date(value).toISOString():"未覆盖";
 return `# 控制台性能基线\n\n来源：${cell(report.source??"unknown")}；仅 production 来源可用于生产基线。\n\n请求区间：${format(report.from)} 至 ${format(report.to)}（UTC）。\n实际服务端采集覆盖：${format(times[0])} 至 ${format(times.at(-1))}。空档分钟：${cell(report.gapMinutes)}。\n24小时连续采集：${report.coverageComplete?"覆盖时间满足；仍需核对节点、客户端缺失与真机证据":"尚未满足"}。\n\n逻辑发送启动：${count("send_started")}；服务端接受：${count("logical_accepted")}；HTTP尝试：${count("http_attempt")}。三项分母不同，不相加。\n\n| 作用域 | 来源／Agent／类型 | 版本 | 阶段／结果 | 样本／计时 | 中位上界ms | P95上界ms | 范围ms |\n|---|---|---|---|---|---|---|---|\n${rows.map(r=>`| ${cell((r.products??[]).join(",")||"账号私有")} | ${cell(r.source)}/${cell(r.agent)}/${cell(r.kind)} | ${cell(r.version)} | ${cell(r.stage)}/${cell(r.result)} | ${cell(r.n)}/${cell(r.timed)} | ${cell(r.p50UpperBoundMs)} | ${r.timed>=100?cell(r.p95UpperBoundMs):"不足100，不作稳定结论"} | ${cell(r.lo)}–${cell(r.hi)} |`).join("\n")}\n\n## 观测时间最长的区间\n\n${waits.length?waits.map(r=>`- ${cell(r.source)} / ${cell(r.agent)} / ${cell(r.version)} / ${cell(r.stage)}：平均 ${(r.total/r.timed).toFixed(2)}ms，计时样本 ${r.timed}。`).join("\n"):"暂无有效计时样本。"}\n\n这些区间可能重叠，不能相加；各版本及缺失覆盖不同，排序仅为诊断线索，不直接证明瓶颈根因。\n\n## 覆盖与限制\n\n- 业务有样本桶：${cell(report.businessSampleBuckets?.length)}；没有业务样本不代表采集故障。服务器心跳不证明所有客户端在线。\n- 待结算服务端观察：${cell(report.pendingObservations)}；缺失记录：${count("missing")}。旧节点及无法关联回合不能填0耗时。\n- 持久采集入口的已知丢弃尝试：${cell(report.knownDropRate?.numerator)} / ${cell(report.knownDropRate?.denominator)}；上游已知丢弃：${cell(report.status?.knownDroppedSinceProcessStart)}（当前进程范围）。全体客户端丢失分母不可知，不能报告零丢失或伪造百分比。\n- ${report.status?.degraded?"采集器受损，结果不完整。":"采集状态以报告快照为准。"} ${report.truncated?"结果被截断，不能宣称完整。":""}\n- 分位数是固定直方图上界近似；至少100个相同版本、Agent、类型、阶段样本才显示P95，仍不保证统计稳定。\n- 不同设备时钟不相减，重叠区间不相加；Agent首输出包括宿主、提供方及模型等待，模型内部耗时不可观测。\n- 首次显示近似下一次绘制机会；隐藏、挂起、关闭及采集失败需要单列。非5分钟对齐窗口含边界桶近似：${Boolean(report.bucketBoundaryApproximation)}。\n- 真实24小时基线、弱网及前后台真机验证须在获准发布后完成，测试数据不能冒充生产。\n`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [input,output]=process.argv.slice(2);if(!input||!output)throw new Error("Usage: node scripts/console-performance-report.mjs <authorized-report.json> <report.md>");
 const raw=readFileSync(input);if(raw.length>20*1024*1024)throw new Error("Report input exceeds 20 MiB");
 writeFileSync(output,renderPerformanceReport(JSON.parse(raw.toString("utf8"))));
}
