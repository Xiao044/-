const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const fixture = fs.readFileSync(path.join(__dirname, 'generation-jobs.test.js'), 'utf8');
const { startServer, json } = new Function('require', '__dirname', fixture.slice(0, fixture.indexOf("test('")) + '\nreturn {startServer,json};')(require, __dirname);
const project = (id = 'text-demo', a = '已确认珍珠项链窗边柔光居中构图') => ({ projectId: id, product: { name: '珍珠项链' }, descriptionA: a, acceptedASnapshot: { rawText: a, fields: { scene: '窗边' } }, descriptionAStructured: { scene: '窗边' }, currentAgentRunId: 'run-confirmed', currentAgentRunVersion: 2, promptB: 'manual B', progress: 3 });
const identity = (job) => ({ kind: job.kind, protocolVersion: job.protocolVersion, projectId: job.projectId, jobId: job.jobId, attemptId: job.attemptId, routeSession: job.routeSession, sourceFingerprint: job.source.fingerprint });
const setup = async (t, options) => {
  const server = await startServer(t, options);
  const call = async (route = '', method = 'GET', body, id = 'text-demo') => {
    const response = await json(server.base, `/api/projects/${id}${route}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, ...(await response.json()) };
  };
  assert.equal((await call('', 'PUT', project())).status, 200);
  const create = async (key = 'request-1') => call('/text-jobs', 'POST', { idempotencyKey: key });
  const action = async (job, action, extra = {}) => call(`/text-jobs/${job.jobId}/${action}`, 'POST', { ...identity(job), ...extra });
  const complete = async (job) => {
    assert.equal((await action(job, 'dispatch')).status, 200);
    assert.equal((await action(job, 'events', { state: 'submitted' })).status, 200);
    return action(job, 'events', { state: 'completed', rawReply: '网页原始 B\n柔光写实摄影', pageUrl: 'https://www.doubao.com/chat/synthetic', userAnchor: 'new-user-1', completionEvidence: 'new-assistant-action-bar-stable' });
  };
  return { ...server, call, create, action, complete };
};

test('text API snapshots confirmed A, versioned instruction and independent provider selection; no image store created', async (t) => {
  const s = await setup(t);
  const selected = await s.call('/text-jobs', 'PATCH', { platform: 'chatgpt', model: 'current-page' });
  assert.equal(selected.status, 200);
  const made = await s.create(), job = made.job;
  assert.equal(made.status, 201); assert.equal(job.kind, 'prompt_b'); assert.equal(job.platform, 'chatgpt');
  assert.equal(job.model, 'current-page'); assert.equal(job.source.version, 2); assert.equal(job.source.runId, 'run-confirmed'); assert.match(job.source.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(job.instructionVersion, 'prompt-b-v1'); assert.match(job.prompt, /不生成图片/);
  assert.equal(fs.existsSync(path.join(s.dataDir, 'generation-jobs.json')), false);
  assert.equal((await s.call('/text-jobs', 'PATCH', { platform: 'gemini', model: 'current-page' })).status, 400);
  assert.equal((await s.call('/text-jobs', 'PATCH', { platform: 'doubao', model: 'invented-model' })).status, 400);
});
test('text creation is idempotent concurrently and dispatch is a one-time persisted claim', async (t) => {
  const s = await setup(t), results = await Promise.all([s.create(), s.create()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  assert.equal(results[0].job.jobId, results[1].job.jobId);
  const job = results[0].job;
  assert.equal((await s.create('another')).status, 409);
  assert.equal((await s.action(job, 'dispatch')).status, 200);
  assert.equal((await s.action(job, 'dispatch')).status, 409);
  assert.equal((await s.call('/text-jobs')).workflow.jobs.length, 1);
});
test('text completion is explicit, immutable and candidate-only; no canonical B or image job mutation', async (t) => {
  const s = await setup(t), { job } = await s.create();
  assert.equal((await s.action(job, 'events', { state: 'completed', rawReply: 'early' })).status, 409);
  assert.equal((await s.action(job, 'dispatch')).status, 200);
  assert.equal((await s.action(job, 'events', { state: 'submitted' })).status, 200);
  assert.equal((await s.action(job, 'events', { state: 'completed', rawReply: 'not complete' })).status, 400);
  const result = await s.action(job, 'events', { state: 'completed', rawReply: 'raw web reply', pageUrl: 'https://www.doubao.com/chat/test', userAnchor: 'user-1', completionEvidence: 'new-assistant-action-bar-stable' });
  assert.equal(result.status, 200); assert.equal(result.job.candidate.text, 'raw web reply');
  assert.equal((await s.action(job, 'events', { state: 'completed', rawReply: 'tampered' })).status, 409);
  assert.equal((await s.call('')).project.promptB, 'manual B');
  assert.equal((await s.call('/text-jobs')).workflow.jobs[0].rawReply, 'raw web reply');
  assert.equal(fs.existsSync(path.join(s.dataDir, 'generation-jobs.json')), false);
});
test('ordinary PUT cannot forge, erase or resurrect server-owned text history', async (t) => {
  const s = await setup(t), { job } = await s.create(); await s.complete(job);
  const current = (await s.call('')).project;
  assert.equal((await s.call('', 'PUT', { ...current, textWorkflow: { jobs: [], selection: { platform: 'gemini' } } })).status, 200);
  assert.equal((await s.call('/text-jobs')).workflow.jobs[0].rawReply, '网页原始 B\n柔光写实摄影');
});
test('cross-project, wrong attempt, A fingerprint and route session events are rejected', async (t) => {
  const s = await setup(t), { job } = await s.create(); await s.action(job, 'dispatch');
  for (const patch of [{ projectId: 'other' }, { kind: 'image' }, { attemptId: 'wrong' }, { routeSession: 'wrong' }, { sourceFingerprint: 'a'.repeat(64) }, { protocolVersion: 'old' }]) assert.equal((await s.action(job, 'events', { state: 'submitted', ...patch })).status, 409);
  await s.call('', 'PUT', project('other'), 'other');
  assert.equal((await s.call(`/text-jobs/${job.jobId}/events`, 'POST', { ...identity(job), state: 'submitted' }, 'other')).status, 404);
});
test('cancel/retry creates a new attempt/session with candidate lineage and retry idempotency', async (t) => {
  const s = await setup(t), { job } = await s.create();
  assert.equal((await s.action(job, 'cancel')).job.status, 'cancelled');
  assert.equal((await s.action(job, 'events', { state: 'submitted' })).status, 409);
  const retried = await s.action(job, 'retry'), again = await s.action(job, 'retry');
  assert.equal(retried.status, 201); assert.equal(again.job.jobId, retried.job.jobId);
  assert.notEqual(retried.job.attemptId, job.attemptId); assert.notEqual(retried.job.routeSession, job.routeSession);
  assert.equal(retried.job.parentJobId, job.jobId);
  const done = await s.complete(retried.job); assert.equal(done.job.candidate.parentJobId, job.jobId);
});
test('new A cancels active text and old saved project cannot restore that active history', async (t) => {
  const s = await setup(t), { job } = await s.create(), old = (await s.call('')).project;
  await s.action(job, 'dispatch');
  await s.call('', 'PUT', { ...project(), currentAgentRunVersion: 3 });
  assert.equal((await s.call('/text-jobs')).workflow.jobs[0].status, 'cancelled');
  await s.call('', 'PUT', old);
  assert.equal((await s.call('/text-jobs')).workflow.jobs[0].status, 'cancelled');
  assert.equal((await s.action(job, 'events', { state: 'submitted' })).status, 409);
});
test('platform changes cancel active responses and invalidate completed web provenance', async (t) => {
  const s = await setup(t), { job } = await s.create();
  await s.complete(job);
  const input = { platforms: ['doubao'], prompt: 'edited B', bSnapshot: { positive_prompt: 'edited B', aspect_ratio: '4:5', source: `web-text:${job.jobId}`, version: 1 }, textProvenance: identity(job) };
  assert.equal((await s.call('/generation-jobs', 'POST', input)).status, 201);
  await s.call('/text-jobs', 'PATCH', { platform: 'chatgpt', model: 'current-page' });
  assert.equal((await s.call('/generation-jobs', 'POST', input)).status, 409);
  assert.equal((await s.call('/generation-jobs', 'POST', { platforms: ['doubao'], prompt: 'legacy B' })).status, 201);
});
test('text state survives server restart without duplicate submission; timeout is persisted', async (t) => {
  const s = await setup(t), { job } = await s.create(); await s.action(job, 'dispatch'); await s.action(job, 'events', { state: 'submitted' });
  const ended = new Promise((resolve) => s.child.once('exit', resolve)); s.child.kill(); await ended;
  const restarted = await startServer(t, { dataDir: s.dataDir });
  const state = await (await json(restarted.base, '/api/projects/text-demo/text-jobs')).json();
  assert.equal(state.workflow.jobs[0].status, 'submitted'); assert.equal(state.workflow.jobs.length, 1);
  const response = await json(restarted.base, `/api/projects/text-demo/text-jobs/${job.jobId}/dispatch`, { method: 'POST', body: JSON.stringify(identity(job)) }); assert.equal(response.status, 409);
  // Deterministic synthetic persisted expiry, never touch workspace data.
  const storePath = path.join(s.dataDir, 'projects.json');
  const store = JSON.parse(fs.readFileSync(storePath)); store['text-demo'].textWorkflow.jobs[0].expiresAt = '2000-01-01T00:00:00.000Z'; fs.writeFileSync(storePath, JSON.stringify(store));
  const timed = await (await json(restarted.base, '/api/projects/text-demo/text-jobs')).json(); assert.equal(timed.workflow.jobs[0].status, 'timeout');
});
test('import cancels active history and nested version history cannot resurrect jobs', async (t) => {
  const s = await setup(t), { job } = await s.create(); await s.action(job, 'dispatch');
  const exported = await s.call('/export');
  const imported = await s.call('/import', 'POST', { ...exported, mode: 'replace' }); assert.equal(imported.status, 200);
  assert.equal((await s.call('/text-jobs')).workflow.jobs[0].status, 'cancelled');
  assert.equal((await s.action(job, 'events', { state: 'submitted' })).status, 409);
  exported.versions = [{ versionId: 'version-synthetic-001', projectId: 'text-demo', snapshot: { ...project(), textWorkflow: { schemaVersion: 1, jobs: [{ kind: 'prompt_b', projectId: 'foreign' }], selection: { platform: 'doubao', model: 'current-page' } } } }];
  assert.equal((await s.call('/import', 'POST', { ...exported, mode: 'replace' })).status, 400);
});
test('version snapshots cannot carry text history; restore cancels live work and rejects delayed events', async (t) => {
  const s = await setup(t), { job } = await s.create();
  const saved = await s.call('/versions', 'POST', { snapshot: { ...project(), textWorkflow: { forged: true } } });
  assert.equal(saved.status, 201); assert.equal(saved.version.snapshot.textWorkflow, undefined);
  await s.action(job, 'dispatch');
  assert.equal((await s.call(`/versions/${saved.version.versionId}/restore`, 'POST', {})).status, 201);
  assert.equal((await s.call('/text-jobs')).workflow.jobs[0].status, 'cancelled');
  assert.equal((await s.action(job, 'events', { state: 'submitted' })).status, 409);
});
test('unconfirmed A is rejected; a mutation race has exactly one winner and no image side effects', async (t) => {
  const s = await setup(t);
  await s.call('', 'PUT', { ...project(), acceptedASnapshot: null });
  assert.equal((await s.create()).status, 409);
  await s.call('', 'PUT', project());
  const { job } = await s.create(); await s.action(job, 'dispatch');
  await Promise.all([s.action(job, 'events', { state: 'submitted' }), s.call('', 'PUT', project('text-demo', '新的已确认 A'))]);
  assert.equal((await s.call('/text-jobs')).workflow.jobs[0].status, 'cancelled');
  assert.equal(fs.existsSync(path.join(s.dataDir, 'generation-jobs.json')), false);
});

test('changing A and later restoring the same content cannot resurrect prior completed web provenance', async (t) => {
  const s = await setup(t), { job } = await s.create(); await s.complete(job);
  const original = project(); await s.call('', 'PUT', project('text-demo', '替换为新 A')); await s.call('', 'PUT', original);
  const state = await s.call('/text-jobs'); assert.notEqual(state.workflow.epoch, job.epoch);
  const result = await s.call('/generation-jobs', 'POST', { platforms: ['doubao'], bSnapshot: { positive_prompt: 'edited B', aspect_ratio: '4:5', source: `web-text:${job.jobId}` }, textProvenance: identity(job) });
  assert.equal(result.status, 409);
});
test('imported completed text remains immutable history but cannot become current execution provenance', async (t) => {
  const s = await setup(t), { job } = await s.create(); await s.complete(job);
  const exported = await s.call('/export'); assert.equal((await s.call('/import', 'POST', { ...exported, mode: 'replace' })).status, 200);
  const state = await s.call('/text-jobs'); assert.equal(state.workflow.jobs[0].rawReply, '网页原始 B\n柔光写实摄影'); assert.notEqual(state.workflow.epoch, job.epoch);
  assert.equal((await s.call('/generation-jobs', 'POST', { platforms: ['doubao'], bSnapshot: { positive_prompt: 'B', aspect_ratio: '4:5', source: `web-text:${job.jobId}` }, textProvenance: identity(job) })).status, 409);
  const malformed = structuredClone(exported); malformed.project[0].textWorkflow.jobs[0].candidate.text = { nested: 'untrusted' };
  assert.equal((await s.call('/import', 'POST', { ...malformed, mode: 'replace' })).status, 400);
});
test('image web provenance requires exact source job, route session and current A version', async (t) => {
  const s = await setup(t), { job } = await s.create(); await s.complete(job);
  const input = { platforms: ['doubao'], bSnapshot: { positive_prompt: 'B', aspect_ratio: '4:5', source: `web-text:${job.jobId}` }, textProvenance: identity(job) };
  assert.equal((await s.call('/generation-jobs', 'POST', { ...input, textProvenance: { ...identity(job), routeSession: 'wrong' } })).status, 409);
  assert.equal((await s.call('/generation-jobs', 'POST', { ...input, bSnapshot: { ...input.bSnapshot, source: 'web-text:wrong-job' } })).status, 409);
  await s.call('', 'PUT', { ...project(), currentAgentRunVersion: 4 });
  assert.equal((await s.call('/generation-jobs', 'POST', input)).status, 409);
});
test('text API persistence failure returns an explicit error instead of reporting an unsaved completion', async () => {
  const { createHandler } = require('../lib/text-jobs');
  let result;
  const handler = createHandler({ read: () => ({ demo: project('demo') }), write: () => { throw new Error('synthetic disk full'); }, readBody: async () => ({}), send: (_, status, body) => result = { status, body }, queue: (fn) => Promise.resolve().then(fn) });
  await handler({ url: '/api/projects/demo/text-jobs', method: 'GET' }, {});
  assert.equal(result.status, 500); assert.match(result.body.error, /persisted/);
});

test('server rejects saved unconfirmed raw A and raw edit cache despite retaining an old accepted snapshot', async (t) => {
  const s = await setup(t);
  for (const patch of [{ descriptionA: '尚未确认的新原文' }, { descriptionARawEdit: '尚未确认的编辑缓存' }, { descriptionADraft: { rawText: '尚未确认的草稿原文' } }]) {
    await s.call('', 'PUT', { ...project(), ...patch });
    assert.equal((await s.create(crypto.randomUUID())).status, 409);
  }
});
test('server compares all six semantic A fields and rejects stale confirmation in draft/structured/edit-cache representations', async (t) => {
  const s = await setup(t);
  const fields = { productFactsSummary: '珍珠项链', scene: '窗边', composition: '居中', lightingMood: '柔光', mustKeep: ['商品结构'], forbidden: ['水印'] };
  const baseline = { ...project(), descriptionARawEdit: null, descriptionAFieldEdits: {}, acceptedASnapshot: { rawText: project().descriptionA, fields }, descriptionAStructured: fields, descriptionADraft: { rawText: project().descriptionA, fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }])) } };
  for (const key of Object.keys(fields)) for (const representation of ['draft', 'structured', 'cache']) {
    const changed = structuredClone(baseline), value = Array.isArray(fields[key]) ? ['未确认的新约束'] : '未确认的新语义';
    if (representation === 'draft') changed.descriptionADraft.fields[key].value = value;
    if (representation === 'structured') changed.descriptionAStructured[key] = value;
    if (representation === 'cache') changed.descriptionAFieldEdits = { [key]: value };
    await s.call('', 'PUT', changed);
    assert.equal((await s.create(`${representation}-${key}`)).status, 409, `${representation}/${key}`);
  }
  await s.call('', 'PUT', baseline); assert.equal((await s.create('genuinely-confirmed')).status, 201);
});
test('genuine pre-snapshot manual legacy A remains supported but explicit unconfirmed and agent drafts do not inherit the exemption', async (t) => {
  const s = await setup(t), legacy = project(); delete legacy.acceptedASnapshot; delete legacy.currentAgentRunId;
  await s.call('', 'PUT', { ...legacy, projectId: 'legacy' }, 'legacy');
  const created = await s.call('/text-jobs', 'POST', { idempotencyKey: 'legacy-confirmed' }, 'legacy'); assert.equal(created.status, 201);
  await s.call('', 'PUT', { ...legacy, acceptedASnapshot: null }); assert.equal((await s.create('explicit-null')).status, 409);
  // PUT preserves omitted fields, so use a fresh isolated project to exercise the actual legacy shape.
  await s.call('', 'PUT', { ...legacy, currentAgentRunId: 'new-agent-draft' }); assert.equal((await s.create('agent-draft')).status, 409);
});
test('completion page URL must be a real string on the selected provider, with no credentials or hostile host suffix', async (t) => {
  const s = await setup(t), { job } = await s.create(); await s.action(job, 'dispatch'); await s.action(job, 'events', { state: 'submitted' });
  const base = { state: 'completed', rawReply: 'synthetic raw reply', userAnchor: 'new-user', completionEvidence: 'new-assistant-action-bar-stable' };
  for (const pageUrl of [{ toString: 'https://www.doubao.com/' }, 123, 'https://chatgpt.com/c/wrong-provider', 'https://doubao.com.evil.example/chat', 'https://user:password@www.doubao.com/chat', 'http://www.doubao.com/chat', 'https://www.doubao.com:8443/chat']) assert.equal((await s.action(job, 'events', { ...base, pageUrl })).status, 400);
  assert.equal((await s.action(job, 'events', { ...base, pageUrl: 'https://www.doubao.com/chat/synthetic' })).status, 200);
});

for (const [label, unit] of [['plain', 'x'], ['JSON-escaped', '"\\\u0001\n']]) {
  test(`text prompt ${label} size boundaries include instruction and canonical JSON overhead and roundtrip successful creates`, async (t) => {
    const s = await setup(t), limit = 100000;
    const smallest = project('text-demo', 'AZ');
    assert.equal((await s.call('', 'PUT', smallest)).status, 200);
    const seed = await s.create('size-seed'); assert.equal(seed.status, 201);
    const baseLength = seed.job.prompt.length;
    assert.equal((await s.action(seed.job, 'cancel')).status, 200);
    const escapedUnitLength = JSON.stringify(unit).length - 2;
    for (const targetLength of [limit - 1, limit, limit + 1]) {
      const available = targetLength - baseLength;
      const raw = 'A' + unit.repeat(Math.floor(available / escapedUnitLength)) + 'x'.repeat(available % escapedUnitLength) + 'Z';
      const candidate = project('text-demo', raw);
      assert.ok(Buffer.byteLength(JSON.stringify(candidate), 'utf8') < 512 * 1024, 'valid ordinary project PUT remains below its body limit');
      assert.equal((await s.call('', 'PUT', candidate)).status, 200);
      const before = (await s.call('/text-jobs')).workflow.jobs;
      const created = await s.create(`size-${label}-${targetLength}`);
      if (targetLength > limit) {
        assert.equal(created.status, 400, 'oversize final prompt must be rejected explicitly');
        assert.match(created.error, /prompt.*100000|100000.*prompt/i);
        const after = (await s.call('/text-jobs')).workflow.jobs;
        assert.deepEqual(after, before, 'failed oversize create must not append or alter history');
      } else {
        assert.equal(created.status, 201);
        assert.equal(created.job.prompt.length, targetLength, 'boundary is the fully constructed, JSON-escaped prompt');
        assert.equal(created.job.source.descriptionA, raw, 'source must never be truncated');
        const exported = await s.call('/export'); assert.equal(exported.status, 200);
        assert.equal(exported.project[0].textWorkflow.jobs.at(-1).prompt, created.job.prompt);
        const imported = await s.call('/import', 'POST', { ...exported, mode: 'replace' });
        assert.equal(imported.status, 200, 'every successful boundary create can export and reimport');
        const restored = (await s.call('/text-jobs')).workflow.jobs.at(-1);
        assert.equal(restored.prompt, created.job.prompt); assert.equal(restored.status, 'cancelled');
      }
    }
  });
}

test('retry also rejects an overlimit newly confirmed A without appending an attempt or truncating its source', async (t) => {
  const s = await setup(t), { job } = await s.create(); await s.action(job, 'cancel');
  const raw = 'x'.repeat(100000), nextProject = project('text-demo', raw);
  assert.equal((await s.call('', 'PUT', nextProject)).status, 200);
  const before = (await s.call('/text-jobs')).workflow.jobs;
  const retried = await s.action(job, 'retry');
  assert.equal(retried.status, 400); assert.match(retried.error, /prompt.*100000/i);
  assert.deepEqual((await s.call('/text-jobs')).workflow.jobs, before);
  assert.equal((await s.call('')).project.descriptionA, raw);
});
