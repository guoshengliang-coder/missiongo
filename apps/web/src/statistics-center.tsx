import { Select } from "./select";
import { BackButton } from "./back-button";
import { StatisticsBatches } from "./statistics-batches";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { InsightMetric, InsightMetrics } from "@missiongo/domain";
import { api } from "./api";
import { localizedErrorText } from "./error-text";
import { useI18n } from "./i18n";
import { ITEM_TYPES, ITEM_STATUSES, type Product } from "./types";
import { statisticsDatesValid, statisticsQuery, statisticsState, statisticsStateUrl, statisticsToday, type StatisticsFilters, type StatisticsSelection } from "./statistics-state";

function openDatePicker(event: MouseEvent<HTMLInputElement>) {
  try {
    event.currentTarget.showPicker?.();
  } catch {
    // Keep native date editing available if the browser cannot open its picker.
  }
}

export function StatisticsCenter({products,accountId,onClose,onOpenItem}:{products:readonly Product[];accountId:string|undefined;onClose:()=>void;onOpenItem:(key:string,productId:string)=>void}) {
  const {locale,t,statusLabel,typeLabel}=useI18n(); const zh=locale==="zh-CN";
  const label=(cn:string,en:string)=>zh ? cn : en;
  const initial=useRef(statisticsState()).current;
  const [filters,setFilters]=useState(initial.filters),[draft,setDraft]=useState(initial.filters);
  const [selection,setSelection]=useState<StatisticsSelection|null>(initial.selection);
  const [filterError,setFilterError]=useState(false);
  const detailRef=useRef<HTMLElement>(null);
  const number=(n:number)=>new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(n);
  const duration=(hours:number|null)=>hours===null ? "—" : hours>=48 ? `${number(hours/24)} ${label("天","days")}` : `${number(hours)} ${label("小时","hours")}`;
  const titles:Record<InsightMetric,string>={started_to_delivery:label("开工至交付周期","Start-to-delivery cycle"),created:label("新增条目","New items"),development_complete:label("开发完成","Development complete"),pending_verification:label("进入待验证","Released for verification"),completed:label("人工完成","Human-completed"),backlog:label("当前积压","Current backlog"),period_end_backlog:label("期末积压","Period-end backlog"),returned:label("验收打回条目","Returned items"),stalled:label("阶段停留 ≥ 7 天","Stage age ≥ 7 days"),repeat_returned:label("期内多次打回","Repeated returns in period")};
  const queryInput=statisticsQuery(filters);
  const scopeKey=products.map(product=>product.id).sort().join(",");
  const query=useQuery({queryKey:["project-insights",accountId,scopeKey,queryInput],queryFn:()=>api.projectInsights(queryInput),enabled:Boolean(accountId)&&statisticsDatesValid(filters),staleTime:60000});
  const detailInput={...queryInput,...(selection?.product ? {productIds:[selection.product]} : {}),
    ...(selection?.day ? {period:"custom" as const,startDate:selection.day,endDate:selection.endDay ?? selection.day} : {}),
    ...(selection?.status ? {statuses:[selection.status]} : {}),metric:selection?.metric ?? "created",limit:25,offset:selection?.offset ?? 0};
  const details=useQuery({queryKey:["project-insight-items",accountId,scopeKey,detailInput],queryFn:()=>api.projectInsightItems(detailInput),enabled:Boolean(accountId)&&selection!==null&&query.isSuccess,staleTime:60000});
  useEffect(()=>{history.replaceState(history.state,"",statisticsStateUrl(filters,selection));},[filters,selection]);
  const expand=(metric:InsightMetric,product?:string,day?:string,status?:StatisticsSelection["status"],endDay?:string)=>{
    setSelection({metric,product,day,status,offset:0,...(endDay ? {endDay} : {})});
    requestAnimationFrame(()=>detailRef.current?.scrollIntoView({behavior:"smooth",block:"start"}));
  };
  const changeScope=(product:string)=>{const next={...filters,product};setFilters(next);setDraft(next);setSelection(null);};
  const range=query.data?.period;
  const summary=query.data?.aggregate;
  const dirty=JSON.stringify(filters)!==JSON.stringify(draft);
  const metricButton=(metric:InsightMetric,value:number,product?:string)=> <button type="button" className="statistics-number" onClick={()=>expand(metric,product)} aria-label={`${titles[metric]} ${number(value)}`}>{number(value)}</button>;
  const cycle=(metrics:InsightMetrics,kind:"deliveryCycle"|"startToDeliveryCycle")=>{
    const value=metrics[kind],metric=kind==="deliveryCycle" ? "completed" : "started_to_delivery";
    return <div className="statistics-cycle"><h3>{kind==="deliveryCycle" ? label("提交至人工完成","Submission to human completion") : label("开工至交付周期","Start-to-delivery cycle")}</h3>
      <button type="button" className="statistics-cycle-value" onClick={()=>expand(metric)} aria-label={label("查看周期样本：","View cycle samples: ")+titles[metric]}>{duration(value.medianHours)}</button>
      {kind === "startToDeliveryCycle" && <p>{label("首次处理中 → 首次待验证，按首次交付时间纳入统计。", "First in progress → first pending verification, grouped by first delivery date.")}</p>}
      <p>{label("中位数","Median")} · {label("有效样本","Valid samples")} {value.sampleCount} / {value.eligibleCount} · {label("缺失","Missing")} {value.missingCount}</p>
      <p>{value.p90Hours===null ? label("P90：至少需要 10 个有效样本","P90 requires at least 10 valid samples") : `P90 ${duration(value.p90Hours)}`}</p>
    </div>;
  };
  return <main className="statistics-center">
    <header className="statistics-header"><BackButton onClick={onClose} label={label("返回工作区","Back to workspace")} />
      <div className="statistics-heading"><p className="eyebrow"><BarChart3 size={14}/>{label("工作流与交付","WORKFLOW & DELIVERY")}</p><h1>{label("产品统计","Product statistics")}</h1></div>
      <button type="button" className="secondary-button" disabled={!accountId||query.isFetching} onClick={()=>{void query.refetch();if(selection)void details.refetch();}}><RefreshCw size={16} className={query.isFetching ? "spin" : ""}/>{label("刷新","Refresh")}</button>
    </header>
    <div className="statistics-content">
      <form className={`statistics-filters ${draft.period === "custom" ? "has-custom-dates" : ""}`} onSubmit={event=>{event.preventDefault();if(!statisticsDatesValid(draft)){setFilterError(true);return;}setFilterError(false);setFilters({...draft});setSelection(null);}}>
        <label>{label("产品范围","Products")}<Select value={draft.product} onChange={e=>setDraft({...draft,product:e.target.value})}><option value="all">{label("全部可见产品","All visible products")}</option>{products.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}{draft.product!=="all"&&!products.some(p=>p.id===draft.product)&&<option value={draft.product}>{label("产品不可用","Unavailable product")}</option>}</Select></label>
        <label>{label("统计时间","Period")}<Select value={draft.period} onChange={e=>setDraft({...draft,period:e.target.value as StatisticsFilters["period"]})}>
          <option value="today">{label("今天","Today")}</option><option value="yesterday">{label("昨天","Yesterday")}</option><option value="last7Days">{label("最近 7 天","Last 7 days")}</option><option value="thisMonth">{label("本月","This month")}</option><option value="custom">{label("自定义时间","Custom dates")}</option></Select></label>
        <label>{label("条目类型","Item type")}<Select value={draft.type} onChange={e=>setDraft({...draft,type:e.target.value as StatisticsFilters["type"]})}><option value="all">{label("全部类型","All types")}</option>{ITEM_TYPES.map(type=><option value={type} key={type}>{typeLabel(type)}</option>)}</Select></label>
        {draft.period === "custom" && (
          <div className="statistics-date-range" role="group" aria-label={label("自定义日期范围", "Custom date range")}>
            <label>{label("开始日期", "Start date")}<input type="date" required max={statisticsToday()} value={draft.start} onClick={openDatePicker} onChange={e => setDraft({...draft, start: e.target.value})}/></label>
            <label>{label("结束日期", "End date")}<input type="date" required max={statisticsToday()} value={draft.end} onClick={openDatePicker} onChange={e => setDraft({...draft, end: e.target.value})}/></label>
          </div>
        )}
        <button type="submit" className="primary-button">{label("应用筛选","Apply filters")}</button>
        {dirty&&<p className="statistics-filter-note" role="status">{label("筛选尚未应用，报表仍按下方已显示的范围统计。","Filters have not been applied; the report still uses its displayed scope.")}</p>}
        {(filterError||!statisticsDatesValid(filters))&&<p className="inline-error" role="alert">{label("请选择有效日期，开始不晚于结束，结束不晚于今天，范围不超过 366 天。","Choose valid dates: start ≤ end ≤ today, spanning at most 366 days.")}</p>}
      </form>
      {query.isPending&&accountId&&statisticsDatesValid(filters)&&<p role="status" className="statistics-loading"><LoaderCircle className="spin" size={18}/>{label("正在计算统计…","Loading statistics…")}</p>}
      {!accountId&&<p role="status" className="statistics-help">{label("连接工作区后即可查看统计。", "Connect to the workspace to view statistics.")}</p>}
      {query.isError&&<div role="alert" className="statistics-error"><strong>{label("无法读取统计","Unable to load statistics")}</strong><p>{localizedErrorText(query.error,t)}</p><button className="secondary-button" type="button" onClick={()=>void query.refetch()}>{label("重试","Retry")}</button></div>}
      {query.isSuccess&&range&&summary&&<>
        <div className="statistics-range"><p><strong>{filters.product==="all" ? label("全部可见产品","All visible products") : products.find(p=>p.id===filters.product)?.name}</strong> · {filters.type==="all" ? label("全部类型","All types") : typeLabel(filters.type)} · {range.startDate} — {range.endDate} · {range.timezone}</p><p>{label("数据截至","Data as of")} {new Date(range.dataAsOf).toLocaleString(locale,{timeZone:range.timezone})}</p></div>
        <section className="statistics-metrics" aria-label={label("核心指标","Key metrics")}>
          {(["created","development_complete","pending_verification","completed","period_end_backlog","backlog"] as const).map(metric=><article className={`statistics-metric ${metric==="completed" ? "statistics-metric-completed" : ""}`} key={metric}><h2>{titles[metric]}</h2>{metricButton(metric,summary.counts[metric])}<p>{metric==="backlog" ? label("当前未完成、未取消","Open now; excludes cancelled") : metric==="period_end_backlog" ? label("按历史状态重建","Reconstructed from history") : label("统计期内的不同条目","Distinct items in the period")}</p></article>)}
        </section>
        {!query.data.projects.length&&<p className="statistics-empty">{label("此范围暂无可见产品。","No visible products in this scope.")}</p>}
        <div className="statistics-delivery-grid">
        <section className="statistics-panel statistics-weekly" aria-label={label("每周交付吞吐量", "Weekly delivery throughput")}>
          <div className="statistics-panel-head"><h2>{label("每周交付吞吐量", "Weekly delivery throughput")}</h2><span>{label("进入待验证的不同条目数", "Distinct items entering pending verification")}</span></div>
          <p className="statistics-help">{label("北京时间周一至周日；同一条目同周多次交付只计一次，跨周再次交付分别计入。未满周包含本周及被筛选范围截断的周。", "Monday–Sunday in Beijing time. Repeat deliveries deduplicate within a week, but count again across weeks. Partial weeks include the current week and weeks clipped by the filter.")}</p>
          <div className="statistics-week-bars">{summary.weeklyDeliveries?.map(week => <button type="button" key={week.weekStart} className="statistics-week" onClick={() => expand("pending_verification", undefined, week.startDate, undefined, week.endDate)} aria-label={`${week.startDate} — ${week.endDate} ${label("交付", "Delivered")} ${week.delivered}`}>
            <span className="statistics-week-label">{week.weekStart} — {week.weekEnd}{week.partial && <small>{label("未满周", "Partial week")}</small>}</span>
            <span className="statistics-week-track"><span style={{width: `${week.delivered / Math.max(1,...(summary.weeklyDeliveries ?? []).map(value => value.delivered)) * 100}%`}}/></span>
            <strong>{number(week.delivered)}</strong>
          </button>)}</div>
        </section>
          <section className="statistics-panel"><h2>{label("交付与验收","Delivery & verification")}</h2>{cycle(summary,"startToDeliveryCycle")}{cycle(summary,"deliveryCycle")}
            <div className="statistics-return"><h3>{label("验收打回率","Verification return rate")}</h3><button type="button" className="statistics-cycle-value" aria-label={label("查看验收打回条目","View returned items")} onClick={()=>expand("returned")}>{summary.verificationReturnRate.rate===null ? "—" : `${number(summary.verificationReturnRate.rate*100)}%`}</button>
              <p>{label("失败","Failed")} {summary.verificationReturnRate.failedRounds} / {label("已决定轮次","Decided rounds")} {summary.verificationReturnRate.decidedRounds} · {label("通过","Passed")} {summary.verificationReturnRate.passedRounds}</p><p>{label("失败 ÷（通过 + 失败）；未决验收不计入。轮次数与不同条目数分别统计。","Failed ÷ (passed + failed); pending verification excluded. Rounds and distinct items are separate counts.")}</p></div>
          </section>
        </div>
        <StatisticsBatches accountId={accountId} scopeKey={scopeKey} input={queryInput} valid={statisticsDatesValid(filters)} onOpenItem={onOpenItem}/>
        <div className="statistics-grid">
          <section className="statistics-panel statistics-trend"><div className="statistics-panel-head"><h2>{label("每日吞吐与积压","Daily throughput & backlog")}</h2><span>{label("点击数字查看明细","Select a value for details")}</span></div>
            <p className="statistics-help">{label("每日完成数量按条目去重；同一条跨日再次完成，会分别计入当天。期间总数按整个期间去重。当天积压截至当前时间。","Daily completion deduplicates items per day; a repeated completion on another day appears again. Period totals deduplicate across the entire period. Today’s backlog is measured as of now.")}</p>
            <div className="statistics-table-scroll statistics-trend-scroll" tabIndex={0} role="region" aria-label={label("每日趋势表，可滚动","Daily trends, scrollable")}><table><thead><tr><th scope="col">{label("日期","Date")}</th><th scope="col">{label("新增","Created")}</th><th scope="col">{label("人工完成","Human-completed")}</th><th scope="col">{label("当日期末积压","Day-end backlog")}</th></tr></thead><tbody>
              {summary.trend?.map(point=><tr key={point.date}><th scope="row">{point.date}</th>{(["created","completed","backlog"] as const).map(metric=>{
                const max=Math.max(1,...(summary.trend??[]).map(day=>day[metric]));const target=metric==="backlog" ? "period_end_backlog" : metric;
                return <td key={metric}><button type="button" className={`statistics-bar statistics-bar-${metric}`} aria-label={`${point.date} ${titles[target]} ${point[metric]}`} onClick={()=>expand(target,undefined,point.date)}><span aria-hidden="true" className="statistics-bar-fill" style={{width:`${point[metric]/max*100}%`}}/><span>{number(point[metric])}</span>{metric==="backlog"&&point.unknownStatusCount>0&&<small>{label("未知","Unknown")} {point.unknownStatusCount}</small>}</button></td>;
              })}</tr>)}
            </tbody></table></div>
          </section>
          <section className="statistics-panel statistics-projects"><h2>{label("各产品情况","By product")}</h2><div className="statistics-table-scroll" role="region" tabIndex={0} aria-label={label("产品报表，可横向滚动","Product report, horizontally scrollable")}><table><thead><tr><th scope="col">{label("产品","Product")}</th>{(["created","development_complete","pending_verification","completed","backlog"] as const).map(metric=><th scope="col" key={metric}>{titles[metric]}</th>)}<th scope="col">{label("打回条目","Returned items")}</th></tr></thead><tbody>{query.data.projects.map(project=><tr key={project.productId}><th scope="row"><button type="button" className="statistics-project-link" onClick={()=>changeScope(project.productId)}>{project.productName}</button></th>{(["created","development_complete","pending_verification","completed","backlog","returned"] as const).map(metric=><td key={metric}>{metricButton(metric,project.counts[metric],project.productId)}</td>)}</tr>)}</tbody></table></div></section>
          <section className="statistics-panel"><h2>{label("当前积压分布","Current backlog by stage")}</h2><div className="statistics-stages">{ITEM_STATUSES.filter(status=>status!=="done"&&status!=="cancelled").map(status=><button type="button" key={status} onClick={()=>expand("backlog",undefined,undefined,status)}><span>{statusLabel(status)}</span><strong>{number(summary.currentByStatus[status])}</strong></button>)}</div>
            <div className="statistics-watch"><button type="button" onClick={()=>expand("stalled")}><span>{titles.stalled}</span><strong>{summary.counts.stalled}</strong></button><button type="button" onClick={()=>expand("repeat_returned")}><span>{titles.repeat_returned}</span><strong>{summary.counts.repeat_returned}</strong></button></div>
          </section>
        </div>
        <section className="statistics-panel statistics-details" ref={detailRef} aria-label={label("条目明细","Item details")}>
          {selection ? <><div className="statistics-panel-head"><h2>{titles[selection.metric]}{selection.day ? ` · ${selection.day}${selection.endDay ? ` — ${selection.endDay}` : ""}` : ""}</h2><button type="button" className="icon-button" onClick={()=>setSelection(null)} aria-label={label("关闭明细","Close details")}><X size={18}/></button></div>
            <p className="statistics-help">{selection.product ? products.find(p=>p.id===selection.product)?.name : label("所选产品范围","Selected product scope")} · {selection.status ? statusLabel(selection.status)+" · " : ""}{details.data?.period.startDate??range.startDate} — {details.data?.period.endDate??range.endDate} · {range.timezone} · {filters.type==="all" ? label("全部类型","All types") : typeLabel(filters.type)}</p>
            {details.isPending&&<p role="status">{label("正在读取明细…","Loading details…")}</p>}{details.isError&&<p className="inline-error" role="alert">{localizedErrorText(details.error,t)}</p>}
            {details.isSuccess&&<><p className="statistics-help">{label("共","Total")} {details.data.total} {label("条；状态列为当前状态。","items; statuses below are current.")}</p>{details.data.items.length===0 ? <p className="statistics-empty">{label("此筛选下没有条目。","No items match these filters.")}</p> : <ul className="statistics-items">{details.data.items.map(item=><li key={item.itemKey}><button type="button" className="statistics-item-link" onClick={()=>onOpenItem(item.itemKey,item.productId)}><strong>{item.itemKey}</strong><span>{item.title}</span></button><div className="statistics-item-meta"><span>{item.productName}</span><span>{typeLabel(item.type)}</span><span>{label("当前","Now")}: {statusLabel(item.currentStatus)}</span><span>{label("期末","Period end")}: {item.periodEndStatus ? statusLabel(item.periodEndStatus) : label("未知","Unknown")}</span>{item.deliveryHours!==null&&<span>{label("提交至人工完成","Submission to completion")}: {duration(item.deliveryHours)}</span>}{item.startToDeliveryHours!==null&&<span>{label("开工至交付", "Start to delivery")}: {duration(item.startToDeliveryHours)}</span>}
              {selection.metric === "started_to_delivery" && <><span>{label("首次开工", "First start")}: {item.firstStartedAt ? new Date(item.firstStartedAt).toLocaleString(locale,{timeZone:range.timezone}) : label("缺失", "Missing")}</span><span>{label("首次交付", "First delivery")}: {item.firstDeliveredAt ? new Date(item.firstDeliveredAt).toLocaleString(locale,{timeZone:range.timezone}) : label("缺失", "Missing")}</span></>}{item.stageHours!==null&&<span>{label("当前阶段","Current stage")}: {duration(item.stageHours)}</span>}{item.verificationFailuresTotal>0&&<span>{label("期内 / 历史打回","Period / lifetime returns")}: {item.verificationFailuresInPeriod} / {item.verificationFailuresTotal}</span>}</div></li>)}</ul>}
              <nav className="statistics-pagination" aria-label={label("明细分页","Detail pages")}><button type="button" className="secondary-button" disabled={selection.offset===0} onClick={()=>setSelection({...selection,offset:Math.max(0,selection.offset-25)})}><ChevronLeft size={16}/>{label("上一页","Previous")}</button><span>{Math.floor(selection.offset/25)+1}</span><button type="button" className="secondary-button" disabled={details.data.nextOffset===undefined} onClick={()=>setSelection({...selection,offset:details.data.nextOffset!})}>{label("下一页","Next")}<ChevronRight size={16}/></button></nav>
            </>}
          </> : <p className="statistics-empty">{label("点击指标或图表数字，在此查看对应条目。","Select a metric or chart value to explore its items here.")}</p>}
        </section>
        <section className="statistics-quality"><h2>{label("统计口径与数据覆盖","Definitions & data coverage")}</h2><p>{label("新增按创建时间；完成按期内进入人工完成的不同条目统计。开工至交付从首次处理中计至首次待验证，包含开工后的暂停及发布等待；提交至人工完成还包含开工前排队和验收等待。阶段停留按当前阶段至少 7 个自然日计算。","Creation uses submission time; completion counts distinct items entering done by a human in the period. Start-to-delivery measures first in progress to first pending verification, including pauses and release waits; submission-to-completion also includes queue and verification waits. Stalled means at least seven calendar days in the current stage.")}</p><p>{label("当前积压使用当前状态；期末积压和每日积压按历史事件重建。产品与类型使用当前归属，转移来源及复制历史不重复计数。","Current backlog uses current status; period-end and daily backlog are reconstructed from events. Project and type dimensions use their current values; transferred sources and copied history are excluded.")}</p><p>{label("缺少创建事件","Missing creation events")}: {summary.quality.missingCreationEvents} · {label("期末状态未知","Unknown period-end states")}: {summary.quality.unknownPeriodEnd} · {label("合并/发布仅有记录时间","Recorded-only merge/release times")}: {summary.quality.estimatedEventTimes} · {label("无法解析的事件","Unparseable events")}: {query.data.invalidEventCount}</p></section>
      </>}
    </div>
  </main>;
}
