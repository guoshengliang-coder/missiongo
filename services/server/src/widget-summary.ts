/**
 * What the Android home-screen widget shows (AND-149): the console's three
 * conversation counts and the item list's "ready" count, across every product
 * the account can see.
 *
 * The counts use the console's own definitions (apps/web/src/agent-session-view.ts)
 * so a number on the widget is the number the person finds after tapping it.
 * Archived conversations count for nothing, as they do in the console.
 */

export interface WidgetSummarySession {
  readonly id: string;
  readonly status: string;
  readonly needsAttention: boolean;
  readonly archivedAt?: string;
  readonly command?: { readonly status: string };
  readonly items: readonly { readonly productId: string; readonly key?: string }[];
  /** What the notification shows for a conversation waiting on the person (AND-150). */
  readonly attention?: {
    readonly kind?: string;
    readonly reason?: string;
    readonly revision?: string;
  };
  readonly latestMessageText?: string;
}

/** One notification line (AND-150): what is waiting, and what a tap or "无需处理" acts on. */
export interface WidgetAttentionEntry {
  readonly sessionId: string;
  readonly itemKeys: readonly string[];
  readonly productId: string | null;
  readonly kind: string;
  readonly reason?: string;
  readonly excerpt: string;
  readonly revision: string;
}

export interface WidgetSummary {
  readonly generatedAt: string;
  readonly agent: {
    readonly attention: number;
    readonly active: number;
    readonly failed: number;
    /** Where a tap lands: the product holding the most conversations that need the person. */
    readonly attentionProductId: string | null;
    /** Present only when exactly one conversation needs the person, so a tap can open it. */
    readonly attentionSessionId?: string;
  };
  readonly items: {
    readonly ready: number;
    /** Where a tap lands: the product with the most ready items. */
    readonly readyProductId: string | null;
  };
  /** Same conversations as agent.attention, with what a notification needs to say about each. */
  readonly attentionEntries: readonly WidgetAttentionEntry[];
}

/**
 * The web views are scoped to one product at a time, so a tap has to pick one.
 * The busiest product is the one most likely to hold what the person came for.
 * Ties go to the earlier product in the given order, which keeps the choice
 * stable between refreshes.
 */
function busiest(counts: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [productId, count] of counts) {
    if (count > bestCount) {
      best = productId;
      bestCount = count;
    }
  }
  return best;
}

/** Short, single-line: a notification line, not a transcript. */
function excerpt(text: string | undefined): string {
  if (!text) return "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= 140 ? collapsed : `${collapsed.slice(0, 140)}…`;
}

export function widgetSummary(
  sessions: readonly WidgetSummarySession[],
  readyByProduct: ReadonlyMap<string, number>,
  now: Date = new Date(),
): WidgetSummary {
  const live = sessions.filter((session) => !session.archivedAt);
  const attention = live.filter((session) => session.needsAttention);
  const attentionByProduct = new Map<string, number>();
  for (const session of attention) {
    // One conversation can cover several items from the same product; it is
    // still one conversation there.
    for (const productId of new Set(session.items.map((item) => item.productId))) {
      attentionByProduct.set(productId, (attentionByProduct.get(productId) ?? 0) + 1);
    }
  }
  let ready = 0;
  for (const count of readyByProduct.values()) ready += count;
  return {
    generatedAt: now.toISOString(),
    agent: {
      attention: attention.length,
      active: live.filter((session) => session.status === "active").length,
      failed: live.filter((session) => session.status === "failed" || session.command?.status === "failed").length,
      attentionProductId: busiest(attentionByProduct),
      ...(attention.length === 1 ? { attentionSessionId: attention[0]!.id } : {}),
    },
    items: {
      ready,
      readyProductId: busiest(readyByProduct),
    },
    attentionEntries: attention.map((session) => {
      const itemKeys = session.items
        .map((item) => item.key)
        .filter((key): key is string => Boolean(key));
      return {
        sessionId: session.id,
        itemKeys,
        productId: session.items[0]?.productId ?? null,
        kind: session.attention?.kind ?? "uncertain",
        ...(session.attention?.reason ? { reason: session.attention.reason } : {}),
        excerpt: excerpt(session.latestMessageText),
        revision: session.attention?.revision ?? "",
      };
    }),
  };
}
