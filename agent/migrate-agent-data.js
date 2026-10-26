const fs = require('node:fs');
const path = require('node:path');
const {
  createAgentRunRecord,
  legacyStructured: formatLegacyStructured,
  normalizeAgentOutput,
  nowIso,
  validateAgentInput
} = require('./agent-service');

const root = path.resolve(__dirname, '..');
const defaultProjectsPath = path.join(root, 'data', 'projects.json');

const readStore = (projectsPath) => {
  const parsed = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('projects.json must contain an object');
  return parsed;
};

const writeAtomic = (projectsPath, store) => {
  const temporaryPath = `${projectsPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(temporaryPath, projectsPath);
};

const buildLegacyAgentState = (projectId, project, timestamp = project.updatedAt || nowIso()) => {
  const existing = project.agent && typeof project.agent === 'object' && !Array.isArray(project.agent) ? project.agent : null;
  if (existing?.schemaVersion === 1 && Array.isArray(existing.runs)) return { state: existing, migrated: false };

  const legacyDescription = typeof project.descriptionA === 'string' ? project.descriptionA.trim() : '';
  const legacyStructuredValue = project.descriptionAStructured && typeof project.descriptionAStructured === 'object' && !Array.isArray(project.descriptionAStructured)
    ? project.descriptionAStructured
    : {};
  const validation = validateAgentInput({
    task: 'description_a',
    projectId,
    product: project.product || {},
    scene: project.selectedScene || '',
    note: project.agentNote || ''
  });
  const input = validation.ok ? validation.value : {
    task: 'description_a',
    projectId,
    product: {},
    creativeDirection: { scene: '', note: '' },
    conversation: []
  };
  const runId = `agent-legacy-${projectId}`;
  const output = normalizeAgentOutput({
    reply: project.agentReply || '',
    followUpQuestion: project.agentQuestion || '',
    descriptionA: legacyDescription,
    descriptionAStructured: legacyStructuredValue
  }, input, { runId, version: 1, updatedAt: timestamp });
  output.model = 'legacy-import';
  if (legacyDescription) {
    output.draft.rawText = legacyDescription;
    output.descriptionA = legacyDescription;
    output.descriptionAStructured = legacyStructuredValue && Object.keys(legacyStructuredValue).length ? {
      ...legacyStructuredValue,
      ...formatLegacyStructured(output.draft)
    } : formatLegacyStructured(output.draft);
  }
  const run = createAgentRunRecord({
    runId,
    input,
    output: legacyDescription ? output : null,
    status: legacyDescription ? 'completed' : 'waiting_user',
    version: 1,
    createdAt: timestamp,
    completedAt: legacyDescription ? timestamp : null
  });
  if (legacyDescription && Number(project.progress) >= 3) {
    run.accepted = true;
    run.acceptedAt = timestamp;
    run.acceptedVersion = 1;
  }
  return {
    migrated: true,
    state: {
      schemaVersion: 1,
      latestRunId: legacyDescription ? runId : '',
      acceptedRunId: legacyDescription && Number(project.progress) >= 3 ? runId : '',
      latestDraftVersion: legacyDescription ? 1 : 0,
      runs: legacyDescription ? [run] : []
    }
  };
};

const migrateStore = (store, { timestamp = nowIso() } = {}) => {
  const nextStore = JSON.parse(JSON.stringify(store));
  const migratedProjectIds = [];
  const skippedProjectIds = [];
  for (const [projectId, project] of Object.entries(nextStore)) {
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
      skippedProjectIds.push(projectId);
      continue;
    }
    const result = buildLegacyAgentState(projectId, project, project.updatedAt || timestamp);
    if (!result.migrated) {
      skippedProjectIds.push(projectId);
      continue;
    }
    project.agent = result.state;
    project.updatedAt = project.updatedAt || timestamp;
    migratedProjectIds.push(projectId);
  }
  return { store: nextStore, changed: migratedProjectIds.length > 0, migratedProjectIds, skippedProjectIds };
};

const migrateFile = (projectsPath = defaultProjectsPath, { timestamp = nowIso(), backup = true } = {}) => {
  const original = fs.readFileSync(projectsPath, 'utf8');
  const store = readStore(projectsPath);
  const result = migrateStore(store, { timestamp });
  let backupPath = '';
  if (result.changed) {
    if (backup) {
      backupPath = `${projectsPath}.backup-agent-${new Date(timestamp).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
      fs.writeFileSync(backupPath, original, 'utf8');
    }
    try {
      writeAtomic(projectsPath, result.store);
    } catch (error) {
      try { fs.writeFileSync(projectsPath, original, 'utf8'); } catch {}
      throw error;
    }
  }
  return { ...result, backupPath, projectsPath };
};

if (require.main === module) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('用法：node agent/migrate-agent-data.js [projects.json 路径]\n');
    process.exit(0);
  }
  const requestedPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultProjectsPath;
  try {
    const result = migrateFile(requestedPath);
    process.stdout.write(`${JSON.stringify({ ok: true, changed: result.changed, migrated: result.migratedProjectIds, skipped: result.skippedProjectIds, backupPath: result.backupPath }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildLegacyAgentState, migrateFile, migrateStore, defaultProjectsPath };
