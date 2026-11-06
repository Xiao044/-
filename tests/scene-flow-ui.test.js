const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const declaration = (name) => {
  const start = source.indexOf(`      const ${name} =`);
  assert.ok(start >= 0, `missing ${name}`);
  const next = source.indexOf('\n      const ', start + 12);
  const close = source.indexOf('\n      };', start + 12);
  const end = close >= 0 && close < next ? close + '\n      };'.length : next;
  assert.ok(end > start, `missing end of ${name}`);
  return source.slice(start, end);
};
const between = (startText, endText) => {
  const start = source.indexOf(`\n${startText}`) + 1;
  const endMarker = endText.startsWith('\n') ? endText : `\n${endText}`;
  const end = source.indexOf(endMarker, start + startText.length);
  assert.ok(start > 0 && end > start);
  return source.slice(start, end);
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const element = (textContent = '') => ({
  textContent, innerHTML: '', value: '', disabled: false, hidden: false, open: false, dataset: {}, attributes: {}, handlers: {},
  classList: { values: new Set(), contains(value) { return this.values.has(value); }, add(value) { this.values.add(value); }, remove(value) { this.values.delete(value); }, toggle(value, enabled) { const on = enabled ?? !this.values.has(value); on ? this.values.add(value) : this.values.delete(value); return on; } },
  setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
  addEventListener(type, listener) { (this.handlers[type] ||= []).push(listener); },
  emit(type, event = {}) { for (const listener of this.handlers[type] || []) listener(event); },
  showModal() { this.open = true; }, close() { this.open = false; }, focus() {},
  querySelector() { return null; }
});
const makeContext = ({ downstream = false } = {}) => {
  const scenes = ['自然窗边', '工作室'].map(element);
  scenes[0].classList.add('selected');
  const next = element(), replyButton = element(), replyInput = element(), modal = element(), modalTitle = element(), modalBody = element(), closeButton = element(), stepTrack = element();
  replyInput.value = ' 尚未提交的方向文字 ';
  const greeting = element('旧回复'), question = element('旧问题');
  const failure = element(), failureTitle = element(), failureMessage = element(), retryButton = element();
  failure.hidden = true;
  const storage = new Map(), requests = [], calls = [];
  const nodes = { '.reply-box button': replyButton, '.reply-box textarea': replyInput, '.agent-greeting strong': greeting, '.agent-greeting p': question, '.modal-close': closeButton, '.step-track': stepTrack, '[data-agent-failure]': failure, '[data-agent-failure-title]': failureTitle, '[data-agent-failure-message]': failureMessage, '[data-agent-retry]': retryButton };
  const context = {
    acceptedASnapshot: null, activeAOperation: null, pendingAConfirmation: null, aImageFeedback: null, refreshAImageFeedback() {},
    detailContents: { a: { querySelector: () => null } },
    resolveAcceptedASnapshot() {}, refreshAConfirmationState() {},
    projectId: 'demo', projectApiUrl: '/api/projects/demo', projectSession: 0,
    pendingImportedProjectReload: false, pendingSceneChange: null, modalSession: 0,
    agentRequestSequence: 0, activeAgentRequest: null, agentBusy: false, agentFailure: null,
    sceneOptions: scenes, interrupted: false, generated: downstream, editingAgent: false, progress: downstream ? 4 : 1,
    productState: { name: '项链', subtitle: '', description: '', imageUrl: '/product.png', facts: { material: '黄铜' }, extension: { sku: 'sku-1' } },
    agentNote: '已提交方向文字', descriptionA: downstream ? '原 A' : '', descriptionAStructured: {}, agentWarnings: [], descriptionADraft: null, descriptionAFieldEdits: {},
    promptB: downstream ? '原 B' : '', negativePrompt: '', aspectRatio: '4:5', platformParams: {}, platformOverrides: {},
    promptBSource: 'workbench', promptBVersion: 1, promptBTemplateId: '', promptBTemplateVersion: 0, agentTemplateId: '', agentTemplateVersion: 0,
    currentAgentRunId: downstream ? 'run-old' : '', currentAgentRunVersion: downstream ? 1 : 0,
    aReferenceImageUrl: '/reference.png', versions: [{ versionId: 'v-old' }], agentRunHistory: [{ runId: 'run-old' }], latestAgentDraftVersion: 0,
    resultGenerated: downstream, resultSelected: downstream ? 0 : -1, generatedResults: downstream ? [{ url: '/old-result.png', saved: true }] : [],
    generationJobId: downstream ? 'job-old' : '', generationResendSourceJobId: downstream ? 'job-source' : '', invalidatedGenerationJobs: new Set(),
    doubaoBridgeState: downstream ? 'completed' : 'idle', doubaoAttemptId: 0, selectedGenerationPlatforms: new Set(['doubao']),
    generationPlatforms: { doubao: { state: downstream ? 'completed' : 'idle', message: '', attemptId: 'attempt-old' } },
    nextButton: next, interruptButton: element(), currentStep: element(), currentStepLabel: element(), modal, modalTitle, modalBody, closeButton,
    flowSteps: [element(), element(), element(), element(), element()], workflowNodes: [], stepNodes: {},
    storageKey: 'scene-test', projectName: '测试项目', serverUpdatedAt: '', pendingProjectSync: null, serverSyncQueue: null,
    document: { querySelector: (selector) => nodes[selector] || null },
    window: { localStorage: { setItem: (key, value) => storage.set(key, value), getItem: (key) => storage.get(key) ?? null }, confirm: () => true, matchMedia: () => ({ matches: true }) },
    CSS: { escape: (value) => value },
    escapeHtml: (value) => String(value ?? '').replace(/[&<>"']/g, ''),
    showToast: (message) => calls.push(['toast', message]), setStatus: (...args) => calls.push(['status', ...args]),
    resetFlowStep: (index) => calls.push(['reset-step', index]), markStepComplete() {}, setCurrentStep() {}, unlockCard() {}, openDetail: (...args) => calls.push(['open-detail', ...args]),
    refreshAgentWarningPanel() {}, commitPlatformOverrides() {}, renderResults() {}, renderPlatformStatuses() {}, reloadImportedProject() {},
    fetch: async (url, options = {}) => {
      requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
      return { ok: true, status: 200, json: async () => options.method === 'POST'
        ? { run: { runId: 'run-new', version: 2, output: { version: 2, descriptionA: '新 A', reply: '新回复', followUpQuestion: '' } } }
        : { project: { updatedAt: '2026-11-06T10:00:00Z' } } };
    }
  };
  vm.createContext(context);
  const helpers = ['selectedSceneName', 'agentInputSignature', 'captureAgentRequest', 'isAgentRequestCurrent', 'beginAgentRequest', 'finishAgentRequest', 'invalidateAgentRequest', 'hasSceneDownstream', 'applySceneSelection', 'selectScene', 'confirmSceneChange', 'agentRequestError', 'agentFailureMessage', 'clearAgentFailure', 'isAgentFailureCurrent', 'renderAgentFailure', 'showAgentFailure', 'retryAgentRequest', 'generateDescriptionA', 'submitAgentNote'];
  const presentHelpers = helpers.filter((name) => source.includes(`      const ${name} =`));
  vm.runInContext([
    ...['persistedResults', 'persistState', 'serializeProject', 'syncProject', 'ensureProjectOnServer', 'restoreAgentRunsFromServer', 'restoreAgentRun', 'requestAgent', 'setAgentBusy', 'openModal', 'closeModal', 'resetDownstream', ...presentHelpers].map(declaration),
    between('      sceneOptions.forEach((option) => {', "      interruptButton.addEventListener('click'"),
    between("      interruptButton.addEventListener('click'", '      const generateDescriptionA ='),
    between("      nextButton.addEventListener('click'", "      saveButton.addEventListener('click'"),
    between("      document.querySelector('.reply-box button').addEventListener('click'", '      const flowSteps ='),
    between("      document.querySelector('.modal-close').addEventListener('click'", "      modal.addEventListener('click'"),
    between("      document.querySelector('.step-track').addEventListener('click'", "      workflowCanvas.addEventListener('click'"),
    between("      modal.addEventListener('cancel'", '\n\n      try {'),
    `globalThis.modalAction = (action) => { ${between("        const action = event.target.closest('[data-modal-action]')?.dataset.modalAction;", '        const taskActionElement =').replace("        const action = event.target.closest('[data-modal-action]')?.dataset.modalAction;", '')} };`,
    `globalThis.ui = { requestAgent, restoreAgentRunsFromServer, restoreAgentRun, serializeProject, openModal, closeModal, ${presentHelpers.join(', ')} };`
  ].join('\n'), context);
  return { context, scenes, next, replyButton, replyInput, modal, closeButton, stepTrack, greeting, question, storage, requests, calls, failure, failureTitle, failureMessage, retryButton };
};
const selected = ({ scenes }) => scenes.find((item) => item.classList.contains('selected')).textContent;

test('new scene without downstream saves locally and by PUT; same scene is a no-op and Agent uses saved scene', async () => {
  const setup = makeContext();
  setup.scenes[0].emit('click');
  assert.equal(setup.requests.length, 0);
  assert.equal(setup.storage.size, 0);
  setup.scenes[1].emit('click');
  await setup.context.serverSyncQueue;
  assert.equal(selected(setup), '工作室');
  assert.equal(setup.scenes[1].attributes['aria-pressed'], 'true');
  assert.equal(JSON.parse(setup.storage.get('scene-test')).selectedScene, '工作室');
  assert.equal(setup.requests[0].body.selectedScene, '工作室');
  assert.equal(setup.context.progress, 1);
  const saves = setup.requests.length;
  setup.scenes[1].emit('click');
  assert.equal(setup.requests.length, saves);
  await setup.context.ui.requestAgent('description_a');
  assert.equal(setup.requests.find((entry) => entry.method === 'POST').body.scene, '工作室');
});

test('downstream confirmation keeps selection and full project unchanged until confirm; cancel, close and Escape discard pending selection', () => {
  for (const cancel of ['button', 'close', 'escape']) {
    const setup = makeContext({ downstream: true });
    const { updatedAt: beforeTime, ...before } = plain(setup.context.ui.serializeProject());
    setup.scenes[1].emit('click');
    assert.equal(setup.modal.open, true);
    assert.equal(selected(setup), '自然窗边');
    assert.equal(setup.requests.length, 0);
    assert.equal(setup.storage.size, 0);
    if (cancel === 'button') setup.context.modalAction('cancel');
    else if (cancel === 'close') setup.closeButton.emit('click');
    else { let prevented = false; setup.modal.emit('cancel', { preventDefault() { prevented = true; } }); assert.equal(prevented, true); }
    assert.equal(setup.modal.open, false);
    assert.equal(setup.context.pendingSceneChange, null);
    const { updatedAt: afterTime, ...after } = plain(setup.context.ui.serializeProject());
    assert.deepEqual(after, before);
    setup.context.modalAction('confirm-scene-change');
    assert.equal(selected(setup), '自然窗边');
    assert.equal(setup.requests.length, 0);
    assert.equal(setup.storage.size, 0);
  }
});

test('confirm switches exactly once, resets current downstream and preserves product, history, note input and reference image', async () => {
  const setup = makeContext({ downstream: true });
  const product = plain(setup.context.productState), versions = plain(setup.context.versions), history = plain(setup.context.agentRunHistory);
  setup.scenes[1].emit('click');
  setup.context.modalAction('confirm-scene-change');
  setup.context.modalAction('confirm-scene-change');
  await setup.context.serverSyncQueue;
  assert.equal(selected(setup), '工作室');
  assert.equal(setup.modal.open, false);
  assert.equal(setup.requests.length, 1);
  assert.equal(setup.calls.filter(([name, index]) => name === 'reset-step' && index === 1).length, 1);
  const saved = setup.requests[0].body;
  assert.equal(saved.selectedScene, '工作室');
  assert.equal(saved.progress, 1);
  assert.equal(saved.descriptionA, '');
  assert.equal(saved.promptB, '');
  assert.deepEqual(saved.generatedResults, []);
  assert.equal(saved.generationJobId, '');
  assert.equal(saved.generationResendSourceJobId, '');
  assert.deepEqual(saved.invalidatedGenerationJobs, ['job-old']);
  assert.deepEqual(saved.product, product);
  assert.deepEqual(saved.versions, versions);
  assert.deepEqual(plain(setup.context.agentRunHistory), history);
  assert.equal(saved.agentNote, '已提交方向文字');
  assert.equal(setup.replyInput.value, ' 尚未提交的方向文字 ');
  assert.equal(saved.aReferenceImageUrl, '/reference.png');
});

test('content at initial progress still requires confirmation and a stale project or replaced modal cannot commit', () => {
  for (const entry of [{ descriptionADraft: { rawText: '草稿' } }, { descriptionAStructured: { scene: '旧场景' } }, { promptB: '已有B' }, { generationJobId: 'job-pending' }, { generatedResults: [{ url: '/result.png' }] }]) {
    const setup = makeContext(); Object.assign(setup.context, entry);
    setup.scenes[1].emit('click');
    assert.equal(setup.modal.open, true);
    assert.equal(selected(setup), '自然窗边');
  }
  for (const invalidate of ['project', 'modal']) {
    const setup = makeContext({ downstream: true }); setup.scenes[1].emit('click');
    if (invalidate === 'project') setup.context.projectSession++;
    else setup.context.ui.openModal('其他内容', '<p>其他内容</p>');
    setup.context.modalAction('confirm-scene-change');
    assert.equal(selected(setup), '自然窗边');
    assert.equal(setup.requests.length, 0);
  }
});

test('failed scene sync reports local fallback while retaining the selected scene and local data', async () => {
  const setup = makeContext(); setup.context.fetch = async () => { throw new Error('offline'); };
  setup.scenes[1].emit('click'); await setup.context.serverSyncQueue;
  assert.equal(selected(setup), '工作室');
  assert.equal(JSON.parse(setup.storage.get('scene-test')).selectedScene, '工作室');
  assert.ok(setup.calls.some(([kind, message]) => kind === 'toast' && message.includes('已保存在本地')));
  assert.equal(setup.calls.some(([kind, message]) => kind === 'toast' && message.includes('已同步到服务端')), false);
});

for (const task of ['description_a', 'follow_up']) {
  test(`${task} locks scene changes and both Agent actions, then unlocks after success`, async () => {
    const setup = makeContext(), pending = deferred();
    setup.context.fetch = async (url, options = {}) => options.method === 'POST' ? pending.promise : { ok: true, json: async () => ({}) };
    (task === 'description_a' ? setup.next : setup.replyButton).emit('click'); await tick();
    assert.equal(setup.context.agentBusy, true);
    assert.equal(setup.next.disabled, true);
    assert.equal(setup.replyButton.disabled, true);
    assert.equal(setup.scenes[1].disabled, true);
    setup.scenes[1].emit('click');
    assert.equal(selected(setup), '自然窗边');
    pending.resolve({ ok: true, json: async () => ({ run: { runId: 'new', output: { descriptionA: '新 A', reply: '新回复' } } }) });
    await tick();
    assert.equal(setup.context.agentBusy, false);
    assert.equal(setup.replyButton.disabled, false);
    assert.equal(setup.scenes[1].disabled, false);
    setup.scenes[1].emit('click');
    assert.ok(selected(setup) === '工作室' || setup.modal.open);
  });
}

test('Agent request captures route and product before asynchronous project lookup; stale lookup never posts', async () => {
  const setup = makeContext(), lookup = deferred(), seen = [];
  setup.context.fetch = async (url, options = {}) => { seen.push({ url, options }); return lookup.promise; };
  const running = setup.context.ui.requestAgent('description_a');
  setup.context.projectId = 'new'; setup.context.projectApiUrl = '/api/projects/new'; setup.context.projectSession++;
  setup.context.productState.name = '新商品';
  lookup.resolve({ ok: false, status: 404 });
  await running;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/api/projects/demo');
  assert.deepEqual(plain(setup.context.agentRunHistory), [{ runId: 'run-old' }]);
});

test('late Agent success after product changes cannot apply output or history and releases its own lock', async () => {
  const setup = makeContext(), response = deferred();
  setup.context.fetch = async (_url, options = {}) => options.method === 'POST' ? response.promise : { ok: true, json: async () => ({}) };
  setup.next.emit('click'); await tick();
  setup.context.productState.name = '新的商品';
  response.resolve({ ok: true, json: async () => ({ run: { runId: 'stale', output: { descriptionA: '旧商品 A' } } }) });
  await tick();
  assert.equal(setup.context.descriptionA, '');
  assert.deepEqual(plain(setup.context.agentRunHistory), [{ runId: 'run-old' }]);
  assert.equal(setup.context.agentBusy, false);
  assert.equal(setup.storage.size, 0);
});

test('late failure and finally cannot notify a new project or release its newer Agent request', async () => {
  const setup = makeContext(), old = deferred(), current = deferred(); let posts = 0;
  setup.context.fetch = async (_url, options = {}) => options.method === 'POST' ? (++posts === 1 ? old.promise : current.promise) : { ok: true, json: async () => ({}) };
  setup.next.emit('click'); await tick();
  setup.context.projectId = 'new'; setup.context.projectApiUrl = '/api/projects/new'; setup.context.projectSession++;
  setup.context.ui.invalidateAgentRequest(); setup.next.emit('click'); await tick();
  const before = plain(setup.calls);
  old.reject(new Error('旧项目错误')); await tick();
  assert.deepEqual(plain(setup.calls), before);
  assert.equal(setup.context.agentBusy, true);
  assert.equal(setup.scenes[1].disabled, true);
  current.resolve({ ok: true, json: async () => ({ run: { runId: 'new', output: { descriptionA: '新项目 A' } } }) }); await tick();
  assert.equal(setup.context.descriptionA, '新项目 A');
  assert.equal(setup.context.agentBusy, false);
});

test('Agent failure unlocks scene changes and allows retry', async () => {
  const setup = makeContext(); setup.context.fetch = async () => { throw new Error('网络失败'); };
  setup.replyButton.emit('click'); await tick();
  assert.equal(setup.context.agentBusy, false);
  assert.equal(setup.scenes[1].disabled, false);
  assert.ok(setup.calls.some(([kind, message]) => kind === 'toast' && /网络|暂时不可用/.test(message)));
  setup.scenes[1].emit('click');
  assert.equal(selected(setup), '工作室');
});

test('restoring history after a scene reset cannot rebind an old accepted A, while matching legacy A still restores metadata', async () => {
  const oldRun = { runId: 'old-scene-run', task: 'description_a', status: 'completed', version: 4,
    output: { draft: { rawText: '旧 A', fields: { scene: { value: '自然窗边' } } }, descriptionAStructured: { scene: '自然窗边' } } };
  const setup = makeContext({ downstream: true });
  setup.scenes[1].emit('click'); setup.context.modalAction('confirm-scene-change'); await setup.context.serverSyncQueue;
  setup.context.fetch = async () => ({ ok: true, json: async () => ({ runs: [oldRun], latestDraftVersion: 4, acceptedRunId: oldRun.runId }) });
  await setup.context.ui.restoreAgentRunsFromServer();
  assert.equal(setup.context.currentAgentRunId, '');
  assert.equal(setup.context.descriptionADraft, null);
  assert.deepEqual(plain(setup.context.descriptionAStructured), {});
  assert.equal(setup.context.descriptionA, '');
  assert.deepEqual(plain(setup.context.agentRunHistory), [oldRun]);
  const legacy = makeContext(); legacy.context.descriptionA = '旧 A';
  legacy.context.fetch = setup.context.fetch;
  await legacy.context.ui.restoreAgentRunsFromServer();
  assert.equal(legacy.context.currentAgentRunId, oldRun.runId);
  assert.deepEqual(plain(legacy.context.descriptionADraft), oldRun.output.draft);
});

test('history response from an older project or earlier input cannot replace current A metadata', async () => {
  for (const changed of ['project', 'scene', 'current-a']) {
    const setup = makeContext({ downstream: true }), history = deferred();
    const originalHistory = plain(setup.context.agentRunHistory);
    setup.context.fetch = async () => history.promise;
    const restoring = setup.context.ui.restoreAgentRunsFromServer();
    if (changed === 'project') setup.context.projectSession++;
    else if (changed === 'scene') { setup.scenes[0].classList.remove('selected'); setup.scenes[1].classList.add('selected'); }
    else setup.context.descriptionA = '更新的 A';
    history.resolve({ ok: true, json: async () => ({ runs: [{ runId: 'stale' }], latestDraftVersion: 7 }) });
    await restoring;
    assert.deepEqual(plain(setup.context.agentRunHistory), originalHistory);
    assert.equal(setup.context.latestAgentDraftVersion, 0);
    assert.equal(setup.context.descriptionADraft, null);
  }
});

test('missing project creation uses its captured route and full snapshot and never posts after the session changes', async () => {
  const setup = makeContext(), create = deferred(), seen = [];
  setup.context.fetch = async (url, options = {}) => {
    seen.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    return options.method === 'PUT' ? create.promise : { ok: false, status: 404 };
  };
  const requesting = setup.context.ui.requestAgent('description_a'); await tick();
  setup.context.projectSession++; setup.context.productState.name = '新商品';
  create.resolve({ ok: true }); await requesting;
  assert.deepEqual(seen.map(({ url, method }) => ({ url, method })), [{ url: '/api/projects/demo', method: 'GET' }, { url: '/api/projects/demo', method: 'PUT' }]);
  assert.equal(seen[1].body.product.name, '项链');
  assert.equal(seen[1].body.selectedScene, '自然窗边');
});

test('late successful response body cannot append history or overwrite a newer request with the same inputs', async () => {
  const setup = makeContext(), oldBody = deferred(), newResponse = deferred(); let posts = 0;
  setup.context.fetch = async (_url, options = {}) => options.method === 'POST'
    ? (++posts === 1 ? { ok: true, json: () => oldBody.promise } : newResponse.promise)
    : { ok: true, json: async () => ({}) };
  setup.next.emit('click'); await tick();
  setup.context.ui.invalidateAgentRequest(); setup.next.emit('click'); await tick();
  oldBody.resolve({ run: { runId: 'stale', output: { descriptionA: '旧 A' } } }); await tick();
  assert.equal(setup.context.descriptionA, '');
  assert.deepEqual(plain(setup.context.agentRunHistory), [{ runId: 'run-old' }]);
  assert.equal(setup.context.agentBusy, true);
  newResponse.resolve({ ok: true, json: async () => ({ run: { runId: 'new', output: { descriptionA: '新 A' } } }) }); await tick();
  assert.equal(setup.context.descriptionA, '新 A');
  assert.equal(setup.context.agentBusy, false);
});

test('declining a regenerated A still releases the request lock and retains the previous downstream', async () => {
  const setup = makeContext({ downstream: true }); setup.context.editingAgent = true; setup.context.window.confirm = () => false;
  setup.next.emit('click'); await tick();
  assert.equal(setup.context.descriptionA, '原 A');
  assert.equal(setup.context.promptB, '原 B');
  assert.equal(setup.context.agentBusy, false);
  assert.equal(setup.scenes[1].disabled, false);
  assert.equal(setup.storage.size, 0);
});

for (const task of ['description_a', 'follow_up']) {
  test(`${task} remains locked after navigating to Agent and rejects history restore while pending`, async () => {
    const setup = makeContext(), pending = deferred(), posts = [];
    setup.context.agentRunHistory = [{ runId: 'old', task: 'description_a', status: 'completed', output: { draft: { rawText: '旧历史 A' } } }];
    setup.context.fetch = async (url, options = {}) => {
      if (options.method === 'POST') {
        posts.push(url);
        if (url.endsWith('/restore')) return { ok: true, json: async () => ({ run: { runId: 'restored', output: { draft: { rawText: '恢复 A' } } } }) };
        return pending.promise;
      }
      return { ok: true, json: async () => ({}) };
    };
    (task === 'description_a' ? setup.next : setup.replyButton).emit('click'); await tick();
    const jump = { disabled: false, dataset: { stepJump: '1' } };
    setup.stepTrack.emit('click', { target: { closest: () => jump } });
    assert.equal(setup.context.agentBusy, true);
    assert.equal(setup.scenes[1].disabled, true);
    assert.equal(setup.next.disabled, true);
    assert.equal(setup.replyButton.disabled, true);
    setup.scenes[1].emit('click');
    assert.equal(selected(setup), '自然窗边');
    await setup.context.ui.restoreAgentRun('old');
    assert.equal(posts.some((url) => url.endsWith('/restore')), false);
    assert.equal(setup.context.agentBusy, true);
    assert.equal(setup.context.descriptionA, '');
    pending.resolve({ ok: true, json: async () => ({ run: { runId: 'current', output: { descriptionA: '当前生成 A', reply: '当前回复' } } }) }); await tick();
    assert.equal(setup.context.descriptionA, task === 'description_a' ? '当前生成 A' : '');
    assert.equal(setup.context.currentAgentRunId, task === 'description_a' ? 'current' : '');
    assert.equal(setup.context.agentBusy, false);
  });
}

test('history restore owns the Agent lock and stale restore response cannot overwrite newer project inputs', async () => {
  const setup = makeContext(), restore = deferred(), posts = [];
  setup.context.agentRunHistory = [{ runId: 'old', task: 'description_a', status: 'completed', output: { draft: { rawText: '旧历史 A' } } }];
  setup.context.fetch = async (url, options = {}) => {
    if (options.method === 'POST') { posts.push(url); return restore.promise; }
    return { ok: true, json: async () => ({}) };
  };
  const restoring = setup.context.ui.restoreAgentRun('old'); await tick();
  assert.equal(setup.context.agentBusy, true);
  setup.next.emit('click'); setup.replyButton.emit('click'); setup.scenes[1].emit('click'); await tick();
  assert.deepEqual(posts, ['/api/projects/demo/agent-runs/old/restore']);
  assert.equal(selected(setup), '自然窗边');
  setup.context.productState.name = '新的商品';
  restore.resolve({ ok: true, json: async () => ({ run: { runId: 'stale-restored', output: { draft: { rawText: '旧商品恢复 A' } } } }) });
  await restoring;
  assert.equal(setup.context.descriptionA, '');
  assert.equal(setup.context.currentAgentRunId, '');
  assert.equal(setup.context.agentBusy, false);
  assert.equal(setup.storage.size, 0);
});

test('history restore ignores responses after manual A edits and releases its lock after a valid restore', async () => {
  for (const editDuringRestore of [true, false]) {
    const setup = makeContext(), restore = deferred();
    setup.context.agentRunHistory = [{ runId: 'old', task: 'description_a', status: 'completed', output: { draft: { rawText: '旧历史 A' } } }];
    setup.context.fetch = async (_url, options = {}) => options.method === 'POST' ? restore.promise : { ok: true, json: async () => ({}) };
    const restoring = setup.context.ui.restoreAgentRun('old'); await tick();
    if (editDuringRestore) setup.context.descriptionA = '编辑中的新 A';
    restore.resolve({ ok: true, json: async () => ({ run: { runId: 'restored', version: 5, output: { draft: { rawText: '恢复的 A' } } } }) });
    await restoring;
    assert.equal(setup.context.descriptionA, editDuringRestore ? '编辑中的新 A' : '恢复的 A');
    assert.equal(setup.context.currentAgentRunId, editDuringRestore ? '' : 'restored');
    assert.equal(setup.context.agentBusy, false);
  }
});

test('history restore sync completion cannot close a newer dialog, affect a new project or overwrite later A edits', async () => {
  for (const changed of ['project', 'modal', 'edited-a']) {
    const setup = makeContext(), sync = deferred();
    setup.context.ui.openModal('历史', '恢复草稿');
    setup.context.agentRunHistory = [{ runId: 'old', task: 'description_a', status: 'completed', output: { draft: { rawText: '旧历史 A' } } }];
    setup.context.fetch = async (_url, options = {}) => {
      if (options.method === 'POST') return { ok: true, json: async () => ({ run: { runId: 'restored', output: { draft: { rawText: '恢复 A' } } } }) };
      if (options.method === 'PUT') return sync.promise;
      return { ok: true, json: async () => ({}) };
    };
    const restoring = setup.context.ui.restoreAgentRun('old'); await tick();
    assert.equal(setup.context.descriptionA, '恢复 A');
    if (changed === 'project') { setup.context.projectId = 'new'; setup.context.projectApiUrl = '/api/projects/new'; setup.context.projectSession++; setup.context.ui.invalidateAgentRequest(); }
    else if (changed === 'modal') setup.context.ui.openModal('新弹窗', '新的内容');
    else setup.context.descriptionA = '稍后修改 A';
    const before = plain(setup.calls);
    sync.resolve({ ok: true, json: async () => ({}) }); await restoring;
    assert.equal(setup.modal.open, true);
    assert.deepEqual(plain(setup.calls), before);
    if (changed === 'edited-a') assert.equal(setup.context.descriptionA, '稍后修改 A');
  }
});

const failedAgentResponse = (code = 'MODEL_TIMEOUT', status = 504, message = '服务失败') => ({ ok: false, status, json: async () => ({ error: message, errorCode: code }) });
for (const downstream of [false, true]) {
  test(`clearing a failed Agent request after the real pause action preserves the interrupted status (generated=${downstream})`, async () => {
    const setup = makeContext({ downstream });
    setup.context.editingAgent = true;
    setup.context.fetch = async (_url, options = {}) => options.method === 'POST' ? failedAgentResponse() : { ok: true };
    setup.next.emit('click'); await tick();
    assert.equal(setup.failure.hidden, false);
    setup.context.interruptButton.emit('click');
    assert.deepEqual(setup.calls.filter(([kind]) => kind === 'status').at(-1), ['status', '已中断', 'is-interrupted']);
    setup.replyInput.value = '中断后编辑的补充';
    setup.replyInput.emit('input');
    assert.equal(setup.failure.hidden, true);
    assert.equal(setup.context.interrupted, true);
    assert.equal(setup.next.disabled, true);
    assert.equal(setup.context.currentStep.classList.contains('paused'), true);
    assert.deepEqual(setup.calls.filter(([kind]) => kind === 'status').at(-1), ['status', '已中断', 'is-interrupted']);
    assert.equal(setup.context.descriptionA, downstream ? '原 A' : '');
  });
}

for (const [failureKind, expected] of [['network', /网络|连接/], ['read', /项目.*读取/], ['create-network', /网络|连接/], ['save', /保存/], ['restore-api', /既有恢复接口错误/]]) {
  test(`history restore retains useful ${failureKind} failure feedback and the existing restore API message`, async () => {
    const setup = makeContext({ downstream: true }), restoreButton = element('恢复为新草稿'), requested = [];
    restoreButton.isConnected = true;
    setup.context.modalBody.querySelector = () => restoreButton;
    setup.context.agentRunHistory = [{ runId: 'old', task: 'description_a', status: 'completed', output: { draft: { rawText: '旧历史 A' } } }];
    const history = plain(setup.context.agentRunHistory);
    setup.context.fetch = async (url, options = {}) => {
      const method = options.method || 'GET';
      requested.push(method);
      if (method === 'GET') {
        if (failureKind === 'network') throw new TypeError('Failed to fetch');
        return { ok: failureKind === 'restore-api', status: failureKind.startsWith('create-') || failureKind === 'save' ? 404 : 503 };
      }
      if (method === 'PUT' && failureKind === 'create-network') throw new TypeError('Failed to fetch');
      return { ok: false, status: method === 'PUT' ? 500 : 409, json: async () => ({ error: '既有恢复接口错误' }) };
    };
    await setup.context.ui.restoreAgentRun('old');
    assert.match(setup.calls.filter(([kind]) => kind === 'toast').at(-1)[1], expected);
    assert.equal(setup.context.agentBusy, false);
    assert.equal(setup.failure.hidden, true);
    assert.equal(restoreButton.disabled, false);
    assert.equal(restoreButton.textContent, '恢复为新草稿');
    assert.equal(setup.context.descriptionA, '原 A'); assert.equal(setup.context.promptB, '原 B');
    assert.deepEqual(plain(setup.context.agentRunHistory), history);
    assert.deepEqual(requested, failureKind === 'restore-api' ? ['GET', 'POST'] : failureKind.startsWith('create-') || failureKind === 'save' ? ['GET', 'PUT'] : ['GET']);
  });
}

for (const task of ['description_a', 'follow_up']) {
  test(`${task} keeps a persistent task-specific failure and its manual retry preserves existing content`, async () => {
    const setup = makeContext({ downstream: true });
    setup.context.editingAgent = true;
    const product = plain(setup.context.productState), oldA = setup.context.descriptionA, oldB = setup.context.promptB, oldResults = plain(setup.context.generatedResults);
    let posts = 0; const pending = deferred();
    setup.context.fetch = async (url, options = {}) => {
      if (options.method === 'POST') { setup.requests.push({ url, body: JSON.parse(options.body) }); posts++; return posts === 1 ? failedAgentResponse() : pending.promise; }
      return { ok: true, json: async () => ({}) };
    };
    (task === 'description_a' ? setup.next : setup.replyButton).emit('click'); await tick();
    assert.equal(posts, 1);
    assert.equal(setup.context.agentBusy, false);
    assert.equal(setup.failure.hidden, false);
    assert.match(setup.failureTitle.textContent, task === 'description_a' ? /生成描述词 A/ : /提交补充/);
    assert.match(setup.failureMessage.textContent, /超时/);
    assert.equal(setup.retryButton.textContent, task === 'description_a' ? '重试生成描述词 A' : '重新提交补充');
    assert.equal(setup.context.descriptionA, oldA); assert.equal(setup.context.promptB, oldB);
    assert.deepEqual(plain(setup.context.productState), product); assert.deepEqual(plain(setup.context.generatedResults), oldResults);
    assert.equal(setup.replyInput.value, ' 尚未提交的方向文字 ');
    assert.equal(setup.storage.size, 0);
    setup.retryButton.emit('click'); setup.retryButton.emit('click'); await tick();
    assert.equal(posts, 2); assert.equal(setup.requests[1].body.task, task);
    assert.equal(setup.context.agentBusy, true); assert.equal(setup.scenes[1].disabled, true);
    assert.equal(setup.failure.hidden, true);
    pending.resolve({ ok: true, json: async () => ({ run: { runId: 'retry-ok', output: { descriptionA: oldA, reply: '重试回复' } } }) }); await tick();
    assert.equal(setup.context.agentBusy, false); assert.equal(setup.failure.hidden, true);
    assert.equal(setup.context.promptB, oldB);
    assert.equal(task === 'follow_up' ? setup.greeting.textContent : setup.context.currentAgentRunId, task === 'follow_up' ? '重试回复' : 'retry-ok');
  });
}

test('Agent errors preserve stable codes and HTTP status and show safe useful reasons without raw response text', async () => {
  for (const [code, status, expected] of [['AGENT_NOT_CONFIGURED', 503, /配置/], ['MODEL_INVALID_JSON', 502, /格式/], ['MODEL_SCHEMA_INVALID', 502, /格式/], ['INVALID_REQUEST', 400, /资料|输入/], ['PERSIST_FAILED', 500, /保存/], ['UNKNOWN', 502, /暂时不可用/], ['toString', 502, /暂时不可用/], ['constructor', 429, /请求较多/]]) {
    const setup = makeContext();
    setup.context.fetch = async (_url, options = {}) => options.method === 'POST' ? failedAgentResponse(code, status, '<img src=x onerror=alert(1)> secret=sk-private') : { ok: true };
    await assert.rejects(setup.context.ui.requestAgent('description_a'), (error) => error.code === code && error.status === status);
    setup.next.emit('click'); await tick();
    assert.equal(setup.failure.hidden, false); assert.match(setup.failureMessage.textContent, expected);
    assert.doesNotMatch(setup.failureMessage.textContent, /<img|sk-private|secret=/);
    assert.equal(setup.failureMessage.innerHTML, '');
  }
});

test('network and malformed-success failures remain actionable without losing the previous A or generating B', async () => {
  for (const failureKind of ['network', 'missing-output', 'invalid-json']) {
    const setup = makeContext({ downstream: true }); setup.context.editingAgent = true;
    setup.context.fetch = async (_url, options = {}) => {
      if (options.method !== 'POST') return { ok: true };
      if (failureKind === 'network') throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, json: async () => { if (failureKind === 'invalid-json') throw new SyntaxError('bad response'); return {}; } };
    };
    setup.next.emit('click'); await tick();
    assert.equal(setup.failure.hidden, false); assert.equal(setup.retryButton.disabled, false);
    assert.match(setup.failureMessage.textContent, failureKind === 'network' ? /网络|连接/ : /格式|有效/);
    assert.equal(setup.context.descriptionA, '原 A'); assert.equal(setup.context.promptB, '原 B'); assert.equal(setup.context.progress, 4);
  }
});

test('editing the supplemental input clears its old failure and normal resubmission uses the current text once', async () => {
  const setup = makeContext(); let posts = 0;
  setup.context.fetch = async (_url, options = {}) => {
    if (options.method === 'POST') { posts++; setup.requests.push(JSON.parse(options.body)); return failedAgentResponse(); }
    return { ok: true };
  };
  setup.replyButton.emit('click'); await tick();
  assert.equal(setup.failure.hidden, false);
  setup.replyInput.value = '新的补充'; setup.replyInput.emit('input');
  assert.equal(setup.failure.hidden, true);
  setup.retryButton.emit('click'); await tick(); assert.equal(posts, 1);
  setup.replyButton.emit('click'); await tick(); assert.equal(posts, 2); assert.equal(setup.requests[1].note, '新的补充');
});

test('changing committed inputs or project invalidates an old failure without replaying its snapshot', async () => {
  for (const change of ['product', 'scene', 'session']) {
    const setup = makeContext(); let posts = 0;
    setup.context.fetch = async (_url, options = {}) => { if (options.method === 'POST') { posts++; return failedAgentResponse(); } return { ok: true }; };
    setup.next.emit('click'); await tick(); assert.equal(setup.failure.hidden, false);
    if (change === 'product') setup.context.productState.name = '新商品';
    if (change === 'scene') setup.scenes[1].emit('click');
    if (change === 'session') setup.context.projectSession++;
    setup.retryButton.emit('click'); await tick();
    assert.equal(posts, 1); assert.equal(setup.failure.hidden, true);
  }
});

test('stale failures cannot expose a retry in the new project or replace a newer failure', async () => {
  const setup = makeContext(), old = deferred(); let posts = 0;
  setup.context.fetch = async (_url, options = {}) => { if (options.method === 'POST') return ++posts === 1 ? old.promise : failedAgentResponse('AGENT_NOT_CONFIGURED', 503); return { ok: true }; };
  setup.next.emit('click'); await tick();
  setup.context.projectId = 'new'; setup.context.projectApiUrl = '/api/projects/new'; setup.context.projectSession++; setup.context.ui.invalidateAgentRequest();
  setup.next.emit('click'); await tick(); assert.match(setup.failureMessage.textContent, /配置/);
  old.resolve(failedAgentResponse('MODEL_TIMEOUT', 504)); await tick();
  assert.match(setup.failureMessage.textContent, /配置/); assert.equal(setup.context.agentBusy, false);
});
