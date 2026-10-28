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
    const { port } = probe.address();
    probe.close((error) => error ? reject(error) : resolve(port));
  });
});
const startServer = async (t, dataDir) => {
  const port = await getPort();
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ZAOTU_DATA_DIR: dataDir, DEEPSEEK_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited: ${logs}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return { base, child }; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`server did not start: ${logs}`);
};
const json = (base, url, options = {}) => fetch(`${base}${url}`, {
  headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  ...options
});
const project = (name) => ({ projectId: name, projectName: name, product: { name }, descriptionA: `A ${name}`, promptB: `B ${name}`, aspectRatio: '4:5', platformOverrides: { doubao: { seed: name } }, generationJobId: `job-${name}`, generatedResults: [{ id: `result-${name}`, url: `/uploads/${name}/result.png` }] });
const waitExit = (child) => new Promise((resolve) => {
  if (child.exitCode !== null) return resolve();
  child.once('exit', resolve);
});

test('project versions persist snapshots, restore as new, and preserve source jobs/results', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-project-versions-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await startServer(t, dataDir);
  const current = project('version-project');
  assert.equal((await json(server.base, '/api/projects/version-project', { method: 'PUT', body: JSON.stringify(current) })).status, 200);
  const jobResponse = await json(server.base, '/api/projects/version-project/generation-jobs', { method: 'POST', body: JSON.stringify({ platforms: ['doubao'], prompt: 'immutable job', aspectRatio: '4:5' }) });
  assert.equal(jobResponse.status, 201);
  const sourceJob = (await jobResponse.json()).job;
  const first = await json(server.base, '/api/projects/version-project/versions', { method: 'POST', body: JSON.stringify({ snapshot: { ...current, promptB: 'first' } }) });
  assert.equal(first.status, 201);
  const firstVersion = (await first.json()).version;
  const second = await json(server.base, '/api/projects/version-project/versions', { method: 'POST', body: JSON.stringify({ snapshot: { ...current, promptB: 'second' } }) });
  assert.equal(second.status, 201);
  const secondVersion = (await second.json()).version;
  assert.notEqual(firstVersion.versionId, secondVersion.versionId);
  assert.equal(fs.existsSync(path.join(dataDir, 'project-versions.json')), true);
  const listed = await (await json(server.base, '/api/projects/version-project/versions')).json();
  assert.deepEqual(listed.versions.map((item) => item.versionId), [secondVersion.versionId, firstVersion.versionId]);

  server.child.kill();
  await waitExit(server.child);
  const restarted = await startServer(t, dataDir);
  const afterRestart = await (await json(restarted.base, '/api/projects/version-project/versions')).json();
  assert.equal(afterRestart.versions.length, 2);
  const restored = await json(restarted.base, `/api/projects/version-project/versions/${encodeURIComponent(firstVersion.versionId)}/restore`, { method: 'POST', body: '{}' });
  assert.equal(restored.status, 201);
  const restoredPayload = await restored.json();
  assert.equal(restoredPayload.sourceVersionId, firstVersion.versionId);
  assert.notEqual(restoredPayload.version.versionId, firstVersion.versionId);
  assert.equal(restoredPayload.version.restoredFromVersionId, firstVersion.versionId);
  assert.equal(restoredPayload.project.promptB, 'first');
  const history = await (await json(restarted.base, '/api/projects/version-project/versions')).json();
  const sourceAfterRestore = history.versions.find((item) => item.versionId === firstVersion.versionId);
  assert.equal(sourceAfterRestore.snapshot.promptB, 'first');
  const jobs = await (await json(restarted.base, '/api/projects/version-project/generation-jobs')).json();
  assert.equal(jobs.jobs.length, 1);
  assert.equal(jobs.jobs[0].jobId, sourceJob.jobId);
  assert.equal(fs.readFileSync(path.join(dataDir, 'generation-jobs.json'), 'utf8').includes(sourceJob.jobId), true);
});

test('restore rolls back both stores when the version write fails', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-project-versions-rollback-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await startServer(t, dataDir);
  await json(server.base, '/api/projects/rollback', { method: 'PUT', body: JSON.stringify(project('rollback')) });
  const created = await json(server.base, '/api/projects/rollback/versions', { method: 'POST', body: JSON.stringify({ snapshot: { ...project('rollback'), promptB: 'before restore' } }) });
  const versionId = (await created.json()).version.versionId;
  const projectPath = path.join(dataDir, 'projects.json');
  const versionsPath = path.join(dataDir, 'project-versions.json');
  const beforeProject = fs.readFileSync(projectPath);
  const beforeVersions = fs.readFileSync(versionsPath);
  fs.mkdirSync(versionsPath + '.tmp');
  const restored = await json(server.base, '/api/projects/rollback/versions/' + encodeURIComponent(versionId) + '/restore', { method: 'POST' });
  assert.equal(restored.status, 500);
  assert.deepEqual(fs.readFileSync(projectPath), beforeProject);
  assert.deepEqual(fs.readFileSync(versionsPath), beforeVersions);
});

test('project versions reject malformed input and isolate project ids', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-project-versions-invalid-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await startServer(t, dataDir);
  await json(server.base, '/api/projects/one', { method: 'PUT', body: JSON.stringify(project('one')) });
  await json(server.base, '/api/projects/two', { method: 'PUT', body: JSON.stringify(project('two')) });
  assert.equal((await json(server.base, '/api/projects/one/versions', { method: 'POST', body: JSON.stringify({ snapshot: null }) })).status, 400);
  assert.equal((await json(server.base, '/api/projects/one/versions', { method: 'POST', body: JSON.stringify({ snapshot: {} }) })).status, 400);
  assert.equal((await json(server.base, '/api/projects/one/versions', { method: 'POST', body: JSON.stringify({ snapshot: { projectId: 'one', product: { name: 'Only product' } } }) })).status, 400);
  assert.equal((await json(server.base, '/api/projects/one/versions', { method: 'POST', body: JSON.stringify({ snapshot: [] }) })).status, 400);
  assert.equal((await json(server.base, '/api/projects/missing/versions')).status, 404);
  const created = await json(server.base, '/api/projects/one/versions', { method: 'POST', body: JSON.stringify({ snapshot: project('one') }) });
  const versionId = (await created.json()).version.versionId;
  assert.equal((await json(server.base, `/api/projects/two/versions/${encodeURIComponent(versionId)}/restore`, { method: 'POST' })).status, 404);
  assert.equal((await json(server.base, '/api/projects/one/versions/not-a-version/restore', { method: 'POST' })).status, 400);
});

test('malformed percent encoded version route parts return 400 without crashing', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-project-versions-encoding-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await startServer(t, dataDir);
  await json(server.base, '/api/projects/encoded', { method: 'PUT', body: JSON.stringify(project('encoded')) });
  const malformedProject = await fetch(server.base + '/api/projects/%ZZ/versions');
  assert.equal(malformedProject.status, 400);
  const malformedVersion = await fetch(server.base + '/api/projects/encoded/versions/%ZZ/restore', { method: 'POST' });
  assert.equal(malformedVersion.status, 400);
  assert.equal((await fetch(server.base + '/api/health')).status, 200);
});

test('version history frontend uses server versions and restore endpoint', () => {
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(source, /fetch\(`\$\{projectApiUrl\}\/versions`/);
  assert.match(source, /\/versions\/\$\{encodeURIComponent\(record\.versionId\)\}\/restore/);
  assert.match(source, /localStorage\.setItem\(storageKey, JSON\.stringify\(\{ ...restoredProject/);
  assert.doesNotMatch(source, /window\.localStorage\.removeItem\(storageKey\)/);
  assert.doesNotMatch(source, /window\.localStorage\.setItem\(storageKey, JSON\.stringify\(\{ \.\.\.version,/);
});
