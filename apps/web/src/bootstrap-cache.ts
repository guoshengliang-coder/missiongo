import type { QueryClient, QueryKey } from "@tanstack/react-query";

/** Only the initial bootstrap seeds resources. Reset/foreground reads have
 * independent query owners and must not overwrite their newer snapshots. */
export function bootstrapCacheSeeder(client: QueryClient) {
  const initial = client.getQueryData(["bootstrap"]) === undefined;
  const versions = new Map(client.getQueryCache().getAll().map(query =>
    [query.queryHash, {query, updates: query.state.dataUpdateCount}] as const));
  return <T>(key: QueryKey, data: T) => {
    if (!initial) return;
    const current = client.getQueryCache().find({queryKey:key, exact:true});
    if (current) {
      const previous = versions.get(current.queryHash);
      // Also protect a resource fetched/edited during the initial bootstrap.
      if ((!previous && current.state.data !== undefined) || (previous &&
        (previous.query !== current || previous.updates !== current.state.dataUpdateCount))) return;
    } else if (versions.size && [...versions.values()].some(({query}) => JSON.stringify(query.queryKey) === JSON.stringify(key))) {
      return; // An explicitly removed snapshot must not be resurrected.
    }
    client.setQueryData(key, data);
  };
}
