import type { MissionGoStore } from "./store.js";
import type { MergeDeliveries } from "./merge-deliveries.js";
import { completionPayload } from "./completion.js";

/** The single candidate-page contract for MCP and explicit Web release preview. */
export function releaseCandidatePage(store:MissionGoStore,merges:MergeDeliveries,productId:string,limit=100,beforeSequence?:number,includeUnscoped=true) {
      const coverage=includeUnscoped;
      const itemBefore=coverage && beforeSequence ? Math.ceil(beforeSequence/2) : beforeSequence;
      const itemPage = store.listWorkItems({productId,releaseCandidates:true,limit,...(itemBefore ? {beforeSequence:itemBefore} : {})});
      const standalone=coverage ? merges.releaseCandidates(productId,beforeSequence,limit) : [];
      const page=[...itemPage.map(item=>({sequence:Number(item.key.slice(item.key.lastIndexOf("-")+1))*(coverage?2:1),item})),...standalone]
        .sort((a,b)=>b.sequence-a.sequence).slice(0,limit);
      const items=page.flatMap(row=>"item" in row ? [row.item] : []);
      const noReleaseItems: Array<{ itemKey: string; noReleaseReason: string }> = [];
      const candidates = items.flatMap(item => {
        const records=store.getDeliveryRecords(item.key);
        const outstanding=records.filter(d=>!d.published);
        if(!records.length && item.status==="development_complete") {
          if(!includeUnscoped) return [];
          const e=store.getDevelopmentEvidence(item.key);
          return [{itemKey:item.key,expectedRevision:item.revision,developmentEventId:e.handover?.id,roundKey:e.roundKey}];
        }
        return outstanding.flatMap(record=>{
          const {completion,requiredArtifacts,noReleaseReason}=record;
          if(requiredArtifacts?.length===0 && noReleaseReason) {
            if(!noReleaseItems.some(row=>row.itemKey===item.key)) noReleaseItems.push({itemKey:item.key,noReleaseReason});return [];
          }
          if(!includeUnscoped && (!completion || !requiredArtifacts?.length)) return [];
          return [{itemKey:item.key,expectedRevision:item.revision,developmentEventId:record.id,roundKey:record.roundKey,
            ...(completion?completionPayload(completion):{}),...(requiredArtifacts!==null?{requiredArtifacts}: {})}];
        });
      });
      const deliveryCandidates=page.flatMap(row=>{
        if(!("delivery" in row)) return [];
        const d=row.delivery;
        if(!d.requiredArtifacts.length && d.noReleaseReason) return [];
        if(d.requiredArtifacts.length && d.requiredArtifacts.every(a=>d.releaseReceipts?.some(r=>r.releases.some(release=>release.artifact===a)))) return [];
        return [row.candidate];
      });
      const noReleaseDeliveries=page.flatMap(row=>"delivery" in row && !row.delivery.requiredArtifacts.length && row.delivery.noReleaseReason
        ? [{deliveryId:row.delivery.id,noReleaseReason:row.delivery.noReleaseReason}] : []);
      const lastSequence=page.at(-1)?.sequence;
      return {
        productId,
        candidates:[...candidates,...deliveryCandidates],
        ...(includeUnscoped ? { coverageVersion: 2, generatedAt: new Date().toISOString(), noReleaseItems, noReleaseDeliveries } : {}),
        ...(page.length === limit && Number.isSafeInteger(lastSequence) ? { nextBeforeSequence: lastSequence } : {}),
      };
}
