import { lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

export const PREPARATION_STAGES = ["settings", "discovery", "transfer", "validation", "compile"];
export const STAGES = [...PREPARATION_STAGES, "measurement", "cleanup"];

// Tiny, payload-free progress survives killing a synchronously blocked worker.
export function stageRecorder(directory) {
  const started = performance.now(), rows = [];
  let current;
  const save = () => {
    const temporary = join(directory, "progress.next");
    writeFileSync(temporary, JSON.stringify({ version: 1, stage: current?.name, stages: rows }), { mode: 0o600 });
    renameSync(temporary, join(directory, "progress.json"));
  };
  const finish = (status = "passed") => {
    if (current && current.status === "running") {
      current.durationMs = performance.now() - started - current.startedMs;
      current.status = status;
      save();
    }
  };
  return {
    start(name) {
      if (!STAGES.includes(name)) throw new Error("Unknown performance stage");
      finish(); current = { name, startedMs: performance.now() - started, status: "running" };
      rows.push(current); save();
    },
    finish,
    get stage() { return current?.name ?? "settings"; },
    get stages() { return structuredClone(rows); },
  };
}

export function readStageProgress(directory) {
  try {
    const bytes = readFileSync(join(directory, "progress.json"));
    if (bytes.length > 16384) return null;
    const value = JSON.parse(bytes);
    if (value.version !== 1 || !STAGES.includes(value.stage) || !Array.isArray(value.stages) || value.stages.length > 16
      || !value.stages.every(row => STAGES.includes(row.name) && Number.isFinite(row.startedMs) && row.startedMs >= 0)) return null;
    return value;
  } catch { return null; }
}

export function temporaryDataBytes(directory, limit = Infinity) {
  let bytes = 0;
  const visit = path => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      let stat;
      try { stat = lstatSync(child); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (stat.isSymbolicLink()) throw new Error("Unexpected temporary symlink");
      if (stat.isDirectory()) visit(child);
      else bytes += stat.size;
      if (bytes > limit) throw Object.assign(new Error("Temporary data limit exceeded"), { observedBytes: bytes });
    }
  };
  visit(directory); return bytes;
}
