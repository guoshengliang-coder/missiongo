import type { CommentAudienceInput } from "@missiongo/domain";
export interface DraftMention { readonly start:number; readonly end:number; readonly label:string; readonly accountId?:string; readonly target?:"all" }
export function mentionQuery(text:string,cursor:number): {start:number;end:number;query:string}|null {
  const match=/(?:^|\s)@([^\s@]*)$/u.exec(text.slice(0,cursor));
  if(!match)return null;
  return {start:cursor-match[1]!.length-1,end:cursor,query:match[1]!};
}
/** Keep a token only if an edit leaves its exact span intact. Same-named people stay distinct. */
export function editMentions(before:string,after:string,mentions:readonly DraftMention[]):DraftMention[] {
  let prefix=0;while(prefix<before.length && prefix<after.length && before[prefix]===after[prefix])prefix++;
  let suffix=0;while(suffix<before.length-prefix && suffix<after.length-prefix && before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
  const end=before.length-suffix,delta=after.length-before.length;
  return mentions.flatMap(mention=>{
    if(mention.end<=prefix)return [mention];
    if(mention.start>=end)return [{...mention,start:mention.start+delta,end:mention.end+delta}];
    return [];
  }).filter(mention=>after.slice(mention.start,mention.end)===`@${mention.label}`);
}
export function mentionAudience(mentions:readonly DraftMention[]):CommentAudienceInput {
  return {mentionAccountIds:[...new Set(mentions.flatMap(mention=>mention.accountId?[mention.accountId]:[]))],
    mentionTargets:mentions.some(mention=>mention.target==="all")?["all"]:[]};
}

/** Keep recipients selected by an Agent visible without repeating names already in the comment. */
export function additionalMentionNames(text:string,names:readonly string[]):string[] {
  const hasToken=(label:string)=>{
    const token=`@${label}`;
    let at=text.indexOf(token);
    while(at>=0){
      const next=text.slice(at+token.length,at+token.length+1);
      if(!next || /[\s\p{P}\p{S}]/u.test(next))return true;
      at=text.indexOf(token,at+token.length);
    }
    return false;
  };
  return [...new Set(names)].filter(name=>!hasToken(name));
}
