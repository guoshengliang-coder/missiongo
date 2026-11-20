import {createHash} from "node:crypto";
import type {PublicationScope, PublicationScopeRow} from "@missiongo/contracts";
import type {MissionGoDatabase} from "./storage/database.js";

const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const deliveryScope=(rows:readonly (readonly [string,number,string|null,string|null])[])=>digest(rows);
export const historicalDeliveryFingerprint=(row:PublicationScopeRow)=>digest([
  row.identity,row.itemKey,row.developmentEventId,row.roundKey,row.completion??null,row.requiredArtifacts??null,row.itemScope,
]);

type ReviewedBatch={accountId:string;publicationScope?:PublicationScope;publicationReview?:{accountId:string;at:string;scopeDigest:string};
  reconciliation?:{requests:{action:{kind:string};decision?:string;decidedAt?:string;decidedBy?:string;appliedAt?:string;publicationScope?:PublicationScope}[]}};
type Delivery={id:string;roundKey:string|null;completion?:unknown;requiredArtifacts:readonly string[]|null};

/** A history disposition only affects eligibility; it never publishes or accepts work. */
export function reviewedHistoricalDeliveries(db:MissionGoDatabase,item:{id:string;key:string;productId:string;contentVersion:number;builderAccountId?:string|null;roundKey:string|null},records:readonly Delivery[]) {
  const candidates=records.filter(r=>!r.completion||r.requiredArtifacts===null),reviewed=new Set<string>();
  if(!candidates.length)return reviewed;
  const itemScope=deliveryScope([[item.id,item.contentVersion,item.builderAccountId??null,item.roundKey]]);
  const batches=db.connection.prepare(`SELECT data_json FROM merge_batches WHERE product_id=? AND EXISTS
    (SELECT 1 FROM json_each(json_extract(data_json,'$.publicationScope.candidates')) c WHERE json_extract(c.value,'$.itemKey')=?)`)
    .all(item.productId,item.key) as {data_json:string}[];
  for(const raw of batches) {
    const batch=JSON.parse(raw.data_json) as ReviewedBatch,scope=batch.publicationScope;
    if(!scope)continue;
    const startReview=batch.publicationReview;
    const reviewedAtStart=startReview?.accountId===batch.accountId&&Boolean(startReview.at)&&startReview.scopeDigest===scope.digest;
    const reviewedInRecovery=batch.reconciliation?.requests.some(r=>r.action.kind==="allow_partial_publication"&&r.decision==="approved"
      &&r.decidedAt&&r.decidedBy&&r.appliedAt&&r.publicationScope?.digest===scope.digest&&digest(r.publicationScope)===digest(scope));
    if(!reviewedAtStart&&!reviewedInRecovery)continue;
    for(const record of candidates) {
      const identity=`${item.key}:${record.id}`,frozen=scope.candidates.find(c=>c.identity===identity);
      if(!frozen?.historicalGapReason)continue;
      const observed:PublicationScopeRow={identity,title:frozen.title,selected:false,itemKey:item.key,developmentEventId:record.id,
        roundKey:record.roundKey,completion:record.completion,...(record.requiredArtifacts!==null?{requiredArtifacts:[...record.requiredArtifacts]}:{}),itemScope};
      if(historicalDeliveryFingerprint(frozen)===historicalDeliveryFingerprint(observed))reviewed.add(record.id);
    }
  }
  return reviewed;
}
