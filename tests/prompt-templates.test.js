const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const stylesSource = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const serverPath = path.join(root, 'server.js');
const getPort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close((error) => error ? reject(error) : resolve(address.port));
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
  t.after(() => { if (child.exitCode === null) child.kill(); });
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
  headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options
});
const createProject = (base, projectId) => json(base, `/api/projects/${projectId}`, { method: 'PUT', body: JSON.stringify({ projectName: projectId }) });

test('prompt template project tool exposes escaped cards, CRUD actions, and A/B apply flows', () => {
  assert.match(indexSource, /data-open-prompt-templates/);
  assert.match(indexSource, /fetch\(`\$\{projectApiUrl\}\/templates`/);
  assert.match(indexSource, /data-template-action="save-current-a"/);
  assert.match(indexSource, /data-template-action="save-current-b"/);
  assert.match(indexSource, /method: 'PATCH'[\s\S]{0,180}enabled: !template\.enabled/);
  assert.match(indexSource, /'\/duplicate'/);
  assert.match(indexSource, /escapeHtml\(template\.name\)/);
  assert.match(indexSource, /escapeHtml\(templatePreviewText\(template\)/);
  assert.match(indexSource, /templateApplyPreviewMarkup/);
  assert.match(indexSource, /提示词 B 已修改。当前生成结果将失效/);
  assert.match(indexSource, /JSON\.stringify\(proposed\.platformOverrides\) !== JSON\.stringify\(platformOverrides\)/);
  assert.match(indexSource, /const readBExecutionFields = \(\) =>/);
  assert.match(indexSource, /platformOverrides: nextPlatformOverrides/);
  assert.match(indexSource, /JSON\.stringify\(bFields\.platformOverrides\) !== JSON\.stringify\(bPlatformOverridesBaseline\(\)\)/);
  assert.match(indexSource, /const clearPromptBTemplateProvenance = \(\) =>/);
  assert.match(indexSource, /if \(platformOverridesDirty\) clearPromptBTemplateProvenance\(\)/);
  assert.match(indexSource, /平台覆盖参数已修改。当前生成结果将失效/);
  assert.match(indexSource, /resetDownstream\(3\)/);
  assert.match(indexSource, /setStatus\('可在所选平台生成', 'is-ready'\)/);
  assert.match(indexSource, /source: 'user'/);
  assert.match(indexSource, /promptBSource = `template:\$\{template\.templateId\}@v/);
  assert.match(indexSource, /promptBTemplateId/);
  assert.match(indexSource, /promptBTemplateVersion/);
  assert.match(indexSource, /agentTemplateId/);
  assert.match(indexSource, /agentTemplateVersion/);
  assert.match(indexSource, /templateVersion: promptBTemplateVersion/);
  assert.match(indexSource, /await syncProject\(\)/);
  assert.doesNotMatch(indexSource, /serverSyncBusy/);
  assert.match(indexSource, /let serverSyncQueue = null/);
  assert.match(indexSource, /let pendingProjectSync = null/);
  assert.match(indexSource, /JSON\.stringify\(serializeProject\(\)\)/);
  assert.match(indexSource, /while \(pendingProjectSync\)/);
  assert.match(indexSource, /return serverSyncQueue/);
  assert.match(stylesSource, /\.template-grid/);
  assert.match(stylesSource, /\.template-card/);
  assert.match(stylesSource, /\.template-apply-preview/);
});

test('prompt templates CRUD validates ownership, fields, enablement, and version increments', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-prompt-templates-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await startServer(t, dataDir);
  await createProject(server.base, 'templates-one');
  await createProject(server.base, 'templates-two');
  let response = await json(server.base, '/api/projects/templates-one/templates', { method: 'POST', body: JSON.stringify({ projectId: 'templates-two', kind: 'category', name: 'Wrong', content: 'x' }) });
  assert.equal(response.status, 400);
  response = await json(server.base, '/api/projects/templates-one/templates', { method: 'POST', body: JSON.stringify({ kind: 'other', name: 'Wrong', content: 'x' }) });
  assert.equal(response.status, 400);
  response = await json(server.base, '/api/projects/templates-one/templates', { method: 'POST', body: JSON.stringify({ kind: 'category', name: 'Wrong', content: 'x', unknown: true }) });
  assert.equal(response.status, 400);
  response = await json(server.base, '/api/projects/templates-one/templates', { method: 'POST', body: JSON.stringify({ kind: 'category', name: 'Jewelry', fields: { material: 'silver' }, enabled: true, source: 'manual', sourceVersionId: 'version-source-1' }) });
  assert.equal(response.status, 201);
  const created = (await response.json()).template;
  assert.equal(created.version, 1);
  assert.equal(created.projectId, 'templates-one');
  assert.equal(created.enabled, true);
  response = await json(server.base, `/api/projects/templates-one/templates/${created.templateId}`, { method: 'PATCH', body: JSON.stringify({ enabled: false, name: 'Jewelry updated' }) });
  assert.equal(response.status, 200);
  const patched = (await response.json()).template;
  assert.equal(patched.version, 2);
  assert.equal(patched.enabled, false);
  response = await json(server.base, `/api/projects/templates-two/templates/${created.templateId}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
  assert.equal(response.status, 404);
  response = await json(server.base, `/api/projects/templates-one/templates/${created.templateId}`, { method: 'PATCH', body: JSON.stringify({ version: 99 }) });
  assert.equal(response.status, 400);
  response = await json(server.base, '/api/projects/templates-one/templates');
  assert.deepEqual((await response.json()).templates.map((item) => item.templateId), [created.templateId]);
});

test('prompt templates persist across restart and export/import with project isolation', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-prompt-templates-restart-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const first = await startServer(t, dataDir);
  await createProject(first.base, 'templates-persist');
  let response = await json(first.base, '/api/projects/templates-persist/templates', { method: 'POST', body: JSON.stringify({ kind: 'negative', name: 'Avoid', content: 'blur', source: 'manual' }) });
  const template = (await response.json()).template;
  first.child.kill();
  await new Promise((resolve) => first.child.once('exit', resolve));
  const second = await startServer(t, dataDir);
  response = await json(second.base, '/api/projects/templates-persist/templates');
  assert.deepEqual((await response.json()).templates.map((item) => item.templateId), [template.templateId]);
  response = await json(second.base, '/api/projects/templates-persist/export');
  const exported = await response.json();
  assert.equal(exported.templates.length, 1);
  const importedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-prompt-templates-import-'));
  t.after(() => fs.rmSync(importedDir, { recursive: true, force: true }));
  const third = await startServer(t, importedDir);
  await createProject(third.base, 'templates-imported');
  const importPayload = { ...exported, projectId: 'templates-imported', mode: 'replace', project: [{ ...exported.project[0], projectId: 'templates-imported' }], templates: exported.templates.map((item) => ({ ...item, projectId: 'templates-imported' })) };
  response = await json(third.base, '/api/projects/templates-imported/import', { method: 'POST', body: JSON.stringify(importPayload) });
  assert.equal(response.status, 200);
  response = await json(third.base, '/api/projects/templates-imported/templates');
  const imported = await response.json();
  assert.equal(imported.templates.length, 1);
  response = await json(third.base, '/api/projects/templates-persist/templates');
  assert.equal(response.status, 404);
});
