import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DingTalkBindingInput, DingTalkImportRow, DingTalkSettingsInput } from "@missiongo/domain";
import type { AccountSnapshot, AccountStore } from "./accounts-store.js";
import type { MissionGoStore } from "./store.js";
import type { DingTalkNotifications } from "./dingtalk-notifications.js";
import { invalidInput, notFound } from "./errors.js";

function body(request: FastifyRequest): Record<string,unknown> {
  if (!request.body || typeof request.body!=="object" || Array.isArray(request.body)) throw invalidInput("请求正文必须为对象。");
  return request.body as Record<string,unknown>;
}
function rows(value: unknown): DingTalkImportRow[] {
  if (!Array.isArray(value) || value.some(row=>!row || typeof row!=="object" || Array.isArray(row))) throw invalidInput("导入行格式无效。");
  return value as DingTalkImportRow[];
}
export function registerDingTalkRoutes(app: FastifyInstance,{store,accounts,service,requireAccount}: {
  store:MissionGoStore;accounts:AccountStore;service:DingTalkNotifications;requireAccount:(request:FastifyRequest)=>AccountSnapshot;
}) {
  // Only a signed-in administrator manages credentials or the cross-project directory.
  const admin=(request:FastifyRequest)=>{const account=requireAccount(request);if(account.role!=="admin")throw notFound("Settings");return account;};
  app.get("/api/v1/dingtalk/settings",async request=>{admin(request);return service.settings();});
  app.put("/api/v1/dingtalk/settings",async request=>{
    const account=admin(request),value=body(request);
    return service.saveSettings(value as unknown as DingTalkSettingsInput,account.id);
  });
  app.post("/api/v1/dingtalk/check",async request=>{admin(request);await service.checkConnection();return {available:true};});
  app.get("/api/v1/dingtalk/bindings",async request=>{admin(request);return {bindings:service.bindings(),tests:service.tests()};});
  app.put("/api/v1/dingtalk/bindings/:accountId",async request=>{
    const account=admin(request),{accountId}=request.params as {accountId:string},value=body(request);
    if(value.expectedRevision!==null && typeof value.expectedRevision!=="string")throw invalidInput("缺少当前绑定版本，请刷新。");
    return {bindings:service.saveBinding(accountId,value.binding===null?null:value.binding as DingTalkBindingInput,value.expectedRevision as string|null,account.id)};
  });
  app.post("/api/v1/dingtalk/bindings/preview",async request=>{admin(request);return service.preview(rows(body(request).rows));});
  app.post("/api/v1/dingtalk/bindings/import",async request=>{
    const account=admin(request),value=body(request);
    if(typeof value.fingerprint!=="string")throw invalidInput("请先预览再导入。");
    return {bindings:service.importBindings(rows(value.rows),value.fingerprint,account.id)};
  });
  app.post("/api/v1/dingtalk/bindings/:accountId/test",async request=>{
    const account=admin(request),{accountId}=request.params as {accountId:string};return service.test(accountId,account.id);
  });
  app.get("/api/v1/products/:productId/dingtalk",async request=>{
    const account=requireAccount(request),{productId}=request.params as {productId:string};return service.project(productId,account);
  });
  app.put("/api/v1/products/:productId/dingtalk",async request=>{
    const account=requireAccount(request),{productId}=request.params as {productId:string},value=body(request);
    if(typeof value.enabled!=="boolean" || typeof value.expectedEnabled!=="boolean")throw invalidInput("通知开关格式无效。");
    return service.saveProject(productId,account,value.enabled,value.expectedEnabled);
  });
  const visible=(request:FastifyRequest)=>{
    const account=requireAccount(request),{itemKey}=request.params as {itemKey:string},item=store.getWorkItem(itemKey);
    if(!accounts.allows(account,item.productId,"view"))throw notFound("Work item");
    return {account,item,canRetry:!item.transferred && accounts.allows(account,item.productId,"operate")};
  };
  app.get("/api/v1/items/:itemKey/dingtalk-notifications",async request=>{
    const {item,canRetry}=visible(request);return {notifications:service.list(item.id),canRetry};
  });
  app.get("/api/v1/items/:itemKey/comments/:commentId/dingtalk-notifications",async request=>{
    const {item,canRetry}=visible(request),{commentId}=request.params as {commentId:string};
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(commentId))throw invalidInput("评论编号格式无效。");
    return {notifications:service.listComment(item.id,commentId),canRetry};
  });
  app.post("/api/v1/items/:itemKey/dingtalk-notifications/:id/retry",async request=>{
    const {account,item,canRetry}=visible(request);if(!canRetry)throw notFound("Notification");
    const {id}=request.params as {id:string};service.retry(item.key,id,account.id);return {notifications:service.list(item.id),canRetry};
  });
}
