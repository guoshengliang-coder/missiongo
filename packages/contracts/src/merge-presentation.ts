/** Read-only presentation facts. Never grants merge, recovery or release authority. */
export type IntegrationPublication = "not_required" | "pending" | "partial" | "published" | "unknown";
export interface MergeBatchPresentation {
  entries: Record<string, {
    title: string;
    itemKeys?: string[];
    summary: string;
    pullRequestUrl: string;
    requiredArtifacts: string[];
    noReleaseReason?: string | undefined;
    publication: IntegrationPublication;
    releases: { artifact: string; version: string; sourceCommit: string; checkedAt: string }[];
  }>;
}

/** Current conversation display only; historical receipts and item states stay independent. */
export type SessionDeliveryStage = "pending" | "merging" | "publishing" | "publication_unknown" | "publication_partial" | "merged" | "published" | "partial" | "blocked";

export type IntegrationActionMode = "merge_only" | "merge_and_publish" | "publish_only";
export interface IntegrationQueueFacts {
  stage: "merge" | "release" | "review" | "history";
  resolution?: "historical" | "not_required";
  review?: {scopeDigest:string;caseId?:string;sessionId?:string;createdAt?:string;closedAt?:string;closeNote?:string};
  merge?:{batchId:string;head:string;commit:string};
  releases?:{artifact:string;version:string;sourceCommit:string}[];
  blocker?: string;
  publishedArtifacts: string[];
  pendingArtifacts: string[];
  records: {itemKey:string;developmentEventId:string;roundKey:string|null;expectedRevision:number}[];
}
export interface PublicationScopeRow {
  identity:string; title:string; completion?:unknown; requiredArtifacts?:string[];
  expectedRevision?:number|string; itemKey?:string; developmentEventId?:string; roundKey?:string|null;
  deliveryId?:string; noReleaseReason?:string; selected:boolean;
}
export interface PublicationScope {
  digest:string; candidates:PublicationScopeRow[]; requiredArtifacts:string[]; blockers:string[];
  exclusions?:{identity:string;title:string;reason:string}[];
}
