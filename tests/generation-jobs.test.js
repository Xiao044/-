const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');

const getPort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const startServer = async (t, options = {}) => {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-generation-'));
  const port = await getPort();
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ZAOTU_DATA_DIR: dataDir, DEEPSEEK_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(() => { child.kill(); });
  if (!options.dataDir) t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited: ${logs}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { base, dataDir, child };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`server did not start: ${logs}`);
};

const json = (base, url, options = {}) => fetch(`${base}${url}`, {
  headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  ...options
});

test('task center API lists 20 mixed jobs and preserves attempt results after restart', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-generation-restart-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await startServer(t, { dataDir });
  const createdJobs = [];
  for (let index = 0; index < 20; index += 1) {
    const response = await json(server.base, '/api/projects/demo/generation-jobs', {
      method: 'POST', body: JSON.stringify({ platforms: ['doubao', 'gemini'], prompt: `snapshot prompt ${index}`, productImageUrl: `/uploads/snapshot-${index}.png` })
    });
    assert.equal(response.status, 201);
    createdJobs.push((await response.json()).job);
  }
  const target = createdJobs[7];
  let attemptId = target.platforms.doubao.attemptId;
  await json(server.base, `/api/projects/demo/generation-jobs/${target.jobId}/platforms/doubao`, {
    method: 'PATCH', body: JSON.stringify({ jobId: target.jobId, platform: 'doubao', attemptId, status: 'extension_disconnected', errorCode: 'EXTENSION_DISCONNECTED', errorMessage: 'first attempt failed', message: 'bridge lost' })
  });
  const retried = await json(server.base, `/api/projects/demo/generation-jobs/${target.jobId}/platforms/doubao/retry`, {
    method: 'POST', body: JSON.stringify({ jobId: target.jobId, platform: 'doubao', attemptId })
  });
  assert.equal(retried.status, 200);
  attemptId = (await retried.json()).job.platforms.doubao.attemptId;
  const assetResponse = await fetch(`${server.base}/api/projects/demo/assets`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('saved result') });
  const asset = await assetResponse.json();
  await json(server.base, `/api/projects/demo/generation-jobs/${target.jobId}/results`, {
    method: 'POST', body: JSON.stringify({ jobId: target.jobId, platform: 'doubao', attemptId, assetUrl: asset.url, id: 'kept-result' })
  });
  await json(server.base, `/api/projects/demo/generation-jobs/${target.jobId}/platforms/gemini`, {
    method: 'PATCH', body: JSON.stringify({ jobId: target.jobId, platform: 'gemini', attemptId: target.platforms.gemini.attemptId, status: 'cancelled', errorMessage: 'cancelled in test' })
  });
  const list = await (await fetch(`${server.base}/api/projects/demo/generation-jobs`)).json();
  assert.equal(list.jobs.length, 20);
  assert.deepEqual(new Set(list.jobs.map((job) => job.status)), new Set(['queued', 'failed']));
  const listedTarget = list.jobs.find((job) => job.jobId === target.jobId);
  assert.equal(listedTarget.platforms.doubao.attempts.length, 1);
  assert.equal(listedTarget.platforms.doubao.attempts[0].errorMessage, 'first attempt failed');
  assert.equal(listedTarget.platforms.doubao.savedResults[0].id, 'kept-result');
  assert.equal(listedTarget.platforms.gemini.status, 'cancelled');

  server.child.kill();
  await new Promise((resolve, reject) => {
    if (server.child.exitCode !== null) return resolve();
    server.child.once('exit', resolve);
    server.child.once('error', reject);
  });
  const restarted = await startServer(t, { dataDir });
  const afterRestart = await (await fetch(`${restarted.base}/api/projects/demo/generation-jobs`)).json();
  assert.equal(afterRestart.jobs.length, 20);
  const persisted = afterRestart.jobs.find((job) => job.jobId === target.jobId);
  assert.equal(persisted.prompt, 'snapshot prompt 7');
  assert.equal(persisted.productImageUrl, '/uploads/snapshot-7.png');
  assert.equal(persisted.platforms.doubao.attempts[0].errorCode, 'EXTENSION_DISCONNECTED');
  assert.equal(persisted.platforms.doubao.savedResults[0].id, 'kept-result');
  assert.equal(persisted.platforms.gemini.status, 'cancelled');
});

test('task center frontend exposes filters, attempt history, and snapshot-based retry', () => {
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(source, /data-task-filter="search"/);
  assert.match(source, /data-task-filter="status"/);
  assert.match(source, /data-task-filter="platform"/);
  assert.match(source, /task-attempt-history/);
  assert.match(source, /attempt\.attemptId/);
  assert.match(source, /payload\.job\.productImageUrl/);
  assert.match(source, /prompt: payload\.job\.prompt \|\| ''/);
  assert.doesNotMatch(source, /retryImageUrl = aReferenceImageUrl \|\| productState\.imageUrl/);
});

test('generation attempts reject stale PATCH and result writes', async (t) => {
  const { base } = await startServer(t);
  const created = await json(base, '/api/projects/demo/generation-jobs', {
    method: 'POST', body: JSON.stringify({ platforms: ['doubao'], prompt: 'test prompt' })
  });
  assert.equal(created.status, 201);
  const job = (await created.json()).job;
  const firstAttempt = job.platforms.doubao.attemptId;

  const retried = await json(base, `/api/projects/demo/generation-jobs/${job.jobId}/platforms/doubao/retry`, {
    method: 'POST', body: JSON.stringify({ jobId: job.jobId, platform: 'doubao', attemptId: firstAttempt })
  });
  assert.equal(retried.status, 200);
  const currentAttempt = (await retried.json()).job.platforms.doubao.attemptId;
  assert.notEqual(currentAttempt, firstAttempt);

  const stale = await json(base, `/api/projects/demo/generation-jobs/${job.jobId}/platforms/doubao`, {
    method: 'PATCH', body: JSON.stringify({ jobId: job.jobId, platform: 'doubao', attemptId: firstAttempt, status: 'completed' })
  });
  assert.equal(stale.status, 409);

  const current = await json(base, `/api/projects/demo/generation-jobs/${job.jobId}/platforms/doubao`, {
    method: 'PATCH', body: JSON.stringify({ jobId: job.jobId, platform: 'doubao', attemptId: currentAttempt, status: 'result_ready' })
  });
  assert.equal(current.status, 200);

  const upload = await fetch(`${base}/api/projects/demo/assets`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('png') });
  assert.equal(upload.status, 201);
  const asset = await upload.json();
  const staleResult = await json(base, `/api/projects/demo/generation-jobs/${job.jobId}/results`, {
    method: 'POST', body: JSON.stringify({ jobId: job.jobId, platform: 'doubao', attemptId: firstAttempt, assetUrl: asset.url, id: 'old' })
  });
  assert.equal(staleResult.status, 409);

  const saved = await json(base, `/api/projects/demo/generation-jobs/${job.jobId}/results`, {
    method: 'POST', body: JSON.stringify({ jobId: job.jobId, platform: 'doubao', attemptId: currentAttempt, assetUrl: asset.url, id: 'current' })
  });
  assert.equal(saved.status, 201);
  const regressed = await json(base, `/api/projects/demo/generation-jobs/${job.jobId}/platforms/doubao`, {
    method: 'PATCH', body: JSON.stringify({ jobId: job.jobId, platform: 'doubao', attemptId: currentAttempt, status: 'generating' })
  });
  assert.equal(regressed.status, 409);
  const hydrated = await (await fetch(`${base}/api/projects/demo/generation-jobs/${job.jobId}`)).json();
  assert.equal(hydrated.job.platforms.doubao.savedResults.length, 1);
});

test('generation status normalization, expiration, and asset traversal are enforced', async (t) => {
  const { base, dataDir } = await startServer(t);
  const created = await json(base, '/api/projects/demo/generation-jobs', {
    method: 'POST', body: JSON.stringify({ platforms: ['doubao', 'gemini'], prompt: 'test prompt' })
  });
  const job = (await created.json()).job;
  const attempts = Object.fromEntries(Object.entries(job.platforms).map(([platform, entry]) => [platform, entry.attemptId]));
  await json(base, `/api/projects/demo/generation-jobs/${job.jobId}/platforms/doubao`, { method: 'PATCH', body: JSON.stringify({ jobId: job.jobId, platform: 'doubao', attemptId: attempts.doubao, status: 'completed' }) });
  await json(base, `/api/projects/demo/generation-jobs/${job.jobId}/platforms/gemini`, { method: 'PATCH', body: JSON.stringify({ jobId: job.jobId, platform: 'gemini', attemptId: attempts.gemini, status: 'cancelled' }) });
  const mixed = await (await fetch(`${base}/api/projects/demo/generation-jobs/${job.jobId}`)).json();
  assert.equal(mixed.job.status, 'failed');

  const missingActionIdentity = await json(base, `/api/projects/demo/generation-jobs/${job.jobId}/platforms/doubao/cancel`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(missingActionIdentity.status, 409);

  const cancelledCreated = await json(base, '/api/projects/demo/generation-jobs', {
    method: 'POST', body: JSON.stringify({ platforms: ['doubao', 'gemini'], prompt: 'cancel all' })
  });
  const cancelledJob = (await cancelledCreated.json()).job;
  for (const [platform, entry] of Object.entries(cancelledJob.platforms)) {
    const response = await json(base, `/api/projects/demo/generation-jobs/${cancelledJob.jobId}/platforms/${platform}/cancel`, {
      method: 'POST', body: JSON.stringify({ jobId: cancelledJob.jobId, platform, attemptId: entry.attemptId })
    });
    assert.equal(response.status, 200);
  }
  const cancelled = await (await fetch(`${base}/api/projects/demo/generation-jobs/${cancelledJob.jobId}`)).json();
  assert.equal(cancelled.job.status, 'cancelled');

  const terminalCreated = await json(base, '/api/projects/demo/generation-jobs', {
    method: 'POST', body: JSON.stringify({ platforms: ['doubao', 'gemini', 'lovart'], prompt: 'terminal expiry guard' })
  });
  const terminalJob = (await terminalCreated.json()).job;
  const terminalEntries = terminalJob.platforms;
  await json(base, `/api/projects/demo/generation-jobs/${terminalJob.jobId}/platforms/doubao`, {
    method: 'PATCH', body: JSON.stringify({ jobId: terminalJob.jobId, platform: 'doubao', attemptId: terminalEntries.doubao.attemptId, status: 'completed' })
  });
  await json(base, `/api/projects/demo/generation-jobs/${terminalJob.jobId}/platforms/gemini/cancel`, {
    method: 'POST', body: JSON.stringify({ jobId: terminalJob.jobId, platform: 'gemini', attemptId: terminalEntries.gemini.attemptId })
  });
  await json(base, `/api/projects/demo/generation-jobs/${terminalJob.jobId}/platforms/lovart`, {
    method: 'PATCH', body: JSON.stringify({ jobId: terminalJob.jobId, platform: 'lovart', attemptId: terminalEntries.lovart.attemptId, status: 'failed', message: 'failed before expiry' })
  });
  const expiredJobAction = await json(base, `/api/projects/demo/generation-jobs/${terminalJob.jobId}/expire`, { method: 'POST' });
  assert.equal(expiredJobAction.status, 200);
  const terminalAfterExpire = (await expiredJobAction.json()).job;
  assert.equal(terminalAfterExpire.platforms.doubao.status, 'completed');
  assert.equal(terminalAfterExpire.platforms.gemini.status, 'cancelled');
  assert.equal(terminalAfterExpire.platforms.lovart.status, 'failed');

  const mixedTerminalCreated = await json(base, '/api/projects/demo/generation-jobs', {
    method: 'POST', body: JSON.stringify({ platforms: ['doubao', 'gemini'], prompt: 'mixed terminal' })
  });
  const mixedTerminalJob = (await mixedTerminalCreated.json()).job;
  const mixedEntries = mixedTerminalJob.platforms;
  await json(base, `/api/projects/demo/generation-jobs/${mixedTerminalJob.jobId}/platforms/doubao`, {
    method: 'PATCH', body: JSON.stringify({ jobId: mixedTerminalJob.jobId, platform: 'doubao', attemptId: mixedEntries.doubao.attemptId, status: 'completed' })
  });
  await json(base, `/api/projects/demo/generation-jobs/${mixedTerminalJob.jobId}/platforms/gemini/expire`, {
    method: 'POST', body: JSON.stringify({ jobId: mixedTerminalJob.jobId, platform: 'gemini', attemptId: mixedEntries.gemini.attemptId })
  });
  const mixedTerminal = await (await fetch(`${base}/api/projects/demo/generation-jobs/${mixedTerminalJob.jobId}`)).json();
  assert.equal(mixedTerminal.job.status, 'failed');

  const storePath = path.join(dataDir, 'generation-jobs.json');
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  store[`demo:${job.jobId}`].expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(storePath, JSON.stringify(store));
  const expired = await (await fetch(`${base}/api/projects/demo/generation-jobs/${job.jobId}`)).json();
  assert.equal(expired.job.platforms.gemini.status, 'cancelled');
  assert.equal(expired.job.status, 'failed');
  const list = await (await fetch(`${base}/api/projects/demo/generation-jobs`)).json();
  assert.equal(list.jobs.find((item) => item.jobId === job.jobId)?.status, 'failed');

  const queued = await json(base, '/api/projects/demo/generation-jobs', {
    method: 'POST', body: JSON.stringify({ platforms: ['doubao'], prompt: 'expires' })
  });
  const queuedJob = (await queued.json()).job;
  const queuedStore = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  queuedStore[`demo:${queuedJob.jobId}`].expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(storePath, JSON.stringify(queuedStore));
  const expiredQueued = await (await fetch(`${base}/api/projects/demo/generation-jobs/${queuedJob.jobId}`)).json();
  assert.equal(expiredQueued.job.platforms.doubao.status, 'expired');
  assert.equal(expiredQueued.job.status, 'expired');

  assert.equal((await fetch(`${base}/assets/../.env`)).status, 404);
  assert.equal((await fetch(`${base}/assets/../data/server.js`)).status, 404);
});

test('concurrent platform PATCH mutations preserve both updates', async (t) => {
  const { base } = await startServer(t);
  const created = await json(base, '/api/projects/demo/generation-jobs', {
    method: 'POST', body: JSON.stringify({ platforms: ['doubao', 'gemini'], prompt: 'concurrent updates' })
  });
  const job = (await created.json()).job;
  const updates = Object.entries(job.platforms).map(([platform, entry]) => json(base, `/api/projects/demo/generation-jobs/${job.jobId}/platforms/${platform}`, {
    method: 'PATCH', body: JSON.stringify({ jobId: job.jobId, platform, attemptId: entry.attemptId, status: 'completed' })
  }));
  const responses = await Promise.all(updates);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const hydrated = await (await fetch(`${base}/api/projects/demo/generation-jobs/${job.jobId}`)).json();
  assert.equal(hydrated.job.platforms.doubao.status, 'completed');
  assert.equal(hydrated.job.platforms.gemini.status, 'completed');
  assert.equal(hydrated.job.status, 'completed');
});

test('frontend hydration scopes candidates to the current attempt and marks saved results recorded', () => {
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(source, /resetPlatformCandidatesForAttempt/);
  assert.match(source, /jobRecorded: true/);
  assert.match(source, /currentSavedResults = item\.savedResults\.filter/);
});

test('generation POST idempotency key returns the original job', async (t) => {
  const { base } = await startServer(t);
  const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'm1-duplicate-key' };
  const body = JSON.stringify({ platforms: ['doubao'], prompt: 'duplicate suppression', idempotencyKey: 'm1-duplicate-key' });
  const first = await fetch(`${base}/api/projects/demo/generation-jobs`, { method: 'POST', headers, body });
  const firstPayload = await first.json();
  assert.equal(first.status, 201);
  const second = await fetch(`${base}/api/projects/demo/generation-jobs`, { method: 'POST', headers, body });
  const secondPayload = await second.json();
  assert.equal(second.status, 200);
  assert.equal(secondPayload.idempotent, true);
  assert.equal(secondPayload.job.jobId, firstPayload.job.jobId);
  const listed = await (await fetch(`${base}/api/projects/demo/generation-jobs`)).json();
  assert.equal(listed.jobs.filter((job) => job.idempotencyKey === 'm1-duplicate-key').length, 1);
});

test('protocol helper normalizes required bridge event fields', () => {
  const protocol = require('../doubao-extension/protocol');
  const event = protocol.normalizeEvent({ type: 'PLATFORM_ERROR', platform: 'Gemini', state: 'extension_disconnected', message: 'bridge timeout' }, { jobId: 'job-1', attemptId: 'attempt-1' });
  assert.equal(event.platform, 'gemini');
  assert.equal(event.jobId, 'job-1');
  assert.equal(event.attemptId, 'attempt-1');
  assert.equal(event.state, 'extension_disconnected');
  assert.equal(event.errorCode, 'EXTENSION_DISCONNECTED');
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('extension_disconnected is terminal failure and preserves protocol error fields', async (t) => {
  const { base } = await startServer(t);
  const created = await json(base, '/api/projects/demo/generation-jobs', {
    method: 'POST', body: JSON.stringify({ platforms: ['doubao'], prompt: 'bridge disconnect' })
  });
  const job = (await created.json()).job;
  const entry = job.platforms.doubao;
  const patched = await json(base, `/api/projects/demo/generation-jobs/${job.jobId}/platforms/doubao`, {
    method: 'PATCH', body: JSON.stringify({ jobId: job.jobId, platform: 'doubao', attemptId: entry.attemptId, status: 'extension_disconnected', errorCode: 'EXTENSION_DISCONNECTED', errorMessage: 'bridge timeout', message: '平台页面连接已断开' })
  });
  assert.equal(patched.status, 200);
  const persisted = (await patched.json()).job.platforms.doubao;
  assert.equal(persisted.status, 'extension_disconnected');
  assert.equal(persisted.errorCode, 'EXTENSION_DISCONNECTED');
  assert.equal(persisted.errorMessage, 'bridge timeout');
  assert.equal((await (await fetch(`${base}/api/projects/demo/generation-jobs/${job.jobId}`)).json()).job.status, 'failed');
});


test('generation POST validates and persists the B execution snapshot and reference image', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-generation-b-snapshot-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await startServer(t, { dataDir });
  const response = await json(server.base, '/api/projects/demo/generation-jobs', {
    method: 'POST',
    body: JSON.stringify({ platforms: ['doubao'], positivePrompt: 'positive execution prompt', negativePrompt: 'blur, text', aspectRatio: 'bad-ratio', platformParams: { seed: 42, quality: 'high' }, source: 'manual-editor', version: 7, referenceImageUrl: 'https://cdn.example.test/reference.png' })
  });
  assert.equal(response.status, 201);
  const job = (await response.json()).job;
  assert.equal(job.prompt, 'positive execution prompt');
  assert.equal(job.referenceImageUrl, 'https://cdn.example.test/reference.png');
  assert.equal(job.productImageUrl, 'https://cdn.example.test/reference.png');
  assert.equal(job.negativePrompt, 'blur, text');
  assert.equal(job.aspectRatio, '4:5');
  assert.deepEqual(job.platformParams, { seed: 42, quality: 'high' });
  assert.deepEqual(job.bSnapshot, { positive_prompt: 'positive execution prompt', negative_prompt: 'blur, text', aspect_ratio: '4:5', platform_params: { seed: 42, quality: 'high' }, source: 'manual-editor', version: 7 });
  server.child.kill();
  await new Promise((resolve) => server.child.once('exit', resolve));
  const restarted = await startServer(t, { dataDir });
  const persisted = (await (await fetch(restarted.base + '/api/projects/demo/generation-jobs/' + job.jobId)).json()).job;
  assert.equal(persisted.referenceImageUrl, job.referenceImageUrl);
  assert.deepEqual(persisted.bSnapshot, job.bSnapshot);
});

test('generation POST rejects an empty positive or raw prompt', async (t) => {
  const server = await startServer(t);
  const response = await json(server.base, '/api/projects/demo/generation-jobs', { method: 'POST', body: JSON.stringify({ platforms: ['doubao'], prompt: '   ' }) });
  assert.equal(response.status, 400);
  const conflictingSnapshot = await json(server.base, '/api/projects/demo/generation-jobs', { method: 'POST', body: JSON.stringify({ platforms: ['doubao'], prompt: 'legacy prompt', bSnapshot: { positive_prompt: '   ' } }) });
  assert.equal(conflictingSnapshot.status, 400);
});

test('frontend guards A and B semantic minimums and orders A image reset after upload success', () => {
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(source, /validateDescriptionAConfirmation/);
  assert.match(source, /请填写正向提示词 B/);
  const uploadStart = source.indexOf('const uploadABriefImage');
  const uploadEnd = source.indexOf('const restoreProjectFromServer', uploadStart);
  const uploadBlock = source.slice(uploadStart, uploadEnd);
  assert.ok(uploadBlock.indexOf('if (!response.ok || !payload.url)') < uploadBlock.indexOf('resetDownstream(2)'));
  assert.match(source, /referenceImageUrl/);
  assert.match(source, /promptBExecution/);
});
