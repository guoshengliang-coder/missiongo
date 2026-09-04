import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import type { WorkItemPriority, WorkItemStatus, WorkItemType } from "./types";

export type Locale = "zh-CN" | "en";

const EN_MESSAGES = {
  openingWorkspace: "Opening your workspace…",
  privateWorkspace: "Private workspace",
  connectTitle: "Connect to MissionGo",
  connectBody: "Enter the administrator token configured on your MissionGo Server. It stays in this browser tab.",
  startWorkspace: "Start your workspace",
  createFirstProduct: "Create your first product.",
  productHelp: "Products keep related Android, macOS, Web, and server work under one clear identity.",
  openNavigation: "Open navigation",
  closeNavigation: "Close navigation",
  selectedProduct: "Selected product",
  searchItems: "Search items…",
  connectionSettings: "Connection settings",
  capture: "Capture",
  workspace: "Workspace",
  allItems: "All items",
  aiDispatchNext: "AI analysis is ready",
  aiDispatchDescription: "Ask a connected coding agent to analyze an item by ID. Its conclusion will appear in the timeline.",
  addProduct: "Add product",
  productWorkspace: "{prefix} workspace",
  allWork: "All work",
  workspaceSummary: "Workspace summary",
  open: "open",
  toVerify: "to verify",
  filterByType: "Filter by type",
  allTypes: "All types",
  workItems: "Work items",
  captureFirstSpark: "Capture the first spark",
  noMatchingItems: "No matching items",
  firstSparkHelp: "Ideas, requirements, bugs, tasks, and notes all begin here.",
  noMatchHelp: "Try another status, type, or search.",
  captureItem: "Capture item",
  captureNewItem: "Capture a new item",
  captureWork: "Capture work",
  addToProduct: "Add to {product}",
  createProductWorkspace: "Create another product workspace",
  connection: "Connection",
  administratorAccess: "Administrator access for this browser tab",
  connectionUpdated: "Connection settings updated.",
  dismiss: "Dismiss",
  selectItem: "Select an item",
  selectItemHelp: "Open an item to review context, update details, and move the work forward.",
  backToList: "Back to list",
  moreActions: "More actions",
  cancel: "Cancel",
  edit: "Edit",
  title: "Title",
  type: "Type",
  priority: "Priority",
  description: "Description",
  saveChanges: "Save changes",
  noDescription: "No description yet.",
  capturedContext: "Captured context",
  platform: "Platform",
  version: "Version",
  operatingSystem: "OS",
  device: "Device",
  environmentDetails: "Device & version details",
  environmentHelp: "Optional when entering manually. Client SDKs can fill these fields automatically.",
  noEnvironment: "No device or version details yet.",
  notSpecified: "Not specified",
  android: "Android",
  macos: "macOS",
  web: "Web",
  server: "Server",
  shared: "Shared core",
  other: "Other",
  appVersion: "App version",
  buildNumber: "Build number",
  sourceRevision: "Source revision",
  osVersion: "OS version",
  deviceModel: "Device model",
  attachments: "Attachments",
  addAttachments: "Add attachments",
  attachmentHelp: "Images up to 20 MiB, videos up to 100 MiB, and .log/.txt/.json files up to 10 MiB. Maximum 10 files per item.",
  pasteDropHelp: "Choose files, paste a screenshot, or drop images, videos, and logs here.",
  noAttachments: "No images, videos, or logs yet.",
  removeFile: "Remove {filename}",
  download: "Download",
  attachmentLoading: "Loading attachment…",
  attachmentFailed: "Attachment could not be loaded.",
  uploadPartial: "{key} was created, but {count} attachment(s) could not be uploaded.",
  uploadFailed: "{count} attachment(s) could not be uploaded.",
  tooManyFiles: "You can attach at most {count} files.",
  unsupportedFile: "{filename} is not a supported image, video, or log file.",
  fileTooLarge: "{filename} exceeds the {size} MiB limit.",
  nextAction: "Next action",
  moveForward: "Move this work forward",
  timeline: "Timeline",
  analysisConclusion: "Conclusion",
  analysisEvidence: "Evidence",
  analysisRisks: "Risks / open questions",
  status: "Status",
  updated: "Updated",
  whatNeedsAttention: "What needs attention?",
  clearSpecificTitle: "A clear, specific title",
  context: "Context",
  contextPlaceholder: "What did you notice? What should happen instead?",
  optionalDetails: "Optional details",
  optionalDetailsHelp: "Source component, priority, device, and version",
  sourceComponent: "Source component",
  affectedComponents: "Affected components",
  addComponent: "Add a component",
  componentName: "Component name",
  componentNamePlaceholder: "For example: Android client",
  componentKind: "Component kind",
  createComponent: "Create component",
  draftSaved: "Text draft saved on this device. The browser cannot restore attachments after this form closes.",
  captureShortcut: "⌘/Ctrl + Enter to save",
  landsInInbox: "It will land in Inbox.",
  productName: "Product name",
  itemPrefix: "Item prefix",
  prefixHelp: "Used for item IDs, such as HG-128.",
  createWorkspace: "Create workspace",
  administratorToken: "Administrator token",
  pasteToken: "Paste token",
  tokenPrivacy: "Stored only for this browser tab.",
  saveAndConnect: "Save & connect",
  close: "Close",
  loadingItems: "Loading items",
  somethingWentWrong: "Something went wrong.",
  capturedInInbox: "{key} captured in Inbox.",
  itemNotLoaded: "{key} is not loaded in the active product.",
  webToolError: "Web tool error: {message}",
  itemUpdated: "{key} updated.",
  itemMoved: "{key} moved to {status}.",
  switchLanguage: "切换到中文",
} as const;

export type MessageKey = keyof typeof EN_MESSAGES;

const ZH_MESSAGES: Record<MessageKey, string> = {
  openingWorkspace: "正在打开工作区…",
  privateWorkspace: "私人工作区",
  connectTitle: "连接 MissionGo",
  connectBody: "请输入 MissionGo 服务端配置的管理员令牌。令牌只会保存在当前浏览器标签页中。",
  startWorkspace: "开始创建工作区",
  createFirstProduct: "创建你的第一个产品",
  productHelp: "产品用于把相关的 Android、macOS、Web 和服务端工作统一归集在同一个项目下。",
  openNavigation: "打开导航",
  closeNavigation: "关闭导航",
  selectedProduct: "当前产品",
  searchItems: "搜索条目…",
  connectionSettings: "连接设置",
  capture: "记录",
  workspace: "工作区",
  allItems: "全部条目",
  aiDispatchNext: "AI 分析已可用",
  aiDispatchDescription: "让已连接的 AI 按编号分析条目，结论、依据和风险会回写到处理记录。",
  addProduct: "添加产品",
  productWorkspace: "{prefix} 工作区",
  allWork: "全部工作",
  workspaceSummary: "工作区概览",
  open: "未完成",
  toVerify: "待验证",
  filterByType: "按类型筛选",
  allTypes: "全部类型",
  workItems: "工作条目",
  captureFirstSpark: "记录第一个灵感",
  noMatchingItems: "没有匹配的条目",
  firstSparkHelp: "灵感、需求、Bug、任务和备注都可以从这里开始。",
  noMatchHelp: "可以尝试切换状态、类型或搜索条件。",
  captureItem: "记录条目",
  captureNewItem: "记录新条目",
  captureWork: "记录工作",
  addToProduct: "添加到 {product}",
  createProductWorkspace: "创建另一个产品工作区",
  connection: "连接设置",
  administratorAccess: "当前浏览器标签页的管理员访问权限",
  connectionUpdated: "连接设置已更新。",
  dismiss: "关闭提示",
  selectItem: "选择一个条目",
  selectItemHelp: "打开条目即可查看上下文、修改详情并推进处理状态。",
  backToList: "返回列表",
  moreActions: "更多操作",
  cancel: "取消",
  edit: "编辑",
  title: "标题",
  type: "类型",
  priority: "优先级",
  description: "描述",
  saveChanges: "保存修改",
  noDescription: "暂无描述。",
  capturedContext: "采集的环境信息",
  platform: "平台",
  version: "版本",
  operatingSystem: "系统",
  device: "设备",
  environmentDetails: "设备与版本信息",
  environmentHelp: "手动填写时可以留空；客户端 SDK 接入后可自动采集这些字段。",
  noEnvironment: "暂时没有设备或版本信息。",
  notSpecified: "未指定",
  android: "Android",
  macos: "macOS",
  web: "Web",
  server: "服务端",
  shared: "公共核心",
  other: "其他",
  appVersion: "产品版本",
  buildNumber: "构建版本号",
  sourceRevision: "代码版本",
  osVersion: "系统版本",
  deviceModel: "设备型号",
  attachments: "附件",
  addAttachments: "添加附件",
  attachmentHelp: "图片最大 20 MiB，视频最大 100 MiB，.log/.txt/.json 日志最大 10 MiB；每个条目最多 10 个附件。",
  pasteDropHelp: "可以选择文件、直接粘贴截图，或把图片、视频和日志拖到这里。",
  noAttachments: "暂时没有图片、视频或日志。",
  removeFile: "移除 {filename}",
  download: "下载",
  attachmentLoading: "正在加载附件…",
  attachmentFailed: "附件加载失败。",
  uploadPartial: "{key} 已创建，但有 {count} 个附件上传失败。",
  uploadFailed: "有 {count} 个附件上传失败。",
  tooManyFiles: "最多只能添加 {count} 个附件。",
  unsupportedFile: "不支持 {filename} 的文件类型。",
  fileTooLarge: "{filename} 超过了 {size} MiB 的大小限制。",
  nextAction: "下一步操作",
  moveForward: "推进此项工作",
  timeline: "处理记录",
  analysisConclusion: "分析结论",
  analysisEvidence: "判断依据",
  analysisRisks: "风险与待确认项",
  status: "状态",
  updated: "已更新",
  whatNeedsAttention: "需要记录什么？",
  clearSpecificTitle: "请输入清晰、具体的标题",
  context: "补充说明",
  contextPlaceholder: "你发现了什么？期望的结果是什么？",
  optionalDetails: "补充信息（可选）",
  optionalDetailsHelp: "来源板块、优先级、设备和版本",
  sourceComponent: "来源板块",
  affectedComponents: "影响板块",
  addComponent: "添加板块",
  componentName: "板块名称",
  componentNamePlaceholder: "例如：Android 客户端",
  componentKind: "板块类型",
  createComponent: "创建板块",
  draftSaved: "文字草稿已保存在本机；关闭表单后浏览器无法恢复附件。",
  captureShortcut: "按 ⌘/Ctrl + Enter 保存",
  landsInInbox: "条目会先进入收件箱。",
  productName: "产品名称",
  itemPrefix: "条目前缀",
  prefixHelp: "用于生成条目编号，例如 HG-128。",
  createWorkspace: "创建工作区",
  administratorToken: "管理员令牌",
  pasteToken: "粘贴令牌",
  tokenPrivacy: "仅保存在当前浏览器标签页中。",
  saveAndConnect: "保存并连接",
  close: "关闭",
  loadingItems: "正在加载条目",
  somethingWentWrong: "出现了问题。",
  capturedInInbox: "{key} 已记录到收件箱。",
  itemNotLoaded: "当前产品中尚未加载 {key}。",
  webToolError: "网页工具错误：{message}",
  itemUpdated: "{key} 已更新。",
  itemMoved: "{key} 已移至“{status}”。",
  switchLanguage: "Switch to English",
};

const STATUS_LABELS: Record<Locale, Record<WorkItemStatus, string>> = {
  en: {
    inbox: "Inbox",
    ready: "Ready",
    in_progress: "In progress",
    on_hold: "On hold",
    pending_verification: "Pending verification",
    done: "Done",
    cancelled: "Cancelled",
  },
  "zh-CN": {
    inbox: "收件箱",
    ready: "待领取",
    in_progress: "处理中",
    on_hold: "暂缓",
    pending_verification: "待验证",
    done: "已完成",
    cancelled: "已取消",
  },
};

const TYPE_LABELS: Record<Locale, Record<WorkItemType, string>> = {
  en: { idea: "Idea", requirement: "Requirement", bug: "Bug", task: "Task", note: "Note" },
  "zh-CN": { idea: "灵感", requirement: "需求", bug: "Bug", task: "任务", note: "备注" },
};

const PRIORITY_LABELS: Record<Locale, Record<WorkItemPriority, string>> = {
  en: { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" },
  "zh-CN": { urgent: "紧急", high: "高", normal: "普通", low: "低" },
};

const TRANSITION_LABELS: Record<Locale, Record<string, string>> = {
  en: {},
  "zh-CN": {
    "Move to ready": "移至待领取",
    "Start work": "开始处理",
    "Put on hold": "暂缓处理",
    "Move to inbox": "移回收件箱",
    "Submit for verification": "提交验证",
    Release: "释放任务",
    "Resume work": "继续处理",
    "Return to ready": "退回待领取",
    "Verify & close": "验证通过并关闭",
    "Needs more work": "需要继续处理",
    Reopen: "重新打开",
    Restore: "恢复",
  },
};

const ACTOR_LABELS: Record<Locale, Record<string, string>> = {
  en: { human: "Human", agent: "Agent", system: "System" },
  "zh-CN": { human: "人工", agent: "AI", system: "系统" },
};

const EVENT_LABELS: Record<Locale, Record<string, string>> = {
  en: { item_created: "Item created", item_updated: "Item updated", attachment_added: "Attachment added", analysis_appended: "AI analysis added" },
  "zh-CN": { item_created: "已创建条目", item_updated: "已更新详情", attachment_added: "已添加附件", analysis_appended: "AI 已回写分析" },
};

interface I18nValue {
  readonly locale: Locale;
  readonly toggleLocale: () => void;
  readonly t: (key: MessageKey, variables?: Readonly<Record<string, string | number>>) => string;
  readonly statusLabel: (status: WorkItemStatus) => string;
  readonly typeLabel: (type: WorkItemType) => string;
  readonly priorityLabel: (priority: WorkItemPriority) => string;
  readonly transitionLabel: (label: string) => string;
  readonly actorLabel: (actor: string) => string;
  readonly eventLabel: (event: string) => string;
  readonly formatTime: (value: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function interpolate(template: string, variables: Readonly<Record<string, string | number>> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(variables[key] ?? `{${key}}`));
}

export function resolveLocale(storedLocale: string | null): Locale {
  return storedLocale === "en" ? "en" : "zh-CN";
}

export function translate(
  locale: Locale,
  key: MessageKey,
  variables?: Readonly<Record<string, string | number>>,
): string {
  const messages = locale === "zh-CN" ? ZH_MESSAGES : EN_MESSAGES;
  return interpolate(messages[key], variables);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => resolveLocale(localStorage.getItem("missiongo.locale")));

  useEffect(() => {
    localStorage.setItem("missiongo.locale", locale);
    document.documentElement.lang = locale;
    document.title = locale === "zh-CN" ? "MissionGo · 从灵感到交付" : "MissionGo · From idea to shipped";
  }, [locale]);

  const value = useMemo<I18nValue>(() => {
    return {
      locale,
      toggleLocale: () => setLocale((current) => current === "zh-CN" ? "en" : "zh-CN"),
      t: (key, variables) => translate(locale, key, variables),
      statusLabel: (status) => STATUS_LABELS[locale][status],
      typeLabel: (type) => TYPE_LABELS[locale][type],
      priorityLabel: (priority) => PRIORITY_LABELS[locale][priority],
      transitionLabel: (label) => TRANSITION_LABELS[locale][label] ?? label,
      actorLabel: (actor) => ACTOR_LABELS[locale][actor] ?? actor,
      eventLabel: (event) => EVENT_LABELS[locale][event] ?? event.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()),
      formatTime: (value) => {
        const date = new Date(value);
        const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
        if (minutes < 1) return locale === "zh-CN" ? "刚刚" : "just now";
        if (minutes < 60) return locale === "zh-CN" ? `${minutes} 分钟前` : `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return locale === "zh-CN" ? `${hours} 小时前` : `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 7) return locale === "zh-CN" ? `${days} 天前` : `${days}d ago`;
        return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
      },
    };
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider.");
  return value;
}
