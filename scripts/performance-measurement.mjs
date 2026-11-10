import { performance } from "node:perf_hooks";

// Shared by the synthetic regression runner and backup-based release smoke.
export function sampleSync(fn, iterations) {
  const start = performance.now(), cpu = process.cpuUsage();
  for (let i = 0; i < iterations; i++) fn();
  const used = process.cpuUsage(cpu);
  return { cpuMs: (used.user + used.system) / 1000 / iterations, wallMs: (performance.now() - start) / iterations };
}
export async function sampleAsync(fn, iterations) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  return (performance.now() - start) / iterations;
}
