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

const startServer = async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-generation-'));
  const port = await getPort();
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ZAOTU_DATA_DIR: dataDir, DEEPSEEK_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(() => {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited: ${logs}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { base, dataDir };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`server did not start: ${logs}`);
};

const json = (base, url, options = {}) => fetch(`${base}${url}`, {
  headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  ...options
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
