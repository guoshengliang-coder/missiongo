import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { foregroundSyncTargets } from "./foreground-sync";

/**
 * Re-read the queries on screen when the page comes back to the foreground
 * after a while (AND-192). The sync stays invisible (AND-491): unchanged data
 * re-renders nothing, and a spinner for it only looked like a stray status.
 *
 * Deliberately not React Query's `refetchOnWindowFocus`: that fires on every
 * focus, including moving between two side-by-side windows. Here a return only
 * acts on queries whose data is already stale.
 */
export function useForegroundSync(): void {
  const queryClient = useQueryClient();
  const inFlight = useRef(false);

  useEffect(() => {
    const sync = () => {
      if (document.visibilityState !== "visible" || inFlight.current) return;
      const targets = foregroundSyncTargets(
        queryClient.getQueryCache().getAll().map((query) => ({
          queryKey: query.queryKey,
          active: query.isActive(),
          updatedAt: query.state.dataUpdatedAt,
        })),
        Date.now(),
      );
      if (targets.length === 0) return;
      inFlight.current = true;
      void Promise.allSettled(
        targets.map((queryKey) => queryClient.refetchQueries({ queryKey, type: "active" })),
      ).finally(() => {
        inFlight.current = false;
      });
    };
    // `visibilitychange` catches a tab coming back; `focus` also catches two
    // windows side by side, where the page was never hidden at all.
    const onVisibility = () => {
      if (document.visibilityState === "visible") sync();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", sync);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", sync);
    };
  }, [queryClient]);
}
