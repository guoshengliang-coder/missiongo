import { useEffect,useRef,useState } from "react";
import { api } from "./api";
import { MarkdownText } from "./markdown-text";
import { useI18n } from "./i18n";
import type { AgentSession } from "./types";
type Reports=NonNullable<AgentSession["progressReports"]>;

/** Operational reports are retained separately from the native transcript. */
export function AgentProgressReports({ session }: { session: AgentSession | undefined }) {
  const { t } = useI18n();
  const [state,setState]=useState({id:session?.id,older:[] as Reports,next:undefined as string|null|undefined,loading:false,error:false});
  const active=useRef(session?.id);active.current=session?.id;
  const busy=useRef(false);
  const generation=useRef(0);
  useEffect(()=>{generation.current++;busy.current=false;setState({id:session?.id,older:[],next:undefined,loading:false,error:false});},[session?.id]);
  useEffect(()=>{
    generation.current++;busy.current=false;
    setState(old=>old.id!==session?.id?old:({...old,
      older:[...new Map([...old.older,...(session?.progressReports??[])].map(report=>[report.id,report])).values()],
      next:undefined,loading:false,error:false}));
  },[session?.id,session?.progressReports?.at(-1)?.id]);
  const current=state.id===session?.id?state:undefined;
  const reports=[...new Map([...(current?.older??[]),...(session?.progressReports??[])].map(report=>[report.id,report])).values()];
  const cursor=current?.next===undefined?session?.progressHistory?.nextCursor:current.next??undefined;
  const load=async()=>{
    if(!session || !cursor || busy.current)return;
    const id=session.id,run=generation.current;busy.current=true;setState(old=>({...old,loading:true,error:false}));
    try{
      const page=await api.getProgressReports(id,cursor);
      if(active.current!==id || generation.current!==run)return;
      if(page.nextCursor===cursor)throw new Error("Progress cursor did not advance");
      setState(old=>old.id!==id?old:({...old,older:[...new Map([...page.progressReports,...old.older].map(report=>[report.id,report])).values()],next:page.nextCursor??null,loading:false,error:false}));
    }catch{if(active.current===id && generation.current===run)setState(old=>({...old,loading:false,error:true}));}
    finally{if(active.current===id && generation.current===run)busy.current=false;}
  };
  if (!session || !reports.length) return null;
  const hasMessages = session.messages?.some(message => message.phase !== "execution");
  return <details open={!hasMessages} className="agent-session-muted" data-testid="agent-progress-reports">
    <summary>{t("agentProgressReports")}{hasMessages ? ` · ${reports.at(-1)!.text.split("\n")[0]!.slice(0, 160)}` : ""}</summary>
    {cursor && <button type="button" className="secondary-button" disabled={current?.loading} onClick={()=>void load()}>
      {t(current?.loading?"agentHistoryLoading":current?.error?"agentHistoryRetry":"agentHistoryOlder")}</button>}
    {current?.error && <p className="inline-error" role="alert">{t("agentHistoryLoadFailed")}</p>}
    {reports.map(report => <article key={report.id}>
      <time dateTime={report.occurredAt}>{report.occurredAt}</time>
      <MarkdownText>{report.text}</MarkdownText>
    </article>)}
  </details>;
}
