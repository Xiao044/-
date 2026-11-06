const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const declaration = (name) => { const at = source.indexOf(`      const ${name} =`); assert.ok(at >= 0, name); return source.slice(at, source.indexOf('\n      const ', at + 12)); };
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const setup = ({ accepted = false, legacy = false, progress = 4 } = {}) => {
  const calls = [], requests = [];
  const node = (value = '') => ({ value, textContent: '', hidden: true, disabled: false, dataset: {}, attributes: {}, setAttribute(k, v) { this.attributes[k] = String(v); }, removeAttribute(k) { delete this.attributes[k]; }, focus() { calls.push(['focus', this.key]); }, scrollIntoView() {}, classList: { toggle() {}, add() {}, remove() {} } });
  const fields = { productFactsSummary: '珍珠', scene: '窗边', composition: '', lightingMood: '', mustKeep: '保留珍珠', forbidden: '' };
  const inputs = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Object.assign(node(value), { key })]));
  const raw = Object.assign(node('原文 A'), { key: 'descriptionA' });
  const errors = Object.fromEntries(['descriptionA', ...Object.keys(fields)].map((key) => [key, node()]));
  const feedback = node(), preview = node(), fileInput = node();
  const buttons = Object.fromEntries(['save-brief', 'confirm-a', 'regenerate-a'].map((key) => [key, node()]));
  const host = { querySelector(selector) {
    if (selector === '#description-editor') return raw;
    if (selector === '#a-reference-image') return fileInput;
    if (selector === '[data-a-image-feedback]') return feedback;
    if (selector === '[data-a-image-preview]') return preview;
    const error = selector.match(/data-a-field-error="([^"]+)"/); if (error) return errors[error[1]];
    const field = selector.match(/data-agent-field="([^"]+)"/); if (field) return inputs[field[1]];
    const button = selector.match(/data-detail-action="([^"]+)"/); if (button) return buttons[button[1]];
    return null;
  }, querySelectorAll() { return []; } };
  const draft = { rawText: raw.value, fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value: key === 'mustKeep' ? [value] : value }])) };
  const context = {
    detailContents: { a: host }, activeAOperation: null, pendingAConfirmation: null, aImageFeedback: null,
    projectId: 'old', projectApiUrl: '/api/projects/old', projectSession: 0, currentAgentRunId: 'run-a',
    agentRunHistory: [{ runId: 'run-a', accepted, legacyCompatibility: { allowIncompleteSemanticMinimum: legacy }, output: { draft } }],
    descriptionA: raw.value, descriptionADraft: draft, descriptionAStructured: fields, descriptionAFieldEdits: {}, acceptedASnapshot: { rawText: raw.value },
    aReferenceImageUrl: '/old.png', progress, promptB: '旧 B', generatedResults: [{ url: '/old-result.png' }], generationJobId: 'old-job', generationResendSourceJobId: 'resend-old',
    agentBusy: false, interrupted: false, serverSyncQueue: null, productState: { name: '珍珠' }, document: { querySelectorAll: () => [] },
    URL, window: { location: { href: 'http://localhost/' }, confirm: () => { calls.push(['confirm']); return true; } },
    escapeHtml: (value) => String(value).replace(/[&<>"']/g, ''), agentInputSignature: () => JSON.stringify(context.productState),
    resolveAcceptedASnapshot: () => context.acceptedASnapshot,
    captureAOperation: () => ({ projectId: context.projectId, routeUrl: context.projectApiUrl, session: context.projectSession, runId: context.currentAgentRunId, inputSignature: context.agentInputSignature(), content: { rawText: raw.value.trim(), fields: plain(Object.fromEntries(Object.entries(inputs).map(([k,v]) => [k,v.value]))) } }),
    editorAContent: () => context.captureAOperation().content,
    setAOperation: (operation) => { context.activeAOperation = operation; context.agentBusy = Boolean(operation); },
    isAOperationCurrent: (operation) => context.activeAOperation === operation && operation.projectId === context.projectId && operation.session === context.projectSession && operation.routeUrl === context.projectApiUrl && JSON.stringify(operation.content) === JSON.stringify(context.editorAContent()),
    strictAProjectSave: async (operation, candidate) => { const response = await context.fetch(operation.routeUrl, { method: 'PUT', body: JSON.stringify(candidate) }); if (!response.ok) throw new Error('项目未能保存'); return context.isAOperationCurrent(operation); },
    serializeProject: () => plain({ projectId: context.projectId, descriptionA: context.descriptionA, acceptedASnapshot: context.acceptedASnapshot, aReferenceImageUrl: context.aReferenceImageUrl, promptB: context.promptB, generatedResults: context.generatedResults, generationJobId: context.generationJobId, progress: context.progress }),
    confirmedAProject: (content) => ({ ...context.serializeProject(), acceptedASnapshot: content, promptB: '', generatedResults: [], generationJobId: '', progress: 3 }),
    resetDownstream: () => { calls.push(['reset']); context.progress = 3; context.promptB = ''; context.generatedResults = []; context.generationJobId = ''; },
    persistState: () => calls.push(['persist']), syncProject: async () => calls.push(['sync']), openDetail: () => { calls.push(['rebuild']); raw.value = context.descriptionA; },
    showToast: (message) => calls.push(['toast', message]), refreshAConfirmationState() {}, hasADownstream: () => false, isAConfirmationPending: () => false,
    confirmDescriptionOperation: async () => calls.push(['accept']), openModal() {}, modalSession: 0,
  };
  context.fetch = async (url, options = {}) => { requests.push({ url, method: options.method, body: options.body }); return { ok: true, status: 200, json: async () => ({ url: '/uploads/old/new.png', project: {} }) }; };
  const optional = ['requiresASemanticValidation', 'aFieldInput', 'setAFieldError', 'showAFieldErrors', 'clearCorrectedAFieldError', 'renderAFieldRequirement', 'refreshAFieldRequirements', 'refreshAImageFeedback', 'setAImageFeedback', 'refreshAImagePreview', 'isAImageUploadCurrent'];
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('      const agentDraftFieldDefinitions ='), source.indexOf('      const getDraftField =')) + '\n' + [...optional.filter((name) => source.includes(`      const ${name} =`)), 'validateDescriptionAConfirmation', 'confirmDescription', 'uploadABriefImage'].map(declaration).join('\n') + '\nglobalThis.ui = { validateDescriptionAConfirmation, confirmDescription, uploadABriefImage' + optional.filter((name) => source.includes(`      const ${name} =`)).map((name) => `, ${name}`).join('') + ' };', context);
  return { context, calls, requests, raw, inputs, errors, feedback, preview, fileInput, buttons };
};
const file = { type: 'image/png', size: 100 };

test('confirmation locates every missing required field without requests or resetting downstream', async () => {
  const s = setup(); s.raw.value = ' '; for (const key of ['productFactsSummary', 'scene', 'mustKeep']) s.inputs[key].value = ' ';
  await s.context.ui.confirmDescription();
  assert.deepEqual(s.calls.filter(([kind]) => kind === 'focus'), [['focus', 'descriptionA']]);
  for (const key of ['descriptionA', 'productFactsSummary', 'scene', 'mustKeep']) { assert.equal(s.errors[key].hidden, false); assert.match(s.errors[key].textContent, /不能为空|请/); assert.equal((key === 'descriptionA' ? s.raw : s.inputs[key]).attributes['aria-invalid'], 'true'); }
  assert.equal(s.requests.length, 0); assert.equal(s.context.promptB, '旧 B'); assert.equal(s.context.aReferenceImageUrl, '/old.png');
});
test('correcting one field clears only its error and valid confirmation keeps optional fields optional', async () => {
  const s = setup(); s.inputs.scene.value = ''; s.inputs.mustKeep.value = '';
  await s.context.ui.confirmDescription(); s.inputs.scene.value = '新场景';
  assert.ok(s.context.ui.clearCorrectedAFieldError); s.context.ui.clearCorrectedAFieldError('scene');
  assert.equal(s.errors.scene.hidden, true); assert.equal(s.errors.mustKeep.hidden, false);
  s.inputs.mustKeep.value = '保留珍珠'; await s.context.ui.confirmDescription(); assert.equal(s.calls.filter(([kind]) => kind === 'accept').length, 1);
});
test('accepted and legacy compatibility preserve existing semantic exemption', async () => {
  for (const options of [{ accepted: true }, { legacy: true }]) { const s = setup(options); s.raw.value = ''; Object.values(s.inputs).forEach((input) => { input.value = ''; }); await s.context.ui.confirmDescription(); assert.equal(s.calls.some(([kind]) => kind === 'accept'), true); }
});
test('invalid type and oversized references show persistent safe errors without requests', async () => {
  for (const candidate of [{ type: 'text/plain', size: 1 }, { type: 'image/png', size: 8 * 1024 * 1024 + 1 }]) { const s = setup(); await s.context.ui.uploadABriefImage(candidate); assert.equal(s.feedback.hidden, false); assert.match(s.feedback.textContent, /PNG|8MB/); assert.equal(s.requests.length, 0); assert.equal(s.context.promptB, '旧 B'); }
});
test('HTTP, network and invalid responses preserve all text, reference and downstream with persistent errors', async () => {
  for (const mode of ['http', 'network', 'missing', 'bad-url']) {
    const s = setup(); s.raw.value = '尚未保存原文'; s.inputs.scene.value = '尚未保存场景';
    s.context.fetch = async () => { if (mode === 'network') throw new Error('sensitive-internal-body'); return { ok: mode !== 'http', status: 500, json: async () => ({ error: 'sensitive-internal-body', ...(mode === 'bad-url' ? { url: 'javascript:alert(1)' } : {}) }) }; };
    await s.context.ui.uploadABriefImage(file); assert.equal(s.feedback.hidden, false); assert.doesNotMatch(s.feedback.textContent, /sensitive|javascript/); assert.equal(s.raw.value, '尚未保存原文'); assert.equal(s.inputs.scene.value, '尚未保存场景'); assert.equal(s.context.aReferenceImageUrl, '/old.png'); assert.equal(s.context.promptB, '旧 B'); assert.equal(s.calls.some(([kind]) => kind === 'reset'), false);
  }
});
test('success updates only attachment, saves binding before reset and keeps unsaved A and baseline', async () => {
  const s = setup(); s.raw.value = '尚未保存原文'; s.inputs.scene.value = '尚未保存场景'; const baseline = plain(s.context.acceptedASnapshot);
  await s.context.ui.uploadABriefImage(file);
  assert.equal(s.raw.value, '尚未保存原文'); assert.equal(s.inputs.scene.value, '尚未保存场景'); assert.equal(s.calls.some(([kind]) => kind === 'rebuild'), false);
  assert.equal(s.context.aReferenceImageUrl, '/uploads/old/new.png'); assert.deepEqual(plain(s.context.acceptedASnapshot), baseline);
  const put = s.requests.find((request) => request.method === 'PUT'); assert.ok(put); assert.equal(JSON.parse(put.body).aReferenceImageUrl, '/uploads/old/new.png'); assert.equal(s.calls.filter(([kind]) => kind === 'reset').length, 1);
});
test('binding failure retains reference/downstream and never announces success', async () => {
  const s = setup(); s.context.fetch = async (url, options) => ({ ok: options.method !== 'PUT', status: 500, json: async () => ({ url: '/uploads/old/new.png' }) });
  await s.context.ui.uploadABriefImage(file); assert.equal(s.context.aReferenceImageUrl, '/old.png'); assert.equal(s.context.promptB, '旧 B'); assert.equal(s.feedback.hidden, false); assert.equal(s.calls.some(([kind]) => kind === 'reset'), false); assert.equal(s.calls.some(([kind,message]) => kind === 'toast' && /已上传/.test(message)), false);
});
test('old upload response cannot modify or sync a new project', async () => {
  const s = setup(); const gate = deferred(); s.context.fetch = async () => gate.promise;
  const pending = s.context.ui.uploadABriefImage(file); await tick(); s.context.projectId = 'new'; s.context.projectApiUrl = '/api/projects/new'; s.context.projectSession++;
  gate.resolve({ ok: true, json: async () => ({ url: '/old-project-upload.png' }) }); await pending;
  assert.equal(s.context.aReferenceImageUrl, '/old.png'); assert.equal(s.calls.some(([kind]) => ['sync','persist','reset','rebuild'].includes(kind)), false);
});
test('pending upload locks A confirmation and duplicate upload, then permits editing before final save', async () => {
  const s = setup(); const gate = deferred(); let posts = 0;
  s.context.fetch = async (url, options) => { if (options.method === 'POST') { posts++; return gate.promise; } return { ok: true, json: async () => ({}) }; };
  const pending = s.context.ui.uploadABriefImage(file); await tick(); await s.context.ui.confirmDescription(); const duplicate = s.context.ui.uploadABriefImage(file); await tick(); const observedPosts = posts; const observedAccept = s.calls.some(([kind]) => kind === 'accept');
  s.raw.value = '上传期间继续编辑'; gate.resolve({ ok: true, json: async () => ({ url: '/uploads/old/new.png' }) }); await Promise.all([pending, duplicate]); assert.equal(observedPosts, 1); assert.equal(observedAccept, false); assert.equal(s.raw.value, '上传期间继续编辑'); assert.equal(s.context.activeAOperation, null);
});
test('late JSON and superseded upload finalizers do not overwrite or unlock another operation', async () => {
  const s = setup(); const gate = deferred(); s.context.fetch = async () => ({ ok: true, json: () => gate.promise });
  const pending = s.context.ui.uploadABriefImage(file); await tick(); const next = { projectId: 'new-operation' }; s.context.activeAOperation = next; s.feedback.textContent = '新操作提示'; s.feedback.hidden = false;
  gate.resolve({ url: '/uploads/old/new.png' }); await pending; assert.equal(s.context.activeAOperation, next); assert.equal(s.context.aReferenceImageUrl, '/old.png'); assert.equal(s.feedback.textContent, '新操作提示');
});


test('real field input delegation clears the corrected error and retains other errors', async () => {
  const s = setup(); s.raw.value = ''; s.inputs.scene.value = ''; await s.context.ui.confirmDescription();
  let listener; s.context.workflowCanvas = { addEventListener: (type, handler) => { listener = handler; } }; s.context.refreshDraftFieldSource = () => {};
  const registration = source.match(/^      workflowCanvas\.addEventListener\('input', \(event\) => \{[\s\S]*?^      \}\);/m); assert.ok(registration);
  vm.runInContext(registration[0], s.context);
  s.raw.value = '修正原文'; listener({ target: { id: 'description-editor' } });
  assert.equal(s.errors.descriptionA.hidden, true); assert.equal(s.errors.scene.hidden, false);
  s.inputs.scene.value = '新场景'; s.inputs.scene.dataset.agentField = 'scene'; listener({ target: { closest: () => s.inputs.scene } });
  assert.equal(s.errors.scene.hidden, true); assert.equal(s.context.descriptionAFieldEdits.scene, '新场景');
});
test('real file change delegation clears its value so the same file can be selected again', () => {
  let listener, uploads = 0; const context = { workflowCanvas: { addEventListener: (type, handler) => { listener = handler; } }, uploadABriefImage: () => { uploads++; } };
  const registration = source.match(/^      workflowCanvas\.addEventListener\('change', \(event\) => \{[\s\S]*?^      \}\);/m); vm.runInNewContext(registration[0], context);
  const target = { id: 'a-reference-image', value: 'C:\\fakepath\\same.png', files: [file], matches: () => false };
  listener({ target }); assert.equal(target.value, ''); listener({ target }); assert.equal(uploads, 2);
});
test('initial A upload preserves its unconfirmed progress and Chinese project upload URLs', async () => {
  const s = setup({ progress: 2 }); s.context.projectId = '中文项目'; s.context.projectApiUrl = '/api/projects/中文项目'; s.context.acceptedASnapshot = null;
  const url = `/uploads/${encodeURIComponent(s.context.projectId)}/reference.png`;
  s.context.fetch = async (route, options) => { s.requests.push({ route, method: options.method, body: options.body }); return { ok: true, json: async () => ({ url }) }; };
  await s.context.ui.uploadABriefImage(file); assert.equal(s.context.progress, 2); assert.equal(s.context.acceptedASnapshot, null); assert.equal(s.context.aReferenceImageUrl, url); assert.equal(s.calls.some(([kind]) => kind === 'reset'), false); assert.equal(s.feedback.hidden, false); assert.match(s.feedback.textContent, /已上传并保存/);
});
test('upload waits for the old sync queue and captures later text before readonly binding', async () => {
  const s = setup(); const queue = deferred(), put = deferred(); s.context.serverSyncQueue = queue.promise;
  s.context.setAgentBusy = (busy) => { s.context.agentBusy = Boolean(busy); };
  vm.runInContext([declaration('refreshAConfirmationState'), declaration('setAOperation'), declaration('strictAProjectSave')].join('\n'), s.context);
  s.context.fetch = async (url, options) => { s.requests.push({ url, method: options.method }); if (options.method === 'PUT') return put.promise; return { ok: true, json: async () => ({ url: '/uploads/old/new.png' }) }; };
  const pending = s.context.ui.uploadABriefImage(file); await tick(); assert.equal(s.requests.filter((request) => request.method === 'PUT').length, 0); assert.equal(s.raw.readOnly, false); assert.equal(s.buttons['save-brief'].disabled, true);
  s.raw.value = '排队时的新文字'; queue.resolve(); await tick(); assert.equal(s.raw.readOnly, true); assert.equal(s.context.promptB, '旧 B'); assert.equal(s.context.aReferenceImageUrl, '/old.png');
  put.resolve({ ok: true }); await pending; assert.equal(s.raw.readOnly, false); assert.equal(s.buttons['save-brief'].disabled, false); assert.equal(s.raw.value, '排队时的新文字'); assert.equal(s.context.aReferenceImageUrl, '/uploads/old/new.png');
});
test('stale binding response cannot update a new project or release its new operation', async () => {
  const s = setup(); const put = deferred();
  s.context.fetch = async (url, options) => { s.requests.push({ url, method: options.method }); return options.method === 'PUT' ? put.promise : { ok: true, json: async () => ({ url: '/uploads/old/new.png' }) }; };
  const pending = s.context.ui.uploadABriefImage(file); await tick(); s.context.projectId = 'new'; s.context.projectApiUrl = '/api/projects/new'; s.context.projectSession++; const newer = { projectId: 'new' }; s.context.activeAOperation = newer;
  put.resolve({ ok: true }); await pending; assert.equal(s.context.activeAOperation, newer); assert.equal(s.context.aReferenceImageUrl, '/old.png'); assert.equal(s.calls.some(([kind]) => ['reset','persist','sync'].includes(kind)), false); assert.equal(s.requests.filter((request) => request.method === 'PUT').every((request) => request.url === '/api/projects/old'), true);
});

test('reopening A during its final reference binding preserves the live editor and commits locally', async () => {
  const s = setup(); const put = deferred(); const host = s.context.detailContents.a;
  s.context.stepNodes = { a: { classList: { contains: () => false, add() {} }, querySelector: () => ({}), scrollIntoView() {} } };
  s.context.revealDetail = () => {}; s.context.renderAgentWarnings = () => ''; s.context.renderAgentDraftFields = () => '';
  s.context.window.matchMedia = () => ({ matches: true });
  Object.defineProperty(host, 'innerHTML', { set(value) { s.calls.push(['rebuild']); const match = value.match(/<textarea id="description-editor"[^>]*>([\s\S]*?)<\/textarea>/); s.raw.value = match?.[1] || ''; } });
  vm.runInContext([declaration('openDetail'), declaration('strictAProjectSave'), 'globalThis.ui.openDetail = openDetail;'].join('\n'), s.context);
  s.raw.value = '绑定前未保存的原文'; s.inputs.scene.value = '绑定前未保存的场景';
  s.context.fetch = async (url, options) => { s.requests.push({ url, method: options.method, body: options.body }); return options.method === 'PUT' ? put.promise : { ok: true, json: async () => ({ url: '/uploads/old/new.png' }) }; };
  const pending = s.context.ui.uploadABriefImage(file); await tick(); assert.equal(s.context.activeAOperation.committing, true);
  s.context.ui.openDetail('a'); const preservedRaw = s.raw.value; const rebuilt = s.calls.some(([kind]) => kind === 'rebuild');
  put.resolve({ ok: true }); await pending;
  assert.equal(preservedRaw, '绑定前未保存的原文'); assert.equal(rebuilt, false); assert.equal(s.inputs.scene.value, '绑定前未保存的场景');
  assert.equal(s.context.aReferenceImageUrl, '/uploads/old/new.png'); assert.equal(s.context.promptB, ''); assert.equal(s.context.activeAOperation, null); assert.match(s.feedback.textContent, /已上传并保存/);
});
