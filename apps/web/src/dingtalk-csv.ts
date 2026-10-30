import type { DingTalkImportRow } from "@missiongo/domain";

/** CSV is parsed locally; the server receives bounded structured rows. */
export function parseDingTalkCsv(source: string): DingTalkImportRow[] {
  if (source.length>256_000) throw new Error("CSV 超过 256 KB，请分批导入。");
  const table:string[][]=[];let row:string[]=[],field="",quoted=false,closed=false;
  const input=source.replace(/^\uFEFF/,"");
  for(let i=0;i<input.length;i++) {
    const char=input[i]!;
    if(quoted) {
      if(char==='"' && input[i+1]==='"'){field+='"';i++;}
      else if(char==='"'){quoted=false;closed=true;} else field+=char;
    } else if(char==='"') {
      if(field || closed)throw new Error("CSV 引号格式无效。");quoted=true;
    } else if(char==="," || char==="\n" || char==="\r") {
      row.push(field);field="";closed=false;
      if(char!==","){if(row.some(cell=>cell.trim()))table.push(row);row=[];if(char==="\r" && input[i+1]==="\n")i++;}
    } else {if(closed)throw new Error("CSV 引号后只能是逗号或换行。");field+=char;}
  }
  if(quoted)throw new Error("CSV 存在未闭合的引号。");
  row.push(field);if(row.some(cell=>cell.trim()))table.push(row);
  const header=table.shift()?.map(value=>value.trim());
  if(!header || header.length!==4 || !["邮箱,MissionGo 邮箱,email".split(",").includes(header[0]!),["钉钉用户 ID","钉钉企业用户 ID","userId"].includes(header[1]!),["姓名","name"].includes(header[2]!),["部门","department"].includes(header[3]!)].every(Boolean)) throw new Error("表头应为：邮箱,钉钉用户 ID,姓名,部门");
  if(!table.length || table.length>500)throw new Error("每次导入 1 至 500 行。");
  return table.map((cells,index)=>{if(cells.length!==4)throw new Error(`第 ${index+2} 行应有 4 列。`);return {email:cells[0]!.trim(),userId:cells[1]!.trim(),name:cells[2]!.trim(),department:cells[3]!.trim()};});
}
