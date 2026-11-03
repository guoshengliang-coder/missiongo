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
  commentId: string | null;
  unavailable: boolean;
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
