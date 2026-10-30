import { Select } from "./select";
import { useEffect, useRef, useState } from "react";
import { Filter, X } from "lucide-react";
import type {
  ItemFilters,
  WorkItemPriority,
  WorkItemType,
} from "@missiongo/domain";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useI18n } from "./i18n";
import { Modal } from "./modal";
import { ITEM_PRIORITIES, ITEM_TYPES } from "./types";

interface FilterState extends ItemFilters {
  builder: string;
}
interface Props {
  productId: string;
  value: FilterState;
  search: string;
  builders: readonly { id: string; name: string }[];
  buildersFailed: boolean;
  onChange: (value: FilterState) => void;
  onClearSearch: () => void;
  onClear: () => void;
}

export function ListFilters({
  productId,
  value,
  search,
  builders,
  buildersFailed,
  onChange,
  onClearSearch,
  onClear,
}: Props) {
  const { locale, typeLabel, priorityLabel } = useI18n();
  const zh = locale === "zh-CN";
  const word = (cn: string, en: string) => (zh ? cn : en);
  const [draft, setDraft] = useState<FilterState | null>(null);
  const [peopleSearch, setPeopleSearch] = useState("");
  const [moduleSearch, setModuleSearch] = useState("");
  const [chipLimit, setChipLimit] = useState(2);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setChipLimit((entry?.contentRect.width ?? 0) < 500 ? 1 : 2),
    );
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const options = useQuery({
    queryKey: ["item-filter-options", productId],
    queryFn: () => api.getItemFilterOptions(productId),
    enabled: Boolean(productId),
  });
  const modules = useQuery({
    queryKey: ["components", productId, "with-archived"],
    queryFn: () => api.listComponents(productId, { includeArchived: true }),
    enabled: Boolean(productId),
  });
  const open = () => {
    setPeopleSearch("");
    setModuleSearch("");
    setDraft({ ...value });
  };
  const without = (key: keyof ItemFilters) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };
  const groups: Array<{
    key: keyof ItemFilters | "search";
    label: string;
    clear: () => void;
  }> = [];
  const proposerName = (key: string) =>
    key === "mine"
      ? word("我", "Me")
      : (options.data?.proposers.find((p) => p.value === key)?.label ??
        word("已选提需者", "Selected proposer"));
  const add = (key: keyof ItemFilters, label: string, text: string) => {
    if (text)
      groups.push({
        key,
        label: `${label}：${text}`,
        clear: () => without(key),
      });
  };
  add(
    "priorities",
    word("优先级", "Priority"),
    (value.priorities ?? []).map(priorityLabel).join("、"),
  );
  add(
    "proposerKeys",
    word("提需者", "Proposer"),
    (value.proposerKeys ?? []).map(proposerName).join("、"),
  );
  add(
    "sourceComponentIds",
    word("模块", "Module"),
    (value.sourceComponentIds ?? [])
      .map(
        (id) =>
          modules.data?.find((m) => m.id === id)?.name ??
          word("已选模块", "Selected module"),
      )
      .join("、"),
  );
  for (const [prefix, label] of [
    ["created", word("创建时间", "Created")],
    ["updated", word("更新时间", "Updated")],
  ] as const) {
    const from = `${prefix}From` as keyof ItemFilters,
      to = `${prefix}To` as keyof ItemFilters;
    if (value[from] || value[to])
      groups.push({
        key: from,
        label: `${label}：${value[from] || "…"} ~ ${value[to] || "…"}`,
        clear: () => {
          const next = { ...value };
          delete next[from];
          delete next[to];
          onChange(next);
        },
      });
  }
  const extraCount = groups.length;
  if (search.trim())
    groups.push({
      key: "search",
      label: `${word("搜索", "Search")}：${search.trim()}`,
      clear: onClearSearch,
    });
  const activeCount =
    extraCount +
    (value.builder ? 1 : 0) +
    (value.types?.length ? 1 : 0) +
    (search.trim() ? 1 : 0);
  const builderOptions = (compact = false) => (
    <>
      <option value="">{word("全部", "All")}</option>
      <option value="mine">
        {compact
          ? word("我", "Me")
          : word("我担任 Builder 的", "My Builder items")}
      </option>
      <option value="unassigned">{word("待分配", "Unassigned")}</option>
      {builders.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
      {value.builder &&
        !["mine", "unassigned"].includes(value.builder) &&
        !builders.some((b) => b.id === value.builder) && (
          <option value={value.builder}>
            {word("原 Builder（不可用）", "Previous Builder (unavailable)")}
          </option>
        )}
    </>
  );
  const editArray = (
    key: "types" | "priorities" | "sourceComponentIds" | "proposerKeys",
    id: string,
    checked: boolean,
  ) => {
    if (!draft) return;
    const values: readonly string[] = draft[key] ?? [];
    setDraft({
      ...draft,
      [key]: checked
        ? [...new Set([...values, id])]
        : values.filter((v) => v !== id),
    });
  };
  const checks = (
    key: "types" | "priorities" | "sourceComponentIds" | "proposerKeys",
    entries: readonly { id: string; name: string }[],
  ) => (
    <div className="list-filter-choices">
      {entries.map((entry) => (
        <label key={entry.id}>
          <input
            type="checkbox"
            checked={
              (draft?.[key] as readonly string[] | undefined)?.includes(
                entry.id,
              ) ?? false
            }
            onChange={(e) => editArray(key, entry.id, e.target.checked)}
          />
          <span>{entry.name}</span>
        </label>
      ))}
    </div>
  );
  const hiddenTypes = value.types?.length ? (
    <button
      className="filter-chip list-filter-hidden-type"
      type="button"
      onClick={open}
    >
      <span>
        {word("类型", "Type")}：{value.types.map(typeLabel).join("、")}
      </span>
    </button>
  ) : null;
  return (
    <div className="list-filter-bar" ref={root}>
      <div
        className="list-filter-controls"
        aria-label={word("条目筛选", "Item filters")}
      >
        <label className="list-filter-builder">
          <span>Builder</span>
          <Select anchorToLabel
            aria-label="Builder"
            value={value.builder}
            onChange={(e) => onChange({ ...value, builder: e.target.value })}
          >
            {builderOptions(true)}
          </Select>
        </label>
        <label className="list-filter-type">
          <span>{word("类型", "Type")}</span>
          <Select anchorToLabel
            aria-label={word("类型", "Type")}
            value={
              value.types?.length === 1
                ? value.types[0]
                : value.types?.length
                  ? "multiple"
                  : ""
            }
            onChange={(e) => {
              if (e.target.value === "multiple") open();
              else
                onChange({
                  ...value,
                  types: e.target.value ? [e.target.value as WorkItemType] : [],
                });
            }}
          >
            <option value="">{word("全部", "All")}</option>
            {ITEM_TYPES.map((type) => (
              <option key={type} value={type}>
                {typeLabel(type)}
              </option>
            ))}
            {(value.types?.length ?? 0) > 1 && (
              <option value="multiple">
                {word(
                  `已选 ${value.types!.length} 项`,
                  `${value.types!.length} selected`,
                )}
              </option>
            )}
          </Select>
        </label>
        <button
          className="secondary-button list-filter-more"
          type="button"
          onClick={open}
        >
          <Filter size={14} />
          <span>
            {word("更多筛选", "More filters")}
            {extraCount > 0 ? ` · ${extraCount}` : ""}
          </span>
        </button>
        <button
          className="secondary-button list-filter-all"
          type="button"
          onClick={open}
        >
          <Filter size={14} />
          {word("筛选", "Filters")}
          {activeCount > 0 ? ` · ${activeCount}` : ""}
        </button>
        {activeCount > 0 && groups.length === 0 && (
          <button
            className="text-button list-filter-clear"
            type="button"
            onClick={onClear}
          >
            {word("清除", "Clear")}
          </button>
        )}
      </div>
      {(groups.length > 0 || hiddenTypes) && (
        <div
          className={`list-filter-summary ${groups.length === 0 ? "list-filter-only-type" : ""}`}
          aria-label={word("已应用筛选", "Applied filters")}
          aria-live="polite"
        >
          {hiddenTypes}
          {groups.slice(0, chipLimit).map((group) => (
            <button
              key={group.key}
              className="filter-chip"
              type="button"
              title={group.label}
              onClick={group.clear}
            >
              <span>{group.label}</span>
              <X size={12} aria-hidden="true" />
            </button>
          ))}
          {groups.length > chipLimit && (
            <button className="text-button" type="button" onClick={open}>
              {word(
                `另有 ${groups.length - chipLimit} 项`,
                `${groups.length - chipLimit} more`,
              )}
            </button>
          )}
          <button
            className="text-button list-filter-clear"
            type="button"
            onClick={onClear}
          >
            {word("清除筛选", "Clear filters")}
          </button>
        </div>
      )}
      {buildersFailed && (
        <p role="alert" className="list-filter-error">
          {word(
            "Builder 列表加载失败，请刷新重试。",
            "Builder list failed to load. Please refresh.",
          )}
        </p>
      )}
      {draft && (
        <Modal
          title={word("筛选条目", "Filter items")}
          subtitle={word(
            "当前产品 · 当前状态",
            "Current product · current status",
          )}
          onClose={() => setDraft(null)}
        >
          <form
            className="list-filter-form"
            onSubmit={(e) => {
              e.preventDefault();
              onChange(draft);
              setDraft(null);
            }}
          >
            <label className="list-filter-field">
              Builder
              <Select
                data-initial-focus
                aria-label={word("筛选 Builder", "Filter Builder")}
                value={draft.builder}
                onChange={(e) =>
                  setDraft({ ...draft, builder: e.target.value })
                }
              >
                {builderOptions()}
              </Select>
            </label>
            <fieldset>
              <legend>{word("类型", "Type")}</legend>
              {checks(
                "types",
                ITEM_TYPES.map((id) => ({ id, name: typeLabel(id) })),
              )}
            </fieldset>
            <fieldset>
              <legend>{word("优先级", "Priority")}</legend>
              {checks(
                "priorities",
                ITEM_PRIORITIES.map((id) => ({
                  id,
                  name: priorityLabel(id as WorkItemPriority),
                })),
              )}
            </fieldset>
            <fieldset>
              <legend>{word("提需者", "Proposer")}</legend>
              <input
                type="search"
                aria-label={word("搜索提需者", "Search proposers")}
                placeholder={word("搜索人员或来源", "Search people or sources")}
                value={peopleSearch}
                onChange={(e) => setPeopleSearch(e.target.value)}
              />
              {checks("proposerKeys", [
                { id: "mine", name: word("我提出的", "Proposed by me") },
              ])}
              {(["human", "agent", "sdk", "unknown"] as const).map((kind) => {
                const entries = (options.data?.proposers ?? []).filter(
                  (p) =>
                    p.kind === kind &&
                    p.label
                      .toLocaleLowerCase()
                      .includes(peopleSearch.toLocaleLowerCase()),
                );
                return (
                  entries.length > 0 && (
                    <div key={kind}>
                      <p className="list-filter-group-name">
                        {
                          {
                            human: word("人员", "People"),
                            agent: "Agent",
                            sdk: word("SDK 来源", "SDK sources"),
                            unknown: word("历史记录", "Historical"),
                          }[kind]
                        }
                      </p>
                      {checks(
                        "proposerKeys",
                        entries.map((p) => ({ id: p.value, name: p.label })),
                      )}
                    </div>
                  )
                );
              })}
              {options.isPending && (
                <p role="status">{word("正在加载…", "Loading…")}</p>
              )}
              {options.isError && (
                <p role="alert">
                  {word("提需者加载失败。", "Unable to load proposers.")}{" "}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void options.refetch()}
                  >
                    {word("重试", "Retry")}
                  </button>
                </p>
              )}
            </fieldset>
            <fieldset>
              <legend>{word("模块（来源模块）", "Module (source)")}</legend>
              <input
                type="search"
                aria-label={word("搜索模块", "Search modules")}
                placeholder={word("搜索模块", "Search modules")}
                value={moduleSearch}
                onChange={(e) => setModuleSearch(e.target.value)}
              />
              {checks(
                "sourceComponentIds",
                (modules.data ?? [])
                  .filter((m) =>
                    m.name
                      .toLocaleLowerCase()
                      .includes(moduleSearch.toLocaleLowerCase()),
                  )
                  .map((m) => ({
                    id: m.id,
                    name: `${m.name}${m.archivedAt ? word("（已归档）", " (archived)") : ""}`,
                  })),
              )}
              {modules.isError && (
                <p role="alert">
                  {word("模块加载失败。", "Unable to load modules.")}{" "}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void modules.refetch()}
                  >
                    {word("重试", "Retry")}
                  </button>
                </p>
              )}
            </fieldset>
            {(["created", "updated"] as const).map((prefix) => (
              <fieldset key={prefix}>
                <legend>
                  {prefix === "created"
                    ? word("创建时间", "Created")
                    : word("更新时间", "Updated")}
                </legend>
                <div className="list-filter-dates">
                  {(["From", "To"] as const).map((edge) => {
                    const key = `${prefix}${edge}` as
                      | "createdFrom"
                      | "createdTo"
                      | "updatedFrom"
                      | "updatedTo";
                    return (
                      <label key={key}>
                        {edge === "From"
                          ? word("从", "From")
                          : word("至（含当天）", "Through")}
                        <input
                          type="date"
                          aria-label={`${prefix === "created" ? word("创建", "Created") : word("更新", "Updated")}${edge === "From" ? word("开始日期", " from") : word("结束日期", " through")}`}
                          value={draft[key] ?? ""}
                          {...(edge === "To"
                            ? { min: draft[`${prefix}From`] ?? "" }
                            : { max: draft[`${prefix}To`] ?? "" })}
                          onChange={(e) =>
                            setDraft({ ...draft, [key]: e.target.value })
                          }
                        />
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}
            <footer className="list-filter-footer">
              <button
                className="text-button"
                type="button"
                onClick={() => setDraft({ builder: "" })}
              >
                {word("重置条件", "Reset conditions")}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setDraft(null)}
              >
                {word("取消", "Cancel")}
              </button>
              <button className="primary-button" type="submit">
                {word("应用筛选", "Apply filters")}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
