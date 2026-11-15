import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const snapshot = {
      version: "fixture", registered: true, server: "https://missiongo.example.com", name: "测试设备", running: false, loginPending: false, managedEnabled: false,
      agents: {}, health: { state: "stopped", agents: [] },
      products: [{ id: "fixture", name: "测试项目", keyPrefix: "FX" }], repos: [], distributions: ["Ubuntu-24.04"],
      preferences: { runtime: "native", distribution: "", launchAtLogin: false, startHidden: false, notifications: true },
    };
    Object.assign(window, { setUpdate: (update: unknown) => Object.assign(snapshot,{update}), desktop: {
      subscribe: () => () => {},
      request: async (value: Record<string, unknown>) => {
        if (value.method === "checkUpdates") Object.assign(snapshot,{update:{state:"available",version:"0.1.1",notes:"更新 Agent 识别与原生权限能力"}});
        if (value.method === "installUpdate") Object.assign(snapshot,{update:{state:"downloading",version:"0.1.1",percent:42,transferred:42,total:100}});
        if (value.method === "cancelUpdate") Object.assign(snapshot,{update:{state:"cancelled",version:"0.1.1"}});
        if (value.method === "snapshot") return structuredClone(snapshot);
        if (value.method === "listDistributions") return ["Ubuntu-24.04"];
        if (value.method === "preferences") snapshot.preferences = value.value as typeof snapshot.preferences;
        if (value.method === "run") snapshot.running = value.enabled as boolean;
        if (value.method === "agent" && value.enabled) snapshot.agents = { ...snapshot.agents, [String(value.kind)]: value.settings };
        if (value.method === "managed") snapshot.managedEnabled = value.enabled as boolean;
        if (value.method === "chooseDirectory") return "C:\\开发\\my repository";
        if (value.method === "repository") snapshot.repos = value.path ? [{ productId: "fixture", repoPath: value.path }] as never[] : [];
        return {};
      },
    } });
  });
});

for (const colorScheme of ["light", "dark"] as const) for (const width of [320, 1000]) {
  test(`${colorScheme} ${width}: controls fit and unsaved Agent settings survive an accidental close`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 }); await page.emulateMedia({ colorScheme }); await page.goto("/");
    await expect(page.getByRole("heading", { name: "Agent 集成" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "启用", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").first().fill("C:\\custom path\\codex.cmd");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "继续编辑" })).toBeVisible();
    await dialog.getByRole("button", { name: "继续编辑" }).click();
    await expect(dialog.getByRole("textbox").first()).toHaveValue("C:\\custom path\\codex.cmd");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.screenshot({ path: `test-results/windows-${colorScheme}-${width}.png`, fullPage: true });
  });
}

for (const colorScheme of ["light", "dark"] as const) for (const width of [320, 1000]) test(`${colorScheme} ${width}: WSL saves its explicit nvm Node path`, async ({ page }) => {
  await page.setViewportSize({ width, height: 600 }); await page.emulateMedia({ colorScheme });
  await page.goto("/"); await page.getByRole("button", { name: "本机设置" }).click();
  await page.getByRole("combobox", { name: "执行环境", exact: true }).click();
  await page.getByRole("option", { name: "WSL", exact: true }).click();
  await page.getByLabel("WSL 发行版", { exact: true }).fill("Ubuntu-24.04");
  await page.getByLabel("WSL Node.js 绝对路径").fill("/home/fixture/.nvm/versions/node/v22.13.0/bin/node");
  expect(await page.getByRole("dialog").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: `test-results/windows-wsl-${colorScheme}-${width}.png`, fullPage: true });
  for (const name of ["登录 Windows 后启动客户端", "启动时收起到托盘", "显示会话待处理通知"]) {
    const label = page.getByRole("checkbox", { name }).locator("..");
    // Allow subpixel rounding at the scroll viewport edge (less than one pixel).
    await label.scrollIntoViewIfNeeded(); await expect(label).toBeInViewport({ ratio: 0.99 });
  }
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeInViewport({ ratio: 0.99 });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("WSL · Ubuntu-24.04", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "本机设置" }).click();
  await expect(page.getByLabel("WSL Node.js 绝对路径")).toHaveValue("/home/fixture/.nvm/versions/node/v22.13.0/bin/node");
});

test("managed execution starts disabled and needs an enabled Codex plus explicit saved opt-in", async ({ page }) => {
  await page.goto("/"); await expect(page.getByRole("button", { name: "设置受控执行" })).toBeDisabled();
  await page.getByRole("button", { name: "启用", exact: true }).first().click(); await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "设置受控执行" }).click();
  const checkbox = page.getByRole("checkbox", { name: "允许此环境接收受控执行" }); await expect(checkbox).not.toBeChecked();
  await checkbox.check(); await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("已允许此环境接收受控 Codex 任务", { exact: true })).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) test(`${colorScheme}: update progress, cancellation and retry stay reachable at 320px`,async({page})=>{
  await page.setViewportSize({width:320,height:600});await page.emulateMedia({colorScheme});await page.goto("/");
  await page.getByRole("button",{name:"检查更新",exact:true}).click();
  await page.getByText("更新内容",{exact:true}).click();await expect(page.getByText("更新 Agent 识别与原生权限能力",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"下载更新",exact:true}).click();
  const progress=page.getByRole("progressbar",{name:"更新下载进度"});await expect(progress).toHaveAttribute("value","42");
  await expect(page.getByRole("button",{name:"检查更新",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"取消下载",exact:true}).scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`test-results/windows-update-${colorScheme}-320.png`,fullPage:true});
  await page.getByRole("button",{name:"取消下载",exact:true}).click();await expect(page.getByText(/下载已取消/)).toBeVisible();
  await page.getByRole("button",{name:"下载更新",exact:true}).click();await expect(progress).toBeVisible();
  await page.evaluate(()=> (window as unknown as {setUpdate:(value:unknown)=>void}).setUpdate({state:"verifying",version:"0.1.1"}));
  await expect(page.getByText(/正在校验更新签名/)).toBeVisible();await expect(page.getByRole("button",{name:"取消下载",exact:true})).toHaveCount(0);
  await page.evaluate(()=> (window as unknown as {setUpdate:(value:unknown)=>void}).setUpdate({state:"failed",version:"0.1.1",error:"更新包签名身份校验失败，未安装"}));
  await expect(page.getByText(/签名身份校验失败/)).toBeVisible();await expect(page.getByRole("button",{name:"下载更新",exact:true})).toBeEnabled();
});
