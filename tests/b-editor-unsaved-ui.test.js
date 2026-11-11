const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixture = fs.readFileSync(path.join(__dirname, 'scene-flow-ui.test.js'), 'utf8').replace(/\r\n/g, '\n');
const { makeContext, source, declaration } = new Function('require', '__dirname', fixture.slice(0, fixture.indexOf('\ntest(')) + '\nreturn { makeContext, source, declaration };')(require, __dirname);
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const ids = { positivePrompt: 'prompt-editor', negativePrompt: 'negative-prompt-editor', aspectRatio: 'aspect-ratio-editor', platformParamsText: 'platform-params-editor' };
const decode = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const setup = () => {
  const s = makeContext({ downstream: true }), c = s.context;
  Object.assign(c, { promptBEdit: null, promptB: '旧 B', negativePrompt: '旧负面', aspectRatio: '4:5', platformParams: { seed: 42 }, promptBSource: 'template:old@v2', promptBTemplateId: 'old', promptBTemplateVersion: 2, allowedAspectRatios: ['1:1', '4:5', '3:4', '9:16', '16:9'], maxPlatformParams: 30, guardAConfirmation: () => true, bPlatformOverridesBaseline: () => c.platformOverrides, readPlatformOverridesEditor: () => ({ errors: [], platformOverrides: c.platformOverrides }) });
  const controls = Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, { id, value: '', closest: () => null, matches: () => false }]));
  let present = true;
  const host = { querySelector(selector) { return present ? Object.values(controls).find((input) => selector === '#' + input.id) || null : null; }, querySelectorAll() { return []; } };
  Object.defineProperty(host, 'innerHTML', { set(html) { for (const [key, id] of Object.entries(ids)) { const matched = key === 'aspectRatio' ? html.match(/<option value="([^"]+)" selected>/) : html.match(new RegExp('<textarea id="' + id + '"[^>]*>([\\s\\S]*?)<\\/textarea>')); // HTML parsing removes one initial LF immediately after a textarea start tag.
      const decoded = decode(matched?.[1] ?? ''); controls[key].value = key === 'aspectRatio' ? decoded : decoded.replace(/^\n/, ''); } } });
  c.detailContents.b = host;
  const query = c.document.querySelector;
  c.document.querySelector = (selector) => host.querySelector(selector) || query(selector);
  const node = { classList: { contains: () => false, add() {}, remove() {} }, querySelector: () => ({ classList: { remove() {} } }), scrollIntoView() {} };
  c.stepNodes.b = node; c.revealDetail = () => {}; c.refreshAConfirmationState = () => {};
  c.escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  c.workflowCanvas = { addEventListener(type, listener) { (c.listeners[type] ||= []).push(listener); } }; c.listeners = {};
  c.window.setTimeout = (fn) => s.calls.push(['timer', fn]);
  const helpers = []; // The shared scene fixture loads the optional B helpers.
  const inputStart = source.indexOf("      workflowCanvas.addEventListener('input', (event) => {", source.indexOf("message.type === 'PLATFORM_IMPORTED'"));
  const inputEnd = source.indexOf("\n      modal.addEventListener('click'", inputStart);
  const changeStart = source.indexOf("      workflowCanvas.addEventListener('change', (event) => {");
  const changeEnd = source.indexOf("\n\n      window.addEventListener('message'", changeStart);
  vm.runInContext([...helpers.map(declaration), ...['validatePlatformParams', 'parsePlatformParamsEditor', 'validateBExecution', 'clearPromptBTemplateProvenance', 'readBExecutionFields', 'confirmPrompt', 'resendPromptB', 'openDetail', 'closeDetail', 'restoreProjectFromServer', 'createProject', 'restoreVersion', 'reloadImportedProject', 'importProjectFromFile'].map(declaration), source.slice(inputStart, inputEnd), source.slice(changeStart, changeEnd), 'globalThis.bui = { openDetail, closeDetail, readBExecutionFields, confirmPrompt, resendPromptB, restoreProjectFromServer, createProject, restoreVersion, importProjectFromFile, resetDownstream, serializeProject, persistState };'].join('\n'), c);
  c.bui.openDetail('b', false);
  s.controls = controls;
  s.edit = (values, type = 'input') => { for (const [key, value] of Object.entries(values)) { controls[key].value = value; for (const listener of c.listeners[type]) listener({ target: controls[key] }); } };
  s.values = () => Object.fromEntries(Object.entries(controls).map(([key, input]) => [key, input.value]));
  s.reopen = () => { c.bui.closeDetail('b'); c.bui.openDetail('b', false); };
  s.removeEditor = () => { present = false; };
  s.startup = (saved) => { s.storage.set(c.storageKey, JSON.stringify(saved)); const start = source.indexOf("      try {\n        const saved = JSON.parse(window.localStorage.getItem(storageKey)"); const end = source.indexOf('\n      resolveAcceptedASnapshot();\n      renderProduct();', start); vm.runInContext(source.slice(start, end), c); };
  return s;
};
const edits = { positivePrompt: '  新 <B>\n第二行  ', negativePrompt: ' \n不要水印 ', aspectRatio: '16:9', platformParamsText: ' {unfinished json\n ' };

test('B input caches four exact raw values locally without changing canonical execution or history', () => {
  const s = setup(), c = s.context, before = plain(c.bui.serializeProject()); s.edit(edits); assert.ok(s.storage.has(c.storageKey), 'B input must persist local edits'); const saved = JSON.parse(s.storage.get(c.storageKey));
  assert.deepEqual(saved.promptBEdit, edits); assert.deepEqual(plain(c.promptBEdit), edits);
  const after = plain(c.bui.serializeProject()); for (const key of ['promptB', 'negativePrompt', 'aspectRatio', 'platformParams', 'promptBSource', 'promptBVersion', 'promptBTemplateId', 'generatedResults', 'generationJobId', 'versions']) assert.deepEqual(after[key], before[key], key);
  assert.equal(s.requests.length, 0);
});
test('B close reopen and repeated navigation preserve raw strings, empty values and invalid JSON', () => {
  for (const values of [edits, { positivePrompt: '', negativePrompt: '', aspectRatio: '1:1', platformParamsText: '' }]) { const s = setup(); s.edit(values); s.reopen(); s.context.bui.openDetail('b', false); assert.deepEqual(s.values(), values); }
});
test('ratio change alone persists and restores without relying on an input event', () => {
  const s = setup(); s.edit({ aspectRatio: '9:16' }, 'change'); s.reopen(); assert.equal(s.controls.aspectRatio.value, '9:16'); assert.equal(JSON.parse(s.storage.get(s.context.storageKey)).promptBEdit.aspectRatio, '9:16'); assert.equal(s.requests.length, 0);
});
test('no-DOM B collection uses cached text with existing trim and JSON validation', () => {
  const s = setup(); s.edit(edits); s.removeEditor(); const invalid = s.context.bui.readBExecutionFields(); assert.equal(invalid.positivePrompt, '新 <B>\n第二行'); assert.equal(invalid.aspectRatio, '16:9'); assert.ok(invalid.errors.some((message) => message.includes('JSON')));
});
test('invalid B confirmation keeps editing cache and all old downstream state', () => {
  const s = setup(); s.edit(edits); const before = plain(s.context.bui.serializeProject()); s.context.bui.confirmPrompt(); s.reopen(); assert.deepEqual(s.values(), edits); assert.equal(s.context.promptB, before.promptB); assert.deepEqual(plain(s.context.generatedResults), before.generatedResults); assert.equal(s.requests.length, 0);
});
test('cancelled B confirmation and resend retain exact edits and do not submit', () => {
  for (const action of ['confirmPrompt', 'resendPromptB']) { const s = setup(); s.context.progress = 5; s.context.window.confirm = () => false; const values = { ...edits, platformParamsText: ' {"seed": 9} ' }; s.edit(values); s.context.bui[action](); s.reopen(); assert.deepEqual(s.values(), values); assert.equal(s.context.promptB, '旧 B'); assert.equal(s.requests.length, 0); }
});
test('successful B confirmation and resend clear cache after committing canonical values and old DOM', async () => {
  for (const action of ['confirmPrompt', 'resendPromptB']) { const s = setup(); s.edit({ ...edits, platformParamsText: ' {"seed": 9} ' }); s.context.openDetail = () => {}; s.context.bui[action](); await s.context.serverSyncQueue; assert.equal(s.context.promptBEdit, null); assert.equal(s.context.promptB, '新 <B>\n第二行'); assert.equal(s.context.negativePrompt, '不要水印'); assert.equal(s.context.aspectRatio, '16:9'); assert.deepEqual(plain(s.context.platformParams), { seed: 9 }); assert.equal(s.controls.positivePrompt.value, s.context.promptB); assert.equal(s.requests.at(-1).body.promptBEdit, null); s.reopen(); assert.equal(s.controls.platformParamsText.value, JSON.stringify({ seed: 9 }, null, 2)); }
});
test('startup restores empty or malformed JSON editing strings and old projects have no cache', () => {
  for (const cache of [edits, { positivePrompt: '', negativePrompt: '', aspectRatio: '1:1', platformParamsText: '' }, null]) { const s = setup(); s.startup({ promptB: '持久 B', ...(cache ? { promptBEdit: cache } : {}) }); s.context.bui.openDetail('b', false); assert.deepEqual(plain(s.context.promptBEdit), cache); assert.equal(s.controls.positivePrompt.value, cache ? cache.positivePrompt : '持久 B'); }
});
test('startup does not fetch over an existing local B edit and in-flight newer edits prevent reload', async () => {
  const cached = setup(); cached.edit(edits); let reads = 0; cached.context.fetch = async () => { reads++; return { ok: true, json: async () => ({ project: { updatedAt: '2099-01-01' } }) }; }; await cached.context.bui.restoreProjectFromServer(); assert.equal(reads, 0);
  for (const stage of ['fetch', 'json', 'project']) { const s = setup(), gate = deferred(); let reloads = 0; s.context.window.location = { reload: () => reloads++ }; s.context.fetch = stage === 'json' ? async () => ({ ok: true, json: () => gate.promise }) : () => gate.promise; const restoring = s.context.bui.restoreProjectFromServer(); await tick(); if (stage === 'project') s.context.projectSession++; else s.edit(edits); gate.resolve(stage === 'json' ? { project: { updatedAt: '2099-01-01' } } : { ok: true, json: async () => ({ project: { updatedAt: '2099-01-01' } }) }); await restoring; assert.equal(reloads, 0); if (stage !== 'project') assert.deepEqual(plain(s.context.promptBEdit), edits); }
});
test('downstream-only reset preserves B edits while A replacement clears cache and stale B DOM', () => {
  const s = setup(); s.edit(edits); s.context.bui.resetDownstream(3); s.reopen(); assert.deepEqual(s.values(), edits); s.context.bui.resetDownstream(2); assert.equal(s.context.promptBEdit, null); assert.equal(s.controls.positivePrompt.value, ''); s.reopen(); assert.equal(s.controls.platformParamsText.value, '{}');
});
test('new projects clear B editing cache and old controls before saving their empty B', async () => {
  const s = setup(); s.edit(edits); let reloads = 0; s.context.window.location = { reload: () => reloads++ }; await s.context.bui.createProject(); assert.equal(s.context.promptBEdit, null); assert.equal(s.controls.positivePrompt.value, ''); assert.equal(JSON.parse(s.storage.get(s.context.storageKey)).promptBEdit, null); assert.equal(reloads, 1);
});
test('version replacement drops the prior B edit while failed restoration keeps it', async () => {
  for (const failure of [true, false]) { const s = setup(); s.edit(edits); s.context.window.location = { reload() {} }; s.context.fetch = async () => ({ ok: !failure, json: async () => ({ project: { promptB: '版本 B', promptBEdit: edits } }) }); if (failure) { await assert.rejects(s.context.bui.restoreVersion({ versionId: 'v1' })); assert.deepEqual(plain(s.context.promptBEdit), edits); } else { await s.context.bui.restoreVersion({ versionId: 'v1' }); const saved = JSON.parse(s.storage.get(s.context.storageKey)); assert.equal(saved.promptBEdit, null); assert.equal(saved.promptB, '版本 B'); } }
});

test('B templates keep cancelled edits and clear stale cache and controls after applying new content', async () => {
  const s = setup(), c = s.context; s.edit(edits); c.progress = 5;
  c.templateApplyCandidate = { templateId: 'new-template', version: 3 };
  c.templateApplyFields = () => ({ mode: 'b', positivePrompt: '模板 B', negativePrompt: '模板负面', aspectRatio: '3:4', platformParams: { seed: 7 }, platformOverrides: {} });
  vm.runInContext(declaration('validatePlatformOverrides') + '\n' + declaration('applyPromptTemplate') + '\nglobalThis.applyTemplate = applyPromptTemplate;', c);
  c.window.confirm = () => false; await c.applyTemplate(); assert.deepEqual(plain(c.promptBEdit), edits); assert.equal(s.controls.positivePrompt.value, edits.positivePrompt); assert.equal(s.requests.length, 0);
  c.window.confirm = () => true; await c.applyTemplate(); assert.equal(c.promptBEdit, null); assert.equal(c.promptB, '模板 B'); assert.equal(s.controls.positivePrompt.value, '模板 B'); assert.equal(s.controls.platformParamsText.value, JSON.stringify({ seed: 7 }, null, 2)); assert.equal(c.promptBTemplateId, 'new-template'); assert.equal(s.requests.at(-1).body.promptBEdit, null);
});
test('strict A downstream replacement clears B editing cache in its server candidate without altering an unchanged B', () => {
  const s = setup(), c = s.context; s.edit(edits);
  vm.runInContext(declaration('confirmedAProject') + '\nglobalThis.aCandidate = confirmedAProject;', c);
  assert.deepEqual(plain(c.aCandidate({ rawText: 'A' }, false).promptBEdit), edits);
  const candidate = c.aCandidate({ rawText: 'A' }, true); assert.equal(candidate.promptBEdit, null); assert.equal(candidate.promptB, ''); assert.deepEqual(plain(c.promptBEdit), edits);
});
test('B import clears replacement cache, with cancellation failure and warning reload retaining correct snapshots', async () => {
  for (const mode of ['cancel', 'fail', 'success', 'warnings']) {
    const s = setup(), c = s.context; s.edit(edits); const before = s.storage.get(c.storageKey);
    c.latestProjectImportRequestId = 0; c.projectImportInput = { value: 'picked.json' }; let reloads = 0; c.window.location = { reload: () => reloads++ }; c.window.confirm = () => mode !== 'cancel';
    const imported = { projectId: c.projectId, promptB: '导入 B', negativePrompt: '导入负面', promptBEdit: edits, product: { name: '导入商品' } };
    c.fetch = async (url, options) => { s.requests.push({ url, method: options.method, body: JSON.parse(options.body) }); return { ok: mode !== 'fail', json: async () => ({ project: imported, warnings: mode === 'warnings' ? [{ code: 'UPLOAD_MISSING', path: '/uploads/test/missing.png', message: '请补齐图片' }] : [] }) }; };
    await c.bui.importProjectFromFile({ text: async () => JSON.stringify({ project: [imported] }) });
    if (mode === 'cancel' || mode === 'fail') { assert.equal(s.storage.get(c.storageKey), before); assert.deepEqual(plain(c.promptBEdit), edits); assert.equal(s.controls.positivePrompt.value, edits.positivePrompt); assert.equal(reloads, 0); assert.equal(s.requests.length, mode === 'cancel' ? 0 : 1); }
    else { const saved = JSON.parse(s.storage.get(c.storageKey)); assert.equal(saved.promptBEdit, null); assert.equal(saved.promptB, '导入 B'); assert.equal(saved.negativePrompt, '导入负面'); assert.equal(s.requests[0].body.mode, 'replace'); if (mode === 'warnings') { assert.equal(c.pendingImportedProjectReload, true); assert.equal(reloads, 0); const snapshot = s.storage.get(c.storageKey); vm.runInContext('reloadImportedProject();', c); assert.equal(reloads, 1); assert.equal(s.storage.get(c.storageKey), snapshot); } else assert.equal(reloads, 1); }
  }
});
test('malformed legacy B editing cache is ignored instead of breaking startup', () => {
  for (const cache of [{ positivePrompt: 'partial' }, { ...edits, aspectRatio: 'bad' }, 'not-an-object']) { const s = setup(); s.startup({ promptB: '兼容 B', promptBEdit: cache }); assert.equal(s.context.promptBEdit, null); s.reopen(); assert.equal(s.controls.positivePrompt.value, '兼容 B'); }
});


test('opening B preserves leading line feeds after standard textarea HTML parsing', () => {
  const cases = [
    { positivePrompt: '\nB 首行换行', negativePrompt: '\n负面首行', aspectRatio: '16:9', platformParamsText: '\n{invalid json' },
    { positivePrompt: '\n\nB 多首行', negativePrompt: '\n\n负面首行', aspectRatio: '16:9', platformParamsText: '\n\n{invalid json' },
    { positivePrompt: '\n', negativePrompt: '\n', aspectRatio: '16:9', platformParamsText: '\n' }
  ];
  for (const values of cases) {
    const s = setup(); s.edit(values); s.reopen(); assert.deepEqual(s.values(), values);
    s.context.bui.openDetail('b', false); assert.deepEqual(s.values(), values);
    const saved = JSON.parse(s.storage.get(s.context.storageKey)); s.startup(saved); s.context.bui.openDetail('b', false); assert.deepEqual(s.values(), values);
  }
});
