import "@vitejs/plugin-react/preamble";
import { createRoot } from "react-dom/client";
import { Select } from "../../apps/web/src/select";
import "../../apps/web/src/styles.css";

createRoot(document.getElementById("root")!).render(<main style={{ padding: 16 }}>
  <Select aria-label="多位数菜单" defaultValue="unlinked" fitContent
    renderOption={() => <span className="agent-console-option"><span>非派单会话</span>
      <span className="agent-console-option-counts"><span className="agent-console-option-running">999999999 运行中</span><span>/</span><span>999999999</span></span>
    </span>}>
    <option value="unlinked">非派单会话</option>
  </Select>
</main>);
