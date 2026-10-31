'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SENSITIVE_STATIC_PATHS, runSmoke } = require('../scripts/release-smoke');

const root = path.resolve(__dirname, '..');
const repositoryDataFiles = [
  'projects.json',
  'generation-jobs.json',
  'project-versions.json',
  'prompt-templates.json',
  'result-assets.json'
];
const uploadsRoot = path.join(root, 'data', 'uploads');

const snapshotEntry = (entryPath) => {
  const stats = fs.lstatSync(entryPath);
  if (stats.isDirectory()) return { type: 'directory' };
  if (stats.isFile()) return { type: 'file', bytes: fs.readFileSync(entryPath) };
  if (stats.isSymbolicLink()) return { type: 'symlink', target: fs.readlinkSync(entryPath) };
  return { type: 'other', mode: stats.mode };
};

const snapshotTree = (rootPath) => {
  if (!fs.existsSync(rootPath)) return null;
  const entries = {};
  const visit = (currentPath, relativePath = '') => {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const entryRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
      const entryPath = path.join(currentPath, entry.name);
      entries[entryRelativePath] = snapshotEntry(entryPath);
      if (entry.isDirectory()) visit(entryPath, entryRelativePath);
    }
  };
  visit(rootPath);
  return entries;
};

const snapshotRepositoryData = () => ({
  stores: Object.fromEntries(repositoryDataFiles.map((name) => {
    const filePath = path.join(root, 'data', name);
    return [name, fs.existsSync(filePath) ? fs.readFileSync(filePath) : null];
  })),
  uploads: snapshotTree(uploadsRoot)
});

test('release smoke runs against isolated data and verifies the local release surface', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-release-smoke-test-'));
  const beforeRepositoryData = snapshotRepositoryData();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const result = await runSmoke({ dataDir });

  assert.match(result.base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(result.checks.health, true);
  assert.equal(result.checks.index, true);
  assert.equal(result.checks.sensitiveStaticPaths, SENSITIVE_STATIC_PATHS.length);
  assert.equal(result.checks.exportImport, true);
  assert.equal(fs.existsSync(path.join(dataDir, 'projects.json')), true);
  assert.deepEqual(
    snapshotRepositoryData(),
    beforeRepositoryData,
    'the smoke test must not modify repository data stores or the uploads tree'
  );
});
