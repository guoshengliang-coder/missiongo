import { expect, it } from "vitest";
import { AiTitleService } from "./ai-title.js";
import { MissionGoDatabase } from "./storage/database.js";

it("accepts delivery attribution only as an explicit boolean on instruction classifications", async () => {
  const db = new MissionGoDatabase(":memory:");
  try {
    let verdict: Record<string, unknown> = {};
    const service = new AiTitleService(db, "synthetic-secret", async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("deepseek-flash");
      expect(body.messages[0].content).toContain("独立选择");
      return Response.json({ choices: [{ message: { content: JSON.stringify(verdict) } }] });
    });
    service.setKey("synthetic-provider-key");
    for (const [kind, marker, expected] of [ ["instruction", true, true], ["instruction", false, false],
      ["instruction", undefined, false], ["instruction", "true", false], ["answer", true, false], ["approval", true, false] ] as const) {
      verdict = { needsAttention: true, kind, reason: "Synthetic verdict", deliveryOnly: marker };
      expect((await service.classifyAttention("Synthetic message")).deliveryOnly).toBe(expected);
    }
  } finally { db.close(); }
});
