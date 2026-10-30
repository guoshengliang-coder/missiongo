import { BackButton } from "./back-button";
import { Modal } from "./modal";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus, RefreshCw, X } from "lucide-react";
import type { InsightQuery, InsightBatchStage } from "@missiongo/domain";
import { api } from "./api";
import { localizedErrorText } from "./error-text";
import { useI18n } from "./i18n";

export function StatisticsBatches({ accountId, scopeKey, input, valid, onOpenItem }: {
  accountId: string | undefined; scopeKey: string; input: InsightQuery & {productIds?: string[]}; valid: boolean;
  onOpenItem: (key: string, productId: string) => void;
}) {
  const { locale, t, statusLabel } = useI18n();
  const text = (cn: string, en: string) => locale === "zh-CN" ? cn : en;
  const percent = (rate: number | null) => rate === null ? "—" : new Intl.NumberFormat(locale, {style: "percent", maximumFractionDigits: 1}).format(rate);
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [activeId, setActiveId] = useState(() => new URL(window.location.href).searchParams.get("statsBatch") ?? "");
  const [search, setSearch] = useState("");
  const selectBatch = (id: string) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("statsBatch", id);
    else url.searchParams.delete("statsBatch");
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
    setActiveId(id); setStage("all"); setItemOffset(0); setDeleting(false); setItemsOpen(false);
  };
  useEffect(() => {
    const sync = () => {setActiveId(new URL(window.location.href).searchParams.get("statsBatch") ?? "");setStage("all");setItemOffset(0);setDeleting(false);setItemsOpen(false);};
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const [candidateOffset, setCandidateOffset] = useState(0);
  const [stage, setStage] = useState<InsightBatchStage | "cancelled" | "all">("all");
  const [itemOffset, setItemOffset] = useState(0);
  const [itemsOpen, setItemsOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const list = useQuery({queryKey: ["insight-batches", accountId, scopeKey], queryFn: api.insightBatches, enabled: Boolean(accountId)});
  const batchId = activeId || undefined;
  const progress = useQuery({queryKey: ["insight-batch", accountId, scopeKey, batchId],
    queryFn: () => api.insightBatchProgress(batchId!), enabled: Boolean(accountId && batchId)});
  const candidates = useQuery({queryKey: ["insight-batch-candidates", accountId, scopeKey, input, candidateOffset],
    queryFn: () => api.projectInsightItems({...input, metric: "created", limit: 25, offset: candidateOffset}), enabled: Boolean(accountId && creating && valid)});
  const create = useMutation({mutationFn: () => api.createInsightBatch(name, Object.keys(selected)), onSuccess: async batch => {
    await client.invalidateQueries({queryKey: ["insight-batches", accountId, scopeKey]});
    selectBatch(batch.id); setCreating(false); setSelected({}); setName(""); setStage("all"); setItemOffset(0);
  }});
  const remove = useMutation({mutationFn: () => api.deleteInsightBatch(batchId!), onSuccess: async () => {
    await client.invalidateQueries({queryKey: ["insight-batches", accountId, scopeKey]});
    selectBatch(""); setDeleting(false); setStage("all"); setItemOffset(0);
  }});
  const data = progress.data;
  const labels = {delivered: text("已交付", "Delivered"), processing: text("处理中", "In progress"),
    waiting: text("未开工", "Not started"), paused: text("暂停", "On hold"), cancelled: text("已取消", "Cancelled")};
  const filtered = data?.items.filter(item => stage === "all" || item.stage === stage) ?? [];
  const offset = Math.min(itemOffset, Math.max(0, Math.ceil(filtered.length / 25) - 1) * 25);
  return <section className="statistics-panel statistics-batches" aria-label={text("批次交付进度", "Batch delivery progress")}>
    <div className="statistics-panel-head"><h2>{text("批次交付进度", "Batch delivery progress")}</h2>
      <button type="button" className="secondary-button" disabled={!accountId} onClick={() => {setCreating(true);setName("");setSelected({});create.reset();setCandidateOffset(0);}}>
        {creating ? <X size={16}/> : <Plus size={16}/>}{creating ? text("收起", "Close") : text("创建批次", "Create batch")}
      </button></div>
    <p className="statistics-help">{text("保存一组固定条目，持续查看消化进度。批次仅自己可见，不随上方筛选增减；进度按当前状态计算。", "Save a fixed set of items and track its progress. Batches are private to your account, independent of report filters; progress uses current status.")}</p>
    {list.isError && <div role="alert"><p className="inline-error">{localizedErrorText(list.error, t)}</p><button type="button" className="secondary-button" onClick={() => void list.refetch()}>{text("重试", "Retry")}</button></div>}
    {list.isPending && accountId && <p role="status">{text("正在读取批次…", "Loading batches…")}</p>}
    {creating && <Modal title={text("创建批次", "Create batch")} subtitle={text("批次交付进度", "Batch delivery progress")} onClose={() => setCreating(false)} dirty={Boolean(name || Object.keys(selected).length)} pending={create.isPending} wide scrolls><form className="statistics-batch-create" onSubmit={event => {event.preventDefault();create.mutate();}}>
      <label>{text("批次名称", "Batch name")}<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder={text("例如：本周收到的 10 个反馈", "For example: 10 feedback items received this week")}/></label>
      <p className="statistics-help">{text("候选条目按上方已应用的产品、类型和创建日期筛选。可跨页勾选；保存后成员固定，低优先级和暂停不会被移出。", "Candidates use the applied product, type and creation dates above. Select across pages; saved membership stays fixed, including low-priority and paused items.")}</p>
      {!valid && <p role="alert" className="inline-error">{text("请先应用有效的统计范围。", "Apply a valid report range first.")}</p>}
      {candidates.isPending && valid && <p role="status">{text("正在读取候选条目…", "Loading candidates…")}</p>}
      {candidates.isError && <p role="alert" className="inline-error">{localizedErrorText(candidates.error,t)}</p>}
      {candidates.isSuccess && <>
        <div className="statistics-batch-candidates">{candidates.data.items.length ? candidates.data.items.map(item => <label key={item.itemKey}>
          <input type="checkbox" checked={Boolean(selected[item.itemKey])} disabled={!selected[item.itemKey] && Object.keys(selected).length >= 500}
            onChange={event => setSelected(previous => {const next = {...previous}; if(event.target.checked) next[item.itemKey] = item.title; else delete next[item.itemKey]; return next;})}/>
          <span><strong>{item.itemKey}</strong> {item.title}<small>{item.productName} · {statusLabel(item.currentStatus)}</small></span>
        </label>) : <p className="statistics-empty">{text("当前创建日期范围内没有条目，可调整上方筛选后重试。", "No items were created in this range. Adjust the report filters to try again.")}</p>}</div>
        <nav className="statistics-pagination" aria-label={text("候选条目分页", "Candidate pages")}>
          <button type="button" className="secondary-button" disabled={!candidateOffset} onClick={() => setCandidateOffset(Math.max(0,candidateOffset-25))}><ChevronLeft size={16}/>{text("上一页", "Previous")}</button>
          <span>{Math.floor(candidateOffset/25)+1} · {text("共", "Total")} {candidates.data.total}</span>
          <button type="button" className="secondary-button" disabled={candidates.data.nextOffset === undefined} onClick={() => setCandidateOffset(candidates.data.nextOffset!)}>{text("下一页", "Next")}<ChevronRight size={16}/></button>
        </nav>
      </>}
      <div className="statistics-batch-save form-footer"><button type="button" className="secondary-button" disabled={create.isPending} onClick={() => { setCreating(false); setName(""); setSelected({}); }}>{t("cancel")}</button><span>{text("已选", "Selected")} {Object.keys(selected).length} / 500</span>
        <button type="button" className="text-button" disabled={create.isPending} onClick={() => setSelected({})}>{text("清空选择", "Clear selection")}</button>
        <button type="submit" className="primary-button" disabled={!name.trim() || !Object.keys(selected).length || create.isPending}>{create.isPending ? text("保存中…", "Saving…") : text("保存固定批次", "Save fixed batch")}</button></div>
      {create.isError && <p className="inline-error" role="alert">{localizedErrorText(create.error,t)}</p>}
    </form></Modal>}
    {list.isSuccess && !list.data.batches.length && !creating && <p className="statistics-empty">{text("还没有批次。先选定一组条目，再查看这批交付了多少、还有多少未处理。", "No batches yet. Select a group of items to track deliveries and remaining work.")}</p>}
    {!batchId && list.isSuccess && Boolean(list.data.batches.length) && <>
      <div className="statistics-batch-toolbar"><label>{text("搜索批次", "Search batches")}<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <button type="button" className="secondary-button" disabled={list.isFetching} onClick={() => void list.refetch()}><RefreshCw size={16}/>{text("刷新进度", "Refresh progress")}</button></div>
      <div className="statistics-batch-list">
        {list.data!.batches.filter(batch => batch.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map(batch => <button key={batch.id} type="button" className="settings-hub-row" onClick={() => {selectBatch(batch.id);remove.reset();}}>
          <span><strong>{batch.name}</strong><small>{batch.itemCount} {text("条", "items")} · {new Date(batch.createdAt).toLocaleDateString(locale,{timeZone:"Asia/Shanghai"})}</small>
            <small>{batch.unavailable ? text("部分条目不可用，交付率暂不计算", "Some items are unavailable; delivery rate cannot be calculated") : `${text("已交付", "Delivered")} ${batch.delivered} / ${batch.effective}`}</small></span>
          <span className="statistics-batch-list-progress"><strong>{percent(batch.deliveryRate)}</strong><ChevronRight size={18}/></span>
        </button>)}
        {!list.data!.batches.some(batch => batch.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) && <p className="statistics-empty">{text("没有符合条件的批次。", "No batches match this search.")}</p>}
      </div>
    </>}
    {batchId && <div className="statistics-batch-toolbar">
      <BackButton label={text("返回批次列表", "Back to batches")} onClick={() => {selectBatch("");remove.reset();void list.refetch();}} />
      <strong>{data?.batch.name ?? list.data?.batches.find(batch => batch.id === batchId)?.name}</strong>
      <button type="button" className="secondary-button" disabled={progress.isFetching} onClick={() => {void progress.refetch();void list.refetch();}}><RefreshCw size={16}/>{text("刷新进度", "Refresh progress")}</button>
      <button type="button" className="text-button" onClick={() => setDeleting(true)}>{text("删除批次", "Delete batch")}</button>
    </div>}
    {deleting && <Modal title={text("删除批次确认", "Confirm batch deletion")} subtitle={list.data?.batches.find(batch => batch.id === batchId)?.name ?? ""} onClose={() => setDeleting(false)} pending={remove.isPending}><div className="statistics-batch-delete"><p>{text("仅删除这个批次记录，条目本身不受影响。", "Delete only this saved batch; its work items are unaffected.")}</p>
      <button type="button" className="secondary-button" disabled={remove.isPending} onClick={() => setDeleting(false)}>{text("保留", "Keep")}</button>
      <button type="button" className="danger-button" disabled={remove.isPending} onClick={() => remove.mutate()}>{text("确认删除批次", "Confirm deletion")}</button>
      {remove.isError && <p className="inline-error" role="alert">{localizedErrorText(remove.error,t)}</p>}</div></Modal>}
    {progress.isPending && batchId && <p role="status">{text("正在计算进度…", "Calculating progress…")}</p>}
    {progress.isError && <p role="alert" className="inline-error">{localizedErrorText(progress.error,t)}</p>}
    {batchId && progress.isSuccess && data && <>
      <div className="statistics-batch-summary"><div><strong>{percent(data.deliveryRate)}</strong><span>{text("交付进度", "Delivered")} · {data.delivered} / {data.effective}</span></div>
        <p>{text("原始", "Original")} {data.total} · {text("取消", "Cancelled")} {data.cancelled} · {text("有效", "Effective")} {data.effective}<br/>{text("截至", "As of")} {new Date(data.dataAsOf).toLocaleString(locale,{timeZone:"Asia/Shanghai"})}</p></div>
      {data.unavailable > 0 && <p className="statistics-help" role="status">{text("存在已删除、迁出或失去查看权限的条目：", "Deleted, transferred or no longer visible items: ")}{data.unavailable}{text("。仍保留在原始数量中，交付率暂不计算。", ". Original membership is retained; delivery percentages are unavailable.")}</p>}
      <div className="statistics-batch-stages">{(Object.keys(labels) as Array<keyof typeof labels>).map(key => <button type="button" key={key} className={`statistics-batch-stage statistics-batch-stage-${key}`} aria-pressed={stage===key} onClick={() => {setStage(stage===key ? "all" : key);setItemOffset(0);setItemsOpen(true);}}><span>{labels[key]}</span><strong>{data[key]}</strong></button>)}</div>
      <p className="statistics-help">{text("待验证与已完成算已交付；验收打回后进度回退。取消单列并从有效分母中扣除，未开工和暂停仍计入。", "Pending verification and done are delivered; returns move progress back. Cancelled items are listed separately and excluded from the effective denominator; waiting and paused items remain.")}</p>
      <div className="statistics-batch-milestones">{data.milestones.map(value => <article key={value.days}><h3>{text("收到后", "After receipt ·")} {value.days} {text("天交付率", "days")}</h3><strong>{percent(value.rate)}</strong>
        <p>{value.delivered} / {value.eligible} · {text("截至各条目创建后该天的状态", "State at each item’s deadline")}</p>
        <p>{text("未满观察期", "Not yet observed")} {value.immature} · {text("当时已取消", "Cancelled then")} {value.cancelled} · {text("历史缺失", "Missing history")} {value.unknown}</p></article>)}</div>
      <details className="statistics-batch-items" open={itemsOpen} onToggle={event => setItemsOpen(event.currentTarget.open)}><summary>{text("查看批次条目", "View batch items")} · {data.items.length}</summary>
      <div className="statistics-panel-head"><h3>{stage === "all" ? text("批次条目", "Batch items") : labels[stage]} · {filtered.length}</h3>{stage!=="all" && <button type="button" className="text-button" onClick={() => {setStage("all");setItemOffset(0);}}>{text("查看全部", "Show all")}</button>}</div>
      <ul className="statistics-items">{filtered.slice(offset,offset+25).map(item => <li key={item.itemKey}><button className="statistics-item-link" type="button" onClick={() => onOpenItem(item.itemKey,item.productId)}><strong>{item.itemKey}</strong><span>{item.title}</span></button><div className="statistics-item-meta"><span>{statusLabel(item.status)}</span><span>{text("收到", "Received")} {new Date(item.createdAt).toLocaleDateString(locale,{timeZone:"Asia/Shanghai"})}</span></div></li>)}</ul>
      {!filtered.length && <p className="statistics-empty">{text("当前分组没有条目。", "No items in this group.")}</p>}
      {filtered.length > 25 && <nav className="statistics-pagination" aria-label={text("批次条目分页", "Batch item pages")}><button className="secondary-button" type="button" disabled={!offset} onClick={() => setItemOffset(offset-25)}>{text("上一页", "Previous")}</button><span>{Math.floor(offset/25)+1}</span><button className="secondary-button" type="button" disabled={offset+25>=filtered.length} onClick={() => setItemOffset(offset+25)}>{text("下一页", "Next")}</button></nav>}
      </details>
    </>}
  </section>;
}
