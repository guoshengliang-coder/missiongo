import { useI18n } from "./i18n";

/** Responsibility is a separate group from the item key and Agent activity. */
export function BuilderBadge({ name, needsReassignment = false }: { name?: string | null | undefined; needsReassignment?: boolean | undefined }) {
  const { t } = useI18n();
  return <span className="item-builder">
    <span className="item-builder-label">{t("builderLabel")}</span>{" "}
    <strong>{name ?? t("builderUnassigned")}</strong>
    {needsReassignment && <span className="item-builder-warning">{t("builderNeedsReassignment")}</span>}
  </span>;
}
