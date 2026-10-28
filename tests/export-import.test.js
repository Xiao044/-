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
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-export-import-'));
  const port = await getPort();
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ZAOTU_DATA_DIR: dataDir, DEEPSEEK_API_KEY: '', ...(options.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  if (!options.dataDir) t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited: ${logs}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return { base, dataDir, child }; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`server did not start: ${logs}`);
};
const json = (base, url, options = {}) => fetch(`${base}${url}`, {
  headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options
});
const project = (projectId) => ({ projectId, projectName: projectId, product: { name: projectId }, descriptionA: `A ${projectId}`, promptB: `B ${projectId}`, customField: { keep: true } });
const importPayload = (projectId = 'demo') => ({
  schemaVersion: 1,
  mode: 'replace',
  project: [project(projectId)],
  versions: [{ versionId: 'version-import-001', projectId, snapshot: { projectId, projectName: projectId } }],
  jobs: [{ jobId: 'job-import-1', projectId, prompt: 'imported', status: 'queued', platforms: {} }],
  assets: [{ assetId: 'asset-import-1', projectId, url: `/uploads/${projectId}/missing.png`, archivedUrl: `/uploads/${projectId}/missing.png`, jobId: 'job-import-1' }],
  uploads: [{ path: `/uploads/${projectId}/missing.png`, missing: true }]
});


test('project export filters related stores and emits schema arrays', async (t) => {
  const server = await startServer(t);
  assert.equal((await json(server.base, '/api/projects/alpha', { method: 'PUT', body: JSON.stringify(project('alpha')) })).status, 200);
  assert.equal((await json(server.base, '/api/projects/beta', { method: 'PUT', body: JSON.stringify(project('beta')) })).status, 200);
  const alphaJob = await json(server.base, '/api/projects/alpha/generation-jobs', { method: 'POST', body: JSON.stringify({ platforms: ['doubao'], prompt: 'alpha' }) });
  const betaJob = await json(server.base, '/api/projects/beta/generation-jobs', { method: 'POST', body: JSON.stringify({ platforms: ['doubao'], prompt: 'beta' }) });
  assert.equal(alphaJob.status, 201);
  assert.equal(betaJob.status, 201);
  const response = await json(server.base, '/api/projects/alpha/export');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.schemaVersion, 1);
  assert.equal(Array.isArray(payload.project), true);
  assert.equal(payload.project.length, 1);
  assert.equal(payload.project[0].customField.keep, true);
  assert.ok(payload.jobs.every((job) => job.projectId === 'alpha'));
  assert.ok(payload.jobs.every((job) => !job.prompt || job.prompt === 'alpha'));
  assert.ok(Array.isArray(payload.versions));
  assert.ok(Array.isArray(payload.assets));
});

test('export normalizes legacy versions and warns about legacy jobs and assets', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-export-legacy-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const legacyProject = project('legacy');
  delete legacyProject.projectId;
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({ legacy: legacyProject }), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'project-versions.json'), JSON.stringify({ legacy: [{ versionId: 'version-legacy-001', snapshot: { projectId: 'legacy' } }] }), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'generation-jobs.json'), JSON.stringify({ 'legacy:job-legacy': { jobId: 'job-legacy', prompt: 'legacy' } }), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'result-assets.json'), JSON.stringify({ legacy: { 'asset-legacy-1': { assetId: 'asset-legacy-1', url: '/uploads/legacy/legacy.png' } } }), 'utf8');
  const server = await startServer(t, { dataDir });
  const payload = await (await json(server.base, '/api/projects/legacy/export')).json();
  assert.equal(payload.project[0].projectId, 'legacy');
  assert.ok(payload.warnings.some((warning) => warning.code === 'LEGACY_PROJECT_ID_MISSING'));
  assert.equal(payload.versions[0].projectId, 'legacy');
  assert.ok(payload.warnings.some((warning) => warning.code === 'LEGACY_JOB_PROJECT_ID_MISSING'));
  assert.ok(payload.warnings.some((warning) => warning.code === 'LEGACY_ASSET_PROJECT_ID_MISSING'));
  assert.equal(payload.assets[0].projectId, 'legacy');
  const imported = await json(server.base, '/api/projects/legacy/import', { method: 'POST', body: JSON.stringify({ ...payload, mode: 'replace' }) });
  assert.equal(imported.status, 200);
});

test('export omits conflicting legacy asset ownership and checks actual manifest files', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-export-asset-conflict-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataDir, 'uploads', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'uploads', 'demo', 'present.png'), 'present');
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({ demo: project('demo') }), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'result-assets.json'), JSON.stringify({ demo: {
    'asset-good-1': { assetId: 'asset-good-1', url: '/uploads/demo/present.png' },
    'asset-bad-1': { assetId: 'asset-bad-1', projectId: 'other', url: '/uploads/demo/present.png' },
    'asset-unsafe-1': { assetId: 'asset-unsafe-1', url: '/uploads/other/evil.png' }
  } }), 'utf8');
  const server = await startServer(t, { dataDir });
  const exported = await (await json(server.base, '/api/projects/demo/export')).json();
  assert.deepEqual(exported.assets.map((asset) => asset.assetId), ['asset-good-1']);
  assert.ok(exported.warnings.some((warning) => warning.code === 'LEGACY_ASSET_PROJECT_ID_CONFLICT'));
  assert.ok(exported.warnings.some((warning) => warning.code === 'LEGACY_ASSET_REFERENCE_UNSAFE'));
  assert.equal(exported.assets.some((asset) => asset.assetId === 'asset-unsafe-1'), false);
  const importedPayload = importPayload('demo');
  importedPayload.assets[0].url = '/uploads/demo/present.png';
  importedPayload.assets[0].archivedUrl = '/uploads/demo/present.png';
  importedPayload.uploads = [{ path: '/uploads/demo/present.png', missing: true }];
  const imported = await json(server.base, '/api/projects/demo/import', { method: 'POST', body: JSON.stringify(importedPayload) });
  assert.equal(imported.status, 200);
  const warnings = (await imported.json()).warnings;
  assert.equal(warnings.some((warning) => warning.code === 'UPLOAD_MISSING'), false);
});

test('static serving rejects upload symlink escapes', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-upload-symlink-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const outside = path.join(dataDir, 'outside.png');
  const projectUploads = path.join(dataDir, 'uploads', 'demo');
  fs.mkdirSync(projectUploads, { recursive: true });
  fs.writeFileSync(outside, 'outside');
  try { fs.symlinkSync(outside, path.join(projectUploads, 'link.png'), 'file'); } catch { return; }
  const server = await startServer(t, { dataDir });
  assert.equal((await fetch(server.base + '/uploads/demo/link.png')).status, 404);
});

test('reserved project ids are rejected by project and import routes', async (t) => {
  const server = await startServer(t);
  for (const projectId of ['__proto__', 'constructor', 'prototype']) {
    assert.equal((await json(server.base, `/api/projects/${projectId}`)).status, 400);
    const response = await json(server.base, `/api/projects/${projectId}/import`, {
      method: 'POST', body: JSON.stringify({ schemaVersion: 1, mode: 'replace', project: [{ projectId }], versions: [], jobs: [], assets: [] })
    });
    assert.equal(response.status, 400);
  }
});

test('asset upload rejects a project directory symlink escape', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-upload-dir-symlink-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const outside = path.join(dataDir, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  try { fs.symlinkSync(outside, path.join(dataDir, 'uploads', 'demo'), 'junction'); } catch { return; }
  const server = await startServer(t, { dataDir });
  const response = await fetch(`${server.base}/api/projects/demo/assets`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('image') });
  assert.equal(response.status, 400);
  assert.equal(fs.readdirSync(outside).length, 0);
});

test('concurrent project PUT and import are serialized as complete mutations', async (t) => {
  const server = await startServer(t);
  const importedPayload = importPayload('demo');
  const importRequest = json(server.base, '/api/projects/demo/import', { method: 'POST', body: JSON.stringify(importedPayload) });
  const putRequest = json(server.base, '/api/projects/demo', { method: 'PUT', body: JSON.stringify({ projectId: 'demo', marker: 'put-after-import', product: { name: 'put' }, descriptionA: 'A put', promptB: 'B put' }) });
  const [importResponse, putResponse] = await Promise.all([importRequest, putRequest]);
  assert.equal(importResponse.status, 200);
  assert.equal(putResponse.status, 200);
  const projectResponse = await json(server.base, '/api/projects/demo');
  const finalProject = (await projectResponse.json()).project;
  assert.equal(finalProject.marker, 'put-after-import');
  const versions = await (await json(server.base, '/api/projects/demo/versions')).json();
  assert.equal(versions.versions[0].projectId, 'demo');
  const jobs = await (await json(server.base, '/api/projects/demo/generation-jobs')).json();
  assert.equal(jobs.jobs[0].jobId, 'job-import-1');
});

test('agent-run mutation and import share project mutation serialization', async (t) => {
  const server = await startServer(t);
  const importRequest = json(server.base, '/api/projects/demo/import', { method: 'POST', body: JSON.stringify(importPayload('demo')) });
  const agentRequest = json(server.base, '/api/projects/demo/agent-runs', { method: 'POST', body: JSON.stringify({ task: 'unsupported_task' }) });
  const [importResponse, agentResponse] = await Promise.all([importRequest, agentRequest]);
  assert.equal(importResponse.status, 200);
  assert.equal(agentResponse.status, 400);
  const project = (await (await json(server.base, '/api/projects/demo')).json()).project;
  assert.equal(project.customField.keep, true);
  const runs = await (await json(server.base, '/api/projects/demo/agent-runs')).json();
  assert.equal(runs.runs.length, 1);
});

test('valid import persists through restart and reports missing uploads', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-export-restart-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await startServer(t, { dataDir });
  const response = await json(server.base, '/api/projects/demo/import', { method: 'POST', body: JSON.stringify(importPayload()) });
  assert.equal(response.status, 200);
  const imported = await response.json();
  assert.equal(imported.warnings[0].code, 'UPLOAD_MISSING');
  server.child.kill();
  await new Promise((resolve) => server.child.once('exit', resolve));
  const restarted = await startServer(t, { dataDir });
  assert.equal((await json(restarted.base, '/api/projects/demo')).status, 200);
  assert.equal((await json(restarted.base, '/api/projects/demo/versions')).status, 200);
  const jobs = await (await json(restarted.base, '/api/projects/demo/generation-jobs')).json();
  assert.equal(jobs.jobs[0].jobId, 'job-import-1');
  const assets = await (await json(restarted.base, '/api/projects/demo/assets')).json();
  assert.equal(assets.assets[0].assetId, 'asset-import-1');
});

test('import rejects malformed, foreign, duplicate, and unsafe references and requires replace mode', async (t) => {
  const server = await startServer(t);
  const cases = [
    [{ schemaVersion: 2 }, 400],
    [{ schemaVersion: 1, project: [project('foreign')], versions: [], jobs: [], assets: [] }, 400],
    [{ ...importPayload(), versions: [importPayload().versions[0], importPayload().versions[0]] }, 400],
    [{ ...importPayload(), assets: [{ ...importPayload().assets[0], url: '/uploads/other/evil.png' }] }, 400],
    [{ ...importPayload(), assets: [{ ...importPayload().assets[0], url: '/uploads/demo/\u0000evil.png' }] }, 400]
  ];
  for (const [body, status] of cases) { const response = await json(server.base, '/api/projects/demo/import', { method: 'POST', body: JSON.stringify(body) }); assert.equal(response.status, status, `case ${cases.indexOf(body)}: ${await response.text()}`); }
  assert.equal((await json(server.base, '/api/projects/demo', { method: 'PUT', body: JSON.stringify(project('demo')) })).status, 200);
  const collision = await json(server.base, '/api/projects/demo/import', { method: 'POST', body: JSON.stringify({ ...importPayload(), mode: undefined }) });
  assert.equal(collision.status, 409);
});

test('import enforces configured body limit with 413', async (t) => {
  const server = await startServer(t, { env: { ZAOTU_IMPORT_MAX_BYTES: '128' } });
  const response = await json(server.base, '/api/projects/demo/import', { method: 'POST', body: JSON.stringify({ schemaVersion: 1, project: [project('demo')], versions: [], jobs: [], assets: [], padding: 'x'.repeat(500) }) });
  assert.equal(response.status, 413);
});

test('failed cross-store import rolls back earlier writes', async (t) => {
  const server = await startServer(t);
  assert.equal((await json(server.base, '/api/projects/demo', { method: 'PUT', body: JSON.stringify(project('demo')) })).status, 200);
  const beforeProject = fs.readFileSync(path.join(server.dataDir, 'projects.json'), 'utf8');
  const beforeVersions = fs.existsSync(path.join(server.dataDir, 'project-versions.json')) ? fs.readFileSync(path.join(server.dataDir, 'project-versions.json'), 'utf8') : null;
  const beforeJobs = fs.existsSync(path.join(server.dataDir, 'generation-jobs.json')) ? fs.readFileSync(path.join(server.dataDir, 'generation-jobs.json'), 'utf8') : null;
  const beforeAssets = fs.existsSync(path.join(server.dataDir, 'result-assets.json')) ? fs.readFileSync(path.join(server.dataDir, 'result-assets.json'), 'utf8') : null;
  fs.mkdirSync(path.join(server.dataDir, 'result-assets.json.tmp'));
  const response = await json(server.base, '/api/projects/demo/import', { method: 'POST', body: JSON.stringify(importPayload()) });
  assert.equal(response.status, 500);
  assert.equal(fs.readFileSync(path.join(server.dataDir, 'projects.json'), 'utf8'), beforeProject);
  assert.equal(fs.existsSync(path.join(server.dataDir, 'project-versions.json')) ? fs.readFileSync(path.join(server.dataDir, 'project-versions.json'), 'utf8') : null, beforeVersions);
  assert.equal(fs.existsSync(path.join(server.dataDir, 'generation-jobs.json')) ? fs.readFileSync(path.join(server.dataDir, 'generation-jobs.json'), 'utf8') : null, beforeJobs);
  assert.equal(fs.existsSync(path.join(server.dataDir, 'result-assets.json')) ? fs.readFileSync(path.join(server.dataDir, 'result-assets.json'), 'utf8') : null, beforeAssets);
});
