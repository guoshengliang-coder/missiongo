import type { AgentSessionListItem, AgentSessionSnapshot } from "./agent-session-store.js";
import type { MissionGoDatabase } from "./storage/database.js";
import { invalidInput, notFound } from "./errors.js";

type Message = AgentSessionSnapshot["messages"][number];
interface Key {
  id: string; session_id: string; source_id: string; role: Message["role"]; phase: string | null;
  occurred_at: string; position: number; observed_at: string; ordinal: number; priority: number;
}
interface Source { id: string; external: boolean }

/** Operates only on the already-authorized conversation members. Reads never mutate source rows.
 * Canonicalization precedes the page boundary: a lower-priority mirror must not
 * reappear on a later page just because its timestamp differs from the winner. */
export class StoredSessionMessages {
  constructor(private readonly database: MissionGoDatabase) {}
  private get db() { return this.database.connection; }

  private sources(id: string, members: readonly AgentSessionListItem[]): Source[] {
    return [...members].sort((a,b) => Number(b.id === id)-Number(a.id === id))
      .map(row => ({id:row.id,external:row.source === "external"}));
  }

  private select(sources: Source[], extra = "", args: Array<string | number> = [], limit = 51, orderOverride?: string): Key[] {
    if (sources.length>100) return this.selectMany(sources,extra,args,limit,orderOverride);
    const merged = sources.length > 1;
    const parts = sources.map((source, priority) => {
      const role = source.external ? "json_extract(m.payload_json,'$.role')" : "m.role";
      const phase = source.external ? "json_extract(m.payload_json,'$.phase')" : "m.phase";
      const occurred = source.external ? "COALESCE(json_extract(m.payload_json,'$.occurredAt'),'')" : "m.occurred_at";
      const observed = source.external ? "''" : "m.observed_at";
      const prior = sources.slice(0, priority).map(earlier => `NOT EXISTS(SELECT 1 FROM ${earlier.external ? "external_native_messages" : "agent_session_messages"} p
        WHERE p.session_id=${sqlLiteral(earlier.id)} AND p.source_id=m.source_id
        AND ${earlier.external ? "json_extract(p.payload_json,'$.role')" : "p.role"}=${role}
        AND COALESCE(${earlier.external ? "json_extract(p.payload_json,'$.phase')" : "p.phase"},'')<>'execution')`).join(" AND ");
      return `SELECT m.id,m.session_id,m.source_id,${role} AS role,${phase} AS phase,${occurred} AS occurred_at,
        m.position,${observed} AS observed_at,m.rowid AS ordinal,${priority} AS priority
        FROM ${source.external ? "external_native_messages" : "agent_session_messages"} m
        WHERE m.session_id=${sqlLiteral(source.id)} AND COALESCE(${phase},'')<>'execution' ${prior ? `AND ${prior}` : ""}`;
    });
    if (!parts.length) return [];
    const order = merged ? "occurred_at DESC,priority DESC,position DESC,observed_at DESC,ordinal DESC"
      : "position DESC,observed_at DESC,ordinal DESC";
    return this.db.prepare(`SELECT * FROM (${parts.join(" UNION ALL ")}) ${extra} ORDER BY ${orderOverride ?? order} LIMIT ?`)
      .all(...args,limit) as unknown as Key[];
  }

  /** Long-lived threads can have hundreds of hand-offs. Do not generate one
   * compound SELECT per member (SQLite normally permits only 500). For these
   * large groups rank lightweight metadata in SQL; still fetch only page bodies. */
  private selectMany(sources:Source[],extra:string,args:Array<string|number>,limit:number,orderOverride?:string):Key[] {
    return this.db.prepare(`WITH members AS (
        SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.external') AS external,CAST(key AS INTEGER) AS priority FROM json_each(?)
      ), entries AS (
        SELECT m.id,m.session_id,m.source_id,m.role,m.phase,m.occurred_at,m.position,m.observed_at,m.rowid AS ordinal,s.priority
          FROM members s JOIN agent_session_messages m ON m.session_id=s.id WHERE s.external=0 AND COALESCE(m.phase,'')<>'execution'
        UNION ALL SELECT m.id,m.session_id,m.source_id,json_extract(m.payload_json,'$.role'),json_extract(m.payload_json,'$.phase'),
          COALESCE(json_extract(m.payload_json,'$.occurredAt'),''),m.position,'',m.rowid,s.priority
          FROM members s JOIN external_native_messages m ON m.session_id=s.id WHERE s.external=1 AND COALESCE(json_extract(m.payload_json,'$.phase'),'')<>'execution'
      ), ranked AS (
        SELECT *,ROW_NUMBER() OVER(PARTITION BY role,source_id ORDER BY priority) AS winner FROM entries
      ) SELECT * FROM ranked WHERE winner=1 ${extra?`AND ${extra.slice(6)}`:""}
      ORDER BY ${orderOverride??"occurred_at DESC,priority DESC,position DESC,observed_at DESC,ordinal DESC"} LIMIT ?`)
      .all(JSON.stringify(sources),...args,limit) as unknown as Key[];
  }

  private *iterateBodies(keys: readonly Key[], sources: Source[]): Generator<Message> {
    // Reuse one prepared primary-key seek per source. Iterate in selected key
    // order and stop at the byte boundary; a SQL sort of 50 complete bodies
    // could otherwise buffer 200 MB before returning the first oversized row.
    const selectedSources=new Set(keys.map(key=>key.session_id));
    const statements=new Map(sources.filter(source=>selectedSources.has(source.id)).map(source=>[source.id,{external:source.external,statement:this.db.prepare(source.external
      ? "SELECT id,payload_json FROM external_native_messages WHERE id=? AND session_id=?"
      : "SELECT id,source_id,turn_id,role,phase,text,questions_json,occurred_at FROM agent_session_messages WHERE id=? AND session_id=?")} ]));
    for (const key of keys) {
      const source=statements.get(key.session_id)!;
      const row=source.statement.get(key.id,key.session_id) as unknown as {id:string;source_id:string;turn_id:string|null;role:Message["role"];phase:string|null;
        text:string;questions_json:string|null;occurred_at:string;payload_json:string};
      yield source.external ? {...JSON.parse(row.payload_json),id:row.id} : {
        id:row.id,sourceId:row.source_id,role:row.role,text:row.text,occurredAt:row.occurred_at,
        ...(row.turn_id ? {turnId:row.turn_id} : {}),...(row.phase ? {phase:row.phase} : {}),
        ...(row.questions_json ? {questions:JSON.parse(row.questions_json)} : {})};
    }
  }

  private bodies(keys: readonly Key[], sources: Source[]): Message[] { return [...this.iterateBodies(keys,sources)]; }

  page(id: string, members: readonly AgentSessionListItem[], before?: string): {messages: Message[]; nextCursor?: string} {
    const sources = this.sources(id,members);
    let extra = "", args: Array<string|number> = [];
    if (before !== undefined) {
      if (!before.startsWith("stored:")) throw invalidInput("Invalid stored history cursor.");
      const anchor = this.select(sources,"WHERE id=?",[before.slice(7)],1)[0];
      if (!anchor) throw notFound("Stored history anchor");
      extra = sources.length > 1 ? "WHERE (occurred_at,priority,position,observed_at,ordinal)<(?,?,?,?,?)"
        : "WHERE (position,observed_at,ordinal)<(?,?,?)";
      args = [...(sources.length > 1 ? [anchor.occurred_at,anchor.priority] : []),anchor.position,anchor.observed_at,anchor.ordinal];
    }
    const keys = this.select(sources,extra,args);
    const messages:Message[]=[];
    let bytes = 0, count = 0;
    for (const message of this.iterateBodies(keys.slice(0,50),sources)) {
      const size = Buffer.byteLength(JSON.stringify(message));
      if (count && bytes+size>512*1024) break;
      bytes+=size;count++;messages.push(message);
    }
    const page = messages.slice(0,count).reverse();
    return {messages:page,...(keys.length>count && page.length ? {nextCursor:`stored:${page[0]!.id}`} : {})};
  }

  /** Small authoritative context for plan validity; never use the visible page
   * as evidence that an earlier user input or declined plan does not exist. */
  context(id: string, members: readonly AgentSessionListItem[], nativeSourceId?: string): Message[] {
    const sources = this.sources(id,members), keys = new Map<string,Key>();
    const add = (rows: Key[]) => rows.forEach(row => keys.set(row.id,row));
    add(this.select(sources,"WHERE role<>'user'",[],1));
    add(this.select(sources,"WHERE role='user'",[],1));
    // Deduplication is by role/source ID, so an ID can still represent up to
    // three roles across mirrors. Keep them all: assess() uses the first source
    // occurrence and must also see any declined variant, not merely the newest.
    if (nativeSourceId) add(this.select(sources,"WHERE source_id=?",[nativeSourceId],3));
    // Legacy source timestamps can disagree with position. The source-less
    // registered-plan check needs the maximum user timestamp, not just its tail.
    add(this.select(sources,"WHERE role='user'",[],1,"occurred_at DESC,priority DESC,position DESC,observed_at DESC,ordinal DESC"));
    return this.bodies([...keys.values()].sort((a,b) => sources.length>1
      ? a.occurred_at.localeCompare(b.occurred_at)||a.priority-b.priority||a.position-b.position||a.observed_at.localeCompare(b.observed_at)||a.ordinal-b.ordinal
      : a.position-b.position||a.observed_at.localeCompare(b.observed_at)||a.ordinal-b.ordinal),sources);
  }

  reports(id:string,members:readonly AgentSessionListItem[],before?:string): {
    progressReports:NonNullable<AgentSessionSnapshot["progressReports"]>;nextCursor?:string;
  } {
    const sources=this.sources(id,members).filter(source=>source.external);
    if (!sources.length) {
      if (before) throw notFound("Progress history anchor");
      return {progressReports:[]};
    }
    const ids=JSON.stringify(sources.map(source=>source.id));
    const from=`FROM json_each(?) j JOIN external_agent_session_reports r ON r.session_id=j.value`;
    let args:Array<string|number>=[ids],where="";
    if(before!==undefined){
      if(!before.startsWith("reports:"))throw invalidInput("Invalid progress history cursor.");
      const anchor=this.db.prepare(`SELECT r.created_at,CAST(j.key AS INTEGER) AS priority,r.rowid AS ordinal ${from} WHERE r.id=?`)
        .get(ids,before.slice(8)) as {created_at:string;priority:number;ordinal:number}|undefined;
      if(!anchor)throw notFound("Progress history anchor");
      where="WHERE (r.created_at,CAST(j.key AS INTEGER),r.rowid)<(?,?,?)";
      args=[ids,anchor.created_at,anchor.priority,anchor.ordinal];
    }
    const keys=this.db.prepare(`SELECT r.id,r.session_id ${from} ${where}
      ORDER BY r.created_at DESC,CAST(j.key AS INTEGER) DESC,r.rowid DESC LIMIT 51`).all(...args) as {id:string;session_id:string}[];
    const get=this.db.prepare("SELECT id,item_key,text,status,created_at FROM external_agent_session_reports WHERE id=? AND session_id=?");
    const reports:Array<{id:string;text:string;occurredAt:string}>=[];let bytes=0;
    for(const key of keys.slice(0,50)){
      const row=get.get(key.id,key.session_id) as {id:string;item_key:string;text:string|null;status:string;created_at:string};
      const report={id:row.id,text:`${row.item_key} · ${row.text??row.status}`,occurredAt:row.created_at};
      const size=Buffer.byteLength(JSON.stringify(report));if(reports.length && bytes+size>512*1024)break;
      bytes+=size;reports.push(report);
    }
    const nextCursor=keys.length>reports.length && reports.length ? `reports:${reports.at(-1)!.id}` : undefined;
    return {progressReports:reports.reverse(),...(nextCursor?{nextCursor}:{})};
  }

  currentRequests(id: string, members: readonly AgentSessionListItem[]): Message[] {
    const sources = this.sources(id,members);
    // The partial indexes cover question-bearing rows; ordinary long histories
    // do not need to be parsed merely to find the current form.
    const keys: Key[] = [];
    for (let priority=0;priority<sources.length;priority++) {
      const source=sources[priority]!;
      const phase=source.external ? "json_extract(payload_json,'$.phase')" : "phase";
      const questions=source.external ? "json_extract(payload_json,'$.questions')" : "questions_json";
      const rows=this.db.prepare(`SELECT id FROM ${source.external ? "external_native_messages" : "agent_session_messages"}
        WHERE session_id=? AND ${questions} IS NOT NULL AND COALESCE(${phase},'')<>'execution'
        AND EXISTS(SELECT 1 FROM json_each(${questions}) q WHERE json_extract(q.value,'$.answered') IS NULL
          AND COALESCE(json_extract(q.value,'$.withdrawn'),0)=0)`).all(source.id) as {id:string}[];
      for (const row of rows) {
        const key=this.select(sources,"WHERE id=?",[row.id],1)[0];
        if (key) keys.push(key);
      }
    }
    return this.bodies(keys,sources);
  }
}

// Values come from authorized DB identities, but still must be bound/escaped.
function sqlLiteral(value: string): string { return `'${value.replaceAll("'","''")}'`; }
