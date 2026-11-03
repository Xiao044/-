const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const declaration = (name) => {
  const start = source.indexOf(`      const ${name} =`);
  assert.notEqual(start, -1, `missing ${name}`);
  const end = source.indexOf('\n      const ', start + 12);
  assert.notEqual(end, -1, `missing end of ${name}`);
  return source.slice(start, end);
};
const definitions = source.slice(source.indexOf('      const agentDraftFieldDefinitions ='), source.indexOf('      const getDraftField ='));
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, '');
const badge = () => ({ textContent: '', classList: { values: new Set(), add(value) { this.values.add(value); }, remove(value) { this.values.delete(value); } } });
const makeAContext = () => {
  const values = { productFactsSummary: '淡水珍珠项链', scene: '窗边静物', composition: '居中', lightingMood: '柔光', mustKeep: '珍珠结构\n乳白色', forbidden: '不可改色' };
  const inputs = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
  const badges = Object.fromEntries(Object.keys(values).map((key) => [key, badge()]));
  const confirmButton = { disabled: false };
  const raw = { value: '珍珠项链置于窗边，保留结构与乳白色。' };
  const aHost = { querySelector(selector) {
    if (selector === '#description-editor') return raw;
    if (selector === '[data-detail-action="confirm-a"]') return confirmButton;
    const field = selector.match(/data-agent-field="([^"]+)"/);
    const fieldSource = selector.match(/data-agent-field-source="([^"]+)"/);
    return field ? inputs[field[1]] : fieldSource ? badges[fieldSource[1]] : null;
  } };
  const cHost = { querySelector() { return null; } };
  const draft = { rawText: raw.value, fields: Object.fromEntries(Object.keys(values).map((key) => [key, { value: ['mustKeep', 'forbidden'].includes(key) ? ['旧约束'] : '旧值', source: 'agent', version: 1 }])) };
  const calls = [];
  const context = {
    detailContents: { a: aHost, c: cHost }, detailContent: cHost,
    document: { querySelector: (selector) => selector === '#description-editor' ? raw : null },
    descriptionA: raw.value, descriptionADraft: draft, descriptionAStructured: {}, descriptionAFieldEdits: {},
    agentRunHistory: [{ runId: 'run-1', output: { draft }, accepted: false }], currentAgentRunId: 'run-1', currentAgentRunVersion: 1,
    getDraftField: (key) => context.descriptionADraft.fields[key], agentWarnings: [], projectApiUrl: '/api/projects/test',
    progress: 2, window: { confirm: () => true },
    persistState() {}, syncProject: async () => {}, showToast: (message) => calls.push(['toast', message]),
    refreshAgentWarningPanel() {}, resetDownstream: (step) => calls.push(['reset', step]),
    markStepComplete() {}, setCurrentStep() {}, unlockCard: (name) => calls.push(['unlock', name]), setStatus() {}, openDetail() {}
  };
  vm.createContext(context);
  vm.runInContext([definitions, ...['parseDraftFieldInput', 'refreshDraftFieldSource', 'refreshSavedDraftFieldSources', 'collectAgentDraftPatch', 'validateDescriptionAConfirmation', 'saveAgentDraftEdits', 'confirmDescription'].map(declaration), 'globalThis.ui = { collectAgentDraftPatch, validateDescriptionAConfirmation, refreshDraftFieldSource, refreshSavedDraftFieldSources, saveAgentDraftEdits, confirmDescription };'].join('\n'), context);
  return { context, inputs, badges, confirmButton, calls, raw };
};
const plain = (value) => JSON.parse(JSON.stringify(value));

test('A confirmation and draft collection read filled A fields independently of C', () => {
  const { context, inputs } = makeAContext();
  assert.deepEqual(plain(context.ui.validateDescriptionAConfirmation(context.descriptionA)), []);
  const collected = context.ui.collectAgentDraftPatch();
  assert.equal(collected.changed, true);
  assert.equal(collected.patch.fields.productFactsSummary, inputs.productFactsSummary.value);
  assert.deepEqual(plain(collected.patch.fields.mustKeep), ['珍珠结构', '乳白色']);
  inputs.productFactsSummary.value = '  ';
  assert.equal(context.ui.validateDescriptionAConfirmation(context.descriptionA)[0], '请补充商品事实摘要');
  inputs.productFactsSummary.value = '淡水珍珠项链';
  inputs.scene.value = '';
  inputs.mustKeep.value = '\n ';
  assert.deepEqual(plain(context.ui.validateDescriptionAConfirmation(context.descriptionA)), ['请补充场景', '请至少填写一条必须保留项']);
});

test('A save persists structured edits, source badges and user metadata', async () => {
  const { context, badges } = makeAContext();
  context.currentAgentRunId = '';
  context.ui.refreshDraftFieldSource('scene');
  assert.equal(badges.scene.textContent, '待保存修改');
  assert.equal(badges.scene.classList.values.has('is-unsaved'), true);
  await context.ui.saveAgentDraftEdits({ showFeedback: false });
  assert.equal(context.descriptionADraft.fields.scene.value, '窗边静物');
  assert.equal(context.descriptionADraft.fields.scene.source, 'user');
  assert.equal(badges.scene.textContent, '用户资料');
  assert.equal(badges.scene.classList.values.has('is-unsaved'), false);
});

test('A confirmation disables its own button while edits and accept are pending', async () => {
  const { context, confirmButton, calls } = makeAContext();
  let releasePatch;
  const patchWait = new Promise((resolve) => { releasePatch = resolve; });
  context.fetch = async (url, options) => {
    if (options.method === 'PATCH') {
      await patchWait;
      const patch = JSON.parse(options.body).draft;
      const run = { runId: 'run-1', version: 2, output: { draft: { rawText: context.descriptionA, fields: Object.fromEntries(Object.entries(patch.fields).map(([key, value]) => [key, { value, source: 'user' }])) } } };
      return { ok: true, json: async () => ({ run }) };
    }
    return { ok: true, json: async () => ({ run: { ...context.agentRunHistory[0], accepted: true } }) };
  };
  const pending = context.ui.confirmDescription();
  assert.equal(confirmButton.disabled, true);
  releasePatch();
  await pending;
  assert.equal(context.progress, 3);
  assert.equal(calls.some(([kind, name]) => kind === 'unlock' && name === 'b'), true);
});

test('restored legacy A compatibility agrees with the accept API while new drafts stay strict', () => {
  const { context, inputs } = makeAContext();
  for (const input of Object.values(inputs)) input.value = '';
  context.agentRunHistory[0].legacyCompatibility = { allowIncompleteSemanticMinimum: true, sourceRunId: 'legacy-run' };
  assert.deepEqual(plain(context.ui.validateDescriptionAConfirmation(context.descriptionA)), []);
  delete context.agentRunHistory[0].legacyCompatibility;
  assert.ok(context.ui.validateDescriptionAConfirmation(context.descriptionA).length);
});

class EventNode {
  constructor(parent = null) { this.parent = parent; this.listeners = {}; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  dispatch(type, target) { for (let node = this; node; node = node.parent) for (const handler of node.listeners[type] || []) handler({ target }); }
}

test('A reference image change bubbles to its handler and C uploads and selection still work', () => {
  const canvas = new EventNode();
  const a = new EventNode(canvas);
  const c = new EventNode(canvas);
  const calls = [];
  c.querySelectorAll = () => [{ value: 'doubao' }, { value: 'chatgpt' }];
  const context = { workflowCanvas: canvas, detailContent: c, detailContents: { a, c }, uploadABriefImage: (file) => calls.push(['a', file]), uploadGeneratedResults: (files) => calls.push(['c', files]), syncPlatformPicker() {}, renderPlatformOverridesEditor() {}, renderPlatformStatuses() {}, persistState() {}, selectedGenerationPlatforms: new Set() };
  const registration = source.match(/^      (?:detailContent|workflowCanvas)\.addEventListener\('change', \(event\) => \{[\s\S]*?^      \}\);/m);
  assert.ok(registration, 'missing workflow change delegation');
  vm.runInNewContext(registration[0], context);
  const file = { name: 'reference.png' };
  a.dispatch('change', { id: 'a-reference-image', files: [file], matches: () => false });
  assert.deepEqual(calls, [['a', file]]);
  c.dispatch('change', { id: 'result-upload-input', files: [file], matches: () => false });
  assert.deepEqual(calls[1], ['c', [file]]);
  c.dispatch('change', { matches: () => true });
  assert.deepEqual([...context.selectedGenerationPlatforms], ['doubao', 'chatgpt']);
});

const makeAssetContext = () => {
  const labels = ['usable', 'discarded', 'subject_complete', 'structure_preserved', 'clear'];
  const modal = new EventNode();
  const buttons = labels.map((qualityLabel) => ({ dataset: { qualityLabel, assetAction: 'quality-label', assetId: 'asset-1' }, disabled: false }));
  const context = {
    modal, modalSession: 1, CSS: { escape: (value) => value }, projectApiUrl: '/api/projects/test',
    pendingAssetQualityUpdates: new Set(), assetQualityLabels: Object.fromEntries(labels.map((label) => [label, label])),
    assetLibraryAssets: [{ assetId: 'asset-1', qualityLabels: [] }],
    modalBody: { querySelectorAll: () => buttons, querySelector: () => buttons[0] },
    isAssetLibraryView: () => true, requests: [], toasts: [],
    showToast: (message) => context.toasts.push(message),
    fetch: async (url, options) => { context.requests.push({ url, options }); return { ok: true, json: async () => ({}) }; },
    fetchAssetLibrary: async () => { context.assetLibraryAssets[0].qualityLabels = JSON.parse(context.requests.at(-1).options.body).qualityLabels; }
  };
  vm.createContext(context);
  const start = source.indexOf("      modal.addEventListener('click', (event) => {\n        const runSelection");
  const end = source.indexOf("      modal.addEventListener('input'", start);
  assert.ok(start >= 0 && end > start, 'missing modal action delegation');
  vm.runInContext(declaration('handleAssetAction') + '\n' + source.slice(start, end), context);
  const click = (label) => {
    const button = buttons.find((item) => item.dataset.qualityLabel === label);
    modal.dispatch('click', { closest: (selector) => selector === '[data-asset-action]' ? button : null });
  };
  return { context, buttons, click, labels };
};
const settle = () => new Promise(setImmediate);

test('quality-label clicks route each of five labels, toggle, and enforce usable/discarded exclusion', async () => {
  const { context, click, labels } = makeAssetContext();
  for (const label of labels) {
    context.assetLibraryAssets[0].qualityLabels = [];
    click(label);
    await settle();
    assert.deepEqual(context.assetLibraryAssets[0].qualityLabels, [label], `clicked ${label}`);
    click(label);
    await settle();
    assert.deepEqual(context.assetLibraryAssets[0].qualityLabels, [], `toggle ${label}`);
  }
  context.assetLibraryAssets[0].qualityLabels = ['usable', 'clear'];
  click('discarded');
  await settle();
  assert.deepEqual(context.assetLibraryAssets[0].qualityLabels, ['clear', 'discarded']);
  click('usable');
  await settle();
  assert.deepEqual(context.assetLibraryAssets[0].qualityLabels, ['clear', 'usable']);
});

test('quality-label rapid clicks are guarded and failed requests preserve labels and allow retry', async () => {
  const { context, buttons, click } = makeAssetContext();
  let rejectRequest;
  context.fetch = (url, options) => {
    context.requests.push({ url, options });
    return new Promise((resolve, reject) => { rejectRequest = reject; });
  };
  click('clear');
  click('discarded');
  assert.equal(context.requests.length, 1);
  assert.equal(buttons.every((button) => button.disabled), true);
  rejectRequest(new Error('模拟网络失败'));
  await settle();
  assert.equal(context.pendingAssetQualityUpdates.size, 0);
  assert.equal(buttons.every((button) => !button.disabled), true);
  assert.deepEqual(context.assetLibraryAssets[0].qualityLabels, []);
  assert.deepEqual(context.toasts, ['模拟网络失败']);
  context.fetch = async (url, options) => { context.requests.push({ url, options }); return { ok: true, json: async () => ({}) }; };
  click('clear');
  await settle();
  assert.deepEqual(context.assetLibraryAssets[0].qualityLabels, ['clear']);
});

test('generation picker renders explicit unverified platform status and keeps manual fallback', () => {
  const host = { innerHTML: '' };
  const context = {
    stepNodes: { c: { classList: { contains: () => false, add() {} }, querySelector: () => ({}) } }, detailContents: { c: host }, revealDetail() {},
    generationPlatforms: { doubao: { label: '豆包' }, chatgpt: { label: 'ChatGPT' }, gemini: { label: 'Gemini' }, lovart: { label: 'Lovart' } },
    selectedGenerationPlatforms: new Set(['doubao']), escapeHtml, doubaoExtensionReady: false,
    syncPlatformPicker() {}, renderPlatformOverridesEditor() {}, renderPlatformStatuses() {}, resultGenerated: false
  };
  vm.createContext(context);
  vm.runInContext(declaration('openDetail') + '\nopenDetail("c", false);', context);
  for (const name of ['豆包', 'ChatGPT', 'Gemini', 'Lovart']) assert.ok(host.innerHTML.includes(name));
  assert.match(host.innerHTML, /未验收/);
  assert.match(host.innerHTML, /实验性/);
  assert.match(host.innerHTML, /data-bridge-action="manual-result"/);
});

const makeImageExportContext = () => {
  const button = { disabled: false }, calls = [], context = {
    projectId: 'alpha', projectApiUrl: '/api/projects/alpha', projectSession: 1, projectName: '珍珠项链', imageExportPending: false,
    projectFilename: (name) => name, showToast: (message) => calls.push(['toast', message]),
    URL: { createObjectURL: () => { calls.push(['url']); return 'blob:zip'; }, revokeObjectURL: (url) => calls.push(['revoke', url]) },
    window: { setTimeout: (callback) => callback() },
    document: {
      querySelector: () => button, body: { appendChild: (anchor) => calls.push(['append', anchor]) },
      createElement: () => ({ click() { calls.push(['download', this.download]); }, remove() { calls.push(['remove']); } })
    },
    fetch: async () => ({ ok: true, blob: async () => ({ type: 'application/zip' }), headers: { get: (name) => name === 'X-Export-Image-Count' ? '2' : '1' } })
  };
  vm.createContext(context);
  const registration = source.split('\n').find((line) => line.includes("?.addEventListener('click', exportProjectImages)"));
  assert.ok(registration, 'missing image export button registration');
  context.document.querySelector = (selector) => {
    assert.equal(selector, '[data-project-action="export-images"]');
    return { ...button, addEventListener: (_type, handler) => { context.clickExport = handler; }, get disabled() { return button.disabled; }, set disabled(value) { button.disabled = value; } };
  };
  vm.runInContext(declaration('exportProjectImages') + '\n' + registration, context);
  return { context, calls, button };
};

test('image export button downloads ZIP, cleans its object URL and reports manifest warnings', async () => {
  const { context, calls, button } = makeImageExportContext();
  await context.clickExport();
  assert.deepEqual(calls.find(([name]) => name === 'download'), ['download', '珍珠项链-images.zip']);
  assert.ok(calls.some(([name]) => name === 'remove'));
  assert.deepEqual(calls.find(([name]) => name === 'revoke'), ['revoke', 'blob:zip']);
  assert.match(calls.find(([name]) => name === 'toast')[1], /2 张图片；1 项未导出.*manifest.json/);
  assert.equal(button.disabled, false);
  assert.equal(context.imageExportPending, false);
});

test('image export blocks repeated clicks and allows retry after JSON and network failures', async () => {
  const { context, button, calls } = makeImageExportContext();
  let release, requests = 0;
  context.fetch = () => { requests++; return new Promise((resolve) => { release = resolve; }); };
  const first = context.clickExport();
  await context.clickExport();
  assert.equal(requests, 1);
  assert.equal(button.disabled, true);
  release({ ok: false, json: async () => ({ error: 'Image package exceeds its size limit.' }) });
  await first;
  assert.equal(button.disabled, false);
  assert.match(calls.find(([name]) => name === 'toast')[1], /exceeds its size limit/);
  context.fetch = async () => { throw new Error('offline'); };
  await context.clickExport();
  assert.deepEqual(calls.at(-1), ['toast', 'offline']);
  assert.equal(context.imageExportPending, false);
  assert.equal(calls.some(([name]) => name === 'download'), false);
});

test('image export ignores old project responses before and after asynchronous blob reads', async () => {
  for (const phase of ['response', 'blob']) {
    const { context, calls, button } = makeImageExportContext();
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const response = { ok: true, blob: async () => phase === 'blob' ? pending : ({}), headers: { get: () => '0' } };
    context.fetch = async () => phase === 'response' ? pending : response;
    const running = context.clickExport();
    await Promise.resolve();
    context.projectSession++;
    release(phase === 'response' ? response : {});
    await running;
    assert.equal(calls.length, 0, `stale ${phase} must not download or notify`);
    assert.equal(button.disabled, false);
    assert.equal(context.imageExportPending, false);
  }
});
