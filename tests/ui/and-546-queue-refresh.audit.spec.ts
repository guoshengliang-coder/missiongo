import { expect, test } from '@playwright/test';

test('AND-546 keeps two selected deliveries stable and requires review of a changed publication scope', async ({ page, request }) => {
  const product = await (await request.post('/api/v1/products', {
    data: { name: 'Button flicker fixture', keyPrefix: 'FLICKER' },
  })).json();
  const rows = [1, 2].map(n => ({
    id: 'delivery-' + n, revision: 'revision-' + n, sessionId: 'source-' + n,
    productId: product.id, state: 'confirmed', summary: 'Pending PR ' + n,
    validation: 'Fixture check', itemKeys: [], head: String(n).repeat(40),
    requiredArtifacts: ['web'], pullRequestUrl: 'https://github.com/example/project/pull/' + n,
    evidence: { checkedAt: '2026-11-27T00:00:00Z', source: 'fixture' },
    queue: { stage: 'merge', publishedArtifacts: [], pendingArtifacts: ['web'], records: [] },
  }));
  let queueReads = 0, queueStatus = 200, previewReads = 0;
  let withdrawn = false, active = false;
  let gate: (() => void) | undefined;
  let digest = 'stable-scope';
  await page.clock.setFixedTime(new Date('2026-11-27T00:00:00Z'));
  const scope = { digest: 'stable-scope', requiredArtifacts: ['web'], blockers: [],
    candidates: rows.map(row => ({identity: row.id, title: row.summary, selected: true, requiredArtifacts: ['web']})) };
  await page.route('**/integration-queue?**', route => {
    queueReads++;
    const stage = new URL(route.request().url()).searchParams.get('stage');
    if (queueStatus !== 200 && stage === 'all') return route.fulfill({status: queueStatus, json: {}});
    const delivered = stage === 'release' ? [] : withdrawn ? rows.slice(1) : rows;
    return route.fulfill({json: {deliveries: delivered, counts: {merge: withdrawn ? 1 : 2}, occupancy: {active: active && stage === 'all'}}});
  });
  await page.route('**/integration-preview', async route => {
    expect(route.request().postDataJSON().selection).toEqual(rows.map(({id, revision}) => ({id, revision})));
    previewReads++;
    if (previewReads === 2 || previewReads === 4) await new Promise<void>(resolve => { gate = resolve; });
    await route.fulfill({json: {...scope, digest}});
  });
  await page.route('**/api/v1/nodes', route => route.fulfill({json: {nodes: [{
    id: 'node', name: 'Fixture node', online: true, supportsFreeSessions: true,
    agents: [{kind: 'codex', planApprovalProtocol: 1, ready: true, models: []}],
    repos: [{productId: product.id, repoPath: 'fixture'}], repoCandidates: [],
  }]}}));
  await page.route(/\/api\/v1\/(dispatch-defaults|integration-defaults)$/, route =>
    route.fulfill({json: {nodeId: 'node', agentKind: 'codex', agents: {codex: {mode: 'auto'}}}}));
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (typeof input !== 'string' || !input.startsWith('/api/v1/console/events')) return originalFetch(input, init);
      const stream = new ReadableStream({start(controller) {
        let i = 0;
        Object.assign(window, {emitQueueEvent(kind: 'sessions' | 'merge') {
          const id = 'flicker-fixture:' + ++i;
          const body = JSON.stringify({resources: [{kind, resourceId: 'unrelated-session'}]});
          controller.enqueue(new TextEncoder().encode('id: ' + id + '\nevent: change\ndata: ' + body + '\n\n'));
        }});
      }});
      return Promise.resolve(new Response(stream, {headers: {'content-type': 'text/event-stream'}}));
    };
  });
  const emit = (kind: 'sessions' | 'merge' = 'sessions') => page.evaluate(
    kind => (window as unknown as {emitQueueEvent: (kind: string) => void}).emitQueueEvent(kind), kind,
  );
  await page.goto(`/?product=${product.id}&console=agent`);
  await page.getByRole('button', {name: '待集成 2', exact: true}).click();
  const dialog = page.getByRole('dialog');
  for (const box of await dialog.locator('.merge-row input').all()) await box.check();
  const next = dialog.getByRole('button', {name: '下一步：配置 Agent', exact: true});
  await expect(next).toBeEnabled();
  const initialQueueReads = queueReads;
  await emit(); await expect.poll(() => queueReads).toBeGreaterThan(initialQueueReads);
  await expect(next).toBeEnabled();
  expect(previewReads).toBe(0);
  queueStatus = 503;
  await emit();
  await expect(dialog.getByRole('alert').filter({hasText: '待集成清单加载失败'})).toBeVisible();
  await expect(next).toBeEnabled();
  for (const box of await dialog.locator('.merge-row input').all()) await expect(box).toBeChecked();
  queueStatus = 200;
  await emit(); await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('button', {name: '待发布 0', exact: true}).click();
  await expect(dialog.locator('.merge-row')).toHaveCount(0);
  await expect(next).toBeEnabled();
  active = true;
  await emit('merge');
  await expect(next).toBeDisabled();
  await expect(dialog.getByText('当前批次尚未结束，暂不能进入下一步。')).toBeVisible();
  active = false;
  await emit('merge');
  await expect(next).toBeEnabled();
  withdrawn = true;
  await emit();
  await expect(dialog.getByRole('button', {name: '重新选择', exact: true})).toBeVisible();
  await expect(next).toBeDisabled();
  withdrawn = false;
  await emit();
  await expect(next).toBeEnabled();
  await next.click();
  await dialog.getByRole('checkbox', {name: /合并后发布/}).check();
  const start = dialog.getByRole('button', {name: '开始处理', exact: true});
  await expect(start).toBeEnabled();
  await expect(dialog.getByRole('heading', {name: '发布范围', exact: true})).toBeVisible();
  for (let i = 0; i < 3; i++) {
    const reads = queueReads;
    await emit();
    await expect.poll(() => queueReads).toBeGreaterThan(reads);
    await expect(start).toBeEnabled();
    expect(previewReads).toBe(1);
  }

  await emit('merge');
  await expect.poll(() => previewReads).toBe(2);
  await expect(start).toBeEnabled();
  digest = 'updated-scope';
  gate!();
  const confirm = dialog.getByRole('button', {name: '确认新版发布范围'});
  await expect(confirm).toBeEnabled();
  await expect(start).toBeDisabled();
  await dialog.getByRole('button', {name: '上一步', exact: true}).click();
  await next.click();
  await expect.poll(() => previewReads).toBe(3);
  await expect(confirm).toBeEnabled();
  await expect(start).toBeDisabled();
  await confirm.click();
  await expect(start).toBeEnabled();

  let submissions = 0;
  await page.route('**/merge-batches', route => {
    expect(route.request().postDataJSON().scopeDigest).toBe('updated-scope');
    submissions++;
    return route.fulfill({status: 409, json: {
      code: 'publication_scope_changed', title: '发布范围已变化或缺少依据，请重新审阅。',
    }});
  });
  digest = 'latest-scope';
  await start.click();
  await expect.poll(() => previewReads).toBe(4);
  await expect(start).toBeDisabled();
  gate!();
  await expect(confirm).toBeEnabled();
  await expect(start).toBeDisabled();
  expect(submissions).toBe(1);

  await confirm.click();
  await page.unroute('**/merge-batches');
  await page.route('**/merge-batches', route => route.fulfill({status: 503, json: {}}));
  await start.click();
  const retry = dialog.getByRole('button', {name: '重试原批次', exact: true});
  await expect(retry).toBeEnabled();
  queueStatus = 403;
  await emit();
  await expect(retry).toBeDisabled();
});
