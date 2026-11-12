const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const fixture = fs.readFileSync(path.join(__dirname, 'b-editor-unsaved-ui.test.js'), 'utf8').replace(/\r\n/g, '\n');
const { setup: editorSetup, source, declaration } = new Function('require', '__dirname', fixture.slice(0, fixture.indexOf('\ntest(')) + '\nreturn {setup,source,declaration};')(require, __dirname);
const plain = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise((r) => resolve = r); return { promise, resolve }; };
const setup = () => {
  const s = editorSetup(), c = s.context, posts = [];
  Object.assign(c, { textWorkflow: { epoch: 'epoch-1', selection: { platform: 'doubao', model: 'current-page' }, jobs: [] }, textRequestBusy: false, textCandidateDraft: null, textProvenance: null, textEventTail: Promise.resolve(), textMutationRevision: 0, textRestoreSequence: 0, deferredTextEvents: [], crypto, doubaoExtensionVersion: '0.5.1', activeBOperation: null, activeAOperation: null, currentAgentRunId: 'run-a', currentAgentRunVersion: 3, resolveAcceptedASnapshot: () => ({ rawText: c.descriptionA, fields: {} }), guardAConfirmation: () => !c.activeAOperation && !c.activeBOperation });
  c.acceptedASnapshot = c.resolveAcceptedASnapshot();
  c.window.postMessage = (message) => posts.push(plain(message)); c.document.querySelectorAll = () => [];
  const helpers = ['flushDeferredTextEvents', 'isTextActive', 'textIdentity', 'textContext', 'textCurrentJob', 'renderTextWorkflow', 'textFetch', 'restoreTextWorkflow', 'selectTextPlatform', 'dispatchTextJob', 'generateTextB', 'textJobAction', 'applyTextCandidate'];
  vm.runInContext(helpers.map(declaration).join('\n') + '\nglobalThis.textui = {restoreTextWorkflow,selectTextPlatform,generateTextB,textJobAction,applyTextCandidate,renderTextWorkflow,readBEditorRaw};', c);
  const start = source.indexOf('      const handleTextEvent ='), end = source.indexOf("      window.addEventListener('message', handleTextEvent);", start);
  vm.runInContext(source.slice(start, end) + '\nglobalThis.handleTextEvent = handleTextEvent;', c);
  s.job = (status = 'completed') => ({ kind: 'prompt_b', protocolVersion: 'text-v1', projectId: c.projectId, jobId: 'text-job', attemptId: 'attempt-1', routeSession: 'session-1', epoch: 'epoch-1', platform: c.textWorkflow.selection.platform, model: 'current-page', source: { content: c.resolveAcceptedASnapshot(), descriptionA: c.descriptionA, runId: c.currentAgentRunId, version: c.currentAgentRunVersion, fingerprint: 'a'.repeat(64) }, instructionVersion: 'prompt-b-v1', status, rawReply: '原始网页 B', candidate: { candidateId: 'candidate-1', text: '原始网页 B' } });
  s.complete = () => { const job = s.job(); c.textWorkflow.jobs = [job]; return job; };
  s.posts = posts; s.callLog = [];
  c.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null; s.callLog.push({ url, method: options.method, body });
    if (options.method === 'PUT') return { ok: true, json: async () => ({ project: body }) };
    if (options.method === 'PATCH') { c.textWorkflow.selection = { platform: body.platform, model: body.model }; return { ok: true, json: async () => ({ workflow: plain(c.textWorkflow) }) }; }
    let job = c.textWorkflow.jobs.at(-1);
    if (url.endsWith('/text-jobs') && options.method === 'POST') { job = s.job('queued'); c.textWorkflow.jobs.push(job); }
    if (url.endsWith('/dispatch')) job.status = 'preparing';
    if (url.endsWith('/events')) job.status = body.state;
    if (url.endsWith('/cancel')) job.status = 'cancelled';
    return { ok: true, json: async () => ({ job: job && plain(job), workflow: plain(c.textWorkflow) }) };
  };
  return s;
};
test('text platform selection persists separately from image selection and never generates', async () => {
  const s = setup(), c = s.context, selected = [...c.selectedGenerationPlatforms];
  await c.textui.selectTextPlatform('chatgpt'); assert.equal(c.textWorkflow.selection.platform, 'chatgpt'); assert.deepEqual([...c.selectedGenerationPlatforms], selected);
  assert.equal(s.callLog.find((r) => r.method === 'PATCH').url, `${c.projectApiUrl}/text-jobs`);
  assert.equal(s.posts.length, 0); assert.equal(s.callLog.some((r) => /generation-jobs/.test(r.url)), false);
});
test('generate B persists confirmed A then creates/claims one text task, never changes canonical B or starts images', async () => {
  const s = setup(), c = s.context, before = c.promptB;
  await c.textui.generateTextB();
  assert.deepEqual(s.callLog.map((r) => r.method), ['PUT', 'POST', 'POST']);
  assert.deepEqual(s.callLog[0].body.acceptedASnapshot, plain(c.resolveAcceptedASnapshot()));
  assert.equal(s.posts.length, 1); assert.equal(s.posts[0].type, 'TEXT_PREPARE'); assert.equal(s.posts[0].job.kind, 'prompt_b'); assert.equal(s.posts[0].job.status, 'preparing');
  assert.equal(c.promptB, before); assert.equal(s.callLog.some((r) => /generation-jobs/.test(r.url)), false);
  await c.textui.generateTextB(); assert.equal(s.posts.length, 1);
});
test('delayed strict source save suppresses duplicate clicks and stale A/project cannot dispatch', async () => {
  for (const mutation of ['a', 'project']) {
    const s = setup(), c = s.context, wait = deferred(); c.fetch = async () => wait.promise;
    const pending = c.textui.generateTextB(); await tick(); await c.textui.generateTextB();
    if (mutation === 'a') c.descriptionA = 'new A'; else c.projectSession++;
    wait.resolve({ ok: true, json: async () => ({}) }); await pending;
    assert.equal(s.posts.length, 0); assert.equal(c.textRequestBusy, false);
  }
});
test('candidate response preserves intervening manual edits, raw reply and canonical B; explicit apply asks before overwriting', async () => {
  const s = setup(), c = s.context, job = s.complete(), old = c.promptB;
  c.textCandidateDraft = { jobId: job.jobId, editorBaseline: JSON.stringify(c.textui.readBEditorRaw()) };
  s.edit({ positivePrompt: 'intervening manual edit' }); c.window.confirm = () => false;
  c.textui.applyTextCandidate(); assert.equal(s.controls.positivePrompt.value, 'intervening manual edit'); assert.equal(c.promptB, old); assert.equal(c.textProvenance, null);
  c.window.confirm = () => true; c.textui.applyTextCandidate();
  assert.equal(s.controls.positivePrompt.value, job.rawReply); assert.equal(c.promptBEdit.positivePrompt, job.rawReply); assert.equal(c.promptB, old);
  assert.equal(c.textProvenance.jobId, job.jobId); assert.equal(job.rawReply, '原始网页 B'); assert.equal(s.posts.length, 0);
});
test('completed text event records a candidate, never calls B confirmation, save or image generation', async () => {
  const s = setup(), c = s.context, job = s.job('submitted'); c.textWorkflow.jobs = [job];
  s.edit({ positivePrompt: 'manual edit during generation' }); const before = plain(c.promptBEdit);
  c.handleTextEvent({ source: c.window, data: { ...job, source: 'zaotu-doubao-extension', type: 'TEXT_EVENT', sourceFingerprint: job.source.fingerprint, state: 'completed', rawReply: 'new text', pageUrl: 'https://www.doubao.com/chat/synthetic', userAnchor: 'u1', completionEvidence: 'new-assistant-action-bar-stable' } });
  await c.textEventTail;
  assert.equal(c.textWorkflow.jobs[0].status, 'completed'); assert.deepEqual(plain(c.promptBEdit), before); assert.equal(s.posts.length, 0);
  assert.equal(s.callLog.length, 1); assert.match(s.callLog[0].url, /\/events$/);
});
test('wrong job/session/attempt/project text events cannot reach API or mutate current candidate', async () => {
  const s = setup(), c = s.context, job = s.job('submitted'); c.textWorkflow.jobs = [job];
  for (const patch of [{ projectId: 'foreign' }, { attemptId: 'wrong' }, { routeSession: 'wrong' }, { kind: 'image' }]) c.handleTextEvent({ source: c.window, data: { ...job, source: 'zaotu-doubao-extension', type: 'TEXT_EVENT', sourceFingerprint: job.source.fingerprint, state: 'completed', ...patch } });
  await c.textEventTail; assert.equal(s.callLog.length, 0); assert.equal(c.textWorkflow.jobs[0].status, 'submitted');
});
test('reload restores queued/submitted/completed state but never resubmits a text job', async () => {
  for (const state of ['queued', 'submitted', 'completed']) {
    const s = setup(), c = s.context; c.textWorkflow.jobs = [s.job(state)];
    await c.textui.restoreTextWorkflow(); await c.textui.restoreTextWorkflow(); assert.equal(s.posts.every((message) => message.type === 'TEXT_REPLAY'), true); assert.equal(s.posts.length, state === 'completed' ? 0 : 2); assert.equal(s.callLog.every((r) => r.method === 'GET'), true);
  }
});
test('A/run/platform/epoch changes prevent old candidate application', () => {
  for (const field of ['a', 'run', 'version', 'platform', 'epoch']) {
    const s = setup(), c = s.context; s.complete(); c.window.confirm = () => true;
    if (field === 'a') c.descriptionA = 'changed'; if (field === 'run') c.currentAgentRunId = 'new-run'; if (field === 'version') c.currentAgentRunVersion++; if (field === 'platform') c.textWorkflow.selection.platform = 'chatgpt'; if (field === 'epoch') c.textWorkflow.epoch = 'new-epoch';
    const before = s.controls.positivePrompt.value; c.textui.applyTextCandidate(); assert.equal(s.controls.positivePrompt.value, before, field); assert.equal(c.textProvenance, null);
  }
});
test('applied candidate strict B confirmation failure retains canonical B and creates zero image actions', async () => {
  const s = setup(), c = s.context; const job = s.complete(); c.window.confirm = () => true; c.textui.applyTextCandidate();
  const before = c.promptB; c.fetch = async () => ({ ok: false, status: 503 }); await c.bui.confirmPrompt();
  assert.equal(c.promptB, before); assert.equal(c.promptBEdit.positivePrompt, job.rawReply); assert.equal(s.posts.length, 0); assert.equal(s.calls.some(([kind]) => kind === 'generate'), false);
});
test('product UI has no silent resend-image B action, and manual/template paths retain explicit image send', () => {
  assert.match(source, /id="text-platform"/); assert.match(source, /data-detail-action="generate-b"/); assert.match(source, /data-detail-action="apply-text-candidate"/);
  assert.doesNotMatch(source, /data-detail-action="resend-b">重新发送 B/);
  assert.match(declaration('applyPromptTemplate'), /textProvenance = null/);
  assert.match(declaration('resetDownstream'), /textCandidateDraft = null; textProvenance = null/);
  assert.match(declaration('createProject'), /textWorkflow = null; textCandidateDraft = null; textProvenance = null/);
  assert.doesNotMatch(declaration('submitBConfirmation'), /generateResults\(/);
});

test('API-save acknowledgements follow persistence; offline text completion is not acknowledged or auto-resubmitted', async () => {
  for (const offline of [false, true]) {
    const s = setup(), c = s.context, job = s.job('submitted'); c.textWorkflow.jobs = [job];
    if (offline) c.fetch = async () => { throw new Error('offline synthetic server'); };
    c.handleTextEvent({ source: c.window, data: { ...job, source: 'zaotu-doubao-extension', type: 'TEXT_EVENT', sourceFingerprint: job.source.fingerprint, state: 'completed', eventId: 'event-1', rawReply: 'B' } });
    await c.textEventTail;
    assert.equal(s.posts.some((message) => message.type === 'TEXT_ACK'), !offline);
    assert.equal(s.posts.some((message) => message.type === 'TEXT_PREPARE'), false);
  }
});
test('import/version replacement in flight blocks text generation, application and late event persistence', async () => {
  const s = setup(), c = s.context, job = s.job('submitted'); c.textWorkflow.jobs = [job]; c.projectWriteCount = 1;
  await c.textui.generateTextB(); await c.textui.selectTextPlatform('chatgpt'); await c.textui.textJobAction('retry');
  c.handleTextEvent({ source: c.window, data: { ...job, source: 'zaotu-doubao-extension', type: 'TEXT_EVENT', sourceFingerprint: job.source.fingerprint, state: 'completed' } });
  await c.textEventTail; assert.equal(s.callLog.length, 0); assert.equal(s.posts.length, 0);
});

for (const mutation of ['selection', 'cancel', 'completion']) {
  test(`deferred text restore cannot overwrite a newer ${mutation} commit`, async () => {
    const s = setup(), c = s.context; c.textWorkflow.jobs = [s.job('running')];
    const old = plain(c.textWorkflow), wait = deferred(), originalFetch = c.fetch;
    c.fetch = (url, options) => options.method === 'GET' ? wait.promise : originalFetch(url, options);
    const restoring = c.textui.restoreTextWorkflow(); await tick();
    if (mutation === 'selection') await c.textui.selectTextPlatform('chatgpt');
    if (mutation === 'cancel') await c.textui.textJobAction('cancel');
    if (mutation === 'completion') {
      const job = c.textWorkflow.jobs[0]; c.handleTextEvent({ source: c.window, data: { ...job, source: 'zaotu-doubao-extension', type: 'TEXT_EVENT', sourceFingerprint: job.source.fingerprint, state: 'completed' } }); await c.textEventTail;
    }
    const committed = plain(c.textWorkflow);
    wait.resolve({ ok: true, json: async () => ({ workflow: old }) }); await restoring;
    assert.deepEqual(plain(c.textWorkflow), committed);
  });
}
test('changing text provider permits genuine manual rewrite but never launders the unchanged stale web B', async () => {
  const s = setup(), c = s.context; const job = s.complete();
  c.promptB = job.rawReply; c.promptBSource = `web-text:${job.jobId}`; c.textProvenance = { jobId: job.jobId }; s.controls.positivePrompt.value = c.promptB;
  await c.textui.selectTextPlatform('chatgpt'); assert.equal(c.textProvenance, null);
  s.edit({ positivePrompt: 'genuinely rewritten manual B' });
  await c.bui.confirmPrompt(); assert.equal(c.promptB, 'genuinely rewritten manual B'); assert.equal(c.promptBSource, 'workbench');
  const stale = setup(), d = stale.context; const oldJob = stale.complete();
  d.promptB = oldJob.rawReply; d.promptBSource = `web-text:${oldJob.jobId}`; d.textProvenance = { jobId: oldJob.jobId }; stale.controls.positivePrompt.value = d.promptB;
  await d.textui.selectTextPlatform('chatgpt'); const count = stale.callLog.length;
  await d.bui.confirmPrompt(); assert.equal(d.promptBSource, `web-text:${oldJob.jobId}`);
  assert.equal(stale.callLog.length, count, 'unchanged stale model candidate must require rewrite or fresh provenance, not confirm as manual');
});

test('unchanged applied-but-unconfirmed candidate cannot become manual by switching provider, even over an older confirmed web B', async () => {
  for (const oldSource of ['workbench', 'web-text:older-confirmed']) {
    const s = setup(), c = s.context; c.promptBSource = oldSource; s.complete(); c.window.confirm = () => true;
    c.textui.applyTextCandidate(); const oldCanonical = c.promptB;
    await c.textui.selectTextPlatform('chatgpt'); const count = s.callLog.length;
    await c.bui.confirmPrompt(); assert.equal(c.promptB, oldCanonical); assert.equal(s.callLog.length, count);
    s.edit({ positivePrompt: 'explicit manual replacement after invalidation' }); await c.bui.confirmPrompt();
    assert.equal(c.promptBSource, 'workbench'); assert.equal(c.promptB, 'explicit manual replacement after invalidation');
  }
});
test('late in-flight text completion cannot overwrite a newer selection or cancellation', async () => {
  for (const mutation of ['selection', 'cancel']) {
    const s = setup(), c = s.context, wait = deferred(); c.textWorkflow.jobs = [s.job('running')];
    const normalFetch = c.fetch;
    c.fetch = (url, options) => url.endsWith('/events') ? wait.promise : normalFetch(url, options);
    const job = c.textWorkflow.jobs[0], completed = plain(c.textWorkflow); completed.jobs[0].status = 'completed';
    c.handleTextEvent({ source: c.window, data: { ...job, source: 'zaotu-doubao-extension', type: 'TEXT_EVENT', sourceFingerprint: job.source.fingerprint, state: 'completed', eventId: 'late-completion' } });
    await tick();
    if (mutation === 'selection') await c.textui.selectTextPlatform('chatgpt'); else await c.textui.textJobAction('cancel');
    const current = plain(c.textWorkflow);
    wait.resolve({ ok: true, json: async () => ({ workflow: completed, job: completed.jobs[0] }) }); await c.textEventTail;
    assert.deepEqual(plain(c.textWorkflow), current); assert.equal(s.posts.some((message) => message.type === 'TEXT_ACK'), false);
  }
});
test('manual fallback confirms and sends through the real isolated image API, while stale web provenance is rejected', async (t) => {
  const fixture = fs.readFileSync(path.join(__dirname, 'generation-jobs.test.js'), 'utf8');
  const { startServer } = new Function('require', '__dirname', fixture.slice(0, fixture.indexOf("test('")) + '\nreturn {startServer};')(require, __dirname);
  const server = await startServer(t), s = setup(), c = s.context;
  c.promptBSource = 'web-text:stale-prior-job'; c.textProvenance = { jobId: 'stale-prior-job' };
  c.fetch = (url, options) => fetch(server.base + url, options);
  const imageInput = () => ({ platforms: ['doubao'], bSnapshot: { positive_prompt: c.promptB, aspect_ratio: c.aspectRatio, source: c.promptBSource }, textProvenance: c.textProvenance });
  await c.textui.selectTextPlatform('chatgpt');
  assert.equal((await c.fetch(c.projectApiUrl + '/generation-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(imageInput()) })).status, 409);
  s.edit({ positivePrompt: 'new user-authored manual B, not a stale model reply' }); await c.bui.confirmPrompt();
  assert.equal(c.promptBSource, 'workbench'); assert.equal(c.textProvenance, null);
  const saved = await (await c.fetch(c.projectApiUrl)).json(); assert.equal(saved.project.promptBSource, 'workbench'); assert.equal(saved.project.promptBExecution.source, 'workbench');
  assert.equal((await c.fetch(c.projectApiUrl + '/generation-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(imageInput()) })).status, 201);
  assert.equal(s.posts.some((message) => /PREPARE/.test(message.type)), false, 'confirmation never sends image/text commands');
});

test('events arriving during a text mutation are deferred without reentering or reviving invalidated source', async () => {
  const s = setup(), c = s.context; c.textWorkflow.jobs = [s.job('running')];
  const wait = deferred(), normal = c.fetch;
  c.fetch = (url, options) => options.method === 'PATCH' ? wait.promise : normal(url, options);
  const selecting = c.textui.selectTextPlatform('chatgpt'); await tick();
  const job = c.textWorkflow.jobs[0]; c.handleTextEvent({ source: c.window, data: { ...job, source: 'zaotu-doubao-extension', type: 'TEXT_EVENT', sourceFingerprint: job.source.fingerprint, state: 'completed' } });
  const next = plain(c.textWorkflow); next.selection.platform = 'chatgpt'; next.epoch = 'new-platform-epoch'; next.jobs[0].status = 'cancelled';
  wait.resolve({ ok: true, json: async () => ({ workflow: next }) }); await selecting; await c.textEventTail;
  assert.deepEqual(plain(c.textWorkflow), next); assert.equal(s.callLog.some((request) => request.url.endsWith('/events')), false);
});

test('an older in-flight event response cannot regress a newer restored completed job', async () => {
  const s = setup(), c = s.context, wait = deferred(); const job = s.job('preparing'); c.textWorkflow.jobs = [job];
  const submitted = plain(c.textWorkflow); submitted.jobs[0].status = 'submitted';
  const completed = plain(c.textWorkflow); completed.jobs[0].status = 'completed';
  c.fetch = (url, options) => url.endsWith('/events') ? wait.promise : Promise.resolve({ ok: true, json: async () => ({ workflow: completed }) });
  c.handleTextEvent({ source: c.window, data: { ...job, source: 'zaotu-doubao-extension', type: 'TEXT_EVENT', sourceFingerprint: job.source.fingerprint, state: 'submitted' } });
  await tick(); await c.textui.restoreTextWorkflow();
  wait.resolve({ ok: true, json: async () => ({ workflow: submitted, job: submitted.jobs[0] }) }); await c.textEventTail;
  assert.equal(c.textWorkflow.jobs[0].status, 'completed');
});
