import {describe,expect,it} from "vitest";
import {notificationGroupStatus} from "./notification-summary";

describe("notification group feedback",()=>{
  it("does not label mixed recipients as sent when any delivery failed or is unknown",()=>{
    expect(notificationGroupStatus([{status:"sent"},{status:"failed"}])).toBe("failed");
    expect(notificationGroupStatus([{status:"uncertain"},{status:"sent"}])).toBe("uncertain");
    expect(notificationGroupStatus([{status:"sent"},{status:"skipped"}])).toBe("skipped");
  });
  it("keeps queued and accepted deliveries distinct from provider-confirmed delivery",()=>{
    expect(notificationGroupStatus([{status:"sent"},{status:"queued"}])).toBe("queued");
    expect(notificationGroupStatus([{status:"accepted"}])).toBe("accepted");
    expect(notificationGroupStatus([{status:"sent"},{status:"sent"}])).toBe("sent");
    expect(notificationGroupStatus([])).toBeNull();
  });
});
