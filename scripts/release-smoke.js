'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');

const SENSITIVE_STATIC_PATHS = [
  '/data',
  '/data/',
  '/data/projects.json',
  '/.env',
  '/deploy',
  '/deploy/README.md',
  '/backups',
  '/backups/latest.zip',
  '/tmp',
  '/tmp/release-smoke.txt'
];

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const getPort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close((error) => error ? reject(error) : resolve(address.port));
  });
});


const request = (base, pathname, options = {}) => new Promise((resolve, reject) => {
  const body = options.body === undefined ? null : String(options.body);
  const target = new URL(pathname, base);
  const headers = { ...(options.headers || {}) };
  if (body !== null) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  const req = http.request(target, {
    method: options.method || 'GET',
    headers,
    timeout: options.timeout || 3000
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({
      status: res.statusCode || 0,
      headers: res.headers,
      body: Buffer.concat(chunks).toString('utf8')
    }));
  });
  req.once('error', reject);
  req.once('timeout', () => req.destroy(new Error(`Request timed out: ${pathname}`)));
  if (body !== null) req.write(body);
  req.end();
});

const parseJson = (response, label) => {
  try {
    return JSON.parse(response.body);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}`);
  }
};

const expectStatus = (response, expected, label) => {
  if (response.status !== expected) {
    const detail = response.body.length > 300 ? `${response.body.slice(0, 300)}…` : response.body;
    throw new Error(`${label}: expected HTTP ${expected}, got ${response.status}: ${detail}`);
  }
};

const waitForServer = async (base, child, getLogs) => {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited before becoming ready: ${getLogs()}`);
    try {
      const response = await request(base, '/api/health', { timeout: 500 });
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await delay(40);
  }
  throw new Error(`server did not become ready${lastError ? `: ${lastError.message}` : ''}${getLogs() ? `; logs: ${getLogs()}` : ''}`);
};

const waitForExit = (child, timeout = 1000) => {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(child.exitCode !== null);
    }, timeout);
    child.once('exit', onExit);
  });
};

const stopServer = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill();
  if (await waitForExit(child, 1000)) return;
  if (child.exitCode === null) child.kill('SIGKILL');
  await waitForExit(child, 1000);
};

const runSmoke = async (options = {}) => {
  const dataDir = path.resolve(options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-release-smoke-')));
  const ownsDataDir = !options.dataDir;
  const port = options.port || await getPort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      ZAOTU_DATA_DIR: dataDir,
      DEEPSEEK_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  child.once('error', (error) => { logs += '\\n' + error.message; });

  try {
    await waitForServer(base, child, () => logs.trim());

    const healthResponse = await request(base, '/api/health');
    expectStatus(healthResponse, 200, 'health endpoint');
    const health = parseJson(healthResponse, 'health endpoint');
    if (health.ok !== true) throw new Error('health endpoint did not report ok=true');

    const indexResponse = await request(base, '/');
    expectStatus(indexResponse, 200, 'index page');
    if (!/<html[\s>]/i.test(indexResponse.body)) throw new Error('index page did not contain HTML markup');

    for (const pathname of SENSITIVE_STATIC_PATHS) {
      const response = await request(base, pathname);
      expectStatus(response, 404, `sensitive static path ${pathname}`);
    }

    const projectId = 'release-smoke';
    const project = {
      projectId,
      projectName: 'Release smoke project',
      product: { name: 'Release smoke product' },
      descriptionA: 'Local release smoke project',
      promptB: 'Local release smoke prompt'
    };
    const saveResponse = await request(base, `/api/projects/${projectId}`, {
      method: 'PUT',
      body: JSON.stringify(project)
    });
    expectStatus(saveResponse, 200, 'project setup');

    const exportResponse = await request(base, `/api/projects/${projectId}/export`);
    expectStatus(exportResponse, 200, 'project export');
    const exported = parseJson(exportResponse, 'project export');
    if (exported.schemaVersion !== 1 || exported.projectId !== projectId || !Array.isArray(exported.project) || exported.project.length !== 1) {
      throw new Error('project export returned an unexpected envelope');
    }

    const importedProjectName = 'Release smoke imported project';
    const importResponse = await request(base, `/api/projects/${projectId}/import`, {
      method: 'POST',
      body: JSON.stringify({
        ...exported,
        mode: 'replace',
        project: [{ ...exported.project[0], projectName: importedProjectName }]
      })
    });
    expectStatus(importResponse, 200, 'project import');
    const imported = parseJson(importResponse, 'project import');
    if (imported.projectId !== projectId || imported.project?.projectId !== projectId) {
      throw new Error('project import did not persist the imported project');
    }
    const importedProjectResponse = await request(base, `/api/projects/${projectId}`);
    expectStatus(importedProjectResponse, 200, 'imported project readback');
    const importedProject = parseJson(importedProjectResponse, 'imported project readback');
    if (importedProject.project?.projectName !== importedProjectName) {
      throw new Error('project import mutation was not persisted in the project store');
    }

    return {
      base,
      dataDir,
      checks: {
        health: true,
        index: true,
        sensitiveStaticPaths: SENSITIVE_STATIC_PATHS.length,
        exportImport: true
      }
    };
  } finally {
    await stopServer(child);
    if (ownsDataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }
};

if (require.main === module) {
  runSmoke()
    .then((result) => {
      console.log(`Release smoke passed at ${result.base}: health, index, ${result.checks.sensitiveStaticPaths} sensitive static paths, project export/import.`);
    })
    .catch((error) => {
      console.error(`Release smoke failed: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { SENSITIVE_STATIC_PATHS, runSmoke };
