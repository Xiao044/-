const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateFile, migrateStore } = require('../agent/migrate-agent-data');

const legacyProject = {
  selectedScene: '春日户外',
  progress: 4,
  descriptionA: '珍珠项链置于春日场景，保持项链结构。',
  descriptionAStructured: {
    subject: '珍珠项链',
    scene: '春日户外',
    mustKeep: ['项链结构'],
    forbidden: ['文字和水印']
  },
  product: {
    name: '春日珍珠项链',
    subtitle: '温润珠光',
    description: '保持淡水珍珠色泽。'
  },
  agentNote: '画面自然、干净',
  agentReply: '已收到补充。',
  agentQuestion: '',
  updatedAt: '2026-10-24T01:50:32.644Z'
};

test('migrates legacy A draft into one accepted Agent run', () => {
  const first = migrateStore({ demo: legacyProject }, { timestamp: '2026-10-27T00:00:00.000Z' });
  assert.equal(first.changed, true);
  const project = first.store.demo;
  assert.equal(project.agent.schemaVersion, 1);
  assert.equal(project.agent.latestDraftVersion, 1);
  assert.equal(project.agent.acceptedRunId, 'agent-legacy-demo');
  assert.equal(project.agent.runs.length, 1);
  assert.equal(project.agent.runs[0].runId, 'agent-legacy-demo');
  assert.equal(project.agent.runs[0].accepted, true);
  assert.equal(project.agent.runs[0].output.model, 'legacy-import');
  assert.equal(project.agent.runs[0].output.descriptionA, legacyProject.descriptionA);
  assert.equal(project.agent.runs[0].output.draft.fields.scene.value, '春日户外');
  assert.equal(project.agent.runs[0].output.draft.fields.scene.source, 'agent');

  const second = migrateStore(first.store, { timestamp: '2026-10-27T00:00:01.000Z' });
  assert.equal(second.changed, false);
  assert.equal(second.store.demo.agent.runs.length, 1);
});

test('migrateFile creates a backup and leaves already migrated files unchanged', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-agent-migration-'));
  const projectsPath = path.join(tempDir, 'projects.json');
  const original = JSON.stringify({ demo: legacyProject }, null, 2);
  fs.writeFileSync(projectsPath, original, 'utf8');
  try {
    const result = migrateFile(projectsPath, { timestamp: '2026-10-27T00:00:00.000Z' });
    assert.equal(result.changed, true);
    assert.ok(result.backupPath);
    assert.equal(fs.readFileSync(result.backupPath, 'utf8'), original);
    const migrated = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
    assert.equal(migrated.demo.agent.runs.length, 1);

    const second = migrateFile(projectsPath, { timestamp: '2026-10-27T00:00:01.000Z' });
    assert.equal(second.changed, false);
    assert.equal(second.backupPath, '');
    assert.equal(JSON.parse(fs.readFileSync(projectsPath, 'utf8')).demo.agent.runs.length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
