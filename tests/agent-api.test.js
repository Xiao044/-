const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');
const mockPath = path.join(__dirname, 'mock-deepseek.js');

const getAvailablePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close((error) => error ? reject(error) : resolve(port));
  });
});

const startServer = async (t, { apiKey = '', mock = false, dataDir = '' } = {}) => {
  const port = await getAvailablePort();
  const env = { ...process.env, PORT: String(port), DEEPSEEK_BASE_URL: 'https://mock.deepseek.invalid', DEEPSEEK_MODEL: '4.0flash' };
  env.DEEPSEEK_API_KEY = apiKey;
  if (dataDir) env.ZAOTU_DATA_DIR = dataDir;
  const child = spawn(process.execPath, [...(mock ? ['-r', mockPath] : []), serverPath], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(() => child.kill());

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before ready: ${logs}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return baseUrl;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start: ${logs}`);
};

const post = (baseUrl, body) => fetch(`${baseUrl}/api/agent`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

const validBody = (note = '请使用自然光') => ({
  task: 'description_a',
  product: { name: '珍珠项链', description: '保持项链结构' },
  scene: '自然窗边',
  note,
  imageUrl: 'must-not-be-sent',
  promptB: 'must-not-be-sent',
  platform: 'doubao'
});

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('POST /api/agent validates requests before checking model configuration', async (t) => {
  const baseUrl = await startServer(t);
  const invalid = await post(baseUrl, { task: 'generate_b' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).errorCode, 'UNSUPPORTED_TASK');

  const malformed = await fetch(`${baseUrl}/api/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{'
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).errorCode, 'INVALID_REQUEST');

  const missingKey = await post(baseUrl, validBody());
  assert.equal(missingKey.status, 503);
  assert.equal((await missingKey.json()).errorCode, 'AGENT_NOT_CONFIGURED');
});

test('POST /api/agent returns the stable schema and maps model failures', async (t) => {
  const baseUrl = await startServer(t, { apiKey: 'test-key', mock: true });
  const success = await post(baseUrl, validBody());
  assert.equal(success.status, 200);
  const output = await success.json();
  assert.equal(output.schemaVersion, 1);
  assert.match(output.runId, /^agent-/);
  assert.equal(output.task, 'description_a');
  assert.equal(output.descriptionAStructured.scene, '自然窗边');
  assert.equal(output.draft.fields.scene.source, 'agent');
  assert.equal(output.model, '4.0flash');

  for (const [marker, expectedCode, expectedStatus] of [
    ['__mock_invalid_json__', 'MODEL_INVALID_JSON', 502],
    ['__mock_empty__', 'MODEL_EMPTY_RESPONSE', 502],
    ['__mock_schema_invalid__', 'MODEL_SCHEMA_INVALID', 502],
    ['__mock_timeout__', 'MODEL_TIMEOUT', 504]
  ]) {
    const response = await post(baseUrl, validBody(marker));
    assert.equal(response.status, expectedStatus, marker);
    assert.equal((await response.json()).errorCode, expectedCode, marker);
  }
});

test('POST /api/agent keeps follow-up response compatible', async (t) => {
  const baseUrl = await startServer(t, { apiKey: 'test-key', mock: true });
  const response = await post(baseUrl, {
    task: 'follow_up',
    product: { name: '珍珠项链' },
    scene: '自然窗边',
    note: '还需要什么信息？'
  });
  assert.equal(response.status, 200);
  const output = await response.json();
  assert.equal(output.followUpQuestion, '希望使用什么背景？');
  assert.equal(output.descriptionA, '');
  assert.equal(output.draft, null);
});

test('initial A normalization stays editable when optional structured fields are missing', async (t) => {
  const baseUrl = await startServer(t, { apiKey: 'test-key', mock: true });
  const response = await post(baseUrl, validBody('__mock_missing_optional_fields__'));
  assert.equal(response.status, 200);
  const output = await response.json();
  assert.equal(output.descriptionA.length > 0, true);
  assert.equal(output.draft.fields.scene.value, '');
  assert.deepEqual(output.draft.fields.mustKeep.value, ['商品主体']);
});

test('project Agent runs are persisted and listed without changing the legacy response contract', async (t) => {
  const projectsPath = path.join(root, 'data', 'projects.json');
  const originalProjects = fs.readFileSync(projectsPath, 'utf8');
  t.after(() => fs.writeFileSync(projectsPath, originalProjects, 'utf8'));
  const isolatedProjects = JSON.parse(originalProjects);
  delete isolatedProjects['demo-pearl-necklace'].agent;
  fs.writeFileSync(projectsPath, JSON.stringify(isolatedProjects, null, 2), 'utf8');
  const baseUrl = await startServer(t, { apiKey: 'test-key', mock: true });
  const createResponse = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validBody('项目运行记录'))
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.projectId, 'demo-pearl-necklace');
  assert.equal(created.run.status, 'completed');
  assert.equal(created.run.version, 1);
  assert.equal(created.run.output.model, '4.0flash');

  const listResponse = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs`);
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json();
  assert.equal(listed.latestRunId, created.run.runId);
  assert.equal(listed.latestDraftVersion, 1);
  assert.equal(listed.runs.length, 1);
  assert.equal(listed.runs[0].input.product.name, '珍珠项链');
  assert.equal('imageUrl' in listed.runs[0].input, false);
});

test('invalid project Agent input persists a terminal failure timestamp', async (t) => {
  const projectsPath = path.join(root, 'data', 'projects.json');
  const originalProjects = fs.readFileSync(projectsPath, 'utf8');
  t.after(() => fs.writeFileSync(projectsPath, originalProjects, 'utf8'));
  const isolatedProjects = JSON.parse(originalProjects);
  delete isolatedProjects['demo-pearl-necklace'].agent;
  fs.writeFileSync(projectsPath, JSON.stringify(isolatedProjects, null, 2), 'utf8');
  const baseUrl = await startServer(t, { apiKey: 'test-key', mock: true });
  const response = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'unsupported_task' })
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.run.status, 'failed');
  assert.equal(payload.run.completedAt, payload.run.createdAt);
  assert.equal(payload.run.updatedAt, payload.run.createdAt);
});

test('project Agent runs persist lifecycle states and cancellation wins over late model completion', async (t) => {
  const projectsPath = path.join(root, 'data', 'projects.json');
  const originalProjects = fs.readFileSync(projectsPath, 'utf8');
  t.after(() => fs.writeFileSync(projectsPath, originalProjects, 'utf8'));
  const isolatedProjects = JSON.parse(originalProjects);
  delete isolatedProjects['demo-pearl-necklace'].agent;
  fs.writeFileSync(projectsPath, JSON.stringify(isolatedProjects, null, 2), 'utf8');
  const baseUrl = await startServer(t, { apiKey: 'test-key', mock: true });
  const pendingResponse = fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validBody('__mock_delay__'))
  });

  await wait(40);
  const inFlightList = await (await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs`)).json();
  const inFlightRun = inFlightList.runs[0];
  assert.ok(inFlightRun);
  assert.equal(inFlightRun.status, 'running');
  assert.ok(inFlightRun.startedAt);

  const cancelResponse = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs/${encodeURIComponent(inFlightRun.runId)}/cancel`, { method: 'POST' });
  assert.equal(cancelResponse.status, 200);
  const cancelled = await cancelResponse.json();
  assert.equal(cancelled.run.status, 'cancelled');
  assert.equal(cancelled.run.errorCode, 'AGENT_CANCELLED');

  const lateResponse = await pendingResponse;
  assert.equal(lateResponse.status, 409);
  const latePayload = await lateResponse.json();
  assert.equal(latePayload.run.status, 'cancelled');
  assert.equal(latePayload.run.output, null);

  const detail = await (await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs/${encodeURIComponent(inFlightRun.runId)}`)).json();
  assert.equal(detail.run.status, 'cancelled');
  assert.equal(detail.run.output, null);

  const failedResponse = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validBody('__mock_invalid_json__'))
  });
  assert.equal(failedResponse.status, 502);
  const failedPayload = await failedResponse.json();
  assert.equal(failedPayload.run.status, 'failed');
  assert.equal(failedPayload.run.errorCode, 'MODEL_INVALID_JSON');
});

test('concurrent completed description runs receive distinct draft versions', async (t) => {
  const projectsPath = path.join(root, 'data', 'projects.json');
  const originalProjects = fs.readFileSync(projectsPath, 'utf8');
  t.after(() => fs.writeFileSync(projectsPath, originalProjects, 'utf8'));
  const isolatedProjects = JSON.parse(originalProjects);
  delete isolatedProjects['demo-pearl-necklace'].agent;
  fs.writeFileSync(projectsPath, JSON.stringify(isolatedProjects, null, 2), 'utf8');
  const baseUrl = await startServer(t, { apiKey: 'test-key', mock: true });
  const createRun = (note) => fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validBody(note))
  });
  const responses = await Promise.all([createRun('__mock_delay__'), createRun('__mock_delay__')]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 201]);
  const runs = (await Promise.all(responses.map((response) => response.json()))).map((payload) => payload.run);
  assert.deepEqual(runs.map((run) => run.version).sort((a, b) => a - b), [1, 2]);
  assert.deepEqual(runs.map((run) => run.output.version).sort((a, b) => a - b), [1, 2]);
  const listed = await (await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs`)).json();
  assert.equal(listed.latestDraftVersion, 2);
});

test('project Agent fact warnings identify conflicts and clear after a user correction', async (t) => {
  const projectsPath = path.join(root, 'data', 'projects.json');
  const originalProjects = fs.readFileSync(projectsPath, 'utf8');
  t.after(() => fs.writeFileSync(projectsPath, originalProjects, 'utf8'));
  const isolatedProjects = JSON.parse(originalProjects);
  delete isolatedProjects['demo-pearl-necklace'].agent;
  fs.writeFileSync(projectsPath, JSON.stringify(isolatedProjects, null, 2), 'utf8');
  const baseUrl = await startServer(t, { apiKey: 'test-key', mock: true });
  const createResponse = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...validBody('__mock_fact_conflict__'),
      product: { name: '珍珠项链', facts: { material: '淡水珍珠' } }
    })
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  const runId = created.run.runId;
  const conflictWarning = created.run.output.warnings.find((warning) => warning.field === 'material');
  assert.equal(conflictWarning.reason, 'contradiction');
  assert.equal(conflictWarning.detectedValue, '黄金');

  const patchResponse = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs/${encodeURIComponent(runId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft: { rawText: '淡水珍珠项链置于自然窗边，商品主体清晰呈现。' } })
  });
  assert.equal(patchResponse.status, 200);
  const corrected = await patchResponse.json();
  assert.equal(corrected.run.output.warnings.some((warning) => warning.field === 'material'), false);
  assert.equal(corrected.run.revisions[0].output.warnings.some((warning) => warning.field === 'material' && warning.reason === 'contradiction'), true);
});

test('project Agent run detail supports user edits and acceptance', async (t) => {
  const projectsPath = path.join(root, 'data', 'projects.json');
  const originalProjects = fs.readFileSync(projectsPath, 'utf8');
  t.after(() => fs.writeFileSync(projectsPath, originalProjects, 'utf8'));
  const isolatedProjects = JSON.parse(originalProjects);
  delete isolatedProjects['demo-pearl-necklace'].agent;
  fs.writeFileSync(projectsPath, JSON.stringify(isolatedProjects, null, 2), 'utf8');
  const baseUrl = await startServer(t, { apiKey: 'test-key', mock: true });
  const createResponse = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validBody('详情测试'))
  });
  const created = await createResponse.json();
  const runId = created.run.runId;

  const detailResponse = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs/${encodeURIComponent(runId)}`);
  assert.equal(detailResponse.status, 200);
  assert.equal((await detailResponse.json()).run.runId, runId);

  const patchResponse = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs/${encodeURIComponent(runId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft: { rawText: '用户确认后的 A 版', fields: { scene: '纯色静物台', mustKeep: ['项链结构'] } } })
  });
  assert.equal(patchResponse.status, 200);
  const edited = await patchResponse.json();
  assert.equal(edited.run.version, 2);
  assert.equal(edited.run.accepted, false);
  assert.equal(edited.run.output.draft.rawText, '用户确认后的 A 版');
  assert.equal(edited.run.output.draft.fields.scene.source, 'user');
  assert.equal(edited.run.output.draft.fields.mustKeep.source, 'user');
  assert.equal(edited.run.output.descriptionA, '用户确认后的 A 版');
  assert.equal(edited.run.revisions.length, 1);
  assert.equal(edited.run.revisions[0].version, 1);
  assert.equal(edited.run.revisions[0].output.descriptionA, '商品主体清晰呈现于自然窗边，使用柔和光线和简洁构图。');

  const acceptResponse = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs/${encodeURIComponent(runId)}/accept`, { method: 'POST' });
  assert.equal(acceptResponse.status, 200);
  const accepted = await acceptResponse.json();
  assert.equal(accepted.run.accepted, true);
  assert.equal(accepted.run.acceptedVersion, 2);
  assert.ok(accepted.run.acceptedAt);

  const listResponse = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs`);
  const listed = await listResponse.json();
  assert.equal(listed.latestDraftVersion, 2);
  assert.equal(listed.acceptedRunId, runId);
  assert.equal(listed.runs[0].accepted, true);
  const projectResponse = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace`);
  const project = (await projectResponse.json()).project;
  assert.equal(project.descriptionA, '用户确认后的 A 版');
  assert.equal(project.descriptionAStructured.scene, '纯色静物台');

  const restoreResponse = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs/${encodeURIComponent(runId)}/restore`, { method: 'POST' });
  assert.equal(restoreResponse.status, 201);
  const restored = await restoreResponse.json();
  assert.notEqual(restored.run.runId, runId);
  assert.equal(restored.run.restoredFromRunId, runId);
  assert.equal(restored.run.version, 3);
  assert.equal(restored.run.accepted, false);
  assert.equal(restored.run.output.draft.rawText, '用户确认后的 A 版');
  assert.equal(restored.run.output.draft.fields.scene.source, 'user');

  const afterRestore = await (await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs`)).json();
  assert.equal(afterRestore.latestRunId, restored.run.runId);
  assert.equal(afterRestore.latestDraftVersion, 3);
  assert.equal(afterRestore.acceptedRunId, runId);
  const originalRun = afterRestore.runs.find((item) => item.runId === runId);
  assert.equal(originalRun.accepted, true);
  assert.equal(originalRun.output.draft.rawText, '用户确认后的 A 版');
});

test('follow-up runs do not advance A versions and accepting an older run keeps latestRunId stable', async (t) => {
  const projectsPath = path.join(root, 'data', 'projects.json');
  const originalProjects = fs.readFileSync(projectsPath, 'utf8');
  t.after(() => fs.writeFileSync(projectsPath, originalProjects, 'utf8'));
  const isolatedProjects = JSON.parse(originalProjects);
  delete isolatedProjects['demo-pearl-necklace'].agent;
  fs.writeFileSync(projectsPath, JSON.stringify(isolatedProjects, null, 2), 'utf8');
  const baseUrl = await startServer(t, { apiKey: 'test-key', mock: true });
  const createRun = (body) => fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const firstResponse = await createRun(validBody('第一版'));
  const first = (await firstResponse.json()).run;
  assert.equal(first.version, 1);

  const followUpResponse = await createRun({ task: 'follow_up', product: { name: '珍珠项链' }, note: '补充方向' });
  const followUp = (await followUpResponse.json()).run;
  assert.equal(followUp.version, 0);
  const restoreFollowUp = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs/${encodeURIComponent(followUp.runId)}/restore`, { method: 'POST' });
  assert.equal(restoreFollowUp.status, 409);

  const secondResponse = await createRun(validBody('第二版'));
  const second = (await secondResponse.json()).run;
  assert.equal(second.version, 2);

  const acceptOld = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs/${encodeURIComponent(first.runId)}/accept`, { method: 'POST' });
  assert.equal(acceptOld.status, 200);
  const listed = await (await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs`)).json();
  assert.equal(listed.latestRunId, second.runId);
  assert.equal(listed.acceptedRunId, first.runId);
  assert.equal(listed.latestDraftVersion, 2);
});

test('new A runs with missing semantic fields are rejected only at acceptance', async (t) => {
  const projectsPath = path.join(root, 'data', 'projects.json');
  const originalProjects = fs.readFileSync(projectsPath, 'utf8');
  t.after(() => fs.writeFileSync(projectsPath, originalProjects, 'utf8'));
  const isolatedProjects = JSON.parse(originalProjects);
  delete isolatedProjects['demo-pearl-necklace'].agent;
  fs.writeFileSync(projectsPath, JSON.stringify(isolatedProjects), 'utf8');
  const baseUrl = await startServer(t, { apiKey: 'test-key', mock: true });
  const created = await fetch(baseUrl + '/api/projects/demo-pearl-necklace/agent-runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(validBody('__mock_missing_optional_fields__')) });
  assert.equal(created.status, 201);
  const run = (await created.json()).run;
  assert.equal(run.output.draft.fields.scene.value, '');
  const accepted = await fetch(baseUrl + '/api/projects/demo-pearl-necklace/agent-runs/' + encodeURIComponent(run.runId) + '/accept', { method: 'POST' });
  assert.equal(accepted.status, 409);
});

test('migrated accepted A drafts with missing semantic fields remain confirmable', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-agent-legacy-accepted-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const legacyRun = {
    runId: 'legacy-run', schemaVersion: 1, task: 'description_a', status: 'completed', version: 1,
    input: { task: 'description_a', projectId: 'legacy-project', product: {}, creativeDirection: { scene: '', note: '' }, conversation: [] },
    output: { schemaVersion: 1, runId: 'legacy-run', task: 'description_a', descriptionA: '历史 A 版', descriptionAStructured: { productFactsSummary: '商品事实' }, draft: { schemaVersion: 1, rawText: '历史 A 版', fields: { productFactsSummary: { value: '商品事实', source: 'agent', version: 1 } }, userFacts: {} }, warnings: [] },
    accepted: true, acceptedAt: '2026-10-27T00:00:00.000Z', acceptedVersion: 1, createdAt: '2026-10-27T00:00:00.000Z', completedAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z'
  };
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({ 'legacy-project': { projectId: 'legacy-project', progress: 4, agent: { schemaVersion: 1, latestRunId: 'legacy-run', acceptedRunId: 'legacy-run', latestDraftVersion: 1, runs: [legacyRun] } } }), 'utf8');
  const baseUrl = await startServer(t, { dataDir });
  const endpoint = baseUrl + '/api/projects/legacy-project/agent-runs/legacy-run/accept';
  const restore = await fetch(baseUrl + '/api/projects/legacy-project/agent-runs/legacy-run/restore', { method: 'POST' });
  assert.equal(restore.status, 201);
  const restoredRun = (await restore.json()).run;
  assert.equal(restoredRun.accepted, false);
  assert.equal(restoredRun.legacyCompatibility.allowIncompleteSemanticMinimum, true);
  const restoredAccept = await fetch(baseUrl + '/api/projects/legacy-project/agent-runs/' + encodeURIComponent(restoredRun.runId) + '/accept', { method: 'POST' });
  assert.equal(restoredAccept.status, 200);
  const afterRestore = (await (await fetch(baseUrl + '/api/projects/legacy-project/agent-runs')).json()).runs;
  const originalAfterRestore = afterRestore.find((item) => item.runId === 'legacy-run');
  assert.equal(originalAfterRestore.accepted, true);
  assert.equal(originalAfterRestore.output.draft.fields.scene, undefined);
  const first = await fetch(endpoint, { method: 'POST' });
  assert.equal(first.status, 200);
  const second = await fetch(endpoint, { method: 'POST' });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).run.accepted, true);
});

test('ordinary project saves cannot erase server-owned Agent history', async (t) => {
  const projectsPath = path.join(root, 'data', 'projects.json');
  const originalProjects = fs.readFileSync(projectsPath, 'utf8');
  t.after(() => fs.writeFileSync(projectsPath, originalProjects, 'utf8'));
  const isolatedProjects = JSON.parse(originalProjects);
  delete isolatedProjects['demo-pearl-necklace'].agent;
  fs.writeFileSync(projectsPath, JSON.stringify(isolatedProjects, null, 2), 'utf8');
  const baseUrl = await startServer(t, { apiKey: 'test-key', mock: true });
  const createdResponse = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validBody('保留历史'))
  });
  const created = await createdResponse.json();
  const saveResponse = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'demo-pearl-necklace', descriptionA: '客户端普通保存' })
  });
  assert.equal(saveResponse.status, 200);
  const runsResponse = await fetch(`${baseUrl}/api/projects/demo-pearl-necklace/agent-runs`);
  const runs = await runsResponse.json();
  assert.equal(runs.runs.length, 1);
  assert.equal(runs.runs[0].runId, created.run.runId);
  assert.equal(runs.latestDraftVersion, 1);
});
