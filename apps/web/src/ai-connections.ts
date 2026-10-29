import type { AiAuthorization } from "./api";

export interface AiConnectionGroup {
  readonly key: string;
  readonly kind: "oauth" | "pat";
  readonly name?: string | undefined;
  readonly authorizations: AiAuthorization[];
  readonly lastUsedAt?: string | undefined;
  /** Undefined when the connections grant different permissions. */
  readonly scopes?: readonly string[] | undefined;
}

const recency = (authorization: AiAuthorization) =>
  Date.parse(authorization.lastUsedAt ?? authorization.issuedAt);

/** Group display names, while keeping every credential independently revocable. */
export function groupAiConnections(authorizations: readonly AiAuthorization[]): AiConnectionGroup[] {
  const groups = new Map<string, AiAuthorization[]>();
  for (const authorization of authorizations) {
    const kind = authorization.kind ?? "oauth";
    const name = (kind === "pat" ? authorization.name : authorization.clientName)?.trim();
    // Unnamed registrations are not necessarily the same client.
    const key = JSON.stringify([kind, name ? "name" : "id", name?.toLowerCase() || authorization.clientId]);
    const entries = groups.get(key) ?? [];
    entries.push(authorization);
    groups.set(key, entries);
  }

  return [...groups].map(([key, entries]) => {
    const sorted = [...entries].sort((a, b) => recency(b) - recency(a));
    const first = sorted[0]!;
    const kind = first.kind ?? "oauth";
    const scopeKey = (entry: AiAuthorization) => JSON.stringify([...new Set(entry.scopes)].sort());
    const lastUsedAt = sorted.flatMap((entry) => entry.lastUsedAt ? [entry.lastUsedAt] : [])
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    return {
      key,
      kind,
      name: (kind === "pat" ? first.name : first.clientName)?.trim() || undefined,
      authorizations: sorted,
      lastUsedAt,
      scopes: sorted.every((entry) => scopeKey(entry) === scopeKey(first)) ? first.scopes : undefined,
    };
  }).sort((a, b) => recency(b.authorizations[0]!) - recency(a.authorizations[0]!));
}
