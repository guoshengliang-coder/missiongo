import {createHash} from "node:crypto";
import type {PublicationScope, PublicationScopeRow} from "@missiongo/contracts";
import type {MissionGoDatabase} from "./storage/database.js";

const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const deliveryScope=(rows:readonly (readonly [string,number,string|null,string|null])[])=>digest(rows);
export const historicalDeliveryFingerprint=(row:PublicationScopeRow)=>digest([
  row.identity,row.itemKey,row.developmentEventId,row.roundKey,row.completion??null,row.requiredArtifacts??null,row.itemScope,
]);

type ReviewedBatch={accountId:string;publicationScope?:PublicationScope;publicationReview?:{accountId:string;at:string;scopeDigest:string};
  reconciliation?:{
    requests:{action:{kind:string;publicationRefresh?:unknown};decision?:string;decidedAt?:string;decidedBy?:string;appliedAt?:string;publicationScope?:PublicationScope}[];
    history?:{action:string;previous?:unknown}[];
  }};
type Delivery={id:string;roundKey:string|null;completion?:unknown;requiredArtifacts:readonly string[]|null};

function reviewedScopes(batch:ReviewedBatch,accountId?:string):PublicationScope[] {
  // Recovery keeps the previous applied scope when it replaces the current snapshot.
  const snapshots=new Map<string,PublicationScope>();
  for(const entry of batch.reconciliation?.history??[]) {
    if(entry.action!=="refresh_publication_scope"||!entry.previous)continue;
    const scope=entry.previous as PublicationScope;
    snapshots.set(scope.digest,scope);
  }
  if(batch.publicationScope)snapshots.set(batch.publicationScope.digest,batch.publicationScope);
  const scopes:PublicationScope[]=[],startReview=batch.publicationReview;
  if(startReview?.accountId===batch.accountId&&startReview.at&&(accountId===undefined||startReview.accountId===accountId)) {
    const original=snapshots.get(startReview.scopeDigest);
    if(original)scopes.push(original);
  }
  for(const review of batch.reconciliation?.requests??[]) {
    if(review.action.kind!=="allow_partial_publication"||!review.action.publicationRefresh||review.decision!=="approved"
      ||!review.decidedAt||!review.decidedBy||!review.appliedAt||!review.publicationScope||(accountId!==undefined&&review.decidedBy!==accountId))continue;
    const applied=snapshots.get(review.publicationScope.digest);
    if(applied&&digest(applied)===digest(review.publicationScope))scopes.push(applied);
  }
  return scopes;
}

/** Match the original human review, without treating inherited reviews as new approvals. */
export function previouslyReviewedHistoricalGaps(db:MissionGoDatabase,productId:string,candidates:readonly PublicationScopeRow[],accountId?:string) {
  const reviewed=new Set<string>();
  const fingerprints=new Map(candidates.map(row=>[row.identity,historicalDeliveryFingerprint(row)]));
  if(!fingerprints.size)return reviewed;
  // Read owned bytes in bounded pages. Node 22.13 can return corrupted text
  // from StatementSync.iterate() for large JSON values; never treat a failed
  // decode as proof that the original review is absent.
  const page = db.connection.prepare(`SELECT rowid AS id, CAST(data_json AS BLOB) AS data FROM merge_batches
    WHERE product_id=? AND rowid>?
    AND (json_extract(data_json,'$.publicationReview') IS NOT NULL OR EXISTS (
      SELECT 1 FROM json_each(json_extract(data_json,'$.reconciliation.requests')) r
      WHERE json_extract(r.value,'$.publicationScope') IS NOT NULL AND json_extract(r.value,'$.appliedAt') IS NOT NULL))
    ORDER BY rowid LIMIT 32`);
  let cursor = 0;
  for (;;) {
    const batches = page.all(productId, cursor) as unknown as { id: number; data: Uint8Array }[];
    if (!batches.length) break;
    for (const raw of batches) {
      const batch = JSON.parse(Buffer.from(raw.data).toString("utf8")) as ReviewedBatch;
      for (const scope of reviewedScopes(batch, accountId)) {
        for (const row of scope.candidates) {
          const expected = fingerprints.get(row.identity);
          if (expected && row.historicalGapReason && !row.historicalGapPreviouslyReviewed && expected === historicalDeliveryFingerprint(row)) {
            reviewed.add(row.identity);
          }
        }
      }
      if (reviewed.size === fingerprints.size) return reviewed;
    }
    cursor = batches.at(-1)!.id;
  }
  return reviewed;
}

/** A history disposition only affects eligibility; it never publishes or accepts work. */
export function reviewedHistoricalDeliveries(db:MissionGoDatabase,item:{id:string;key:string;productId:string;contentVersion:number;builderAccountId?:string|null;roundKey:string|null},records:readonly Delivery[]) {
  const itemScope=deliveryScope([[item.id,item.contentVersion,item.builderAccountId??null,item.roundKey]]);
  const candidates=records.filter(r=>!r.completion||r.requiredArtifacts===null).map(record=>({
    identity:`${item.key}:${record.id}`,title:"",selected:false,itemKey:item.key,developmentEventId:record.id,
    roundKey:record.roundKey,completion:record.completion,...(record.requiredArtifacts!==null?{requiredArtifacts:[...record.requiredArtifacts]}:{}),itemScope,
  }));
  const reviewed=previouslyReviewedHistoricalGaps(db,item.productId,candidates);
  return new Set(candidates.filter(row=>reviewed.has(row.identity)).map(row=>row.developmentEventId));
}
