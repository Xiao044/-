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
    document: { querySelector: (selector) => selector === '#description-editor' ? raw : null, querySelectorAll: () => [] },
    acceptedASnapshot: undefined, activeAOperation: null, pendingAConfirmation: null, agentBusy: false, interrupted: false, pendingSceneChange: null,
    projectId: 'test', projectSession: 0, modalSession: 0, serverSyncQueue: null, pendingProjectSync: null, invalidatedGenerationJobs: new Set(),
    promptB: '', generationJobId: '', generatedResults: [], resultGenerated: false,
    descriptionA: raw.value, descriptionADraft: draft, descriptionAStructured: {}, descriptionAFieldEdits: {},
    agentRunHistory: [{ runId: 'run-1', output: { draft }, accepted: false }], currentAgentRunId: 'run-1', currentAgentRunVersion: 1,
    getDraftField: (key) => context.descriptionADraft.fields[key], agentWarnings: [], projectApiUrl: '/api/projects/test',
    progress: 2, window: { confirm: () => true },
    serializeProject: () => ({}), agentInputSignature: () => '', setAgentBusy: (busy) => { context.agentBusy = busy; },
    fetch: async () => ({ ok: true, json: async () => ({ project: {} }) }),
    persistState() {}, syncProject: async () => {}, showToast: (message) => calls.push(['toast', message]),
    refreshAgentWarningPanel() {}, resetDownstream: (step) => calls.push(['reset', step]),
    markStepComplete() {}, setCurrentStep() {}, unlockCard: (name) => calls.push(['unlock', name]), setStatus() {}, openDetail() {}
  };
  vm.createContext(context);
  vm.runInContext([definitions, ...['parseDraftFieldInput', 'requiresASemanticValidation', 'aFieldInput', 'setAFieldError', 'showAFieldErrors', 'clearCorrectedAFieldError', 'refreshAFieldRequirements',  'refreshDraftFieldSource', 'refreshSavedDraftFieldSources', 'collectAgentDraftPatch', 'normalizeAContent', 'storedAContent', 'editorAContent', 'resolveAcceptedASnapshot', 'hasADownstream', 'isAConfirmationPending', 'refreshAConfirmationState', 'captureAOperation', 'isAOperationCurrent', 'setAOperation', 'strictAProjectSave', 'confirmedAProject', 'saveAgentDraftOperation', 'confirmDescriptionOperation', 'validateDescriptionAConfirmation', 'saveAgentDraftEdits', 'confirmDescription'].map(declaration), 'globalThis.ui = { collectAgentDraftPatch, validateDescriptionAConfirmation, refreshDraftFieldSource, refreshSavedDraftFieldSources, saveAgentDraftEdits, confirmDescription };'].join('\n'), context);
  return { context, inputs, badges, confirmButton, calls, raw };
};
const plain = (value) => JSON.parse(JSON.stringify(value));

const makeProductContext = () => {
  const product = {
    name: '黄铜项链', subtitle: '金色细链', description: '保留商品原有结构', imageUrl: '/data/uploads/test/product.png',
    facts: { material: '黄铜', color: '金色', size: '8mm', batch: 'B-01' },
    material: '黄铜', color: '金色', size: '8mm', category: '首饰', brand: '自有品牌', extension: { sku: 'sku-01', tags: ['首发'] }
  };
  const calls = [], requests = [], storage = new Map();
  const inputs = Object.fromEntries(['name', 'subtitle', 'description'].map((key) => [`#product-${key}`, {
    id: `product-${key}`, value: product[key], attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    focus() { calls.push(['focus', key]); }
  }]));
  const errors = Object.fromEntries(['name', 'subtitle', 'description'].map((key) => [`#product-${key}-error`, { textContent: '', hidden: true }]));
  const context = {
    acceptedASnapshot: null, activeAOperation: null, pendingAConfirmation: null, productState: plain(product), progress: 4, generated: true, interrupted: false, agentFailure: null,
    descriptionA: '已有 A', promptB: '已有 B', negativePrompt: '', aspectRatio: '4:5', platformParams: {}, platformOverrides: {},
    promptBSource: 'workbench', promptBVersion: 1, promptBTemplateId: '', promptBTemplateVersion: 0,
    agentTemplateId: '', agentTemplateVersion: 0, descriptionAStructured: {}, agentWarnings: [], descriptionADraft: null,
    descriptionAFieldEdits: {}, currentAgentRunId: '', currentAgentRunVersion: 0, aReferenceImageUrl: '',
    resultGenerated: true, resultSelected: 0, generatedResults: [{ url: '/data/uploads/test/result.png' }],
    invalidatedGenerationJobs: new Set(), doubaoBridgeState: 'completed', generationJobId: 'job-1', generationResendSourceJobId: '',
    selectedGenerationPlatforms: new Set(['doubao']), versions: [], projectName: '测试项目', projectId: 'test', agentNote: '',
    storageKey: 'product-save-test', projectApiUrl: '/api/projects/test', projectSession: 0, agentRequestSequence: 0, serverUpdatedAt: '', serverSyncQueue: null, pendingProjectSync: null,
    agentRunHistory: [], latestAgentDraftVersion: 0,
    sceneOptions: [{ textContent: '自然窗边', classList: { contains: () => true } }],
    window: {
      localStorage: { setItem: (key, value) => storage.set(key, value), getItem: (key) => storage.get(key) ?? null },
      confirm: () => { calls.push(['confirm']); return true; }
    },
    document: { querySelector: (selector) => inputs[selector] || errors[selector] || null },
    modalBody: { querySelector: (selector) => inputs[selector] || errors[selector] || null },
    escapeHtml, openModal: (title, html) => calls.push(['open', title, html]),
    renderProduct: () => calls.push(['render']), closeModal: () => calls.push(['close']), showToast: (message) => calls.push(['toast', message]),
    resetDownstream: (step) => { calls.push(['reset', step]); context.progress = 1; context.descriptionA = ''; context.promptB = ''; context.generatedResults = []; },
    ensureProjectOnServer: async () => {},
    fetch: async (url, options) => {
      requests.push({ url, method: options.method, body: JSON.parse(options.body) });
      return { ok: true, json: async () => options.method === 'POST'
        ? { run: { runId: 'run-test', output: { version: 1 } } }
        : { project: { updatedAt: '2026-11-06T00:00:00.000Z' } } };
    }
  };
  vm.createContext(context);
  const productHelpers = ['productFieldDefinitions', 'productFieldError', 'showProductFieldError', 'readProductEditor', 'refreshProductFieldValidation'].filter((name) => source.includes(`      const ${name} =`));
  const agentHelpers = ['selectedSceneName', 'agentInputSignature', 'captureAgentRequest', 'isAgentRequestCurrent', 'agentRequestError', 'clearAgentFailure'];
  vm.runInContext([...productHelpers.map(declaration), ...agentHelpers.map(declaration), ...['persistedResults', 'persistState', 'serializeProject', 'syncProject', 'requestAgent', 'openProductEditor', 'saveProduct'].map(declaration), 'globalThis.ui = { saveProduct, requestAgent, serializeProject, openProductEditor };'].join('\n'), context);
  return { context, product, inputs, errors, calls, requests, storage };
};

test('unchanged product save preserves facts and extension data in local and server JSON without resetting downstream', async () => {
  const { context, product, calls, requests, storage } = makeProductContext();
  context.ui.saveProduct();
  await context.serverSyncQueue;
  assert.deepEqual(plain(context.productState), product);
  const saved = JSON.parse(storage.get(context.storageKey));
  assert.deepEqual(saved.product, product);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'PUT');
  assert.deepEqual(requests[0].body.product, product);
  assert.equal(saved.descriptionA, '已有 A');
  assert.equal(saved.promptB, '已有 B');
  assert.equal(saved.generationJobId, 'job-1');
  assert.equal(saved.generatedResults.length, 1);
  assert.equal(calls.some(([kind]) => kind === 'confirm' || kind === 'reset'), false);
});

test('confirmed product edits update visible fields and retain unedited facts and metadata', async () => {
  const { context, product, inputs, calls, requests, storage } = makeProductContext();
  inputs['#product-name'].value = ' 新商品名 ';
  inputs['#product-subtitle'].value = ' 新卖点 ';
  inputs['#product-description'].value = ' 新描述 ';
  context.ui.saveProduct();
  await context.serverSyncQueue;
  const expected = { ...product, name: '新商品名', subtitle: '新卖点', description: '新描述' };
  assert.deepEqual(plain(context.productState), expected);
  assert.deepEqual(JSON.parse(storage.get(context.storageKey)).product, expected);
  assert.deepEqual(requests[0].body.product, expected);
  assert.deepEqual(calls.filter(([kind]) => kind === 'reset'), [['reset', 0]]);
  assert.equal(calls.filter(([kind]) => kind === 'confirm').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'close').length, 1);
});

test('declining product changes leaves product and downstream untouched and keeps the editor open', () => {
  const { context, product, inputs, calls, requests, storage } = makeProductContext();
  inputs['#product-name'].value = '未确认修改';
  context.window.confirm = () => false;
  context.ui.saveProduct();
  assert.deepEqual(plain(context.productState), product);
  assert.equal(context.progress, 4);
  assert.equal(context.descriptionA, '已有 A');
  assert.equal(context.promptB, '已有 B');
  assert.equal(context.generationJobId, 'job-1');
  assert.equal(context.generatedResults.length, 1);
  assert.equal(storage.size, 0);
  assert.equal(requests.length, 0);
  assert.deepEqual(calls, []);
});

test('saved product facts remain in later Agent input and a locally restored save', async () => {
  const { context, product, requests, storage } = makeProductContext();
  context.ui.saveProduct();
  await context.serverSyncQueue;
  const restored = makeProductContext();
  restored.context.productState = JSON.parse(storage.get(context.storageKey)).product;
  restored.context.ui.saveProduct();
  await restored.context.serverSyncQueue;
  await restored.context.ui.requestAgent('description_a');
  const agentRequest = restored.requests.find((request) => request.method === 'POST');
  assert.equal(agentRequest.url, '/api/projects/test/agent-runs');
  assert.deepEqual(agentRequest.body.product, product);
  assert.deepEqual(restored.requests[0].body.product, requests[0].body.product);
});

test('blank product name reports the field before side effects and allows a corrected retry', async () => {
  const { context, product, inputs, errors, calls, requests, storage } = makeProductContext();
  inputs['#product-name'].value = '   ';
  inputs['#product-subtitle'].value = '';
  context.ui.saveProduct();
  assert.deepEqual(plain(context.productState), product);
  assert.equal(context.progress, 4);
  assert.equal(context.descriptionA, '已有 A');
  assert.equal(context.promptB, '已有 B');
  assert.equal(storage.size, 0);
  assert.equal(requests.length, 0);
  assert.match(errors['#product-name-error'].textContent, /请填写商品名称/);
  assert.equal(inputs['#product-name'].attributes['aria-invalid'], 'true');
  assert.deepEqual(calls, [['focus', 'name']]);
  assert.equal(inputs['#product-subtitle'].value, '');
  inputs['#product-name'].value = ' 修正商品名 ';
  context.ui.saveProduct();
  await context.serverSyncQueue;
  assert.equal(context.productState.name, '修正商品名');
  assert.equal(context.productState.subtitle, '');
  assert.equal(errors['#product-name-error'].hidden, true);
  assert.equal(inputs['#product-name'].attributes['aria-invalid'], 'false');
  assert.equal(calls.filter(([kind]) => kind === 'reset').length, 1);
});

test('optional product fields clear through local and server saves, reopen and later Agent input', async () => {
  const { context, product, inputs, requests, storage, calls } = makeProductContext();
  inputs['#product-subtitle'].value = '  ';
  inputs['#product-description'].value = '\n ';
  context.ui.saveProduct();
  await context.serverSyncQueue;
  const expected = { ...product, subtitle: '', description: '' };
  assert.deepEqual(plain(context.productState), expected);
  assert.deepEqual(JSON.parse(storage.get(context.storageKey)).product, expected);
  assert.deepEqual(requests[0].body.product, expected);
  context.ui.openProductEditor();
  const markup = calls.find(([kind]) => kind === 'open')[2];
  assert.match(markup, /id="product-subtitle"[^>]*value=""/);
  assert.match(markup, /id="product-description"[^>]*><\/textarea>/);
  assert.match(markup, /aria-label="商品名称" maxlength="300" required/);
  assert.match(markup, /aria-describedby="product-name-hint product-name-error"/);
  await context.ui.requestAgent('description_a');
  assert.deepEqual(requests.find((request) => request.method === 'POST').body.product, expected);
  const restored = makeProductContext();
  restored.context.productState = JSON.parse(storage.get(context.storageKey)).product;
  restored.inputs['#product-subtitle'].value = '';
  restored.inputs['#product-description'].value = '';
  restored.context.ui.saveProduct();
  await restored.context.serverSyncQueue;
  assert.deepEqual(restored.requests[0].body.product, expected);
});

test('product validation input delegation clears corrected field errors before saving', () => {
  const { context, inputs, errors, requests } = makeProductContext();
  inputs['#product-name'].value = '';
  context.ui.saveProduct();
  assert.equal(errors['#product-name-error'].hidden, false);
  context.modal = { addEventListener: (_event, handler) => { context.inputHandler = handler; } };
  const start = source.indexOf("      modal.addEventListener('input'");
  const end = source.indexOf("      modal.addEventListener('change'", start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  inputs['#product-name'].value = '修正名称';
  context.inputHandler({ target: inputs['#product-name'] });
  assert.equal(inputs['#product-name'].attributes['aria-invalid'], 'false');
  assert.equal(errors['#product-name-error'].hidden, true);
  assert.equal(requests.length, 0);
});

test('empty product display hints remain presentation only', () => {
  const productState = { name: '项链', subtitle: '', description: '', imageUrl: '/uploads/product.png', facts: { material: '黄铜' } };
  const name = { textContent: '' }, caption = { textContent: '' }, subtitle = { textContent: '' }, description = { textContent: '' };
  const context = {
    productState,
    document: {
      querySelector: (selector) => ({ '.product-details h3': name, '#canvas-product-name': caption, '.product-note p': description }[selector]),
      querySelectorAll: (selector) => selector === '.product-subtitle' ? [subtitle] : []
    }
  };
  vm.runInNewContext(declaration('renderProduct') + '\nrenderProduct();', context);
  assert.equal(subtitle.textContent, '未填写商品卖点');
  assert.equal(description.textContent, '未填写商品描述');
  assert.equal(productState.subtitle, '');
  assert.equal(productState.description, '');
});

for (const [key, limit] of [['name', 300], ['subtitle', 500], ['description', 12000]]) {
  test(`product ${key} rejects raw over-limit input and saves the exact ${limit}-character boundary`, async () => {
    const { context, product, inputs, errors, calls, requests, storage } = makeProductContext();
    inputs[`#product-${key}`].value = ' ' + '字'.repeat(limit);
    context.ui.saveProduct();
    assert.deepEqual(plain(context.productState), product);
    assert.equal(storage.size, 0);
    assert.equal(requests.length, 0);
    assert.equal(calls.some(([kind]) => ['confirm', 'reset', 'close'].includes(kind)), false);
    assert.match(errors[`#product-${key}-error`].textContent, new RegExp(String(limit)));
    assert.equal(inputs[`#product-${key}`].value.length, limit + 1);
    inputs[`#product-${key}`].value = '字'.repeat(limit);
    context.ui.saveProduct();
    await context.serverSyncQueue;
    assert.equal(context.productState[key], '字'.repeat(limit));
    assert.deepEqual(plain(context.productState.facts), product.facts);
    assert.equal(errors[`#product-${key}-error`].hidden, true);
  });
}

test('declining valid optional-field clearing preserves product, downstream and edit inputs', () => {
  const { context, product, inputs, requests, storage, calls } = makeProductContext();
  inputs['#product-subtitle'].value = '';
  inputs['#product-description'].value = '';
  context.window.confirm = () => false;
  context.ui.saveProduct();
  assert.deepEqual(plain(context.productState), product);
  assert.equal(context.progress, 4);
  assert.equal(context.descriptionA, '已有 A');
  assert.equal(context.promptB, '已有 B');
  assert.equal(inputs['#product-subtitle'].value, '');
  assert.equal(inputs['#product-description'].value, '');
  assert.equal(requests.length, 0);
  assert.equal(storage.size, 0);
  assert.deepEqual(calls, []);
});

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
    refreshAConfirmationState() {}, syncPlatformPicker() {}, renderPlatformOverridesEditor() {}, renderPlatformStatuses() {}, resultGenerated: false
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
