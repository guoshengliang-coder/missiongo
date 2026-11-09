/** Classify our prepared SQL without turning read-only CTEs into write locks.
 * Quoted values/identifiers and comments cannot introduce SQL keywords. */
export function sourceMutation(sql:string, batch=false):boolean {
  const clean=sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g," ");
  if(batch)return /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(clean);
  let depth=0;
  for(const match of clean.matchAll(/[()]|[A-Za-z_]+/g)) {
    const token=match[0].toUpperCase();
    if(token==="("){depth++;continue;}
    if(token===")"){depth--;continue;}
    if(depth || token==="WITH" || token==="RECURSIVE")continue;
    if(["INSERT","UPDATE","DELETE","REPLACE"].includes(token))return true;
    if(["SELECT","PRAGMA","EXPLAIN","CREATE","DROP","ALTER"].includes(token))return false;
  }
  return false;
}
