import "@vitejs/plugin-react/preamble";
// Browser-only component harness, served by Vite through the UI audit route.
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { Select } from "../../apps/web/src/select";
import "../../apps/web/src/styles.css";

function Harness() {
  const [value, setValue] = useState("");
  const [disabled, setDisabled] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [submitted, setSubmitted] = useState("");
  const [changes, setChanges] = useState(0);
  return <main style={{ padding: 24 }}>
    <form onSubmit={event => { event.preventDefault(); setSubmitted(String(new FormData(event.currentTarget).get("choice"))); }}>
      <label htmlFor="choice">选择项目</label>
      <Select id="choice" name="choice" required value={value} disabled={disabled}
        onChange={event => { setValue(event.target.value); setChanges(count => count + 1); }}>
        <option value="">请选择</option>
        <optgroup label="第一组"><option value="alpha">Alpha</option><option value="blocked" disabled>禁用选项</option><option value="beta">Beta 很长的选项文字，需要在窄屏菜单中完整展示而且不能撑宽视口。{expanded && "动态更新的后缀"}</option></optgroup>
        <optgroup label="禁用组" disabled><option value="group-disabled">组内禁用</option></optgroup>
        <option value="charlie">Charlie</option>
        {expanded && Array.from({ length: 24 }, (_, i) => <option key={i} value={`extra-${i}`}>扩展选项 {i}</option>)}
      </Select>
      <button type="submit">提交</button><button type="button" onClick={() => { setValue("beta"); setExpanded(true); }}>外部更新</button>
      <button type="button" onClick={() => setDisabled(!disabled)}>禁用控件</button>
    </form>
    <output aria-label="已提交">{submitted}</output><output aria-label="变更次数">{changes}</output>
    <form><label>未受控<Select name="uncontrolled" defaultValue="a"><option value="a">初始值</option><option value="b">另一项</option></Select></label><button type="reset">重置</button></form>
    <button type="button" onClick={() => document.querySelector("dialog")?.showModal()}>打开弹窗</button>
    <dialog style={{ width: "90vw", maxWidth: 550, height: "90vh" }}>
      <div style={{ height: 110, overflow: "hidden", padding: 12, border: "1px solid" }}>
        <label>弹窗选项<Select defaultValue="a"><option value="a">第一项</option>{Array.from({ length: 30 }, (_, i) => <option key={i} value={`dialog-${i}`}>弹窗选项 {i}</option>)}</Select></label>
      </div>
      <button type="button" onClick={() => document.querySelector("dialog")?.close()}>关闭弹窗</button>
    </dialog>
  </main>;
}
createRoot(document.getElementById("root")!).render(createElement(Harness));
