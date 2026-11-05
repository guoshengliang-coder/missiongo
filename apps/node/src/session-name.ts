import type { Dispatch } from "./types.js";

/** Only new project sessions carry title metadata; older jobs keep their original naming. */
export function sessionName(job: Dispatch): string {
  const machine = job.nodeName?.trim() || "Linux";
  const title = job.freeSession && job.sessionTitle?.trim();
  return `${machine}-${title || (job.itemKeys.length ? job.itemKeys.join(",") : "新会话")}`;
}
