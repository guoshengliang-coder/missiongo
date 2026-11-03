export type PersonalNotificationKind = "mention" | "reply" | "verification" | "decision";
export interface PersonalNotification {
  id: string;
  sequence: number;
  kind: PersonalNotificationKind;
  itemKey: string;
  itemTitle: string;
  productId: string;
  productName: string;
  actorName: string;
  summary: string;
  createdAt: string;
  readAt: string | null;
  /** Superseded/completed business prompt, independent of whether it was read. */
  resolvedAt: string | null;
  commentId: string | null;
  unavailable: boolean;
}
export interface PersonalTodo {
  id: string;
  sequence: number;
  kind: "verification";
  itemKey: string;
  itemTitle: string;
  productId: string;
  productName: string;
  createdAt: string;
}
export interface PersonalTodoPage {
  todos: PersonalTodo[];
  nextBeforeSequence?: number;
}
export interface PersonalAttentionCount {
  count: number;
  todoCount: number;
  unreadCount: number;
  /** Unread notifications already represented by an active todo. */
  coveredUnreadCount: number;
}
export interface PersonalNotificationDetail extends PersonalNotification { text: string }
export interface PersonalNotificationFilter {
  unread?: boolean | undefined;
  productId?: string | undefined;
  kind?: PersonalNotificationKind | undefined;
  beforeSequence?: number | undefined;
}
export interface PersonalNotificationPage {
  notifications: PersonalNotification[];
  unreadCount: number;
  throughSequence: number;
  nextBeforeSequence?: number;
}
