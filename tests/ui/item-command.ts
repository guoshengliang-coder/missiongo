import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
/** Fixture commands use the same observed revision and retry contract as the console. */
export async function postItemCommand(request:APIRequestContext,path:string,options:{data:Record<string,unknown>}) {
 const data={...options.data};
 const itemKey=path.split("/")[4]!;
 const current=await (await request.get(`/api/v1/items/${itemKey}`)).json();
 data.expectedRevision ??=current.revision;data.expectedStatus ??=current.status;
 data.idempotencyKey ??=randomUUID();
 if (data.reason === "manual_override" && !data.note) data.note="Audited UI fixture state";
 return request.post(path,{data});
}
