/** Local launcher evidence, authenticated by the owning node. This is not a
 * human approval, an acceptance decision, or a claim of model independence. */
export interface DevelopmentReviewEvidence {
  version: 1;
  taskId: string;
  agentKind: "codex" | "claude_code" | "opencode";
  sessionRef: string;
  requestId: string;
  scopeDigest: string;
  revision: number;
  generation: number;
  status: string;
  round: number;
  base: string;
  repository?: string;
  candidateDigest?: string;
  checksPassed: boolean;
  blockingFindings: number;
  limitations: string[];
  findings?: {id:string;severity:"blocking"|"advisory";path:string;trigger:string;expected:string;actual:string;evidence:string;validation:string}[];
  checks?: {name:string;method:string;result:"passed"|"failed"|"not_run";evidence:string}[];
  requiredChecks?: string[];
  reviewer?: { sessionRef: string; model: string; provider: string; readOnly: boolean };
  proof?: { checkedAt: string; head: string; base: string; candidateDigest: string; clean: boolean; valid: boolean };
}
