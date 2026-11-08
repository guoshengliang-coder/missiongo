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
