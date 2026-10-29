import {
  ITEM_FILTER_ARRAYS,
  ITEM_FILTER_DATES,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_TYPES,
  type ItemFilters,
} from "@missiongo/domain";

export function pickItemFilters(filters: ItemFilters): ItemFilters {
  return Object.fromEntries(
    [...ITEM_FILTER_ARRAYS, ...ITEM_FILTER_DATES].flatMap((key) => {
      const value = filters[key];
      return value && value.length ? [[key, value]] : [];
    }),
  );
}

export function readItemFilters(params: URLSearchParams): ItemFilters {
  const filters: Record<string, unknown> = {};
  for (const key of ITEM_FILTER_ARRAYS) {
    try {
      const values: unknown = JSON.parse(params.get(key) ?? "[]");
      const allowed =
        key === "types"
          ? WORK_ITEM_TYPES
          : key === "priorities"
            ? WORK_ITEM_PRIORITIES
            : null;
      if (Array.isArray(values)) {
        const valid = [
          ...new Set(
            values.filter(
              (v): v is string =>
                typeof v === "string" &&
                v.length > 0 &&
                v.length <= 1000 &&
                (!allowed || (allowed as readonly string[]).includes(v)),
            ),
          ),
        ].slice(0, 50);
        if (valid.length) filters[key] = valid;
      }
    } catch {
      /* An invalid shared URL opens with the remaining valid filters. */
    }
  }
  for (const key of ITEM_FILTER_DATES) {
    const date = params.get(key);
    if (
      date &&
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      Number.isFinite(Date.parse(`${date}T12:00:00Z`)) &&
      new Date(`${date}T12:00:00Z`).toISOString().startsWith(date)
    )
      filters[key] = date;
  }
  return filters;
}

export function appendItemFilters(
  params: URLSearchParams,
  filters: ItemFilters,
  wire = false,
): void {
  for (const key of ITEM_FILTER_ARRAYS) {
    const values = [...new Set(filters[key] ?? [])].sort();
    if (values.length) params.set(key, JSON.stringify(values));
    else params.delete(key);
  }
  for (const key of ITEM_FILTER_DATES) {
    const value = filters[key];
    if (!value) {
      params.delete(key);
      continue;
    }
    if (!wire) {
      params.set(key, value);
      continue;
    }
    const date = new Date(`${value}T00:00:00`);
    // Inclusive calendar days become exclusive next-day bounds. setDate follows
    // the browser's timezone and daylight-saving changes, unlike adding 24h.
    if (key.endsWith("To")) date.setDate(date.getDate() + 1);
    params.set(key, date.toISOString());
  }
}
