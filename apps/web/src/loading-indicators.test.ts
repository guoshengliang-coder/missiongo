import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
const styles = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

describe("loading indicators stay tied to what the person did (AND-491)", () => {
  it("does not render the floating foreground-sync spinner", () => {
    expect(appSource).not.toContain("sync-indicator");
    expect(appSource).not.toContain("foregroundSyncing");
    expect(styles).not.toContain(".sync-indicator");
  });

  it("spins the refresh button only for a manual refresh", () => {
    // The button owns its state instead of following a query's isFetching,
    // which made background polling look like a user-requested refresh.
    expect(appSource).toContain("const [refreshing, setRefreshing] = useState(false);");
    expect(appSource).not.toContain("refreshing={");
  });
});
