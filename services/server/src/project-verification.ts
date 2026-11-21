import { conflict } from "./errors.js";
import { z } from "zod";
import { projectCheckSatisfied } from "@missiongo/contracts";
const text = z.string().trim().min(1).max(4000);
export const projectVerificationSchema = z.object({
  repository: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/),
  targetBranch: z.string().regex(/^[\w][\w./-]{0,150}$/),
  rulesSource: text, rulesDigest: z.string().regex(/^[a-f0-9]{64}$/),
  ci: z.enum(["required", "not_required"]), local: z.enum(["required", "not_required"]), reason: text,
  platformRead: z.literal("complete"),
  requiredChecks: z.array(text).max(200), observedChecks: z.array(text).max(200),
  autoMerge: z.boolean(), protectedChecks: z.boolean(), mergeMethod: z.enum(["merge", "squash", "rebase", "queue"]),
}).strict();
export const projectCheckStateSchema = z.enum(["passed", "pending", "failed", "unknown", "not_applicable"]);
export function validateProjectChecks(value: {checks: string; local?: string | undefined; verification?: z.infer<typeof projectVerificationSchema> | undefined}, ctx: z.RefinementCtx) {
  if (value.verification && value.checks === "passed" && value.verification.requiredChecks.some(name=>!value.verification!.observedChecks.includes(name)))
    ctx.addIssue({code:"custom",message:"Required checks are missing from observed results",path:["checks"]});
  for (const local of [false, true]) {
    const status = local ? value.local : value.checks;
    if (status === "not_applicable" && !projectCheckSatisfied(status, value.verification, local))
      ctx.addIssue({code: "custom", message: "Not-applicable checks require verified project rules and complete platform evidence", path: [local ? "local" : "checks"]});
  }
}
export function assertProjectBinding(verification: z.infer<typeof projectVerificationSchema> | undefined, repository: string, targetBranch: string) {
  if (verification && (verification.repository !== repository || verification.targetBranch !== targetBranch))
    throw conflict("merge_delivery_changed", "项目验证证据的仓库或目标分支与交付不一致，请重新核实。");
}
