const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// Share the existing real-source fixture without registering its test cases.
const fixture = fs.readFileSync(path.join(__dirname, 'a-confirmation-ui.test.js'), 'utf8').replace(/\r\n/g, '\n');
const { makeContext, source, declaration } = new Function('require', '__dirname', fixture.slice(0, fixture.indexOf('const approve =')) + '\nreturn { makeContext, source, declaration };')(require, __dirname);
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const setup = (options) => {
  const s = makeContext(options), c = s.context, host = c.detailContents.a;
  c.descriptionARawEdit = null; c.aReferenceImageUrl = '';
  c.workflowCanvas = { addEventListener(type, listener) { if (type === 'input') c.inputListener = listener; } };
  c.escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  c.revealDetail = () => {};
  c.renderAgentWarnings = () => '';
  c.renderAgentDraftFields = () => '';
  c.refreshAImageFeedback = () => {};
  c.refreshAImagePreview = () => {};
  c.window.matchMedia = () => ({ matches: true });
  c.stepNodes = { a: { classList: { contains: () => false, add() {}, remove() {} }, querySelector: () => ({ classList: { remove() {} } }), scrollIntoView() {} } };
  c.commitPlatformOverrides = () => {};
  Object.defineProperty(host, 'innerHTML', { set(html) { const text = html.match(/<textarea id="description-editor"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? ''; s.raw.value = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'); } });
  const listenerStart = source.indexOf("      workflowCanvas.addEventListener('input', (event) => {", source.indexOf("message.type === 'PLATFORM_IMPORTED'"));
  const listenerEnd = source.indexOf("\n      modal.addEventListener('click'", listenerStart);
  assert.ok(listenerStart > 0 && listenerEnd > listenerStart);
  vm.runInContext([declaration('openDetail'), declaration('closeDetail'), source.slice(listenerStart, listenerEnd), 'globalThis.ui.openDetail = openDetail; globalThis.ui.closeDetail = closeDetail;'].join('\n'), c);
  s.edit = (value) => { s.raw.value = value; c.inputListener({ target: { id: 'description-editor', value, closest: () => null } }); };
  s.reopen = () => { c.ui.closeDetail('a'); c.ui.openDetail('a', false); };
  return s;
};

test('raw input is cached locally without changing saved A, accepted baseline or downstream', () => {
  const s = setup(); const original = plain(s.context.descriptionADraft);
  s.edit('  未保存的原文\n第二行  ');
  assert.equal(s.context.descriptionARawEdit, '  未保存的原文\n第二行  ');
  assert.equal(s.context.descriptionA, '原 A'); assert.deepEqual(plain(s.context.descriptionADraft), original);
  assert.equal(s.context.promptB, '旧 B'); assert.equal(s.requests.length, 0); assert.ok(s.calls.some(([kind]) => kind === 'persist'));
});

test('ordinary close, reopen and repeated A navigation retain raw edits including empty strings', () => {
  for (const value of ['尚未保存的 <原文>\n二行', '', ' \n  ']) {
    const s = setup(); s.edit(value); s.reopen(); s.context.ui.openDetail('a', false);
    assert.equal(s.raw.value, value); assert.equal(s.context.descriptionA, '原 A'); assert.equal(s.context.promptB, '旧 B'); assert.equal(s.requests.length, 0);
  }
});

test('reopened unsaved A continues blocking B while a value restored to the baseline permits it', async () => {
  const s = setup(); s.edit('修改后未确认'); s.reopen();
  assert.equal(s.context.ui.isAConfirmationPending(), true); await s.context.ui.confirmPrompt(); assert.equal(s.calls.some(([kind]) => kind === 'read-b'), false);
  s.edit('原 A'); s.reopen(); assert.equal(s.context.ui.isAConfirmationPending(), false);
});

test('no-DOM content comparison and save collection use the cached raw text', () => {
  const s = setup(); s.edit('  无 DOM 编辑\n  '); const query = s.context.detailContents.a.querySelector;
  s.context.detailContents.a.querySelector = (selector) => selector === '#description-editor' ? null : query(selector);
  vm.runInContext('globalThis.collect = collectAgentDraftPatch;', s.context);
  assert.equal(s.context.ui.editorAContent().rawText, '无 DOM 编辑'); assert.equal(s.context.collect().nextDescription, '无 DOM 编辑');
});

test('successful explicit save clears the persisted raw cache while failed project save retains it', async () => {
  const good = setup(); good.edit('  保存新原文  '); await good.context.ui.saveAgentDraftEdits();
  assert.equal(good.context.descriptionARawEdit, null); assert.equal(good.context.descriptionA, '保存新原文');
  assert.equal(good.requests.filter((request) => request.method === 'PUT').at(-1).body.descriptionARawEdit, null);
  const bad = setup(); bad.edit('失败仍保留'); const fetch = bad.context.fetch;
  bad.context.fetch = (url, options) => options.method === 'PUT' ? Promise.resolve({ ok: false }) : fetch(url, options);
  await assert.rejects(bad.context.ui.saveAgentDraftEdits()); bad.reopen(); assert.equal(bad.raw.value, '失败仍保留'); assert.equal(bad.context.descriptionARawEdit, '失败仍保留');
});

test('a whitespace-only edit during project saving survives an older successful response', async () => {
  const s = setup(); s.edit('新原文'); const put = deferred(), fetch = s.context.fetch;
  s.context.fetch = async (url, options) => { if (options.method === 'PUT') await put.promise; return fetch(url, options); };
  const saving = s.context.ui.saveAgentDraftEdits(); await tick(); s.edit('  新原文\n'); put.resolve(); await saving; s.reopen();
  assert.equal(s.context.descriptionARawEdit, '  新原文\n'); assert.equal(s.raw.value, '  新原文\n');
});

test('real local serialization preserves cached empty raw independently of canonical A', () => {
  const s = setup(); Object.assign(s.context, { storageKey: 'raw-edit', generated: true, agentTemplateId: '', agentTemplateVersion: 0, aReferenceImageUrl: '', versions: [], doubaoBridgeState: 'idle', projectName: 'raw', agentNote: '', serverUpdatedAt: '' });
  vm.runInContext(['persistedResults', 'persistState', 'serializeProject'].map(declaration).join('\n') + '\nglobalThis.realPersist = persistState; globalThis.realSerialize = serializeProject;', s.context);
  s.edit(''); s.context.realPersist(); const saved = JSON.parse(s.storage.get('raw-edit'));
  assert.equal(saved.descriptionA, '原 A'); assert.equal(saved.descriptionARawEdit, ''); assert.equal(s.context.realSerialize().descriptionARawEdit, '');
});

const sceneFixture = fs.readFileSync(path.join(__dirname, 'scene-flow-ui.test.js'), 'utf8').replace(/\r\n/g, '\n');
const makeSceneContext = new Function('require', '__dirname', sceneFixture.slice(0, sceneFixture.indexOf('\ntest(')) + '\nreturn makeContext;')(require, __dirname);
const sceneSetup = () => {
  const s = makeSceneContext({ downstream: true }); s.raw = { value: '未保存原文' }; s.context.descriptionARawEdit = s.raw.value;
  s.context.detailContents.a.querySelector = (selector) => selector === '#description-editor' ? s.raw : null;
  return s;
};

test('resetting B preserves A edits but replacing A clears both its cache and stale editor DOM', () => {
  const s = sceneSetup(); vm.runInContext('globalThis.realReset = resetDownstream;', s.context);
  s.context.realReset(2); assert.equal(s.context.descriptionARawEdit, '未保存原文'); assert.equal(s.raw.value, '未保存原文');
  s.context.realReset(1); assert.equal(s.context.descriptionARawEdit, null); assert.equal(s.raw.value, ''); assert.equal(s.context.descriptionA, '');
});

test('a successful regeneration with identical canonical A replaces unsaved cache and stale DOM', async () => {
  const s = sceneSetup(); s.context.fetch = async (_url, options = {}) => ({ ok: true, json: async () => options.method === 'POST' ? { run: { runId: 'new', output: { descriptionA: '原 A' } } } : {} });
  s.context.ui.generateDescriptionA(true); await tick(); await tick();
  assert.equal(s.context.descriptionARawEdit, null); assert.equal(s.context.descriptionA, '原 A'); assert.equal(s.raw.value, '原 A');
});

test('late history metadata cannot apply after a raw edit during either response await', async () => {
  for (const stage of ['fetch', 'json']) {
    const s = sceneSetup(), gate = deferred(); const before = plain(s.context.agentRunHistory);
    const payload = { runs: [{ runId: 'late', accepted: true, output: { draft: { rawText: '原 A', fields: {} } } }], acceptedRunId: 'late' };
    s.context.fetch = stage === 'fetch' ? () => gate.promise : async () => ({ ok: true, json: () => gate.promise });
    const restoring = s.context.ui.restoreAgentRunsFromServer(); await tick(); s.context.descriptionARawEdit = '恢复期间的新编辑'; s.raw.value = s.context.descriptionARawEdit;
    gate.resolve(stage === 'fetch' ? { ok: true, json: async () => payload } : payload); await restoring;
    assert.deepEqual(plain(s.context.agentRunHistory), before); assert.equal(s.raw.value, '恢复期间的新编辑');
  }
});

test('history A restore ignores a late response after raw text changes and retains edits on cancellation', async () => {
  const s = sceneSetup(), gate = deferred();
  s.context.agentRunHistory = [{ runId: 'old', task: 'description_a', status: 'completed', output: { draft: { rawText: '历史 A', fields: {} } } }];
  s.context.fetch = async (_url, options = {}) => options.method === 'POST' ? gate.promise : { ok: true };
  const restoring = s.context.ui.restoreAgentRun('old'); await tick(); s.context.descriptionARawEdit = '新编辑'; s.raw.value = '新编辑';
  gate.resolve({ ok: true, json: async () => ({ run: { runId: 'restored', output: { draft: { rawText: '历史 A', fields: {} } } } }) }); await restoring;
  assert.equal(s.context.descriptionARawEdit, '新编辑'); assert.equal(s.raw.value, '新编辑'); assert.equal(s.context.descriptionA, '原 A');
  s.context.window.confirm = () => false; await s.context.ui.restoreAgentRun('old'); assert.equal(s.context.descriptionARawEdit, '新编辑');
});

test('real startup restores empty and whitespace caches while old projects use their canonical A', () => {
  const start = source.indexOf("      try {\n        const saved = JSON.parse(window.localStorage.getItem(storageKey)");
  const end = source.indexOf('\n      resolveAcceptedASnapshot();\n      renderProduct();', start);
  assert.ok(start > 0 && end > start);
  for (const cache of ['', ' \n ', null]) {
    const s = sceneSetup(); s.context.descriptionARawEdit = null;
    s.storage.set('scene-test', JSON.stringify({ descriptionA: '持久化原文', ...(cache === null ? {} : { descriptionARawEdit: cache }) }));
    vm.runInContext(source.slice(start, end), s.context);
    assert.equal(s.context.descriptionARawEdit, cache); assert.equal(s.context.descriptionA, '持久化原文');
  }
});

test('project startup restore cannot replace a newer raw edit or reload a different project', async () => {
  const s = sceneSetup(), gate = deferred(); s.context.descriptionARawEdit = null; s.context.fetch = () => gate.promise; let reloads = 0;
  s.context.window.location = { reload: () => { reloads++; } };
  vm.runInContext(declaration('restoreProjectFromServer') + '\nglobalThis.restoreProject = restoreProjectFromServer;', s.context);
  const restoring = s.context.restoreProject(); await tick(); s.context.descriptionARawEdit = '服务器读取期间的文字';
  gate.resolve({ ok: true, json: async () => ({ project: { descriptionA: '服务器旧稿', updatedAt: '2099-01-01T00:00:00Z' } }) }); await restoring;
  assert.equal(reloads, 0); assert.equal(s.context.descriptionARawEdit, '服务器读取期间的文字');
});

test('startup keeps an already restored local raw cache even when the server timestamp is newer', async () => {
  const s = sceneSetup(); let reloads = 0, reads = 0;
  s.context.window.location = { reload: () => { reloads++; } };
  s.context.fetch = async () => { reads++; return { ok: true, json: async () => ({ project: { descriptionA: '服务器新稿', updatedAt: '2099-01-01T00:00:00Z' } }) }; };
  vm.runInContext(declaration('restoreProjectFromServer') + '\nglobalThis.restoreProject = restoreProjectFromServer;', s.context);
  await s.context.restoreProject(); assert.equal(reloads, 0); assert.equal(reads, 0); assert.equal(s.context.descriptionARawEdit, '未保存原文');
});

test('applying A templates clears old raw only after accepting the replacement', async () => {
  const s = setup(); s.edit('模板前未保存原文');
  s.context.templateApplyFields = () => ({ mode: 'a', descriptionA: '模板原文', fields: { scene: '模板场景' } });
  s.context.templateValue = (value) => value;
  s.context.window.confirm = () => false; await s.context.ui.applyPromptTemplate(); assert.equal(s.context.descriptionARawEdit, '模板前未保存原文');
  s.context.window.confirm = () => true; await s.context.ui.applyPromptTemplate();
  assert.equal(s.context.descriptionARawEdit, null); assert.equal(s.context.descriptionA, '模板原文'); assert.equal(s.raw.value, '模板原文');
});

test('new projects clear the old raw cache and editor before persisting their blank A', async () => {
  const s = sceneSetup(); let reloads = 0; s.context.window.location = { reload: () => { reloads++; } };
  vm.runInContext(declaration('createProject') + '\nglobalThis.createProject = createProject;', s.context);
  await s.context.createProject(); assert.equal(s.context.descriptionARawEdit, null); assert.equal(s.raw.value, ''); assert.equal(s.context.descriptionA, ''); assert.equal(reloads, 1);
  assert.equal(JSON.parse(s.storage.get('scene-test')).descriptionARawEdit, null);
});

test('project import replaces persisted raw cache while cancellation and failure retain edits, including deferred warning reload', async () => {
  for (const mode of ['cancel', 'fail', 'success', 'warnings']) {
    const s = setup(); s.edit('导入前未保存的原文'); const c = s.context;
    const oldSnapshot = { projectId: c.projectId, descriptionA: c.descriptionA, descriptionARawEdit: c.descriptionARawEdit, promptB: c.promptB };
    c.storageKey = 'import-raw'; s.storage.set(c.storageKey, JSON.stringify(oldSnapshot));
    c.latestProjectImportRequestId = 0; c.projectImportInput = { value: 'picked.json' }; c.pendingImportedProjectReload = false;
    c.invalidateAgentRequest = () => { s.calls.push(['invalidate']); };
    let reloads = 0; c.window.location = { reload: () => { reloads++; } }; c.window.confirm = () => mode !== 'cancel';
    const importedProject = { projectId: c.projectId, descriptionA: '导入文件的已保存原文', descriptionARawEdit: '导入文件不应复活的编辑', promptB: '导入 B', product: { name: '导入商品' } };
    c.fetch = async (url, options) => { s.requests.push({ url, method: options.method, body: JSON.parse(options.body) }); return { ok: mode !== 'fail', json: async () => ({ project: importedProject, warnings: mode === 'warnings' ? [{ code: 'UPLOAD_MISSING', path: '/uploads/test/missing.png', message: '请补齐图片' }] : [] }) }; };
    vm.runInContext([declaration('reloadImportedProject'), declaration('importProjectFromFile'), 'globalThis.importFile = importProjectFromFile; globalThis.reloadImported = reloadImportedProject;'].join('\n'), c);
    await c.importFile({ text: async () => JSON.stringify({ project: [importedProject] }) });
    const persisted = JSON.parse(s.storage.get(c.storageKey));
    if (mode === 'cancel' || mode === 'fail') {
      assert.deepEqual(persisted, oldSnapshot); assert.equal(c.descriptionARawEdit, '导入前未保存的原文'); assert.equal(s.raw.value, '导入前未保存的原文'); assert.equal(reloads, 0);
      assert.equal(s.requests.length, mode === 'cancel' ? 0 : 1);
    } else {
      assert.equal(persisted.descriptionARawEdit, null); assert.equal(persisted.descriptionA, '导入文件的已保存原文'); assert.equal(persisted.promptB, '导入 B'); assert.deepEqual(persisted.product, { name: '导入商品' });
      assert.equal(s.requests.length, 1); assert.equal(s.requests[0].body.mode, 'replace'); assert.equal(s.requests[0].url, '/api/projects/test/import');
      if (mode === 'warnings') {
        assert.equal(c.pendingImportedProjectReload, true); assert.equal(reloads, 0); const beforeReload = s.storage.get(c.storageKey);
        c.reloadImported(); assert.equal(reloads, 1); assert.equal(c.pendingImportedProjectReload, false); assert.equal(s.storage.get(c.storageKey), beforeReload);
      } else assert.equal(reloads, 1);
    }
  }
});
