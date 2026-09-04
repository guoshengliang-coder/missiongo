import { ITEM_PRIORITIES, ITEM_TYPES, type WorkItem, type WorkItemPriority, type WorkItemType } from "./types";

export interface WebMcpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly untrustedContentHint: boolean;
  };
  readonly execute: (input: unknown) => unknown | Promise<unknown>;
}

export interface ModelContextLike {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): void | Promise<void>;
}

export interface MissionGoWebMcpOptions {
  readonly product: { readonly id: string; readonly name: string };
  readonly visibleItems: readonly WorkItem[];
  readonly activeFilters: { readonly status: string; readonly type: string; readonly search: string };
  readonly createItem: (input: {
    readonly title: string;
    readonly description: string;
    readonly type: WorkItemType;
    readonly priority: WorkItemPriority;
  }) => Promise<WorkItem>;
  readonly openItem: (itemKey: string) => WorkItem;
  readonly reportError?: (error: unknown) => void;
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object.");
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

function optionalString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value.trim();
}

function enumValue<T extends string>(input: Record<string, unknown>, field: string, values: readonly T[]): T {
  const value = requiredString(input, field);
  if (!values.includes(value as T)) throw new Error(`${field} must be one of: ${values.join(", ")}.`);
  return value as T;
}

export function registerMissionGoWebMcp(
  context: ModelContextLike | undefined,
  options: MissionGoWebMcpOptions,
): (() => void) | undefined {
  if (!context?.registerTool) return undefined;
  const lifecycle = new AbortController();
  const reportError = options.reportError ?? (() => undefined);
  const register = (tool: WebMcpTool) => {
    try {
      void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(reportError);
    } catch (error) {
      reportError(error);
    }
  };

  register({
    name: "list_visible_work_items",
    title: "List visible work items",
    description: "Read the work items currently visible in MissionGo, including the active product and filters.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute() {
      return {
        product: options.product,
        filters: options.activeFilters,
        items: options.visibleItems.map(({ key, title, type, priority, status, environment, attachments, updatedAt }) => ({
          key,
          title,
          type,
          priority,
          status,
          environment,
          attachmentCount: attachments?.length ?? 0,
          updatedAt,
        })),
      };
    },
  });

  register({
    name: "open_work_item",
    title: "Open work item",
    description: "Open one work item by its visible key in the MissionGo detail panel. This changes page navigation only.",
    inputSchema: {
      type: "object",
      properties: { itemKey: { type: "string", description: "Visible work-item key, for example HG-128." } },
      required: ["itemKey"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute(input) {
      const item = options.openItem(requiredString(objectInput(input), "itemKey").toUpperCase());
      return { opened: item.key, item };
    },
  });

  register({
    name: "create_work_item",
    title: "Create work item",
    description: "Create a new Idea, Requirement, Bug, Task, or Note in the active MissionGo product and open it.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        description: { type: "string" },
        type: { type: "string", enum: ITEM_TYPES },
        priority: { type: "string", enum: ITEM_PRIORITIES },
      },
      required: ["title", "type", "priority"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    async execute(input) {
      const value = objectInput(input);
      const item = await options.createItem({
        title: requiredString(value, "title"),
        description: optionalString(value, "description"),
        type: enumValue(value, "type", ITEM_TYPES),
        priority: enumValue(value, "priority", ITEM_PRIORITIES),
      });
      return { created: item.key, title: item.title, status: item.status };
    },
  });

  return () => lifecycle.abort();
}

declare global {
  interface Document {
    readonly modelContext?: ModelContextLike;
  }
}
