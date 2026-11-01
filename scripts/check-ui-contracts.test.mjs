import assert from "node:assert/strict";
import { test } from "node:test";
import { uiContractViolations } from "./check-ui-contracts.mjs";

test("new surfaces cannot bypass focus and Back with an ARIA-only dialog", () => {
  assert.equal(uiContractViolations("new-preview.tsx", '<div role="dialog" aria-modal="true" />').length, 1);
  assert.equal(uiContractViolations("new-preview.tsx", '<div role={"dialog"} />').length, 1);
  assert.equal(uiContractViolations("new-preview.tsx", '<OverlayDialog aria-label="Preview" onClose={close} />').length, 0);
});
test("new native dialogs and extra dialogs in a registered file fail", () => {
  assert.ok(uiContractViolations("preview.tsx", '<dialog />').length);
  assert.ok(uiContractViolations("App.tsx", 'useModalSurface(dialogRef, close); <dialog /><dialog />').length);
  assert.ok(uiContractViolations("App.tsx", 'dialog.showModal(); <dialog />').length);
  assert.equal(uiContractViolations("App.tsx", 'useModalSurface(dialogRef, close); <dialog />').length, 0);
});
test("action menus share lifecycle while inline disclosures remain native", () => {
  assert.ok(uiContractViolations("actions.tsx", '<details className="new-action-menu">').length);
  assert.equal(uiContractViolations("actions.tsx", '<OverlayMenu className="new-action-menu">').length, 0);
  assert.equal(uiContractViolations("details.tsx", '<details className="environment-more">').length, 0);
});
