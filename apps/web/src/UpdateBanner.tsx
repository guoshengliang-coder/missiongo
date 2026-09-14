import { RotateCw } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { useI18n } from "./i18n";
import { isUpdateReady, reloadToLatest, subscribeToUpdate } from "./version-check";

/**
 * Shown when a newer build is out but reloading on its own could lose what
 * someone is typing. It does not go away by itself: a person who ignores it is
 * still running an old console, and should keep being told.
 */
export function UpdateBanner() {
  const { t } = useI18n();
  const ready = useSyncExternalStore(subscribeToUpdate, isUpdateReady, () => false);
  const [reloading, setReloading] = useState(false);
  if (!ready) return null;

  return (
    <div className="toast update-banner" role="status">
      <span>{t("updateReady")}</span>
      <button
        type="button"
        disabled={reloading}
        onClick={() => {
          setReloading(true);
          void reloadToLatest();
        }}
      >
        <RotateCw size={14} aria-hidden="true" />
        {t("updateReload")}
      </button>
    </div>
  );
}
