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
    env: {
      ...process.env,
      PORT: String(port), ZAOTU_DATA_DIR: dataDir, DEEPSEEK_API_KEY: '',
      ...(options.env || {}),
      ...(options.nodeOptions ? { NODE_OPTIONS: options.nodeOptions } : {})
    },
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

test('result assets are indexed, filterable, editable, soft-deleted, and persistent', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-result-assets-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await startServer(t, { dataDir });
  const created = await json(server.base, '/api/projects/demo/generation-jobs', { method: 'POST', body: JSON.stringify({ platforms: ['doubao'], prompt: 'asset registry test' }) });
  const job = (await created.json()).job;
  const upload = await fetch(server.base + '/api/projects/demo/assets', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('asset bytes') });
  assert.equal(upload.status, 201);
  const uploadInfo = await upload.json();
  const saved = await json(server.base, '/api/projects/demo/generation-jobs/' + job.jobId + '/results', { method: 'POST', body: JSON.stringify({ jobId: job.jobId, platform: 'doubao', attemptId: job.platforms.doubao.attemptId, assetUrl: uploadInfo.url, sourceUrl: 'https://source.example.test/generated.png', thumbnailUrl: '/uploads/demo/thumbnail.png', promptVersion: 7, dimensions: { width: 640, height: 480 }, id: 'candidate-1' }) });
  const savedBody = await saved.json();
  assert.equal(saved.status, 201, JSON.stringify(savedBody));
  assert.equal(savedBody.job.platforms.doubao.savedResults.length, 1);
  assert.equal(savedBody.job.platforms.doubao.savedResults[0].id, 'candidate-1');
  assert.equal(savedBody.job.platforms.doubao.savedResults[0].url, uploadInfo.url);
  const asset = savedBody.asset;
  assert.equal(asset.url, uploadInfo.url);
  assert.equal(asset.archivedUrl, uploadInfo.url);
  assert.equal(asset.thumbnailUrl, '/uploads/demo/thumbnail.png');
  assert.equal(asset.sourceUrl, 'https://source.example.test/generated.png');
  assert.equal(asset.promptVersion, 7);
  assert.deepEqual(asset.dimensions, { width: 640, height: 480 });
  assert.match(asset.archivedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(asset.status, 'archived');
  assert.equal(asset.jobId, job.jobId);
  assert.equal(asset.platform, 'doubao');
  assert.equal(asset.candidateId, 'candidate-1');
  const edited = await json(server.base, '/api/projects/demo/result-assets/' + asset.assetId, { method: 'PATCH', body: JSON.stringify({ tags: [' campaign ', 'hero', 'campaign'], favorite: true }) });
  assert.equal(edited.status, 200);
  assert.deepEqual((await edited.json()).asset.tags, ['campaign', 'hero']);
  const filtered = await (await fetch(server.base + '/api/projects/demo/result-assets?favorite=true&tag=hero&platform=doubao')).json();
  assert.equal(filtered.assets.length, 1);
  assert.equal(filtered.assets[0].assetId, asset.assetId);
  const versionAndTimeFiltered = await (await fetch(server.base + `/api/projects/demo/assets?status=archived&version=7&attemptId=${encodeURIComponent(asset.attemptId)}&createdFrom=${encodeURIComponent(asset.createdAt)}&createdTo=${encodeURIComponent(asset.createdAt)}`)).json();
  assert.equal(versionAndTimeFiltered.assets.length, 1);
  assert.equal(versionAndTimeFiltered.assets[0].assetId, asset.assetId);
  const aliasedFiltered = await (await fetch(server.base + `/api/projects/demo/result-assets?job=${encodeURIComponent(asset.jobId)}&attempt=${encodeURIComponent(asset.attemptId)}&from=${encodeURIComponent(asset.createdAt.slice(0, 10))}&until=${encodeURIComponent(asset.createdAt.slice(0, 10))}`)).json();
  assert.equal(aliasedFiltered.assets.length, 1);
  assert.equal(aliasedFiltered.assets[0].assetId, asset.assetId);
  const invalidRange = await fetch(server.base + '/api/projects/demo/result-assets?createdFrom=2026-10-28&createdTo=2026-10-27');
  assert.equal(invalidRange.status, 400);
  const invalidDate = await fetch(server.base + '/api/projects/demo/result-assets?createdFrom=not-a-date');
  assert.equal(invalidDate.status, 400);
  const temp = await json(server.base, '/api/projects/demo/result-assets/' + asset.assetId, { method: 'PATCH', body: JSON.stringify({ status: 'temp' }) });
  assert.equal(temp.status, 200);
  assert.equal((await temp.json()).asset.status, 'temp');
  const archived = await json(server.base, '/api/projects/demo/result-assets/' + asset.assetId, { method: 'PATCH', body: JSON.stringify({ status: 'archived' }) });
  assert.equal(archived.status, 200);
  assert.match((await archived.json()).asset.archivedAt, /^\d{4}-\d{2}-\d{2}T/);
  const invalid = await json(server.base, '/api/projects/demo/result-assets/' + asset.assetId, { method: 'PATCH', body: JSON.stringify({ status: 'invalid' }) });
  assert.equal(invalid.status, 200);
  assert.equal((await invalid.json()).asset.status, 'invalid');
  const removed = await fetch(server.base + '/api/projects/demo/result-assets/' + asset.assetId, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal((await (await fetch(server.base + '/api/projects/demo/result-assets')).json()).assets.length, 0);
  assert.equal((await (await fetch(server.base + '/api/projects/demo/result-assets?status=deleted')).json()).assets.length, 1);
  assert.equal((await (await fetch(server.base + '/api/projects/other/result-assets')).json()).assets.length, 0);
  server.child.kill();
  await new Promise((resolve, reject) => { if (server.child.exitCode !== null) return resolve(); server.child.once('exit', resolve); server.child.once('error', reject); });
  const restarted = await startServer(t, { dataDir });
  const persisted = await (await fetch(restarted.base + '/api/projects/demo/result-assets?includeDeleted=true')).json();
  assert.equal(persisted.assets.length, 1);
  assert.equal(persisted.assets[0].status, 'deleted');
  assert.equal(persisted.assets[0].favorite, true);
  assert.deepEqual(persisted.assets[0].tags, ['campaign', 'hero']);
  const savedJobs = await (await fetch(restarted.base + '/api/projects/demo/generation-jobs')).json();
  assert.equal(savedJobs.jobs[0].platforms.doubao.savedResults[0].assetId, asset.assetId);
});

test('malformed result asset route parts return 400 and health remains available', async (t) => {
  const { base } = await startServer(t);
  const malformedProject = await fetch(base + '/api/projects/%E0%A4%A/result-assets');
  assert.equal(malformedProject.status, 400);
  const malformedAsset = await fetch(base + '/api/projects/demo/result-assets/%E0%A4%A');
  assert.equal(malformedAsset.status, 400);
  assert.equal((await fetch(base + '/api/health')).status, 200);
});

test('result import rolls back both stores when generation job persistence fails', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-result-assets-rollback-'));
  const preloadPath = path.join(dataDir, 'fail-second-store.cjs');
  fs.writeFileSync(preloadPath, `const fs = require('node:fs'); const path = require('node:path'); const original = fs.renameSync; let armed = false; let failed = false; fs.renameSync = function (from, to) { const destination = path.basename(to); if (!failed && destination === 'result-assets.json') armed = true; if (armed && !failed && destination === 'generation-jobs.json') { failed = true; throw new Error('injected second-store failure'); } return original.apply(this, arguments); };`, 'utf8');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await startServer(t, { dataDir, nodeOptions: `--require=${preloadPath}` });
  const created = await json(server.base, '/api/projects/demo/generation-jobs', { method: 'POST', body: JSON.stringify({ platforms: ['doubao'], prompt: 'rollback test' }) });
  const job = (await created.json()).job;
  const upload = await fetch(server.base + '/api/projects/demo/assets', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('rollback bytes') });
  const uploadInfo = await upload.json();
  const jobsBefore = fs.readFileSync(path.join(dataDir, 'generation-jobs.json'));
  const imported = await json(server.base, `/api/projects/demo/generation-jobs/${job.jobId}/results`, { method: 'POST', body: JSON.stringify({ jobId: job.jobId, platform: 'doubao', attemptId: job.platforms.doubao.attemptId, assetUrl: uploadInfo.url, id: 'rollback-candidate' }) });
  assert.equal(imported.status, 500);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'generation-jobs.json')), jobsBefore);
  assert.equal(fs.existsSync(path.join(dataDir, 'result-assets.json')), false);
  assert.equal((await (await fetch(server.base + '/api/projects/demo/result-assets?includeDeleted=true')).json()).assets.length, 0);
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
  assert.match(source, /promptVersion: Number\(result\.promptVersion \|\| promptBVersion\)/);
  assert.match(source, /dimensions: result\.dimensions/);
  assert.match(source, /sourceUrl: result\.sourceUrl \|\| result\.url, url: new URL\(uploaded\.url/);
  assert.match(source, /assetUrl: new URL\(result\.url, window\.location\.href\)\.pathname, sourceUrl: result\.sourceUrl \|\| result\.url/);
  assert.doesNotMatch(source, /retryImageUrl = aReferenceImageUrl \|\| productState\.imageUrl/);
});


test('result asset library frontend exposes server filters and asset mutations', () => {
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(source, /data-open-asset-library/);
  assert.match(source, /data-asset-filter="search"/);
  assert.match(source, /data-asset-filter="status"/);
  assert.match(source, /data-asset-filter="platform"/);
  assert.match(source, /data-asset-filter="favorite"/);
  assert.match(source, /data-asset-filter="tag"/);
  assert.match(source, /data-asset-filter="promptVersion"/);
  assert.match(source, /data-asset-filter="jobId"/);
  assert.match(source, /data-asset-filter="attemptId"/);
  assert.match(source, /data-asset-filter="createdFrom"/);
  assert.match(source, /data-asset-filter="createdTo"/);
  assert.match(source, /assetLibraryFilters = .*jobId: ''/);
  assert.match(source, /assetLibraryFilters = .*attemptId: ''/);
  assert.match(source, /assetLibraryFilters = .*createdFrom: ''/);
  assert.match(source, /assetLibraryFilters = .*createdTo: ''/);
  assert.match(source, /assetLibraryQuery/);
  assert.match(source, /assetLibraryFilters\[key\]/);
  assert.match(source, /result-assets\$\{requested\.query/);
  assert.match(source, /method: 'PATCH'/);
  assert.match(source, /favorite: !asset\.favorite/);
  assert.match(source, /tags: String\(modalBody\.querySelector/);
  assert.match(source, /method: 'DELETE'/);
  assert.match(source, /window\.confirm\('删除后结果资产会移入回收状态/);
  assert.match(source, /thumbnailUrl \|\| asset\.archivedUrl \|\| asset\.url/);
  assert.match(source, /资产 ID/);
  assert.match(source, /候选 ID/);
  assert.match(source, /更新时间/);
  assert.match(source, /归档时间/);
  assert.match(source, /asset-card-link/);
  assert.match(source, /escapeHtml\(href\)/);
  assert.match(source, /isSafeAssetLink = \(href\) => \/\^https\?:\\\/\\\/\/i\.test\(href\) \|\| \/\^\\\/uploads/);
  assert.match(source, /!isSafeAssetLink\(href\)/);
  assert.match(source, /asset\.sourceUrl/);
  assert.match(source, /asset\.archivedUrl/);
  assert.match(source, /assetLibraryLoading/);
  assert.match(source, /结果资产读取失败/);
  assert.match(source, /没有匹配的结果资产/);
  assert.match(source, /data-asset-action="refresh"/);
  assert.match(source, /Number\(rawVersion\) < 1/);
  assert.match(source, /test\(rawVersion\)/);
  assert.match(source, /提示词版本必须是正整数/);
  assert.match(source, /assetLibraryState\('结果资产读取失败'/);
  assert.match(source, /modalSession/);
  assert.match(source, /assetLibraryRequestId/);
  assert.match(source, /isAssetLibraryView\(session\)/);
  assert.match(source, /await fetchAssetLibrary\(\{ session \}\)/);
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

test('generation POST strictly validates new B snapshots while preserving legacy normalization', async (t) => {
  const server = await startServer(t);
  const invalidRatio = await json(server.base, '/api/projects/demo/generation-jobs', {
    method: 'POST',
    body: JSON.stringify({ platforms: ['doubao'], bSnapshot: { positive_prompt: 'modern prompt', aspect_ratio: 'bad-ratio', platform_params: {} } })
  });
  assert.equal(invalidRatio.status, 400);
  assert.equal((await invalidRatio.json()).errorCode, 'INVALID_ASPECT_RATIO');

  const malformedRatio = await json(server.base, '/api/projects/demo/generation-jobs', {
    method: 'POST',
    body: JSON.stringify({ platforms: ['doubao'], aspectRatio: '4:5', bSnapshot: { positive_prompt: 'modern prompt', aspect_ratio: ['4:5'], platform_params: {} } })
  });
  assert.equal(malformedRatio.status, 400);
  assert.equal((await malformedRatio.json()).errorCode, 'INVALID_ASPECT_RATIO');

  const malformedFields = await json(server.base, '/api/projects/demo/generation-jobs', {
    method: 'POST',
    body: JSON.stringify({ platforms: ['doubao'], bSnapshot: { positive_prompt: 'modern prompt', aspect_ratio: '4:5', negative_prompt: null, source: {}, version: '2', platform_params: {} } })
  });
  assert.equal(malformedFields.status, 400);
  assert.equal((await malformedFields.json()).errorCode, 'INVALID_B_EXECUTION');

  const invalidParams = await json(server.base, '/api/projects/demo/generation-jobs', {
    method: 'POST',
    body: JSON.stringify({ platforms: ['doubao'], bSnapshot: { positive_prompt: 'modern prompt', aspect_ratio: '4:5', platform_params: { seed: { nested: true } } } })
  });
  assert.equal(invalidParams.status, 400);
  assert.equal((await invalidParams.json()).errorCode, 'INVALID_PLATFORM_PARAMS');

  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const pollutedParams = await json(server.base, '/api/projects/demo/generation-jobs', {
      method: 'POST',
      body: JSON.stringify({ platforms: ['doubao'], bSnapshot: { positive_prompt: 'modern prompt', aspect_ratio: '4:5', platform_params: { [key]: 'blocked' } } })
    });
    assert.equal(pollutedParams.status, 400);
    assert.equal((await pollutedParams.json()).errorCode, 'INVALID_PLATFORM_PARAMS');
  }

  const legacy = await json(server.base, '/api/projects/demo/generation-jobs', {
    method: 'POST',
    body: JSON.stringify({ platforms: ['doubao'], positivePrompt: 'legacy prompt', aspectRatio: 'bad-ratio', platformParams: ['ignored'] })
  });
  assert.equal(legacy.status, 201);
  const legacyJob = (await legacy.json()).job;
  assert.equal(legacyJob.aspectRatio, '4:5');
  assert.deepEqual(legacyJob.platformParams, {});
});

test('project persistence stores platform override snapshots in both naming forms', async (t) => {
  const server = await startServer(t);
  const project = {
    promptBExecution: {
      positive_prompt: 'project prompt',
      negative_prompt: '',
      aspect_ratio: '4:5',
      platform_params: { seed: 1 },
      platform_overrides: { doubao: { seed: 9 } },
      source: 'test',
      version: 2
    }
  };
  const saved = await json(server.base, '/api/projects/demo', { method: 'PUT', body: JSON.stringify(project) });
  assert.equal(saved.status, 200);
  const persisted = (await saved.json()).project;
  assert.deepEqual(persisted.platformOverrides, { doubao: { seed: 9 } });
  assert.deepEqual(persisted.promptBExecution.platform_overrides, { doubao: { seed: 9 } });
});

test('generation jobs resolve and persist per-platform parameter overrides across restart', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-generation-overrides-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await startServer(t, { dataDir });
  const response = await json(server.base, '/api/projects/demo/generation-jobs', {
    method: 'POST',
    body: JSON.stringify({
      platforms: ['doubao', 'gemini'],
      bSnapshot: {
        positive_prompt: 'override prompt',
        negative_prompt: '',
        aspect_ratio: '4:5',
        platform_params: { seed: 42, quality: 'standard' },
        platform_overrides: { doubao: { quality: 'turbo', watermark: false }, gemini: { seed: 7 } }
      }
    })
  });
  assert.equal(response.status, 201);
  const job = (await response.json()).job;
  assert.deepEqual(job.platformOverrides, { doubao: { quality: 'turbo', watermark: false }, gemini: { seed: 7 } });
  assert.deepEqual(job.platforms.doubao.platformParams, { seed: 42, quality: 'turbo', watermark: false });
  assert.deepEqual(job.platforms.gemini.platformParams, { seed: 7, quality: 'standard' });
  server.child.kill();
  await new Promise((resolve) => server.child.once('exit', resolve));
  const restarted = await startServer(t, { dataDir });
  const persisted = (await (await fetch(`${restarted.base}/api/projects/demo/generation-jobs/${job.jobId}`)).json()).job;
  assert.deepEqual(persisted.bSnapshot.platform_overrides, job.bSnapshot.platform_overrides);
  assert.deepEqual(persisted.platforms.doubao.platformParams, job.platforms.doubao.platformParams);
  assert.deepEqual(persisted.platforms.gemini.platformParams, job.platforms.gemini.platformParams);
});

test('generation POST rejects invalid platform override maps and preserves legacy defaults', async (t) => {
  const server = await startServer(t);
  const invalidOverrideCases = [
    { platform_overrides: null },
    { platform_overrides: { doubao: { seed: { nested: true } } } },
    { platform_overrides: JSON.parse('{"doubao":{"__PrOtO__":"blocked"}}') },
    { platform_overrides: JSON.parse('{"__PROTO__":{}}') },
    { platform_overrides: { DOUBAO: {}, doubao: {} } },
    { platform_params: JSON.parse('{"__PrOtO__":"blocked"}') }
  ];
  for (const fields of invalidOverrideCases) {
    const response = await json(server.base, '/api/projects/demo/generation-jobs', {
      method: 'POST', body: JSON.stringify({ platforms: ['doubao'], bSnapshot: { positive_prompt: 'bad override', aspect_ratio: '4:5', ...fields } })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).errorCode, fields.platform_params ? 'INVALID_PLATFORM_PARAMS' : 'INVALID_PLATFORM_OVERRIDES');
  }
  const legacy = await json(server.base, '/api/projects/demo/generation-jobs', {
    method: 'POST', body: JSON.stringify({ platforms: ['doubao'], prompt: 'legacy override prompt', platformParams: { seed: 3 } })
  });
  assert.equal(legacy.status, 201);
  const job = (await legacy.json()).job;
  assert.deepEqual(job.platformOverrides, {});
  assert.deepEqual(job.platforms.doubao.platformParams, { seed: 3 });
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
  assert.match(source, /platform-params-editor/);
  assert.match(source, /parsePlatformParamsEditor/);
  assert.match(source, /platform-overrides-editor/);
  assert.match(source, /validatePlatformOverrides/);
  assert.match(source, /platform_overrides/);
  assert.match(source, /platformParams: payload\.job\.platforms\?\.\[platform\]\?\.platformParams/);
  assert.match(source, /platformOverrides,?\s*promptBSource/);
  assert.match(source, /platform_overrides: platformOverrides/);
  assert.match(source, /platformParams = \{\}; platformOverrides = \{\};/);
  assert.match(source, /selectedGenerationPlatforms = new Set\([\s\S]{0,220}renderPlatformOverridesEditor\(\)/);
  assert.match(source, /detailContent.addEventListener\('input',[\s\S]{0,450}platformOverrides = validation.value/);
  assert.match(source, /validateBExecution/);
  assert.match(source, /JSON.stringify\(bFields\.platformParams\)/);
  const createProjectStart = source.indexOf('const createProject = async');
  const createProjectEnd = source.indexOf('const defaultDescription', createProjectStart);
  const createProjectBlock = source.slice(createProjectStart, createProjectEnd);
  assert.match(createProjectBlock, /promptB = '';[\s\S]{0,260}negativePrompt = '';[\s\S]{0,120}aspectRatio = '4:5';[\s\S]{0,120}platformParams = \{\};[\s\S]{0,120}platformOverrides = \{\};[\s\S]{0,120}promptBSource = 'workbench';[\s\S]{0,120}promptBVersion = 1;/);
});
