const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixture = fs.readFileSync(path.join(__dirname, 'b-editor-unsaved-ui.test.js'), 'utf8').replace(/\r\n/g, '\n');
const { setup: editorSetup, source, declaration } = new Function('require', '__dirname', fixture.slice(0, fixture.indexOf('\ntest(')) + '\nreturn { setup, source, declaration };')(require, __dirname);
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const edited = { positivePrompt: '  新 B\n柔和光线  ', negativePrompt: ' 水印 ', aspectRatio: '9:16', platformParamsText: ' {"seed":9} ' };
const withoutTime = (value) => { const copy = plain(value); delete copy.updatedAt; return copy; };
const setup = () => {
  const s = editorSetup(), c = s.context;
  Object.assign(c, { activeBOperation: null, pendingAConfirmation: null, editorAContent: () => ({ rawText: c.descriptionA }), resolveAcceptedASnapshot: () => ({ rawText: '原 A' }), isAConfirmationPending: () => false, doubaoBridgeState: 'idle' });
  c.document.querySelectorAll = () => [];
  c.generateResults = () => s.calls.push(['generate']);
  const helpers = ['captureASendingContext', 'isASendingContextCurrent'];
  vm.runInContext(helpers.filter((name) => source.includes(`      const ${name} =`)).map(declaration).join('\n'), c);
  c.progress = 5; c.generationJobId = 'job-old'; c.generationResendSourceJobId = 'job-source'; c.generatedResults = [{ id: 'r-old', imageUrl: '/uploads/old.png', jobId: 'job-old', saved: true }]; c.resultGenerated = true; c.resultSelected = 0;
  s.edit(edited);
  s.snapshot = () => withoutTime(c.bui.serializeProject());
  return s;
};

for (const action of ['confirmPrompt', 'resendPromptB']) {
  test(`${action}: HTTP and network errors retain B, exact edits, local project and downstream`, async () => {
    for (const mode of ['http', 'network']) {
      const s = setup(), c = s.context, before = s.snapshot(), local = s.storage.get(c.storageKey);
      c.fetch = async (url, options) => { s.requests.push({ url, method: options.method, body: JSON.parse(options.body) }); if (mode === 'network') throw new Error('offline'); return { ok: false, status: 503 }; };
      await c.bui[action]();
      assert.deepEqual(s.snapshot(), before); assert.equal(s.storage.get(c.storageKey), local); assert.equal(s.calls.some(([kind]) => kind === 'timer'), false); assert.equal(s.calls.some(([kind]) => kind === 'open-detail'), false); assert.equal(c.activeBOperation, null);
      assert.ok(s.calls.some(([kind, message]) => kind === 'toast' && /B.*保存|保存.*B/.test(message)), 'must report B save failure');
    }
  });
  test(`${action}: delayed PUT has no local commit and duplicate or cross submission is suppressed`, async () => {
    const s = setup(), c = s.context, wait = deferred(), before = s.snapshot();
    c.fetch = async (url, options) => { s.requests.push({ url, body: JSON.parse(options.body) }); return wait.promise; };
    const first = c.bui[action](); await tick();
    assert.deepEqual(s.snapshot(), before); assert.equal(c.activeBOperation !== null, true);
    await c.bui.confirmPrompt(); await c.bui.resendPromptB(); await c.ui?.syncProject?.();
    assert.equal(s.requests.length, 1); assert.equal(s.calls.some(([kind]) => kind === 'timer'), false);
    wait.resolve({ ok: true }); await first;
    assert.equal(c.promptB, '新 B\n柔和光线'); assert.equal(c.promptBEdit, null); assert.equal(c.promptBVersion, 2); assert.equal(c.generationJobId, ''); assert.deepEqual(plain(c.generatedResults), []); assert.equal(c.activeBOperation, null);
    assert.deepEqual(withoutTime(s.requests[0].body), s.snapshot(), 'saved candidate must equal committed project');
    assert.equal(s.calls.filter(([kind]) => kind === 'timer').length, action === 'resendPromptB' ? 1 : 0);
  });
  test(`${action}: failure can retry once, invalid input and cancelled confirmation never PUT`, async () => {
    const s = setup(), c = s.context; let ok = false;
    c.fetch = async (url, options) => { s.requests.push({ url, body: JSON.parse(options.body) }); return { ok }; };
    await c.bui[action](); assert.deepEqual(plain(c.promptBEdit), edited); ok = true; await c.bui[action](); assert.equal(c.promptBVersion, 2); assert.equal(s.requests.length, 2);
    for (const mode of ['invalid', 'cancel']) { const other = setup(); if (mode === 'invalid') other.edit({ platformParamsText: '{unfinished' }); else other.context.window.confirm = () => false; const before = other.snapshot(); await other.context.bui[action](); assert.deepEqual(other.snapshot(), before); assert.equal(other.requests.length, 0); }
  });
  test(`${action}: old sync drains first and pending sync cannot overwrite the strict save`, async () => {
    const s = setup(), c = s.context, drain = deferred(), put = deferred();
    c.serverSyncQueue = drain.promise;
    const pending = c.bui[action](); await tick(); assert.equal(s.requests.length, 0);
    const sync = vm.runInContext('(showFeedback) => syncProject(showFeedback)', c);
    let blocked = false; const blockedSync = sync(true).then((result) => { blocked = result === false; }); await tick(); assert.equal(blocked, true); assert.equal(c.pendingProjectSync, null);
    c.fetch = async (url, options) => { s.requests.push({ url, body: JSON.parse(options.body) }); return put.promise; };
    drain.resolve(); await tick(); assert.equal(s.requests.length, 1); await sync(); assert.equal(c.pendingProjectSync, null);
    put.resolve({ ok: true }); await pending; assert.equal(s.requests.length, 1);
  });
  test(`${action}: changed project, A or B makes delayed work stale before and after PUT`, async () => {
    for (const phase of ['drain', 'put']) for (const mutation of ['project', 'a', 'b']) {
      const s = setup(), c = s.context, wait = deferred(); if (phase === 'drain') c.serverSyncQueue = wait.promise;
      c.fetch = async (url, options) => { s.requests.push({ url, body: JSON.parse(options.body) }); return phase === 'put' ? wait.promise : { ok: true }; };
      const pending = c.bui[action](); await tick();
      if (mutation === 'project') { c.projectSession++; c.projectId = 'new'; c.projectApiUrl = '/api/projects/new'; c.promptB = 'new project B'; }
      if (mutation === 'a') c.descriptionA = 'later A';
      if (mutation === 'b') s.edit({ positivePrompt: 'later B' });
      const before = s.snapshot(); wait.resolve({ ok: true }); await pending;
      assert.deepEqual(s.snapshot(), before, `${phase}/${mutation}`); assert.equal(s.calls.some(([kind]) => kind === 'timer'), false); assert.equal(s.requests.length, phase === 'put' ? 1 : 0);
    }
  });
}
test('unchanged B preserves its version, provenance and downstream for confirmation and resend', async () => {
  for (const action of ['confirmPrompt', 'resendPromptB']) { const s = setup(), c = s.context; s.edit({ positivePrompt: '旧 B', negativePrompt: '旧负面', aspectRatio: '4:5', platformParamsText: '{"seed":42}' }); await c.bui[action](); assert.equal(c.promptBVersion, 1); assert.equal(c.promptBSource, 'template:old@v2'); assert.equal(c.generationJobId, 'job-old'); assert.equal(c.generatedResults.length, 1); assert.equal(c.promptBEdit, null); assert.deepEqual(withoutTime(s.requests[0].body), s.snapshot()); }
});
test('successful resend sends once only while its confirmed project, A and B remain current', async () => {
  for (const mutation of ['none', 'project', 'a', 'b', 'platform']) { const s = setup(), c = s.context; await c.bui.resendPromptB(); const timers = s.calls.filter(([kind]) => kind === 'timer'); assert.equal(timers.length, 1); if (mutation === 'project') c.projectSession++; if (mutation === 'a') c.descriptionA = 'changed A'; if (mutation === 'b') s.edit({ positivePrompt: 'changed B' }); if (mutation === 'platform') c.selectedGenerationPlatforms.add('gemini'); await timers[0][1](); assert.equal(s.calls.filter(([kind]) => kind === 'generate').length, mutation === 'none' ? 1 : 0, mutation); }
});
test('pending B locks its real controls and A/C sends and retries before any side effect', async () => {
  const s = setup(), c = s.context, wait = deferred(), notice = { hidden: true, textContent: '' }, selected = { disabled: false };
  c.document.querySelectorAll = (selector) => selector === '[data-b-save-state]' ? [notice] : selector.startsWith('#prompt-editor') ? [s.controls.positivePrompt, s.controls.negativePrompt, s.controls.platformParamsText] : selector.startsWith('#aspect-ratio-editor') ? [s.controls.aspectRatio, selected] : [];
  const pending = c.bui.confirmPrompt(); await tick();
  // The default fetch is immediate; use a separate delayed case for the actual lock state.
  await pending;
  s.edit(edited); c.fetch = () => wait.promise;
  const delayed = c.bui.confirmPrompt(); await tick();
  assert.equal(c.activeBOperation !== null, true); assert.equal(notice.hidden, false); assert.match(notice.textContent, /正在保存 B/); assert.match(s.next.innerHTML, /正在保存 B/); assert.doesNotMatch(s.next.innerHTML, /DeepSeek/);
  assert.equal(s.controls.positivePrompt.readOnly, true); assert.equal(s.controls.aspectRatio.disabled, true); assert.equal(selected.disabled, true);
  vm.runInContext(['guardAConfirmation', 'resendGeneration', 'generateResults', 'handleTaskAction', 'applyPromptTemplate'].map(declaration).join('\n') + '\nglobalThis.pendingActions = {resendGeneration,generateResults,handleTaskAction,applyPromptTemplate};', c);
  const oldReads = c.readBExecutionFields; c.readBExecutionFields = () => { throw new Error('must not read'); };
  const before = s.snapshot(), requestCount = s.requests.length;
  await c.pendingActions.generateResults(); await c.pendingActions.resendGeneration(); await c.pendingActions.handleTaskAction('retry', 'old', 'doubao'); await c.pendingActions.applyPromptTemplate(); await c.bui.createProject();
  assert.deepEqual(s.snapshot(), before); assert.equal(s.requests.length, requestCount); c.readBExecutionFields = oldReads;
  wait.resolve({ ok: false, status: 503 }); await delayed;
  assert.equal(notice.hidden, true); assert.equal(s.controls.positivePrompt.readOnly, false); assert.equal(s.controls.aspectRatio.disabled, false); assert.equal(selected.disabled, false);
});
test('B cannot commit while generation task submission owns the current sending response', async () => {
  const s = setup(), c = s.context; c.doubaoBridgeState = 'preparing'; c.generationJobId = '';
  const before = s.snapshot(); await c.bui.confirmPrompt(); await c.bui.resendPromptB(); assert.deepEqual(s.snapshot(), before); assert.equal(s.requests.length, 0); assert.ok(s.calls.some(([kind, message]) => kind === 'toast' && /生图任务正在提交/.test(message)));
});
test('pending older generation/retry context becomes stale when B saving starts', async () => {
  const s = setup(), c = s.context, wait = deferred();
  const capture = vm.runInContext('({captureASendingContext,isASendingContextCurrent})', c); const old = capture.captureASendingContext(); assert.equal(capture.isASendingContextCurrent(old), true);
  c.fetch = () => wait.promise; const pending = c.bui.confirmPrompt(); await tick(); assert.equal(capture.isASendingContextCurrent(old), false); wait.resolve({ ok: false }); await pending;
});
test('B control re-render during pending save retains raw input and remains locked', async () => {
  const s = setup(), c = s.context, wait = deferred(); c.document.querySelectorAll = (selector) => selector.startsWith('#prompt-editor') ? [s.controls.positivePrompt] : selector.startsWith('#aspect-ratio-editor') ? [s.controls.aspectRatio] : [];
  c.fetch = () => wait.promise; const pending = c.bui.confirmPrompt(); await tick(); s.reopen(); assert.deepEqual(s.values(), edited); assert.equal(s.controls.positivePrompt.readOnly, true); assert.equal(s.controls.aspectRatio.disabled, true); wait.resolve({ ok: false }); await pending; assert.deepEqual(s.values(), edited);
});
test('first B commit keeps version 1 and progress 4 without inventing old result invalidation', async () => {
  const s = setup(), c = s.context; c.promptB = ''; c.progress = 3; c.generationJobId = ''; c.generationResendSourceJobId = ''; c.generatedResults = []; c.resultGenerated = false; c.resultSelected = -1; c.promptBSource = 'workbench'; c.promptBTemplateId = ''; c.promptBTemplateVersion = 0;
  await c.bui.confirmPrompt(); assert.equal(c.promptBVersion, 1); assert.equal(c.progress, 4); assert.deepEqual(withoutTime(s.requests[0].body), s.snapshot());
});
test('an older retry response cannot hydrate old generation state after a successful B commit', async () => {
  const s = setup(), c = s.context, wait = deferred();
  vm.runInContext(declaration('guardAConfirmation') + '\n' + declaration('handleTaskAction') + '\nglobalThis.retryOld = handleTaskAction;', c);
  let hydrates = 0; c.hydrateGenerationJob = () => hydrates++; c.fetch = async (url, options) => options.method === 'POST' ? wait.promise : { ok: true };
  const retry = c.retryOld('retry', 'job-old'); await tick(); await c.bui.confirmPrompt(); wait.resolve({ ok: true, json: async () => ({ job: { jobId: 'old-retry' } }) }); await retry; assert.equal(hydrates, 0); assert.equal(c.generationJobId, '');
});
test('B waits for an already started project replacement before saving a candidate', async () => {
  const s = setup(), c = s.context, wait = deferred(); c.latestProjectImportRequestId = 0; c.projectImportInput = { value: '' };
  const importing = c.bui.importProjectFromFile({ text: () => wait.promise }); await tick(); assert.equal(c.projectWriteCount, 1);
  const before = s.snapshot(); await c.bui.confirmPrompt(); assert.deepEqual(s.snapshot(), before); assert.equal(s.requests.length, 0); assert.ok(s.calls.some(([kind, message]) => kind === 'toast' && /项目正在更新/.test(message)));
  c.window.confirm = () => false; wait.resolve(JSON.stringify({ project: { projectId: c.projectId } })); await importing; assert.equal(c.projectWriteCount, 0); c.window.confirm = () => true; await c.bui.confirmPrompt(); assert.equal(s.requests.length, 1);
});
test('only the latest successful B resend may run an equal-content deferred generation callback', async () => {
  const s = setup(), c = s.context; await c.bui.resendPromptB(); await c.bui.resendPromptB();
  const timers = s.calls.filter(([kind]) => kind === 'timer'); assert.equal(timers.length, 2); for (const [, run] of timers) await run();
  assert.equal(s.calls.filter(([kind]) => kind === 'generate').length, 1);
});
test('pending B rejects result uploading and result archival before changing current downstream', async () => {
  const s = setup(), c = s.context, wait = deferred(); c.detailContent = { querySelector: () => null }; c.resultKey = (result) => result.id;
  vm.runInContext(['uploadGeneratedResults', 'completeSelectedImport', 'importResult'].map(declaration).join('\n') + '\nglobalThis.resultActions = {uploadGeneratedResults,completeSelectedImport,importResult};', c);
  c.fetch = async (url, options) => { s.requests.push({ url, method: options.method }); return wait.promise; };
  const pending = c.bui.confirmPrompt(); await tick(); const before = s.snapshot();
  const uploading = c.resultActions.uploadGeneratedResults([{ type: 'image/png', size: 20 }]);
  await tick(); const putsBeforeRelease = s.requests.length;
  const archiving = c.resultActions.completeSelectedImport({ ...c.generatedResults[0], jobRecorded: true });
  const during = s.snapshot(); wait.resolve({ ok: false, status: 503, json: async () => ({}) }); await Promise.all([pending, uploading, archiving]);
  assert.equal(putsBeforeRelease, 1, 'result upload must not POST while B owns project'); assert.deepEqual(during, before);
});
test('result selection callback cannot change selection or persist an old snapshot during B saving', async () => {
  const s = setup(), c = s.context, wait = deferred(); let select;
  const start = source.indexOf("        results.querySelectorAll('[data-result-index]').forEach((button) => button.addEventListener('click', () => {");
  const end = source.indexOf('\n        setResultAction();', start);
  c.results = { querySelectorAll: () => [{ dataset: { resultIndex: '1' }, addEventListener: (_, fn) => { select = fn; } }] };
  vm.runInContext(source.slice(start, end), c); c.fetch = () => wait.promise;
  const pending = c.bui.confirmPrompt(); await tick(); const before = s.snapshot(), local = s.storage.get(c.storageKey); select();
  const during = s.snapshot(), localDuring = s.storage.get(c.storageKey); wait.resolve({ ok: false }); await pending;
  assert.deepEqual(during, before); assert.equal(localDuring, local);
});
test('extension results arriving during B save replay after failure or unchanged success and obsolete jobs stay invalidated', async () => {
  for (const mode of ['failure', 'unchanged', 'changed']) {
    const s = setup(), c = s.context, wait = deferred(); let onMessage;
    if (mode === 'unchanged') s.edit({ positivePrompt: '旧 B', negativePrompt: '旧负面', aspectRatio: '4:5', platformParamsText: '{"seed":42}' });
    c.detailContent = { querySelector: () => null }; c.window.addEventListener = (_, fn) => { onMessage = fn; };
    c.window.postMessage = (data) => { if (data.source === 'zaotu-doubao-extension') onMessage({ source: c.window, data }); };
    c.isCurrentResultMessage = (message) => message.jobId === c.generationJobId; c.syncGenerationStatus = () => {}; c.setResultAction = () => {};
    c.mergePlatformResults = (_, results) => { c.generatedResults.push(...results); return results; };
    const start = source.indexOf("      window.addEventListener('message', (event) => {"), end = source.indexOf("      workflowCanvas.addEventListener('input', (event) => {", start);
    vm.runInContext(source.slice(start, end), c); c.fetch = async (url, options) => options.method === 'PUT' ? wait.promise : { ok: true };
    const pending = c.bui.confirmPrompt(); await tick(); const before = s.snapshot();
    onMessage({ source: c.window, data: { source: 'zaotu-doubao-extension', type: 'PLATFORM_RESULT_CANDIDATES', platform: 'doubao', jobId: 'job-old', attemptId: 'attempt-old', results: [{ id: 'r-new', url: '/uploads/new.png', jobId: 'job-old' }] } });
    const during = s.snapshot(); wait.resolve({ ok: mode !== 'failure', status: mode === 'failure' ? 503 : 200 }); await pending; await tick();
    assert.deepEqual(during, before, mode); assert.equal(c.generatedResults.some((result) => result.id === 'r-new'), mode !== 'changed', mode); if (mode !== 'failure') assert.equal(c.promptBEdit, null);
  }
});
test('a result upload started first finishes and syncs before B can save its candidate', async () => {
  const s = setup(), c = s.context, asset = deferred(); c.URL = URL; c.window.location = { href: 'http://localhost:5173/' }; c.detailContent = { querySelector: () => null };
  vm.runInContext(declaration('uploadGeneratedResults') + '\nglobalThis.uploadResult = uploadGeneratedResults;', c);
  c.fetch = async (url, options) => { s.requests.push({ url, method: options.method, body: options.method === 'PUT' ? JSON.parse(options.body) : null }); return url.endsWith('/assets') ? asset.promise : { ok: true, json: async () => ({ project: {} }) }; };
  const uploading = c.uploadResult([{ type: 'image/png', size: 20 }]); await tick(); assert.equal(c.projectWriteCount, 1);
  await c.bui.confirmPrompt(); assert.equal(s.requests.filter((request) => request.method === 'PUT').length, 0); assert.notEqual(c.promptBEdit, null);
  asset.resolve({ ok: true, json: async () => ({ url: '/uploads/new/manual.png' }) }); await uploading; await c.serverSyncQueue;
  assert.equal(c.projectWriteCount, 0); assert.equal(c.generatedResults.some((result) => result.sourceUrl === 'manual-upload'), true); assert.equal(s.requests.filter((request) => request.method === 'PUT').length, 1);
  await c.bui.confirmPrompt(); assert.equal(c.promptBEdit, null); assert.equal(s.requests.filter((request) => request.method === 'PUT').length, 2); assert.deepEqual(withoutTime(s.requests.at(-1).body), s.snapshot());
});
test('a result archive started first finishes before B can submit', async () => {
  const s = setup(), c = s.context, archive = deferred(); c.URL = URL; c.window.location = { href: 'http://localhost:5173/' }; c.detailContent = { querySelector: () => null }; c.resultKey = (result) => result.id;
  vm.runInContext(declaration('completeSelectedImport') + '\nglobalThis.archiveResult = completeSelectedImport;', c);
  c.fetch = async (url, options) => { s.requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null }); return url.endsWith('/results') ? archive.promise : { ok: true, json: async () => ({ project: {} }) }; };
  const archiving = c.archiveResult(c.generatedResults[0]); await tick(); assert.equal(c.projectWriteCount, 1); await c.bui.confirmPrompt(); assert.equal(s.requests.filter((request) => request.method === 'PUT').length, 0);
  archive.resolve({ ok: true, json: async () => ({}) }); await archiving; await c.serverSyncQueue; assert.equal(c.projectWriteCount, 0); assert.equal(c.generatedResults[0].jobRecorded, true);
  await c.bui.confirmPrompt(); assert.equal(c.promptBEdit, null); assert.deepEqual(withoutTime(s.requests.at(-1).body), s.snapshot());
});
test('two equal successful resends before timers with no job create exactly one real generation POST', async () => {
  const s = setup(), c = s.context; c.progress = 4; c.generationJobId = ''; c.generationResendSourceJobId = ''; c.generationRequestKey = ''; c.generatedResults = []; c.resultGenerated = false; c.resultSelected = -1;
  c.detailContent = { querySelector: () => null }; c.isExampleProductImage = () => true; c.window.location = { href: 'http://localhost:5173/' }; c.window.postMessage = (data) => s.calls.push(['platform-post', data]);
  vm.runInContext(['guardAConfirmation', 'generateResults'].map(declaration).join('\n'), c);
  c.fetch = async (url, options) => { s.requests.push({ url, method: options.method, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ job: { jobId: 'job-real', platforms: { doubao: { attemptId: 'attempt-new' } } } }) }; };
  await c.bui.resendPromptB(); await c.bui.resendPromptB(); const timers = s.calls.filter(([kind]) => kind === 'timer'); assert.equal(timers.length, 2); for (const [, run] of timers) run(); await tick();
  assert.equal(s.requests.filter((request) => request.method === 'POST' && request.url.endsWith('/generation-jobs')).length, 1); assert.equal(c.generationJobId, 'job-real'); assert.equal(s.calls.filter(([kind]) => kind === 'platform-post').length, 1);
});
test('editing a non-template B preserves its existing non-template source while clearing template references', async () => {
  const s = setup(), c = s.context; c.promptBSource = 'manual'; await c.bui.confirmPrompt(); assert.equal(c.promptBSource, 'manual'); assert.equal(c.promptBTemplateId, ''); assert.equal(c.promptBTemplateVersion, 0); assert.equal(s.requests[0].body.promptBExecution.source, 'manual');
});

const setupStartupRestore = () => {
  const s = setup(), c = s.context;
  c.URL = URL;
  c.window.location = { href: 'http://localhost:5173/' };
  Object.assign(c.generatedResults[0], { platform: 'doubao', attemptId: 'attempt-old', url: 'http://localhost:5173/uploads/old.png' });
  c.renderResults = () => s.calls.push(['hydrate-results']);
  c.renderPlatformStatuses = () => s.calls.push(['hydrate-statuses']);
  vm.runInContext(['normalizeResultUrl', 'normalizeResult', 'resultKey', 'resetPlatformCandidatesForAttempt', 'mergePlatformResults', 'hydrateGenerationJob', 'restoreGenerationJobFromServer'].map(declaration).join('\n') + '\nglobalThis.startup = restoreGenerationJobFromServer;', c);
  return s;
};
const startupJobPayload = () => ({ job: { jobId: 'job-old', platforms: { doubao: { attemptId: 'attempt-old', status: 'completed', results: [{ id: 'r-late', url: '/uploads/late.png' }] } } } });

for (const action of ['confirmPrompt', 'resendPromptB']) {
  test(`startup restoration: ${action} waits for both GET and JSON before saving a consistent B candidate`, async () => {
    const s = setupStartupRestore(), c = s.context, get = deferred(), body = deferred();
    c.fetch = async (url, options = {}) => {
      s.requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
      return options.method === 'PUT' ? { ok: true } : get.promise;
    };
    const restoring = c.startup();
    await tick();
    assert.equal(c.projectWriteCount, 1);
    await c.bui[action]();
    assert.equal(s.requests.length, 1);
    assert.deepEqual(plain(c.promptBEdit), edited);
    assert.equal(c.promptB, '旧 B');
    get.resolve({ ok: true, json: () => body.promise });
    await tick();
    assert.equal(c.projectWriteCount, 1);
    await c.bui[action]();
    assert.equal(s.requests.length, 1);
    assert.equal(c.generatedResults.some((result) => result.id === 'r-late'), false);
    body.resolve(startupJobPayload());
    await restoring;
    assert.equal(c.projectWriteCount, 0);
    assert.deepEqual(plain(c.generatedResults.map((result) => result.id)), ['r-old', 'r-late']);
    assert.equal(s.calls.filter(([kind]) => kind === 'hydrate-results').length, 1);
    await c.bui[action]();
    assert.equal(s.requests.filter((request) => request.method === 'PUT').length, 1);
    assert.equal(c.promptBEdit, null);
    assert.deepEqual(withoutTime(s.requests.at(-1).body), s.snapshot());
  });

  test(`startup restoration: pending ${action} rejects new GET and leaves its B save unchanged`, async () => {
    const s = setupStartupRestore(), c = s.context, put = deferred();
    c.fetch = async (url, options = {}) => {
      s.requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
      return options.method === 'PUT' ? put.promise : { ok: true, json: async () => startupJobPayload() };
    };
    const saving = c.bui[action]();
    await tick();
    assert.notEqual(c.activeBOperation, null);
    const before = s.snapshot(), local = s.storage.get(c.storageKey);
    await c.startup();
    assert.equal(s.requests.filter((request) => request.method === 'GET').length, 0);
    assert.equal(s.calls.some(([kind]) => kind === 'hydrate-results'), false);
    assert.deepEqual(s.snapshot(), before);
    assert.equal(s.storage.get(c.storageKey), local);
    assert.equal(c.projectWriteCount, 0);
    put.resolve({ ok: true });
    await saving;
    assert.equal(c.promptBEdit, null);
    assert.deepEqual(withoutTime(s.requests[0].body), s.snapshot());
  });
}

const startupContextChanges = {
  project: (c) => { c.projectId = 'other'; },
  route: (c) => { c.projectApiUrl = '/api/projects/other'; },
  session: (c) => { c.projectSession += 1; },
  job: (c) => { c.generationJobId = 'job-other'; },
  invalidation: (c) => { c.invalidatedGenerationJobs.add('job-old'); },
  'invalidation set replacement': (c) => { c.invalidatedGenerationJobs = new Set(c.invalidatedGenerationJobs); }
};
for (const phase of ['GET', 'JSON']) for (const [name, change] of Object.entries(startupContextChanges)) {
  test(`startup restoration: ${name} changes during ${phase} discard the stale response`, async () => {
    const s = setupStartupRestore(), c = s.context, get = deferred(), body = deferred();
    let jsonReads = 0;
    c.fetch = async (url, options = {}) => {
      s.requests.push({ url, method: options.method || 'GET' });
      return get.promise;
    };
    const restoring = c.startup();
    await tick();
    const response = { ok: true, json: () => { jsonReads += 1; return body.promise; } };
    if (phase === 'JSON') { get.resolve(response); await tick(); assert.equal(jsonReads, 1); }
    change(c);
    const before = s.snapshot(), local = s.storage.get(c.storageKey), platforms = plain(c.generationPlatforms);
    if (phase === 'GET') get.resolve(response);
    body.resolve(startupJobPayload());
    await restoring;
    assert.equal(jsonReads, phase === 'GET' ? 0 : 1);
    assert.deepEqual(s.snapshot(), before);
    assert.deepEqual(plain(c.generationPlatforms), platforms);
    assert.equal(s.storage.get(c.storageKey), local);
    assert.equal(s.calls.some(([kind]) => kind === 'hydrate-results' || kind === 'hydrate-statuses'), false);
    assert.equal(c.projectWriteCount, 0);
    assert.equal(s.requests[0].url, '/api/projects/demo/generation-jobs/job-old');
  });
}

for (const failure of ['network', 'HTTP', 'JSON']) {
  test(`startup restoration: ${failure} failure releases only its own project write lock`, async () => {
    const s = setupStartupRestore(), c = s.context, get = deferred(), body = deferred();
    c.projectWriteCount = 2;
    c.fetch = async () => get.promise;
    const before = s.snapshot(), local = s.storage.get(c.storageKey), restoring = c.startup();
    await tick();
    const duringGET = c.projectWriteCount;
    if (failure === 'network') get.reject(new Error('offline'));
    else if (failure === 'HTTP') get.resolve({ ok: false, status: 503, json: () => assert.fail('HTTP failure must not parse JSON') });
    else {
      get.resolve({ ok: true, json: () => body.promise });
      await tick();
      assert.equal(c.projectWriteCount, 3);
      body.reject(new Error('invalid JSON'));
    }
    await restoring;
    assert.equal(duringGET, 3);
    assert.equal(c.projectWriteCount, 2);
    assert.deepEqual(s.snapshot(), before);
    assert.equal(s.storage.get(c.storageKey), local);
    assert.equal(s.calls.some(([kind]) => kind === 'hydrate-results'), false);
  });
}

test('startup restoration: missing or invalidated current job makes no GET and acquires no lock', async () => {
  for (const mode of ['missing', 'invalidated']) {
    const s = setupStartupRestore(), c = s.context;
    if (mode === 'missing') c.generationJobId = '';
    else c.invalidatedGenerationJobs.add(c.generationJobId);
    c.fetch = async (url) => { s.requests.push({ url }); return { ok: true, json: async () => startupJobPayload() }; };
    const before = s.snapshot(), local = s.storage.get(c.storageKey);
    await c.startup();
    assert.equal(s.requests.length, 0, mode);
    assert.equal(c.projectWriteCount, 0, mode);
    assert.deepEqual(s.snapshot(), before, mode);
    assert.equal(s.storage.get(c.storageKey), local, mode);
    assert.equal(s.calls.some(([kind]) => kind === 'hydrate-results'), false, mode);
  }
});
