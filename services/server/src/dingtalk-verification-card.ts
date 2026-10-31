/** Plain, bounded template data: work-item text must never introduce card actions. */
export function cardText(value: string): string {
  return value.replace(/[\r\n\t]+/g," ").replace(/[\\`*_{}[\]<>#!|]/g," ").replace(/\s+/g," ").trim();
}

export function limitCardText(value: string, maxBytes = 1000): string {
  if (Buffer.byteLength(value,"utf8") <= maxBytes) return value;
  let result="";
  for (const char of value) {
    if (Buffer.byteLength(result+char+"…","utf8") > maxBytes) break;
    result+=char;
  }
  return result+"…";
}

export function verificationSummary(description: string, title: string): string {
  const plain=cardText(description
    .replace(/```[\s\S]*?```/g," ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g," ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g,"$1")
    .replace(/https?:\/\/\S+/g," ")
    .replace(/^\s*#{1,6}\s+.*$/gm," "));
  return plain===cardText(title) ? "" : limitCardText(plain);
}

export function verificationInstructions(payload: Record<string,unknown>): string {
  // Only this round's verified release evidence identifies delivered platforms.
  const releases=payload.reason==="release_verified" && typeof payload.receiptDigest==="string" && Array.isArray(payload.releases)
    ? payload.releases : [];
  const artifacts=new Set(releases.flatMap((value:unknown)=>
    value && typeof value==="object" && "artifact" in value && typeof value.artifact==="string" && "version" in value && typeof value.version==="string"
      ? [value.artifact] : []));
  const instructions: Record<string,string>={
    web:"Web：重新打开网站，使用后验收。",
    androidApp:"Android：下载并安装最新版本，使用后验收。",
    iosApp:"iOS：更新至最新版本，使用后验收。",
    macosApp:"macOS：下载并安装最新的 Mac 版本，使用后验收。",
    windowsApp:"Windows：下载并安装最新的 Windows 版本，使用后验收。",
  };
  const lines=Object.entries(instructions).filter(([artifact])=>artifacts.has(artifact)).map(([,line])=>line);
  if ([...artifacts].some(artifact=>!Object.hasOwn(instructions,artifact))) lines.push("其他产物：请进入条目查看交付内容和验收环境后验收。");
  return lines.join("\n") || "请进入条目查看交付内容和验收环境后验收。";
}

export function buildVerificationCard(input: {projectName:string;itemKey:string;itemTitle:string;description:string;itemUrl:string;payload:Record<string,unknown>}, theme="blue") {
  const headerTitle=limitCardText(`已交付 ${cardText(input.itemKey)} ｜ 请验收`);
  const project=limitCardText(cardText(input.projectName),240);
  // Reserve markup bytes so the heading stays well-formed even at the API limit.
  const title=limitCardText(cardText(input.itemTitle),1000-Buffer.byteLength(project+" | ****","utf8"));
  const heading=`${project} | **${title}**`;
  const summary=verificationSummary(input.description,input.itemTitle);
  const verification=verificationInstructions(input.payload);
  return {
    headerTitle,heading,summary,verification,theme,itemUrl:input.itemUrl,
    // Keep existing templates usable during staged deployment / rollback.
    projectItem:`${project} ｜ ${cardText(input.itemKey)}`,itemTitle:title,
  };
}
