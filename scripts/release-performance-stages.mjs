import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;

export const PREPARATION_STAGES = ["settings", "discovery", "transfer", "validation", "compile"];
export const STAGES = [...PREPARATION_STAGES, "measurement", "cleanup"];

// Tiny, payload-free progress survives killing a synchronously blocked worker.
export function stageRecorder(directory, { now = monotonicMs } = {}) {
  const started = now(), rows = [];
  let current;
  const save = () => {
    const temporary = join(directory, "progress.next");
    writeFileSync(temporary, JSON.stringify({ version: 2, startedMonotonicMs: started, stage: current?.name, stages: rows }), { mode: 0o600 });
    renameSync(temporary, join(directory, "progress.json"));
  };
  const finish = (status = "passed") => {
    if (current && current.status === "running") {
      current.durationMs = now() - started - current.startedMs;
      current.status = status;
      save();
    }
  };
  return {
    start(name) {
      if (!STAGES.includes(name)) throw new Error("Unknown performance stage");
      finish(); current = { name, startedMs: now() - started, status: "running" };
      rows.push(current); save();
    },
    finish,
    get stage() { return current?.name ?? "settings"; },
    get stages() { return structuredClone(rows); },
  };
}

export function readStageProgress(directory) {
  let fd;
  try {
    // Inspect the opened regular file and read at most one bounded record. A
    // FIFO/symlink or oversized report must not stall the supervising process.
    fd = openSync(join(directory, "progress.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) return null;
    const bytes = Buffer.alloc(16385);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 16384) return null;
    const value = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (value.version !== 2 || !Number.isFinite(value.startedMonotonicMs) || value.startedMonotonicMs < 0
      || !STAGES.includes(value.stage) || !Array.isArray(value.stages) || !value.stages.length || value.stages.length > STAGES.length
      || value.stage !== value.stages.at(-1).name || new Set(value.stages.map(row => row.name)).size !== value.stages.length
      || !value.stages.every((row, i) => STAGES.includes(row.name) && Number.isFinite(row.startedMs) && row.startedMs >= 0
        && (!i || row.startedMs >= value.stages[i - 1].startedMs
          && (value.stages[i - 1].status === "running" || row.startedMs + 0.001 >= value.stages[i - 1].startedMs + value.stages[i - 1].durationMs)) && ["running", "passed", "failed"].includes(row.status)
        && (row.status === "running" || Number.isFinite(row.durationMs) && row.durationMs >= 0))) return null;
    return value;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

export function completeMeasurementProgress(progress, { allowFailedMeasurement = false } = {}) {
  const expected = [...PREPARATION_STAGES, "measurement"];
  return progress?.stage === "measurement" && progress.stages.length === expected.length
    && progress.stages.every((row, i) => row.name === expected[i] && (row.status === "passed" || allowFailedMeasurement && row.name === "measurement" && row.status === "failed"));
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
