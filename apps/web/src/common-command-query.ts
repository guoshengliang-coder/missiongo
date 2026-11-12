import type { QueryClient } from "@tanstack/react-query";
import type { CommonCommands } from "@missiongo/contracts";

export function newestCommonCommands(current: CommonCommands | undefined, incoming: CommonCommands): CommonCommands {
  return current && current.revision > incoming.revision ? current : incoming;
}

/** Reads and writes can finish out of order while account config events refetch. */
export function commonCommandsQuery(client: QueryClient, read: () => Promise<CommonCommands>) {
  return {
    queryKey: ["common-commands"],
    queryFn: async () => {
      const incoming = await read();
      return newestCommonCommands(client.getQueryData<CommonCommands>(["common-commands"]), incoming);
    },
    retry: false as const,
  };
}
