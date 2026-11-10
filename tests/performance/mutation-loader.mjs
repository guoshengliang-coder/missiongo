import { registerHooks } from "node:module";
import assert from "node:assert/strict";

// Explicit diagnostic invocation only. Changes loaded code in this process;
// never edits production source or compiled files. Not a normal benchmark run.
const mutation = process.env.PERFORMANCE_MUTATION;
assert.ok(["fivefold", "historical", "scheduling", "release-fivefold-merge-deliveries", "release-fivefold-item-list", "release-fivefold-claim-next"].includes(mutation), "Select an explicit diagnostic mutation");
function replace(source, before, after) {
  assert.ok(source.includes(before), "Mutation no longer matches implementation; review the experiment");
  return source.replace(before, after);
}
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  let source;
  if (mutation === "fivefold" && url.endsWith("/tests/performance/server-fixture.mjs")) {
    source = String(loaded.source);
    source = replace(source, '"merge-deliveries": mergeProjection', '"merge-deliveries": () => { let result; for(let i=0;i<5;i++) result=mergeProjection(); return result; }');
    source = replace(source, '"item-list": list', '"item-list": () => { let result; for(let i=0;i<5;i++) result=list(); return result; }');
    source = replace(source, '"item-summary": () => store.getWorkItemListSummary({ productId: product.id })',
      '"item-summary": () => { let result; for(let i=0;i<5;i++) result=store.getWorkItemListSummary({ productId: product.id }); return result; }');
  }
  if (mutation === "scheduling" && url.endsWith("/tests/performance/server-fixture.mjs")) {
    source = replace(String(loaded.source), '"merge-deliveries": mergeProjection',
      '"merge-deliveries": () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500); return mergeProjection(); }');
  }
  if (mutation === "historical" && url.endsWith("/services/server/dist/merge-deliveries.js")) {
    source = replace(String(loaded.source), "const presentation = presentationOf(b);", "const presentation = this.presentation(b);");
  }
  if (mutation === "historical" && url.endsWith("/services/server/dist/store.js")) {
    source = replace(String(loaded.source), "this.getDevelopmentEvidence(itemKey, event.id, events)", "this.getDevelopmentEvidence(itemKey, event.id)");
    source = replace(source, "this.getDevelopmentReleaseDecision(itemKey, event.id, events)", "this.getDevelopmentReleaseDecision(itemKey, event.id)");
  }
  if (mutation?.startsWith("release-fivefold-") && url.endsWith("/scripts/release-performance-measure.mjs")) {
    const target = mutation.slice("release-fivefold-".length);
    source = String(loaded.source);
    source = replace(source, '    // CPU is the independent machine baseline;', `    const repeated = routes[${JSON.stringify(target)}];
    routes[${JSON.stringify(target)}] = async () => { for (let i = 0; i < 5; i++) await repeated(); };
    // CPU is the independent machine baseline;`);
    if (target !== "claim-next") source = replace(source,
      '    const baseline = () => store.getProduct(productId);',
      `    const original = targets[${JSON.stringify(target)}];
    targets[${JSON.stringify(target)}] = () => { for (let i = 0; i < 5; i++) original(); };
    const baseline = () => store.getProduct(productId);`);
  }
  return source === undefined ? loaded : { ...loaded, source };
} });
