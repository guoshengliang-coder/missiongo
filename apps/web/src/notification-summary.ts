import type { DingTalkNotification, DingTalkNotificationStatus } from "@missiongo/domain";

/** A successful first recipient must not hide another recipient's failed or pending delivery. */
export function notificationGroupStatus(notices:readonly Pick<DingTalkNotification,"status">[]):DingTalkNotificationStatus|null {
  for(const status of ["failed","uncertain","skipped","sending","queued","accepted"] as const) {
    if(notices.some(notice=>notice.status===status))return status;
  }
  return notices.length ? "sent" : null;
}
