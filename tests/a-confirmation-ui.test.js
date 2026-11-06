const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const plain = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const declaration = (name) => { const at = source.indexOf(`      const ${name} =`); assert.notEqual(at, -1, name); const end = source.indexOf('\n      const ', at + 12); return source.slice(at, end); };
const helpers = ['normalizeAContent', 'storedAContent', 'editorAContent', 'resolveAcceptedASnapshot', 'hasADownstream', 'isAConfirmationPending', 'refreshAConfirmationState', 'guardAConfirmation', 'captureASendingContext', 'isASendingContextCurrent', 'captureAOperation', 'isAOperationCurrent', 'setAOperation', 'strictAProjectSave', 'confirmedAProject', 'saveAgentDraftOperation', 'confirmDescriptionOperation', 'confirmPendingDescription'];
const makeContext = ({ run = true, accepted = true, progress = 4 } = {}) => {
  const calls = [], requests = [], storage = new Map();
  const fields = { productFactsSummary: '淡水珍珠', scene: '自然窗边', composition: '居中', lightingMood: '柔光', mustKeep: ['珍珠结构'], forbidden: ['水印'] };
  const draft = { rawText: '原 A', fields: Object.fromEntries(Object.entries(fields).map(([k, value]) => [k, { value, source: 'agent', version: 1 }])) };
  const classList = () => ({ add() {}, remove() {}, toggle() {} });
  const raw = { value: '原 A', disabled: false };
  const inputs = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: Array.isArray(v) ? v.join('\n') : v, disabled: false }]));
  const buttons = Object.fromEntries(['confirm-a', 'save-brief', 'regenerate-a', 'confirm-b', 'resend-b', 'generate', 'regenerate-results'].map((k) => [k, { disabled: false, textContent: k, classList: classList() }]));
  const notice = { textContent: '', hidden: true };
  const host = { querySelector(s) { if (s === '#description-editor') return raw; const f = s.match(/data-agent-field="([^"]+)"/); if (f) return inputs[f[1]]; const b = s.match(/data-detail-action="([^"]+)"/); if (b) return buttons[b[1]]; if (s === '[data-a-confirmation-state]') return notice; return null; }, querySelectorAll() { return Object.values(buttons); } };
  const context = {
    acceptedASnapshot: undefined, activeAOperation: null, pendingAConfirmation: null, detailContents: { a: host, b: host, c: host }, detailContent: host,
    descriptionA: '原 A', descriptionADraft: plain(draft), descriptionAStructured: plain(fields), descriptionAFieldEdits: {}, currentAgentRunId: run ? 'run-a' : '', currentAgentRunVersion: 1,
    agentRunHistory: run ? [{ runId: 'run-a', version: 1, accepted, output: { draft: plain(draft), descriptionAStructured: plain(fields) } }] : [], agentWarnings: [],
    progress, promptB: '旧 B', negativePrompt: '旧负面', aspectRatio: '4:5', platformParams: { seed: 42 }, platformOverrides: { doubao: { style: '旧' } }, promptBSource: 'workbench', promptBVersion: 1, promptBTemplateId: '', promptBTemplateVersion: 0,
    generatedResults: [{ url: '/old.png' }], resultGenerated: true, resultSelected: 0, generationJobId: 'job-old', generationResendSourceJobId: '', invalidatedGenerationJobs: new Set(),
    agentBusy: false, interrupted: false, pendingSceneChange: null, activeAgentRequest: null, projectId: 'test', projectApiUrl: '/api/projects/test', projectSession: 0, modalSession: 0,
    serverSyncQueue: null, pendingProjectSync: null, selectedGenerationPlatforms: new Set(['doubao']), productState: { name: '珍珠' }, sceneOptions: [],
    document: { querySelectorAll: () => [], querySelector: () => null },
    window: { confirm: () => { calls.push(['confirm']); return true; }, localStorage: { setItem: (k, v) => storage.set(k, v) }, setTimeout: (fn) => calls.push(['timer', fn]), postMessage: () => calls.push(['platform']) },
    getDraftField: (k) => context.descriptionADraft.fields[k], agentInputSignature: () => JSON.stringify(context.productState),
    setAgentBusy: (busy) => { context.agentBusy = Boolean(busy || context.activeAgentRequest || context.activeAOperation); },
    refreshSavedDraftFieldSources() {}, refreshAgentWarningPanel() {}, persistState: () => calls.push(['persist']),
    serializeProject: () => plain({ projectId: context.projectId, descriptionA: context.descriptionA, descriptionADraft: context.descriptionADraft, descriptionAStructured: context.descriptionAStructured, acceptedASnapshot: context.acceptedASnapshot, progress: context.progress, promptB: context.promptB, generatedResults: context.generatedResults, generationJobId: context.generationJobId, invalidatedGenerationJobs: [...context.invalidatedGenerationJobs] }),
    syncProject: async () => calls.push(['sync']),
    openModal: () => { context.modalSession++; calls.push(['modal']); }, closeModal: () => { context.pendingAConfirmation = null; calls.push(['close']); },
    showToast: (s) => calls.push(['toast', s]), setStatus: (s) => calls.push(['status', s]), markStepComplete() {}, setCurrentStep() {}, unlockCard: (s) => calls.push(['unlock', s]), openDetail: (s) => calls.push(['open', s]),
    resetDownstream: (n) => { calls.push(['reset', n]); context.progress = n + 1; context.promptB = ''; context.generatedResults = []; context.generationJobId = ''; },
    readBExecutionFields: () => { calls.push(['read-b']); return { positivePrompt: 'new B', negativePrompt: '', aspectRatio: '4:5', platformParams: {}, platformOverrides: {}, errors: [] }; },
    templateApplyCandidate: { templateId: 't', version: 1 }, templateApplyFields: () => ({ mode: 'b', positivePrompt: 'new B', platformParams: {}, platformOverrides: {} }),
    validateBExecution: () => ({ errors: [], platformParams: {} }), readPlatformOverridesEditor: () => ({ errors: [], platformOverrides: {} }),
    bPlatformOverridesBaseline: () => ({}), commitPlatformOverrides() {}, clearPromptBTemplateProvenance() {}, renderResults() {}, taskPlatformLabels: {},
  };
  context.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    if (options.method === 'PATCH') {
      const patch = JSON.parse(options.body).draft;
      const saved = plain(context.agentRunHistory.find((r) => r.runId === 'run-a'));
      saved.revisions = [{ accepted: saved.accepted, output: plain(saved.output) }]; saved.accepted = false; saved.version++;
      if (patch.rawText !== undefined) saved.output.draft.rawText = patch.rawText;
      for (const [k, value] of Object.entries(patch.fields || {})) saved.output.draft.fields[k] = { value, source: 'user', version: 2 };
      saved.output.descriptionAStructured = Object.fromEntries(Object.entries(saved.output.draft.fields).map(([k, f]) => [k, f.value]));
      return { ok: true, json: async () => ({ run: saved }) };
    }
    if (url.endsWith('/accept')) return { ok: true, json: async () => ({ run: { ...plain(context.agentRunHistory[0]), accepted: true } }) };
    return { ok: true, json: async () => ({ project: { updatedAt: 'now' } }) };
  };
  vm.createContext(context);
  const definitions = source.slice(source.indexOf('      const agentDraftFieldDefinitions ='), source.indexOf('      const getDraftField ='));
  vm.runInContext([definitions, ...['parseDraftFieldInput', ...helpers.filter((n) => source.includes(`      const ${n} =`)), 'collectAgentDraftPatch', 'saveAgentDraftEdits', 'validateDescriptionAConfirmation', 'confirmDescription', 'confirmPrompt', 'resendPromptB', 'resendGeneration', 'generateResults', 'applyPromptTemplate', 'handleTaskAction'].map(declaration), `globalThis.ui = { ${['saveAgentDraftEdits', 'confirmDescription', 'confirmPrompt', 'resendPromptB', 'resendGeneration', 'generateResults', 'applyPromptTemplate', 'handleTaskAction', ...helpers.filter((n) => source.includes(`      const ${n} =`))].join(', ')} };`].join('\n'), context);
  return { context, calls, requests, raw, inputs, draft, buttons, notice, storage };
};
const approve = async (s) => { if (s.context.ui.confirmPendingDescription) await s.context.ui.confirmPendingDescription(); };
const edit = (s) => { s.raw.value = '新 A'; s.inputs.scene.value = '静物台'; };

test('failed PATCH after approving an A change keeps the old B/results/job', async () => {
  const s = makeContext(); edit(s); s.context.fetch = async () => ({ ok: false, json: async () => ({ error: '保存失败' }) });
  await s.context.ui.confirmDescription(); await approve(s);
  assert.equal(s.context.promptB, '旧 B'); assert.equal(s.context.generationJobId, 'job-old'); assert.equal(s.calls.some(([k]) => k === 'reset'), false);
});
test('saving an A draft then confirming still prompts and clears downstream only after acceptance', async () => {
  const s = makeContext(); edit(s); await s.context.ui.saveAgentDraftEdits();
  assert.equal(s.context.promptB, '旧 B'); assert.equal(s.context.ui.isAConfirmationPending(), true);
  await s.context.ui.confirmDescription(); assert.equal(s.calls.filter(([k]) => k === 'modal').length, 1); assert.equal(s.context.promptB, '旧 B');
  await approve(s); assert.equal(s.calls.filter(([k]) => k === 'reset').length, 1); assert.equal(s.context.ui.isAConfirmationPending(), false);
});
test('cancelling A change confirmation performs no request or downstream mutation', async () => {
  const s = makeContext(); edit(s); await s.context.ui.confirmDescription();
  assert.equal(s.requests.length, 0); s.context.closeModal(); await approve(s);
  assert.equal(s.requests.length, 0); assert.equal(s.context.promptB, '旧 B');
});
test('accept failure keeps old downstream and the saved draft can be retried', async () => {
  const s = makeContext(); edit(s); const fetch = s.context.fetch;
  s.context.fetch = async (url, options) => url.endsWith('/accept') ? { ok: false, json: async () => ({ error: '接受失败' }) } : fetch(url, options);
  await s.context.ui.confirmDescription(); await approve(s);
  assert.equal(s.context.promptB, '旧 B'); assert.equal(s.context.ui.isAConfirmationPending(), true); assert.equal(s.context.activeAOperation, null);
  s.context.fetch = fetch; await s.context.ui.confirmDescription(); await approve(s); assert.equal(s.context.promptB, '');
});
test('unchanged content or a draft changed back to the confirmed A does not invalidate downstream', async () => {
  const s = makeContext(); s.context.ui.resolveAcceptedASnapshot(); edit(s); await s.context.ui.saveAgentDraftEdits();
  s.raw.value = '原 A'; s.inputs.scene.value = '自然窗边'; await s.context.ui.saveAgentDraftEdits();
  assert.equal(s.context.ui.isAConfirmationPending(), false); await s.context.ui.confirmDescription();
  assert.equal(s.calls.some(([k]) => k === 'reset'), false); assert.equal(s.context.promptB, '旧 B');
});
test('pending A blocks every B confirmation and sending entry before side effects', async () => {
  for (const action of ['confirmPrompt', 'resendPromptB', 'resendGeneration', 'generateResults', 'applyPromptTemplate', 'handleTaskAction']) {
    const s = makeContext(); s.context.ui.resolveAcceptedASnapshot(); edit(s);
    await s.context.ui[action](...(action === 'handleTaskAction' ? ['retry', 'job-old', 'doubao'] : []));
    assert.equal(s.context.promptB, '旧 B', action); assert.equal(s.context.generationJobId, 'job-old', action); assert.equal(s.requests.length, 0, action); assert.equal(s.calls.some(([k]) => ['read-b', 'reset', 'timer', 'platform'].includes(k)), false, action);
  }
});
test('legacy/manual baseline and accepted revisions survive saved draft comparison', async () => {
  for (const kind of ['manual', 'revision']) {
    const s = makeContext({ run: kind !== 'manual', accepted: kind !== 'revision' });
    if (kind === 'revision') s.context.agentRunHistory[0].revisions = [{ accepted: true, output: { draft: plain(s.draft) } }];
    s.context.ui.resolveAcceptedASnapshot(); const baseline = plain(s.context.acceptedASnapshot); edit(s); await s.context.ui.saveAgentDraftEdits();
    assert.deepEqual(plain(s.context.acceptedASnapshot), baseline); assert.equal(s.context.ui.isAConfirmationPending(), true);
  }
});
test('stale PATCH cannot overwrite a new project or proceed to accept', async () => {
  const s = makeContext(); edit(s); const wait = deferred(), fetch = s.context.fetch;
  s.context.fetch = async (url, options) => { if (options.method === 'PATCH') { await wait.promise; } return fetch(url, options); };
  const saving = s.context.ui.saveAgentDraftEdits(); await tick();
  s.context.projectSession++; s.context.projectId = 'new'; s.context.projectApiUrl = '/api/projects/new'; s.context.descriptionA = 'new project A';
  wait.resolve(); await saving;
  assert.equal(s.context.descriptionA, 'new project A'); assert.equal(s.requests.some((r) => r.url.includes('/new')), false);
});
test('editing while PATCH is pending preserves the newer input and prevents acceptance', async () => {
  const s = makeContext(); edit(s); const wait = deferred(), fetch = s.context.fetch;
  s.context.fetch = async (url, options) => { if (options.method === 'PATCH') await wait.promise; return fetch(url, options); };
  await s.context.ui.confirmDescription(); const confirming = approve(s); await tick(); s.inputs.scene.value = '稍后编辑';
  wait.resolve(); await confirming;
  assert.equal(s.inputs.scene.value, '稍后编辑'); assert.equal(s.context.promptB, '旧 B'); assert.equal(s.requests.some((r) => r.url.endsWith('/accept')), false);
});
test('a final project PUT failure preserves downstream and the previous confirmed baseline', async () => {
  const s = makeContext(); s.context.ui.resolveAcceptedASnapshot(); const baseline = plain(s.context.acceptedASnapshot); edit(s); let puts = 0; const fetch = s.context.fetch;
  s.context.fetch = async (url, options) => options.method === 'PUT' && ++puts === 2 ? { ok: false, json: async () => ({}) } : fetch(url, options);
  await s.context.ui.confirmDescription(); await approve(s);
  assert.equal(s.context.promptB, '旧 B'); assert.deepEqual(plain(s.context.acceptedASnapshot), baseline); assert.equal(s.context.ui.isAConfirmationPending(), true);
});

test('an earlier real project sync drains before confirmation and cannot overwrite its final project', async () => {
  const s = makeContext(), wait = deferred(), fetch = s.context.fetch;
  let puts = 0;
  s.context.fetch = async (url, options) => { if (options.method === 'PUT' && ++puts === 1) await wait.promise; return fetch(url, options); };
  vm.runInContext(declaration('syncProject') + '\nglobalThis.realSync = syncProject;', s.context);
  const earlier = s.context.realSync(); await tick();
  edit(s); await s.context.ui.confirmDescription(); const confirmation = approve(s); await tick();
  await s.context.realSync(true);
  assert.equal(puts, 1); assert.equal(s.context.activeAOperation !== null, true);
  wait.resolve(); await earlier; await confirmation;
  assert.equal(puts, 3);
  const final = s.requests.filter((r) => r.method === 'PUT').at(-1).body;
  assert.equal(final.promptB, ''); assert.equal(final.acceptedASnapshot.rawText, '新 A');
  assert.equal(s.context.promptB, '');
});

test('the real persisted project retains the accepted baseline across editor closure and reload', async () => {
  const s = makeContext();
  Object.assign(s.context, { storageKey: 'a-flow', generated: true, selectedScene: '', agentTemplateId: '', agentTemplateVersion: 0, aReferenceImageUrl: '/reference.png', versions: [], doubaoBridgeState: 'idle', projectName: 'A flow', agentNote: '', serverUpdatedAt: '' });
  vm.runInContext(['persistedResults', 'persistState', 'serializeProject'].map(declaration).join('\n') + '\nglobalThis.realSerialize = serializeProject;', s.context);
  edit(s); await s.context.ui.saveAgentDraftEdits();
  const saved = JSON.parse(s.storage.get('a-flow'));
  assert.equal(saved.acceptedASnapshot.rawText, '原 A'); assert.equal(saved.descriptionA, '新 A'); assert.equal(saved.promptB, '旧 B');
  assert.deepEqual(plain(s.context.realSerialize().acceptedASnapshot), saved.acceptedASnapshot);
  const restored = makeContext();
  Object.assign(restored.context, { descriptionA: saved.descriptionA, descriptionADraft: saved.descriptionADraft, descriptionAStructured: saved.descriptionAStructured, acceptedASnapshot: saved.acceptedASnapshot });
  restored.context.detailContents.a.querySelector = () => null;
  assert.equal(restored.context.ui.isAConfirmationPending(), true);
  assert.equal(restored.context.ui.editorAContent().rawText, '新 A');
});

test('duplicate save/confirm actions share one owner and final commit makes editor inputs readonly', async () => {
  const s = makeContext(); edit(s); let puts = 0; const final = deferred(), fetch = s.context.fetch;
  s.context.fetch = async (url, options) => { if (options.method === 'PUT' && ++puts === 2) await final.promise; return fetch(url, options); };
  await s.context.ui.confirmDescription(); const confirmation = approve(s); await tick();
  assert.equal(s.raw.readOnly, true); assert.equal(s.inputs.scene.readOnly, true);
  await s.context.ui.confirmDescription(); await s.context.ui.saveAgentDraftEdits();
  assert.equal(s.requests.filter((r) => r.method === 'PATCH').length, 1);
  final.resolve(); await confirmation;
  assert.equal(s.raw.readOnly, false); assert.equal(s.buttons['confirm-a'].disabled, false);
});

test('explicitly unconfirmed content and unknown run history are never inferred as accepted from old progress', () => {
  const s = makeContext(); s.context.acceptedASnapshot = null;
  assert.equal(s.context.ui.isAConfirmationPending(), true);
  s.context.acceptedASnapshot = undefined; s.context.agentRunHistory = [];
  assert.equal(s.context.ui.isAConfirmationPending(), true);
});

test('editing A during history retry lookup stops retry POST, hydration and platform dispatch', async () => {
  const s = makeContext(), lookup = deferred();
  s.context.hydrateGenerationJob = () => s.calls.push(['hydrate']);
  s.context.openTaskCenter = () => s.calls.push(['task-center']);
  s.context.fetch = async (url, options = {}) => {
    s.requests.push({ url, method: options.method || 'GET' });
    if (!options.method) await lookup.promise;
    return { ok: true, json: async () => ({ job: { jobId: 'job-old', prompt: 'history B', platforms: { doubao: { attemptId: 'old:1' } } } }) };
  };
  const retrying = s.context.ui.handleTaskAction('retry', 'job-old', 'doubao'); await tick();
  edit(s); lookup.resolve(); await retrying;
  assert.equal(s.requests.length, 1); assert.equal(s.context.generationJobId, 'job-old');
  assert.equal(s.calls.some(([k]) => ['hydrate', 'platform', 'task-center'].includes(k)), false);
});

test('editing A during generation creation stops late job writes and dispatch, releasing only its loading UI', async () => {
  const s = makeContext(), created = deferred(), action = { disabled: false, textContent: '向所选平台发送', dataset: {}, insertAdjacentHTML() {} }, bridge = { textContent: '' };
  Object.assign(s.context, { doubaoAttemptId: 0, generationRequestKey: '', aReferenceImageUrl: '', doubaoExtensionReady: false, generationPlatforms: { doubao: { state: 'idle', message: '', attemptId: '' } }, renderPlatformStatuses() {} });
  s.context.detailContent = { querySelector: (selector) => selector === '[data-detail-action]' ? action : selector === '#generation-bridge-status' ? bridge : null };
  s.context.window.location = { href: 'http://localhost/', origin: 'http://localhost' };
  s.context.fetch = async () => { await created.promise; return { ok: true, json: async () => ({ job: { jobId: 'late-job', platforms: { doubao: { attemptId: 'late:1' } } } }) }; };
  const generating = s.context.ui.generateResults(); await tick();
  assert.equal(action.disabled, true); edit(s); created.resolve(); await generating;
  assert.equal(s.context.generationJobId, ''); assert.equal(s.context.generationPlatforms.doubao.attemptId, '');
  assert.equal(s.calls.some(([k]) => k === 'platform'), false); assert.equal(action.disabled, false);
});

test('saving unchanged A clears reverted field dirty state and refreshes saved sources', async () => {
  const s = makeContext(); s.context.descriptionAFieldEdits.scene = '自然窗边';
  s.context.refreshSavedDraftFieldSources = () => s.calls.push(['saved-sources']);
  await s.context.ui.saveAgentDraftEdits();
  assert.deepEqual(plain(s.context.descriptionAFieldEdits), {});
  assert.equal(s.calls.some(([k]) => k === 'saved-sources'), true);
});

test('successful changed A confirmation clears the local resend source to match the persisted candidate', async () => {
  const s = makeContext(); s.context.generationResendSourceJobId = 'failed-resend-source'; edit(s);
  await s.context.ui.confirmDescription(); await approve(s);
  const final = s.requests.filter((r) => r.method === 'PUT').at(-1).body;
  assert.equal(final.generationResendSourceJobId, ''); assert.equal(s.context.generationResendSourceJobId, '');
});
