import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import type { CommonCommands } from "@missiongo/contracts";
import { commonCommandsQuery } from "./common-command-query";

it("a delayed read cannot replace a newer successful write in the shared query cache", async () => {
  const client = new QueryClient();
  const old = { revision: 1, commands: [] };
  const latest = { revision: 2, commands: [{ id: "new", content: "saved", name: "", favorite: false }] };
  let release!: (value: CommonCommands) => void;
  const response = new Promise<CommonCommands>(resolve => { release = resolve; });
  client.setQueryData(["common-commands"], old);
  const read = client.fetchQuery(commonCommandsQuery(client, () => response));
  client.setQueryData(["common-commands"], latest);
  release(old);
  await read;
  expect(client.getQueryData(["common-commands"])).toEqual(latest);
  client.clear();
});
