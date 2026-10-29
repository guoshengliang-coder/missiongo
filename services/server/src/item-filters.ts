import {
  ITEM_FILTER_DATES,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_TYPES,
  type ItemFilters,
} from "@missiongo/domain";
import { invalidInput } from "./errors.js";

export function parseItemFilters(
  query: Record<string, unknown>,
  accountId: () => string,
): ItemFilters {
  function list(
    name: string,
    allowed?: readonly string[],
  ): string[] | undefined {
    const raw = query[name];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || raw.length > 24000)
      throw invalidInput(`Invalid ${name} filter.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalidInput(`Invalid ${name} filter.`);
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length > 50 ||
      parsed.some(
        (v) =>
          typeof v !== "string" ||
          !v ||
          v.length > 1000 ||
          (allowed && !allowed.includes(v)),
      )
    ) {
      throw invalidInput(`Invalid ${name} filter.`);
    }
    return [...new Set(parsed as string[])];
  }
  const dates: Record<string, string> = {};
  for (const key of ITEM_FILTER_DATES) {
    const value = query[key];
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value
    ) {
      throw invalidInput(`Invalid ${key} filter.`);
    }
    dates[key] = value;
  }
  for (const [from, to] of [
    ["createdFrom", "createdTo"],
    ["updatedFrom", "updatedTo"],
  ] as const) {
    if (dates[from] && dates[to] && dates[from]! >= dates[to]!)
      throw invalidInput(`Invalid ${from} range.`);
  }
  const proposerKeys = list("proposerKeys")?.map((key) => {
    if (key === "mine") return JSON.stringify(["human", accountId()]);
    let value: unknown;
    try {
      value = JSON.parse(key);
    } catch {
      throw invalidInput("Invalid proposer filter.");
    }
    if (
      !Array.isArray(value) ||
      !value.every((v) => typeof v === "string") ||
      !(
        (value[0] === "human" && value.length === 2 && value[1]) ||
        (value[0] === "agent" && value.length === 3) ||
        (value[0] === "sdk" && value.length === 2) ||
        (value[0] === "unknown" && value.length === 1)
      )
    )
      throw invalidInput("Invalid proposer filter.");
    return JSON.stringify(value);
  });
  const types = list("types", WORK_ITEM_TYPES);
  const priorities = list("priorities", WORK_ITEM_PRIORITIES);
  const sourceComponentIds = list("sourceComponentIds");
  return {
    ...(types ? { types: types as NonNullable<ItemFilters["types"]> } : {}),
    ...(priorities
      ? { priorities: priorities as NonNullable<ItemFilters["priorities"]> }
      : {}),
    ...(sourceComponentIds ? { sourceComponentIds } : {}),
    ...(proposerKeys ? { proposerKeys } : {}),
    ...dates,
  };
}
