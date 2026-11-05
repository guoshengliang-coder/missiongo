import { expect, it } from "vitest";
import { nativeModeResult } from "./claude-capabilities.js";
it("uses exact native mode confirmation, including custom providers and model changes",()=>{
 expect(nativeModeResult("auto",{subtype:"success",response:{mode:"auto"}},"custom-gateway")).toMatchObject({state:"available",model:"custom-gateway"});
 expect(nativeModeResult("auto",{subtype:"success",response:{mode:"default"}},"official-looking-model").state).toBe("unavailable");
 expect(nativeModeResult("auto",{subtype:"error",error:"Native policy rejected the mode"}).state).toBe("unavailable");
 expect(nativeModeResult("auto",{subtype:"success",response:{}}).state).toBe("unknown");
});
