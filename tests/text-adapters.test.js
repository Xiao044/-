const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixtureSource = fs.readFileSync(path.join(__dirname, 'extension-adapters.test.js'), 'utf8');
const { makeFixture, FixtureElement, add, collect, load } = new Function('require', '__dirname', fixtureSource.slice(0, fixtureSource.indexOf('const adapterCases =')) + '\nreturn { makeFixture,FixtureElement,add,collect,load };')(require, __dirname);
Object.defineProperty(FixtureElement.prototype, 'isConnected', { get() { let n = this; while (n.parentElement) n = n.parentElement; return n.tagName === 'BODY'; } });
FixtureElement.prototype.compareDocumentPosition = function(other) { let root = this; while (root.parentElement) root = root.parentElement; const nodes = collect(root); return nodes.indexOf(other) > nodes.indexOf(this) ? 4 : 2; };
const jobFor = (platform) => ({ kind: 'prompt_b', protocolVersion: 'text-v1', projectId: 'synthetic', jobId: 'job-text', attemptId: 'attempt-text', routeSession: 'route-text', platform, model: 'current-page', source: { fingerprint: 'a'.repeat(64) }, prompt: '只输出纯文本 B，不生成图片', status: 'preparing', expiresAt: new Date(Date.now() + 180000).toISOString() });
const setup = (platform) => {
  const f = makeFixture({ platform, generatedOnClick: false }), timers = new Map();
  f.context.location.hostname = platform === 'doubao' ? 'www.doubao.com' : 'chatgpt.com'; f.context.location.href = `https://${f.context.location.hostname}/chat/synthetic`;
  f.main = f.document.querySelector('main'); f.scope = f.prompt.parentElement;
  f.scope.children.splice(f.scope.children.indexOf(f.prompt), 1);
  if (platform === 'doubao') {
    f.scope.setAttribute('data-testid', 'chat_input');
    let parent = f.scope; for (let i = 0; i < 8; i++) parent = add(parent, new FixtureElement('div', i === 6 ? { 'data-testid': 'chat_input_input' } : {}));
    f.prompt = add(parent, new FixtureElement('div', { contenteditable: 'true' }));
    f.button.setAttribute('data-testid', 'chat_input_send_button');
  } else {
    f.scope.tagName = 'FORM'; f.prompt = add(f.scope, new FixtureElement('div', { id: 'prompt-textarea', contenteditable: 'true' })); f.button.setAttribute('data-testid', 'send-button');
  }
  let serial = 0; f.context.setInterval = (fn) => { const key = ++serial; timers.set(key, fn); return key; }; f.context.clearInterval = (key) => timers.delete(key);
  f.tick = (count = 1) => { for (let i = 0; i < count; i++) [...timers.values()].forEach((fn) => fn()); };
  f.node = (role, value) => {
    const parent = platform === 'chatgpt' ? add(f.main, new FixtureElement('article')) : f.main;
    const attrs = platform === 'doubao' ? { 'data-testid': role === 'user' ? 'send_message' : 'receive_message', 'data-message-role': role } : { 'data-message-author-role': role };
    return add(parent, new FixtureElement('div', attrs, { textContent: value }));
  };
  f.done = (node) => add(platform === 'chatgpt' ? node.closest('article') : node, new FixtureElement('button', { 'data-testid': platform === 'chatgpt' ? 'copy-turn-action-button' : 'message_action_copy' }));
  f.stop = () => add(f.scope, new FixtureElement('button', { 'data-testid': platform === 'chatgpt' ? 'stop-button' : 'chat_input_stop_button' }));
  f.oldUser = f.node('user', 'historical user'); f.oldAssistant = f.node('assistant', 'historical reply'); f.done(f.oldAssistant);
  f.context.ZaotuPlatform = { run() { throw new Error('IMAGE_CALL_FORBIDDEN'); } };
  f.context.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
  f.button.onClick = () => { f.prompt.textContent = ''; f.newUser = f.node('user', jobFor(platform).prompt); };
  load(f, 'text-adapters.js');
  f.send = (message) => { let response; for (const listener of f.chrome.runtime.listeners) listener(message, {}, (r) => response = r); return response; };
  f.start = () => f.send({ type: 'ZAOTU_RUN_TEXT', job: jobFor(platform) });
  f.events = () => f.chrome.runtime.sent.filter((message) => message.type === 'ZAOTU_TEXT_EVENT');
  return f;
};
for (const platform of ['doubao', 'chatgpt']) {
  test(`${platform} text adapter negotiates explicit kind/version and never invokes image adapters`, () => {
    const f = setup(platform), ping = f.send({ type: 'ZAOTU_TEXT_PING' }); assert.equal(ping.adapterVersion, '0.5.1'); assert.equal(ping.protocolVersion, 'text-v1'); assert.deepEqual(Array.from(ping.capabilities), ['prompt_b']);
    assert.equal(f.send({ type: 'ZAOTU_RUN_TEXT', job: { ...jobFor(platform), kind: 'image' } }).ok, false); assert.equal(f.button.clickCount, 0);
    assert.equal(f.start().ok, true); assert.equal(f.button.clickCount, 1);
    assert.equal(f.events()[0].state, 'submitted'); assert.equal(f.events()[0].routeSession, 'route-text');
  });
  test(`${platform} requires new user-turn anchor and excludes historical replies and reused assistant nodes`, () => {
    const f = setup(platform); f.button.onClick = () => { f.prompt.textContent = ''; }; assert.equal(f.start().ok, true);
    f.oldAssistant.textContent = 'reused node changed'; f.tick(10); assert.equal(f.events().some((e) => e.state === 'completed'), false);
    f.newUser = f.node('user', jobFor(platform).prompt); f.oldAssistant.textContent = 'another reused reply'; f.tick(10); assert.equal(f.events().some((e) => e.state === 'completed'), false);
    const reply = f.node('assistant', 'real new reply'); f.done(reply); f.tick(4); assert.equal(f.events().at(-1).state, 'completed'); assert.equal(f.events().at(-1).rawReply, 'real new reply');
  });
  test(`${platform} streaming pauses and text stability without an end marker never complete`, () => {
    const f = setup(platform); f.start(); const reply = f.node('assistant', 'first token'); f.tick(20); assert.equal(f.events().some((e) => e.state === 'completed'), false);
    const stop = f.stop(); f.done(reply); f.tick(20); assert.equal(f.events().some((e) => e.state === 'completed'), false);
    stop.style.display = 'none'; reply.textContent = 'final complete reply'; f.tick(3); assert.equal(f.events().some((e) => e.state === 'completed'), false);
    f.tick(); assert.equal(f.events().at(-1).completionEvidence, 'new-assistant-action-bar-stable');
    assert.equal(f.events().at(-1).rawReply, 'final complete reply'); assert.equal(f.button.clickCount, 1);
  });
  test(`${platform} text changes reset stability after completion marker`, () => {
    const f = setup(platform); f.start(); const reply = f.node('assistant', 'partial'); f.done(reply); f.tick(3); reply.textContent = 'final'; f.tick(3); assert.equal(f.events().some((e) => e.state === 'completed'), false); f.tick(); assert.equal(f.events().at(-1).rawReply, 'final');
  });
  test(`${platform} refuses nonempty foreign composer, attachments, active tools and running generation`, () => {
    for (const mode of ['composer', 'attachment', 'tool', 'running', 'dialog']) {
      const f = setup(platform);
      if (mode === 'composer') f.prompt.textContent = 'foreign draft';
      if (mode === 'attachment') add(f.scope, new FixtureElement('div', { 'data-testid': 'attachment-preview' }));
      if (mode === 'tool') add(f.scope, new FixtureElement('div', { 'data-testid': 'tool-selected' }));
      if (mode === 'running') f.stop();
      if (mode === 'dialog') add(f.main, new FixtureElement('div', { role: 'dialog' }));
      assert.equal(f.start().ok, false, mode); assert.equal(f.button.clickCount, 0); assert.equal(f.events().length, 0);
    }
  });
  test(`${platform} refuses ambiguous scoped send controls and does not choose foreign controls`, () => {
    const f = setup(platform); add(f.scope, new FixtureElement('button', { 'data-testid': platform === 'doubao' ? 'chat_input_send_button' : 'send-button' }));
    assert.equal(f.start().ok, false); assert.equal(f.button.clickCount, 0);
  });
  test(`${platform} duplicate prepares and image-tab leases never click twice`, () => {
    const f = setup(platform); assert.equal(f.start().ok, true); assert.equal(f.start().errorCode, 'DUPLICATE_PREPARE'); assert.equal(f.button.clickCount, 1);
    const g = setup(platform); g.context.window.__zaotuActionLock = 'image:active'; assert.equal(g.start().errorCode, 'TAB_BUSY'); assert.equal(g.button.clickCount, 0);
  });
  test(`${platform} page/conversation change invalidates the task and never returns a candidate`, () => {
    for (const mode of ['url', 'anchor']) {
      const f = setup(platform); f.start(); f.tick();
      if (mode === 'url') f.context.location.href += '-changed';
      else { f.newUser.parentElement.children.splice(f.newUser.parentElement.children.indexOf(f.newUser), 1); f.newUser.parentElement = null; }
      f.tick(); assert.equal(f.events().at(-1).errorCode, 'PAGE_CHANGED'); assert.equal(f.context.window.__zaotuActionLock, null);
    }
  });
  test(`${platform} cancel checks identity and suppresses delivery while retaining collision protection`, () => {
    const f = setup(platform), job = jobFor(platform); f.start();
    assert.equal(f.send({ type: 'ZAOTU_CANCEL_TEXT', ...job, attemptId: 'wrong' }).ok, false);
    assert.equal(f.send({ type: 'ZAOTU_CANCEL_TEXT', ...job }).ok, true); assert.ok(f.context.window.__zaotuActionLock);
    const reply = f.node('assistant', 'late ignored'); f.done(reply); f.tick(5);
    assert.equal(f.events().some((e) => e.state === 'completed'), false); assert.equal(f.context.window.__zaotuActionLock, null);
  });
  test(`${platform} historical or ambiguous assistant turns are never accepted`, () => {
    const f = setup(platform); f.start(); f.node('assistant', 'one'); f.node('assistant', 'two'); f.tick(); assert.equal(f.events().at(-1).errorCode, 'AMBIGUOUS_ASSISTANT'); assert.equal(f.events().some((e) => e.state === 'completed'), false);
  });
}
const background = () => {
  const storage = {}, listeners = [], sends = [], context = { console, URL, Date, Promise, PLATFORM_URLS: { doubao: ['https://www.doubao.com/*'], chatgpt: ['https://chatgpt.com/*'] },
    chrome: { runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } }, storage: { session: { async get(key) { return key === null ? { ...storage } : { [key]: storage[key] }; }, async set(values) { Object.assign(storage, values); } } }, tabs: { query: async () => [{ id: 7, active: true, status: 'complete' }] } },
    sendTabMessage: async (tabId, message) => { sends.push({ tabId, message }); return message.type === 'ZAOTU_TEXT_PING' ? { ok: true, platform: 'doubao', adapterVersion: '0.5.1', protocolVersion: 'text-v1', pageUrl: 'https://www.doubao.com/chat/test', capabilities: ['prompt_b'] } : { ok: true }; },
    toWorkbench: async (route, message) => { sends.push({ tabId: route.sourceTabId, message }); }
  };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname, '../doubao-extension/background-text.js'), 'utf8'), context);
  const sender = { tab: { id: 1, url: 'http://localhost:5173/' }, url: 'http://localhost:5173/' };
  const call = (message, from = sender) => new Promise((resolve) => { for (const fn of listeners) fn(message, from, resolve); });
  const event = (state = 'submitted') => { const job = jobFor('doubao'); return { type: 'ZAOTU_TEXT_EVENT', ...job, sourceFingerprint: job.source.fingerprint, state }; };
  return { storage, sends, context, call, sender, event };
};
test('text routing refuses wrong sender, route session, kind, attempt and cross-project events without fallback', async () => {
  const f = background(); assert.equal((await f.call({ type: 'ZAOTU_PREPARE_TEXT', job: jobFor('doubao') })).ok, true);
  for (const patch of [{ routeSession: 'wrong' }, { projectId: 'other' }, { attemptId: 'old' }, { kind: 'image' }]) assert.equal((await f.call({ ...f.event(), ...patch }, { tab: { id: 7 }, url: 'https://www.doubao.com/chat/test' })).ok, false);
  assert.equal((await f.call(f.event(), { tab: { id: 8 }, url: 'https://www.doubao.com/chat/test' })).ok, false);
  assert.equal(f.sends.filter((entry) => entry.tabId === 1).length, 0);
  assert.equal((await f.call(f.event(), { tab: { id: 7 }, url: 'https://www.doubao.com/chat/test' })).ok, true);
  assert.equal(f.sends.filter((entry) => entry.tabId === 1).length, 1);
});
test('duplicate text routing and ambiguous tab selection cannot submit twice', async () => {
  const f = background(), request = { type: 'ZAOTU_PREPARE_TEXT', job: jobFor('doubao') };
  const results = await Promise.all([f.call(request), f.call(request)]); assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(f.sends.filter((entry) => entry.message.type === 'ZAOTU_RUN_TEXT').length, 1);
  const g = background(); g.context.chrome.tabs.query = async () => [{ id: 7, status: 'complete' }, { id: 8, status: 'complete' }]; assert.equal((await g.call(request)).errorCode, 'AMBIGUOUS_OR_MISSING_TEXT_TAB');
});
test('text routing requires negotiated adapter version and source workbench; never runs image preparation', async () => {
  const f = background(), request = { type: 'ZAOTU_PREPARE_TEXT', job: jobFor('doubao') };
  assert.equal((await f.call(request, { tab: { id: 4 }, url: 'https://foreign.example/' })).ok, false);
  f.context.sendTabMessage = async () => ({ ok: true, platform: 'doubao', adapterVersion: '0.4.4' });
  assert.equal((await f.call(request)).errorCode, 'TEXT_ADAPTER_VERSION_MISMATCH');
  assert.equal(f.sends.some((entry) => /IMAGE|DOUBAO_JOB|PLATFORM_JOB/.test(entry.message.type)), false);
});
test('text cancel is owned by original workbench and rejects all delayed events', async () => {
  const f = background(), job = jobFor('doubao'); await f.call({ type: 'ZAOTU_PREPARE_TEXT', job });
  const cancel = { ...f.event(), type: 'ZAOTU_CANCEL_TEXT' };
  assert.equal((await f.call(cancel, { ...f.sender, tab: { id: 2 } })).ok, false);
  assert.equal((await f.call(cancel)).ok, true);
  assert.equal((await f.call(f.event('completed'), { tab: { id: 7 }, url: 'https://www.doubao.com/chat/test' })).ok, false);
});

test('durable text reply transport replays only to its original workbench until API-save acknowledgement', async () => {
  const f = background(), job = jobFor('doubao'); await f.call({ type: 'ZAOTU_PREPARE_TEXT', job });
  const from = { tab: { id: 7 }, url: 'https://www.doubao.com/chat/test' };
  await f.call(f.event('submitted'), from); await f.call(f.event('running'), from); await f.call({ ...f.event('completed'), rawReply: 'durable synthetic reply' }, from);
  f.sends.length = 0;
  const replay = { ...f.event(), type: 'ZAOTU_REPLAY_TEXT' };
  assert.equal((await f.call(replay, { ...f.sender, tab: { id: 2 } })).ok, false); assert.equal(f.sends.length, 0);
  assert.equal((await f.call(replay)).ok, true); assert.deepEqual(f.sends.map((item) => item.message.state), ['submitted', 'running', 'completed']);
  const completed = f.sends.at(-1).message;
  assert.equal(completed.rawReply, 'durable synthetic reply');
  assert.equal((await f.call({ ...replay, type: 'ZAOTU_ACK_TEXT', eventId: completed.eventId })).ok, true);
  f.sends.length = 0; await f.call(replay); assert.equal(f.sends.length, 0);
  assert.equal((await f.call({ type: 'ZAOTU_PREPARE_TEXT', job })).ok, false);
});
test('text routes refuse same-tab events after a conversation URL change', async () => {
  const f = background(); await f.call({ type: 'ZAOTU_PREPARE_TEXT', job: jobFor('doubao') });
  assert.equal((await f.call(f.event(), { tab: { id: 7 }, url: 'https://www.doubao.com/chat/other' })).ok, false);
  assert.equal(f.sends.filter((item) => item.tabId === 1).length, 0);
});

for (const platform of ['doubao', 'chatgpt']) {
  test(`${platform} cancelled image preparation cannot resume into a newer text task`, async () => {
    const f = setup(platform), waits = [];
    f.context.setTimeout = (callback) => { waits.push(callback); return waits.length; };
    load(f, ...(platform === 'doubao' ? ['content-doubao.js'] : ['platform-common.js', 'content-chatgpt.js']));
    if (platform === 'chatgpt') f.context.ZaotuPlatform = f.context.window.ZaotuPlatform;
    const imageJob = { jobId: 'image-preparing', attemptId: 'image-preparing-1', prompt: 'CANCELLED IMAGE MUST NOT WRITE' };
    const runMessage = { type: platform === 'doubao' ? 'ZAOTU_RUN_DOUBAO_JOB' : 'ZAOTU_RUN_PLATFORM_JOB', platform, job: imageJob };
    let imageResult;
    for (const listener of f.chrome.runtime.listeners) listener(runMessage, {}, (result) => imageResult = result);
    assert.equal(waits.length, 1); assert.equal(f.button.clickCount, 0);
    assert.equal(f.send({ type: 'ZAOTU_CANCEL_PLATFORM_JOB', platform, jobId: imageJob.jobId, attemptId: imageJob.attemptId }).ok, true);
    assert.equal(f.start().ok, true); assert.equal(f.button.clickCount, 1);
    const textLock = f.context.window.__zaotuActionLock;
    waits.shift()(); for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(f.button.clickCount, 1, 'cancelled image runner must never submit after text takes ownership');
    assert.equal(f.prompt.textContent, '', 'cancelled image runner must never overwrite the text composer');
    assert.equal(f.context.window.__zaotuActionLock, textLock, 'late cancellation/finalizer must not release the text lock');
    assert.equal(imageResult?.state, 'cancelled');
  });
}

for (const platform of ['doubao', 'chatgpt']) for (const stage of ['fetch', 'blob']) {
  test(`${platform} cancellation during image ${stage} preparation cannot upload or submit after text starts`, async () => {
    const f = setup(platform), waits = []; let resolvePreparation, imageResult, fetched = false, readingBlob = false;
    const preparation = new Promise((resolve) => resolvePreparation = resolve);
    f.context.setTimeout = (callback) => { waits.push(callback); return waits.length; };
    const input = add(f.scope, new f.context.HTMLInputElement({ type: 'file' })); input.files = [];
    f.context.fetch = () => { fetched = true; return stage === 'fetch' ? preparation : Promise.resolve({ blob: () => { readingBlob = true; return preparation; } }); };
    load(f, ...(platform === 'doubao' ? ['content-doubao.js'] : ['platform-common.js', 'content-chatgpt.js']));
    if (platform === 'chatgpt') f.context.ZaotuPlatform = f.context.window.ZaotuPlatform;
    const job = { jobId: 'image-upload', attemptId: 'image-upload-1', prompt: 'cancelled image prompt', imageDataUrl: 'data:image/png;base64,AA==' };
    for (const listener of f.chrome.runtime.listeners) listener({ type: platform === 'doubao' ? 'ZAOTU_RUN_DOUBAO_JOB' : 'ZAOTU_RUN_PLATFORM_JOB', platform, job }, {}, (result) => imageResult = result);
    waits.shift()(); for (let i = 0; i < 10; i++) await Promise.resolve();
    f.tick(); for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(fetched, true); if (stage === 'blob') assert.equal(readingBlob, true);
    assert.equal(f.send({ type: 'ZAOTU_CANCEL_PLATFORM_JOB', platform, jobId: job.jobId, attemptId: job.attemptId }).ok, true);
    f.prompt.textContent = ''; // User explicitly clears the cancelled image draft before starting text.
    assert.equal(f.start().ok, true); const owner = f.context.window.__zaotuActionLock;
    resolvePreparation(stage === 'fetch' ? { blob: async () => ({ type: 'image/png' }) } : { type: 'image/png' });
    for (let i = 0; i < 15; i++) await Promise.resolve();
    assert.equal(imageResult?.state, 'cancelled'); assert.equal(input.files.length, 0); assert.equal(f.button.clickCount, 1);
    assert.equal(f.context.window.__zaotuActionLock, owner); assert.equal(f.prompt.textContent, '');
  });
}
