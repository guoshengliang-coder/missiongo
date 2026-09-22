#!/usr/bin/env node
import { pathToFileURL } from "node:url";

export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

export async function probe(origin, { samples = 10, timeoutMs = 8_000 } = {}) {
  const target = new URL("/health", origin);
  const results = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
      results.push({
        ok: response.ok,
        status: response.status,
        milliseconds: Math.round(performance.now() - started),
        ray: response.headers.get("cf-ray"),
      });
    } catch (error) {
      results.push({ ok: false, milliseconds: Math.round(performance.now() - started), error: String(error) });
    }
  }
  const successful = results.filter((result) => result.ok);
  const timings = successful.map((result) => result.milliseconds);
  const colos = [...new Set(successful.map((result) => result.ray?.split("-").at(-1)).filter(Boolean))];
  return {
    origin: new URL(origin).origin,
    endpoint: target.pathname,
    samples,
    success: successful.length,
    errors: samples - successful.length,
    p50Milliseconds: percentile(timings, 0.5),
    p95Milliseconds: percentile(timings, 0.95),
    cloudflareColos: colos,
    results,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.argv[2];
  if (!origin) {
    console.error("Usage: node scripts/probe-public-origin.mjs https://gray.example.com [samples]");
    process.exitCode = 2;
  } else {
    const samples = Number.parseInt(process.argv[3] ?? "10", 10);
    const report = await probe(origin, { samples: Number.isFinite(samples) && samples > 0 ? samples : 10 });
    console.log(JSON.stringify(report, null, 2));
    if (report.errors > 0) process.exitCode = 1;
  }
}
