const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const {
  ERROR_CODES: AGENT_ERROR_CODES,
  applyUserDraftEdits,
  buildMessages: buildAgentMessages,
  createAgentRunRecord,
  createRunId,
  collectWarnings,
  legacyStructured,
  normalizeAgentOutput,
  normalizeAgentInputForStorage,
  nowIso,
  parseModelJson,
  validateAgentInput,
  validateAgentDraftSemantics
} = require('./agent/agent-service');

const root = __dirname;
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
const port = Number(process.env.PORT || 5173);
const deepseekApiKey = process.env.DEEPSEEK_API_KEY || '';
const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const deepseekModel = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const dataDir = path.resolve(process.env.ZAOTU_DATA_DIR || path.join(root, 'data'));
const projectStorePath = path.join(dataDir, 'projects.json');
const projectVersionsPath = path.join(dataDir, 'project-versions.json');
const generationJobsPath = path.join(dataDir, 'generation-jobs.json');
const resultAssetsPath = path.join(dataDir, 'result-assets.json');
const uploadsDir = path.join(dataDir, 'uploads');
const assetsDir = path.join(root, 'assets');
const projectIdPattern = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,80}$/;
const isValidProjectId = (value) => Boolean(value && projectIdPattern.test(value));
const ASPECT_RATIOS = new Set(['1:1', '4:5', '3:4', '9:16', '16:9']);
const MAX_PLATFORM_PARAMS = 30;
const MAX_PLATFORM_OVERRIDES = 4;
const limitJobString = (value, max) => String(value ?? '').trim().slice(0, max);
const normalizePlatformParams = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, MAX_PLATFORM_PARAMS)
    .map(([key, item]) => [limitJobString(key, 80), typeof item === 'number' || typeof item === 'boolean' ? item : limitJobString(item, 500)])
    .filter(([key]) => key && !isReservedPlatformParamKey(key)));
};
const hasOwn = (value, key) => Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
const isPlainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const RESERVED_PLATFORM_PARAM_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isReservedPlatformParamKey = (key) => RESERVED_PLATFORM_PARAM_KEYS.has(String(key ?? '').trim().toLowerCase());
const strictPlatformParams = (value, fieldName = 'platformParams') => {
  if (value === undefined) return { ok: true, value: {} };
  if (!isPlainObject(value)) return { ok: false, message: `${fieldName} must be a JSON object.` };
  const entries = Object.entries(value);
  if (entries.length > MAX_PLATFORM_PARAMS) return { ok: false, message: `${fieldName} supports at most ${MAX_PLATFORM_PARAMS} entries.` };
  const normalized = {};
  for (const [rawKey, item] of entries) {
    const key = String(rawKey);
    if (isReservedPlatformParamKey(key)) return { ok: false, message: `${fieldName} key "${key}" is not allowed.` };
    if (!key.trim() || key !== key.trim() || key.length > 80) return { ok: false, message: `${fieldName} keys must be non-empty and at most 80 characters.` };
    if (item === null || (typeof item === 'number' && !Number.isFinite(item)) || !['string', 'number', 'boolean'].includes(typeof item)) {
      return { ok: false, message: `${fieldName} value for "${key}" must be a string, finite number, or boolean.` };
    }
    if (typeof item === 'string' && item.length > 500) return { ok: false, message: `${fieldName} value for "${key}" is too long.` };
    normalized[key] = item;
  }
  return { ok: true, value: normalized };
};
const normalizePlatformOverrides = (value) => {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, MAX_PLATFORM_OVERRIDES)
    .map(([platform, params]) => [String(platform).trim().toLowerCase(), normalizePlatformParams(params)])
    .filter(([platform]) => platform && !isReservedPlatformParamKey(platform)));
};
const strictPlatformOverrides = (value) => {
  if (value === undefined) return { ok: true, value: {} };
  if (!isPlainObject(value)) return { ok: false, message: 'platformOverrides must be a JSON object.' };
  const entries = Object.entries(value);
  if (entries.length > MAX_PLATFORM_OVERRIDES) return { ok: false, message: `platformOverrides supports at most ${MAX_PLATFORM_OVERRIDES} platforms.` };
  const normalized = {};
  for (const [rawPlatform, params] of entries) {
    const platform = String(rawPlatform);
    const canonicalPlatform = platform.trim().toLowerCase();
    if (isReservedPlatformParamKey(platform)) return { ok: false, message: `platformOverrides key "${platform}" is not allowed.` };
    if (!platform.trim() || platform !== platform.trim() || platform.length > 80) return { ok: false, message: 'platformOverrides keys must be non-empty and at most 80 characters.' };
    if (hasOwn(normalized, canonicalPlatform)) return { ok: false, message: `platformOverrides contains duplicate platform key "${platform}".` };
    const result = strictPlatformParams(params, `platformOverrides.${platform}`);
    if (!result.ok) return result;
    normalized[canonicalPlatform] = result.value;
  }
  return { ok: true, value: normalized };
};
const resolvePlatformParams = (platformParams = {}, platformOverrides = {}, platform = '') => ({
  ...normalizePlatformParams(platformParams),
  ...normalizePlatformParams(platformOverrides?.[String(platform).toLowerCase()])
});
const strictBExecution = (input = {}) => {
  if (!hasOwn(input, 'bSnapshot')) return { ok: true, legacy: true, value: normalizeBExecution(input) };
  if (!isPlainObject(input.bSnapshot)) return { ok: false, code: 'INVALID_B_EXECUTION', message: 'bSnapshot must be a JSON object.' };
  const source = input.bSnapshot;
  if (!hasOwn(source, 'positive_prompt') || typeof source.positive_prompt !== 'string') {
    return { ok: false, code: 'INVALID_B_EXECUTION', message: 'bSnapshot.positive_prompt must be a string.' };
  }
  if (!hasOwn(source, 'aspect_ratio') || typeof source.aspect_ratio !== 'string' || !ASPECT_RATIOS.has(source.aspect_ratio)) {
    return { ok: false, code: 'INVALID_ASPECT_RATIO', message: 'bSnapshot.aspect_ratio must be one of 1:1, 4:5, 3:4, 9:16, or 16:9.' };
  }
  if (hasOwn(source, 'negative_prompt') && typeof source.negative_prompt !== 'string') {
    return { ok: false, code: 'INVALID_B_EXECUTION', message: 'bSnapshot.negative_prompt must be a string.' };
  }
  if (typeof source.negative_prompt === 'string' && source.negative_prompt.length > 4000) {
    return { ok: false, code: 'INVALID_B_EXECUTION', message: 'bSnapshot.negative_prompt must be at most 4000 characters.' };
  }
  if (hasOwn(source, 'source') && typeof source.source !== 'string') {
    return { ok: false, code: 'INVALID_B_EXECUTION', message: 'bSnapshot.source must be a string.' };
  }
  if (typeof source.source === 'string' && source.source.length > 80) {
    return { ok: false, code: 'INVALID_B_EXECUTION', message: 'bSnapshot.source must be at most 80 characters.' };
  }
  if (hasOwn(source, 'version') && (typeof source.version !== 'number' || !Number.isFinite(source.version))) {
    return { ok: false, code: 'INVALID_B_EXECUTION', message: 'bSnapshot.version must be a finite number.' };
  }
  const paramsSource = hasOwn(source, 'platform_params') ? source.platform_params : undefined;
  const params = strictPlatformParams(paramsSource);
  if (!params.ok) return { ok: false, code: 'INVALID_PLATFORM_PARAMS', message: params.message };
  const overridesSource = hasOwn(source, 'platform_overrides') ? source.platform_overrides : (hasOwn(source, 'platformOverrides') ? source.platformOverrides : undefined);
  const overrides = strictPlatformOverrides(overridesSource);
  if (!overrides.ok) return { ok: false, code: 'INVALID_PLATFORM_OVERRIDES', message: overrides.message };
  const version = hasOwn(source, 'version') ? Math.max(1, Math.min(999999, source.version)) : 1;
  return {
    ok: true,
    legacy: false,
    value: {
      positivePrompt: source.positive_prompt,
      negativePrompt: source.negative_prompt ?? '',
      aspectRatio: source.aspect_ratio,
      platformParams: params.value,
      platformOverrides: overrides.value,
      source: source.source ?? 'workbench',
      version
    }
  };
};
const isUsableReferenceImageUrl = (value) => {
  const candidate = String(value ?? '').trim();
  if (!candidate) return false;
  if (/^\/uploads\//i.test(candidate)) return true;
  try {
    const parsed = new URL(candidate);
    return ['http:', 'https:'].includes(parsed.protocol) && Boolean(parsed.hostname);
  } catch { return false; }
};
const normalizeReferenceImageUrl = (input = {}) => {
  const candidates = [input.referenceImageUrl, input.productImageUrl];
  return candidates.map((value) => String(value ?? '').trim()).find(isUsableReferenceImageUrl)?.slice(0, 2048) || '';
};
const normalizeBExecution = (input = {}) => {
  const source = input.bSnapshot && typeof input.bSnapshot === 'object' ? input.bSnapshot : input;
  const positivePrompt = limitJobString(source.positive_prompt ?? source.positivePrompt ?? input.prompt, 12000);
  const negativePrompt = limitJobString(source.negative_prompt ?? source.negativePrompt ?? input.negativePrompt, 4000);
  const requestedAspectRatio = source.aspect_ratio ?? source.aspectRatio ?? input.aspectRatio ?? '';
  const aspectRatio = ASPECT_RATIOS.has(String(requestedAspectRatio))
    ? String(source.aspect_ratio ?? source.aspectRatio ?? input.aspectRatio)
    : '4:5';
  const platformParams = normalizePlatformParams(source.platform_params ?? source.platformParams ?? input.platformParams);
  const platformOverrides = normalizePlatformOverrides(source.platform_overrides ?? source.platformOverrides ?? input.platformOverrides);
  const version = Math.max(1, Math.min(999999, Number(source.version ?? input.promptBVersion ?? input.version) || 1));
  const metadata = {
    source: limitJobString(source.source ?? input.promptBSource ?? input.source ?? 'workbench', 80) || 'workbench',
    version
  };
  return { positivePrompt, negativePrompt, aspectRatio, platformParams, platformOverrides, ...metadata };
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8'
};
const publicRootFiles = new Set(['/index.html', '/health.html', '/styles.css', '/scroll-workspace.css', '/scroll-workspace.js']);

const sendJson = (res, statusCode, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  });
  res.end(body);
};

const readProjectStore = () => {
  try {
    if (!fs.existsSync(projectStorePath)) return {};
    const raw = fs.readFileSync(projectStorePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.error('[projects] failed to read store:', error.message);
    return {};
  }
};

const writeProjectStore = (store) => {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporaryPath = `${projectStorePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(temporaryPath, projectStorePath);
};

const cloneJson = (value) => JSON.parse(JSON.stringify(value));
const diffVersionSnapshots = (before, after) => {
  const changes = [];
  const visit = (left, right, currentPath) => {
    if (isDeepStrictEqual(left, right)) return;
    const leftIsArray = Array.isArray(left);
    const rightIsArray = Array.isArray(right);
    if (leftIsArray || rightIsArray) {
      const change = { path: currentPath, type: left === undefined ? 'added' : right === undefined ? 'removed' : 'changed' };
      if (left !== undefined) change.before = cloneJson(left);
      if (right !== undefined) change.after = cloneJson(right);
      changes.push(change);
      return;
    }
    const leftIsObject = isPlainObject(left);
    const rightIsObject = isPlainObject(right);
    if (leftIsObject && rightIsObject) {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      keys.forEach((key) => visit(left[key], right[key], currentPath ? `${currentPath}.${key}` : key));
      return;
    }
    const change = { path: currentPath, type: left === undefined ? 'added' : right === undefined ? 'removed' : 'changed' };
    if (left !== undefined) change.before = cloneJson(left);
    if (right !== undefined) change.after = cloneJson(right);
    changes.push(change);
  };
  visit(before, after, '');
  return changes;
};
const readFileState = (filePath) => ({
  exists: fs.existsSync(filePath),
  bytes: fs.existsSync(filePath) ? fs.readFileSync(filePath) : null
});
const restoreFileState = (filePath, state) => {
  const temporaryPath = `${filePath}.rollback-${process.pid}-${Date.now().toString(36)}`;
  try {
    if (state.exists) {
      fs.writeFileSync(temporaryPath, state.bytes);
      fs.renameSync(temporaryPath, filePath);
    } else {
      if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) fs.unlinkSync(filePath);
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  } catch (error) {
    try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
};
const readProjectVersions = () => {
  try {
    if (!fs.existsSync(projectVersionsPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(projectVersionsPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([projectId, versions]) => [
      projectId,
      Array.isArray(versions) ? versions.filter((version) => version && typeof version === 'object' && !Array.isArray(version)) : []
    ]));
  } catch (error) {
    console.error('[project-versions] failed to read store:', error.message);
    return {};
  }
};

const writeProjectVersions = (store) => {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporaryPath = `${projectVersionsPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(temporaryPath, projectVersionsPath);
};

const createProjectVersionId = () => `version-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
const hasMeaningfulText = (value) => typeof value === 'string' && value.trim().length > 0;
const hasMeaningfulObject = (value) => isPlainObject(value) && Object.keys(value).length > 0;
const normalizeVersionSnapshot = (snapshot, projectId, jobs = {}) => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const normalized = cloneJson(snapshot);
  const product = normalized.product;
  const hasProduct = isPlainObject(product) && Object.values(product).some((value) => hasMeaningfulText(value));
  const bExecution = isPlainObject(normalized.promptBExecution) ? normalized.promptBExecution : {};
  const hasA = hasMeaningfulText(normalized.descriptionA)
    || hasMeaningfulObject(normalized.descriptionAStructured)
    || hasMeaningfulObject(normalized.descriptionADraft)
    || hasMeaningfulText(normalized.a);
  const hasB = hasMeaningfulText(normalized.promptB)
    || hasMeaningfulText(bExecution.positive_prompt)
    || hasMeaningfulText(bExecution.positivePrompt)
    || hasMeaningfulText(normalized.b);
  const hasProjectIdentity = hasMeaningfulText(normalized.projectId)
    || hasMeaningfulText(normalized.projectName)
    || hasMeaningfulText(normalized.id)
    || hasProduct;
  if (!hasProjectIdentity || !hasProduct || !hasA || !hasB) return null;
  normalized.projectId = projectId;
  normalized.product = isPlainObject(normalized.product) ? normalized.product : {};
  normalized.platformParams = isPlainObject(normalized.platformParams) ? normalized.platformParams : {};
  normalized.platformOverrides = isPlainObject(normalized.platformOverrides) ? normalized.platformOverrides : {};
  const taskRefs = Array.isArray(normalized.taskRefs)
    ? normalized.taskRefs
    : Object.values(jobs)
      .filter((job) => job && job.projectId === projectId)
      .map((job) => ({ jobId: job.jobId, createdAt: job.createdAt, status: job.status }));
  const resultRefs = Array.isArray(normalized.resultRefs)
    ? normalized.resultRefs
    : (Array.isArray(normalized.generatedResults) ? normalized.generatedResults : []);
  normalized.taskRefs = cloneJson(taskRefs);
  normalized.resultRefs = cloneJson(resultRefs);
  return normalized;
};
const isValidVersionId = (value) => typeof value === 'string' && /^version-[A-Za-z0-9-]{8,120}$/.test(value);
const decodeRoutePart = (value) => { try { return decodeURIComponent(value); } catch { return null; } };

const readGenerationJobs = () => {
  try {
    if (!fs.existsSync(generationJobsPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(generationJobsPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const normalized = normalizeGenerationJobs(parsed);
    if (JSON.stringify(normalized) !== JSON.stringify(parsed)) {
      try { writeGenerationJobs(normalized); } catch (error) { console.error('[generation-jobs] failed to persist normalized store:', error.message); }
    }
    return normalized;
  } catch (error) {
    console.error('[generation-jobs] failed to read store:', error.message);
    return {};
  }
};

const writeGenerationJobs = (jobs) => {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporaryPath = `${generationJobsPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(normalizeGenerationJobs(jobs), null, 2), 'utf8');
  fs.renameSync(temporaryPath, generationJobsPath);
};

const RESULT_ASSET_STATUSES = new Set(['temp', 'archived', 'invalid', 'deleted']);
const normalizeAssetDimensions = (value) => {
  if (!isPlainObject(value)) return null;
  const { width, height } = value;
  return Number.isInteger(width) && width > 0 && width <= 100000
    && Number.isInteger(height) && height > 0 && height <= 100000
    ? { width, height } : null;
};
const normalizeResultAsset = (asset, projectId, assetId) => {
  if (!isPlainObject(asset)) return null;
  const archivedUrl = typeof (asset.archivedUrl || asset.url) === 'string'
    && (asset.archivedUrl || asset.url).startsWith(`/uploads/${encodeURIComponent(projectId)}/`)
    && !(asset.archivedUrl || asset.url).includes('..')
    ? (asset.archivedUrl || asset.url).slice(0, 2048) : '';
  if (!archivedUrl) return null;
  const tags = Array.isArray(asset.tags)
    ? [...new Set(asset.tags.map((tag) => String(tag).trim().slice(0, 40)).filter(Boolean))].slice(0, 30)
    : [];
  const status = RESULT_ASSET_STATUSES.has(asset.status) ? asset.status : 'archived';
  const createdAt = String(asset.createdAt || new Date().toISOString()).slice(0, 40);
  const thumbnailUrl = typeof asset.thumbnailUrl === 'string' && (/^https:\/\//.test(asset.thumbnailUrl) || asset.thumbnailUrl.startsWith(`/uploads/${encodeURIComponent(projectId)}/`)) && !asset.thumbnailUrl.includes('..')
    ? asset.thumbnailUrl.slice(0, 2048) : archivedUrl;
  return {
    assetId: String(asset.assetId || assetId || '').slice(0, 120),
    projectId,
    url: archivedUrl,
    archivedUrl,
    thumbnailUrl,
    sourceUrl: typeof asset.sourceUrl === 'string' ? asset.sourceUrl.slice(0, 2048) : archivedUrl,
    jobId: String(asset.jobId || '').slice(0, 120),
    platform: String(asset.platform || '').slice(0, 40),
    candidateId: String(asset.candidateId || '').slice(0, 120),
    attemptId: String(asset.attemptId || '').slice(0, 160),
    promptVersion: Number.isInteger(asset.promptVersion) && asset.promptVersion > 0 ? asset.promptVersion : 1,
    dimensions: normalizeAssetDimensions(asset.dimensions),
    createdAt,
    updatedAt: String(asset.updatedAt || createdAt).slice(0, 40),
    archivedAt: typeof asset.archivedAt === 'string' ? asset.archivedAt.slice(0, 40) : (status === 'archived' ? createdAt : null),
    tags,
    favorite: Boolean(asset.favorite),
    status,
    ...(asset.deletedAt ? { deletedAt: String(asset.deletedAt).slice(0, 40) } : {})
  };
};

const readResultAssets = () => {
  try {
    if (!fs.existsSync(resultAssetsPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(resultAssetsPath, 'utf8'));
    if (!isPlainObject(parsed)) return {};
    const normalized = {};
    for (const [projectId, assets] of Object.entries(parsed)) {
      if (!isValidProjectId(projectId) || !isPlainObject(assets)) continue;
      normalized[projectId] = Object.fromEntries(Object.entries(assets)
        .map(([assetId, asset]) => [assetId, normalizeResultAsset(asset, projectId, assetId)])
        .filter(([, asset]) => asset));
    }
    return normalized;
  } catch (error) {
    console.error('[result-assets] failed to read store:', error.message);
    return {};
  }
};

const writeResultAssets = (assets) => {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporaryPath = `${resultAssetsPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(assets, null, 2), 'utf8');
  fs.renameSync(temporaryPath, resultAssetsPath);
};

const createResultAssetId = () => `asset-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;

const projectIdFromRequest = (req) => {
  const match = req.url.match(/^\/api\/projects\/([^/?]+)(?:\?.*)?$/);
  return match ? decodeURIComponent(match[1]) : '';
};

const handleProject = async (req, res) => {
  const projectId = projectIdFromRequest(req);
  if (!isValidProjectId(projectId)) {
    sendJson(res, 400, { error: 'Invalid project id.' });
    return;
  }
  const store = readProjectStore();
  if (req.method === 'GET') {
    if (!store[projectId]) { sendJson(res, 404, { error: 'Project not found.' }); return; }
    sendJson(res, 200, { project: store[projectId] });
    return;
  }
  if (req.method === 'PUT') {
    let project;
    try { project = JSON.parse(await readBody(req)); } catch { sendJson(res, 400, { error: 'Invalid JSON request.' }); return; }
    if (!project || typeof project !== 'object' || Array.isArray(project)) { sendJson(res, 400, { error: 'Project must be an object.' }); return; }
    const updatedAt = new Date().toISOString();
    const existingProject = store[projectId] && typeof store[projectId] === 'object' ? store[projectId] : {};
    const projectB = project.promptBExecution && typeof project.promptBExecution === 'object'
      ? normalizeBExecution({ ...project, ...project.promptBExecution })
      : null;
    if (projectB) {
      project.promptBExecution = { positive_prompt: projectB.positivePrompt, negative_prompt: projectB.negativePrompt, aspect_ratio: projectB.aspectRatio, platform_params: projectB.platformParams, platform_overrides: projectB.platformOverrides, source: projectB.source, version: projectB.version };
      project.promptB = projectB.positivePrompt;
      project.negativePrompt = projectB.negativePrompt;
      project.aspectRatio = projectB.aspectRatio;
      project.platformParams = projectB.platformParams;
      project.platformOverrides = projectB.platformOverrides;
      project.promptBSource = projectB.source;
      project.promptBVersion = projectB.version;
    }
    store[projectId] = {
      ...existingProject,
      ...project,
      ...(existingProject.agent ? { agent: existingProject.agent } : {}),
      projectId,
      updatedAt
    };
    try { writeProjectStore(store); } catch (error) { console.error('[projects] failed to write store:', error.message); sendJson(res, 500, { error: 'Project could not be saved.' }); return; }
    sendJson(res, 200, { project: store[projectId] });
    return;
  }
  sendJson(res, 405, { error: 'Method not allowed.' });
};

const projectVersionCollectionMatch = (req) => req.url.match(/^\/api\/projects\/([^/?]+)\/versions(?:\?.*)?$/);
const projectVersionDiffMatch = (req) => req.url.match(/^\/api\/projects\/([^/?]+)\/versions\/([^/?]+)\/diff(?:\?.*)?$/);
const projectVersionRestoreMatch = (req) => req.url.match(/^\/api\/projects\/([^/?]+)\/versions\/([^/?]+)\/restore(?:\?.*)?$/);
let projectVersionsMutationTail = Promise.resolve();

const handleProjectVersionsUnsafe = async (req, res) => {
  const collectionMatch = projectVersionCollectionMatch(req);
  const diffMatch = projectVersionDiffMatch(req);
  const restoreMatch = projectVersionRestoreMatch(req);
  const encodedProjectId = collectionMatch?.[1] || diffMatch?.[1] || restoreMatch?.[1] || '';
  const projectId = decodeRoutePart(encodedProjectId);
  if (!projectId || !isValidProjectId(projectId)) {
    sendJson(res, 400, { error: 'Invalid project id.' });
    return;
  }
  const projects = readProjectStore();
  if (!projects[projectId]) {
    sendJson(res, 404, { error: 'Project not found.' });
    return;
  }

  const versionsStore = readProjectVersions();
  const projectVersions = Array.isArray(versionsStore[projectId]) ? versionsStore[projectId] : [];
  if (collectionMatch && req.method === 'GET') {
    sendJson(res, 200, { projectId, versions: projectVersions.map((version) => cloneJson(version)) });
    return;
  }

  if (diffMatch && req.method === 'GET') {
    const versionId = decodeRoutePart(diffMatch[2]);
    if (!versionId || !isValidVersionId(versionId)) {
      sendJson(res, 400, { error: 'Invalid version id.' });
      return;
    }
    const against = new URL(req.url, 'http://localhost').searchParams.get('against');
    if (!against) {
      sendJson(res, 400, { error: 'The against version id is required.' });
      return;
    }
    const againstVersionId = decodeRoutePart(against);
    if (!againstVersionId || !isValidVersionId(againstVersionId)) {
      sendJson(res, 400, { error: 'Invalid against version id.' });
      return;
    }
    const version = projectVersions.find((item) => item.versionId === versionId);
    const againstVersion = projectVersions.find((item) => item.versionId === againstVersionId);
    if (!version || !againstVersion || !version.snapshot || !againstVersion.snapshot || Array.isArray(version.snapshot) || Array.isArray(againstVersion.snapshot)) {
      sendJson(res, 404, { error: 'Version not found.' });
      return;
    }
    const changes = diffVersionSnapshots(againstVersion.snapshot, version.snapshot);
    sendJson(res, 200, {
      projectId,
      versionId,
      againstVersionId,
      equal: changes.length === 0,
      changes
    });
    return;
  }

  if (collectionMatch && req.method === 'POST') {
    const body = await readJsonBody(req, res);
    if (!body) return;
    let snapshot;
    if (hasOwn(body, 'snapshot')) snapshot = body.snapshot;
    else if (hasOwn(body, 'project')) snapshot = body.project;
    else snapshot = body;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      sendJson(res, 400, { error: 'Version snapshot must be an object.' });
      return;
    }
    const normalizedSnapshot = normalizeVersionSnapshot(snapshot, projectId, readGenerationJobs());
    if (!normalizedSnapshot) {
      sendJson(res, 400, { error: 'Version snapshot is malformed.' });
      return;
    }
    const version = {
      versionId: createProjectVersionId(),
      projectId,
      createdAt: new Date().toISOString(),
      restoredFromVersionId: null,
      snapshot: normalizedSnapshot
    };
    versionsStore[projectId] = [version, ...projectVersions];
    try {
      writeProjectVersions(versionsStore);
    } catch (error) {
      console.error('[project-versions] failed to write store:', error.message);
      sendJson(res, 500, { error: 'Project version could not be saved.' });
      return;
    }
    sendJson(res, 201, { projectId, version: cloneJson(version), versions: versionsStore[projectId].map((item) => cloneJson(item)) });
    return;
  }

  if (restoreMatch && req.method === 'POST') {
    const versionId = decodeRoutePart(restoreMatch[2]);
    if (!versionId || !isValidVersionId(versionId)) {
      sendJson(res, 400, { error: 'Invalid version id.' });
      return;
    }
    const sourceVersion = projectVersions.find((version) => version.versionId === versionId);
    if (!sourceVersion || !sourceVersion.snapshot || typeof sourceVersion.snapshot !== 'object' || Array.isArray(sourceVersion.snapshot)) {
      sendJson(res, 404, { error: 'Version not found.' });
      return;
    }
    const restoredProject = cloneJson(sourceVersion.snapshot);
    restoredProject.projectId = projectId;
    restoredProject.updatedAt = new Date().toISOString();
    const existingProject = projects[projectId] && typeof projects[projectId] === 'object' ? projects[projectId] : {};
    if (!hasOwn(restoredProject, 'agent') && existingProject.agent) restoredProject.agent = cloneJson(existingProject.agent);
    const restoredVersion = {
      versionId: createProjectVersionId(),
      projectId,
      createdAt: new Date().toISOString(),
      restoredFromVersionId: versionId,
      snapshot: cloneJson(restoredProject)
    };
    projects[projectId] = restoredProject;
    versionsStore[projectId] = [restoredVersion, ...projectVersions];
    const originalProjectFile = readFileState(projectStorePath);
    const originalVersionsFile = readFileState(projectVersionsPath);
    try {
      writeProjectStore(projects);
      writeProjectVersions(versionsStore);
    } catch (error) {
      try {
        restoreFileState(projectStorePath, originalProjectFile);
        restoreFileState(projectVersionsPath, originalVersionsFile);
      } catch (rollbackError) {
        console.error('[project-versions] rollback failed:', rollbackError.message);
      }
      console.error('[project-versions] failed to restore version:', error.message);
      sendJson(res, 500, { error: 'Project version could not be restored.' });
      return;
    }
    sendJson(res, 201, { projectId, sourceVersionId: versionId, version: cloneJson(restoredVersion), project: cloneJson(restoredProject) });
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed.' });
};

const handleProjectVersions = (req, res) => {
  if (req.method === 'GET') return handleProjectVersionsUnsafe(req, res);
  const run = projectVersionsMutationTail.then(() => handleProjectVersionsUnsafe(req, res));
  projectVersionsMutationTail = run.catch(() => {});
  return run;
};

const readBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 512 * 1024) {
      reject(new Error('request body too large'));
      req.destroy();
    }
  });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const readJsonBody = async (req, res) => {
  try {
    const value = JSON.parse(await readBody(req));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON request.');
    return value;
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON request.' });
    return null;
  }
};

const PLATFORM_TERMINAL_SUCCESS = new Set(['completed']);
const PLATFORM_TERMINAL_FAILURE = new Set(['login_required', 'not_open', 'extension_disconnected', 'upload_error', 'submit_error', 'result_timeout', 'adapter_error', 'import_error', 'expired', 'failed']);
const PLATFORM_TERMINAL_CANCELLED = new Set(['cancelled']);
const PLATFORM_ACTIVE = new Set(['checking_login', 'page_opened', 'filling', 'submitted', 'generating', 'result_ready', 'running']);
const PLATFORM_STATUSES = new Set(['queued', ...PLATFORM_ACTIVE, ...PLATFORM_TERMINAL_SUCCESS, ...PLATFORM_TERMINAL_FAILURE, ...PLATFORM_TERMINAL_CANCELLED]);
const deriveGenerationJobStatus = (platforms) => {
  const entries = platforms && typeof platforms === 'object' && !Array.isArray(platforms)
    ? Object.values(platforms).filter((item) => item && typeof item === 'object')
    : [];
  const statuses = entries.map((item) => item.status);
  if (!statuses.length || statuses.every((status) => status === 'queued')) return 'queued';
  if (statuses.every((status) => PLATFORM_TERMINAL_SUCCESS.has(status))) return 'completed';
  if (statuses.every((status) => PLATFORM_TERMINAL_CANCELLED.has(status))) return 'cancelled';
  if (statuses.every((status) => status === 'expired')) return 'expired';
  if (statuses.some((status) => PLATFORM_ACTIVE.has(status)) || statuses.some((status) => status === 'queued')) return 'running';
  if (statuses.every((status) => PLATFORM_TERMINAL_SUCCESS.has(status) || PLATFORM_TERMINAL_FAILURE.has(status) || PLATFORM_TERMINAL_CANCELLED.has(status))) {
    return 'failed';
  }
  return 'running';
};

const isPlatformTerminal = (status) => PLATFORM_TERMINAL_SUCCESS.has(status)
  || PLATFORM_TERMINAL_FAILURE.has(status)
  || PLATFORM_TERMINAL_CANCELLED.has(status);

const expireGenerationJob = (job, timestamp = Date.now()) => {
  if (!job || !job.expiresAt || !Number.isFinite(Date.parse(job.expiresAt)) || Date.parse(job.expiresAt) > timestamp) return false;
  let changed = false;
  Object.values(job.platforms || {}).forEach((entry) => {
    if (!entry || isPlatformTerminal(entry.status)) return;
    entry.status = 'expired';
    entry.message = '该任务已过期';
    entry.errorCode = 'expired';
    entry.errorMessage = '该任务已过期';
    entry.updatedAt = new Date(timestamp).toISOString();
    changed = true;
  });
  if (changed) job.updatedAt = new Date(timestamp).toISOString();
  job.status = deriveGenerationJobStatus(job.platforms);
  return changed;
};

const normalizeResultReference = (result) => {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const url = typeof result.url === 'string' && (/^https:\/\//.test(result.url) || /^\/uploads\//.test(result.url))
    ? result.url.slice(0, 2048)
    : '';
  const id = String(result.id || result.candidateId || '').slice(0, 120);
  if (!id && !url) return null;
  return {
    id: id || `result-${Date.now().toString(36)}`,
    ...(result.assetId ? { assetId: String(result.assetId).slice(0, 120) } : {}),
    candidateId: String(result.candidateId || id).slice(0, 120),
    url,
    sourceUrl: typeof result.sourceUrl === 'string' ? result.sourceUrl.slice(0, 2048) : url,
    createdAt: String(result.createdAt || result.savedAt || new Date().toISOString()).slice(0, 40),
    ...(result.attemptId ? { attemptId: String(result.attemptId).slice(0, 160) } : {})
  };
};

const normalizePlatformEntry = (entry, jobId, platform, fallbackPlatformParams = {}) => {
  const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  const attemptCount = Math.max(1, Number(source.attemptCount) || 1);
  const status = PLATFORM_STATUSES.has(source.status) ? source.status : 'queued';
  const results = Array.isArray(source.results) ? source.results.map(normalizeResultReference).filter(Boolean).slice(0, 12) : [];
  const savedResults = Array.isArray(source.savedResults) ? source.savedResults.map(normalizeResultReference).filter(Boolean).slice(0, 12) : [];
  const attemptId = String(source.attemptId || `${jobId}:${platform}:${attemptCount}`).slice(0, 160);
  const attempts = Array.isArray(source.attempts) ? source.attempts.slice(-12) : [];
  const platformParams = normalizePlatformParams(source.platformParams ?? source.platform_params ?? fallbackPlatformParams);
  return {
    ...source,
    status,
    message: String(source.message || '').slice(0, 1000),
    errorCode: String(source.errorCode || (status === 'extension_disconnected' ? 'EXTENSION_DISCONNECTED' : '')).slice(0, 120),
    errorMessage: String(source.errorMessage || source.message || '').slice(0, 1000),
    attemptId,
    attemptCount,
    attempts,
    platformParams,
    startedAt: source.startedAt || null,
    lastAttemptAt: source.lastAttemptAt || source.updatedAt || null,
    updatedAt: source.updatedAt || source.lastAttemptAt || null,
    results,
    resultRefs: Array.isArray(source.resultRefs) ? source.resultRefs.map(normalizeResultReference).filter(Boolean).slice(0, 12) : results,
    savedResults
  };
};

const normalizeGenerationJob = (job) => {
  if (!job || typeof job !== 'object' || Array.isArray(job)) return job;
  const jobId = String(job.jobId || 'job');
  const bExecution = normalizeBExecution(job);
  const referenceImageUrl = normalizeReferenceImageUrl(job);
  const platforms = job.platforms && typeof job.platforms === 'object' && !Array.isArray(job.platforms)
    ? Object.fromEntries(Object.entries(job.platforms).map(([platform, entry]) => [platform, normalizePlatformEntry(entry, jobId, platform, resolvePlatformParams(bExecution.platformParams, bExecution.platformOverrides, platform))]))
    : {};
  const includePlatformOverridesInSnapshot = hasOwn(job.bSnapshot, 'platform_overrides') || hasOwn(job.bSnapshot, 'platformOverrides');
  const normalized = {
    ...job,
    prompt: bExecution.positivePrompt,
    positivePrompt: bExecution.positivePrompt,
    negativePrompt: bExecution.negativePrompt,
    aspectRatio: bExecution.aspectRatio,
    platformParams: bExecution.platformParams,
    platformOverrides: bExecution.platformOverrides,
    bSnapshot: {
      positive_prompt: bExecution.positivePrompt,
      negative_prompt: bExecution.negativePrompt,
      aspect_ratio: bExecution.aspectRatio,
      platform_params: bExecution.platformParams,
      ...(includePlatformOverridesInSnapshot ? { platform_overrides: bExecution.platformOverrides } : {}),
      source: bExecution.source,
      version: bExecution.version
    },
    referenceImageUrl,
    productImageUrl: normalizeReferenceImageUrl({ productImageUrl: job.productImageUrl, referenceImageUrl }) || referenceImageUrl,
    createdAt: job.createdAt || new Date().toISOString(),
    updatedAt: job.updatedAt || job.createdAt || new Date().toISOString(),
    expiresAt: job.expiresAt || null,
    platforms,
    status: deriveGenerationJobStatus(platforms)
  };
  expireGenerationJob(normalized);
  normalized.status = deriveGenerationJobStatus(normalized.platforms);
  return normalized;
};

const normalizeGenerationJobs = (jobs) => {
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return {};
  return Object.fromEntries(Object.entries(jobs).map(([key, job]) => [key, normalizeGenerationJob(job)]));
};

const handleGenerationJobsUnsafe = async (req, res) => {
  const collectionMatch = req.url.match(/^\/api\/projects\/([^/?]+)\/generation-jobs(?:\?.*)?$/);
  const itemMatch = req.url.match(/^\/api\/projects\/([^/?]+)\/generation-jobs\/([^/?]+)(?:\/platforms\/([^/?]+)(?:\/(retry|cancel|expire))?|\/(results)|\/(retry|cancel|expire))?(?:\?.*)?$/);
  const projectId = decodeURIComponent(collectionMatch?.[1] || itemMatch?.[1] || '');
  if (!isValidProjectId(projectId)) { sendJson(res, 400, { error: 'Invalid project id.' }); return; }
  const jobs = readGenerationJobs();

  if (collectionMatch && req.method === 'POST') {
    const input = await readJsonBody(req, res);
    if (!input) return;
    const allowedPlatforms = new Set(['chatgpt', 'gemini', 'lovart', 'doubao']);
    const platforms = Array.isArray(input.platforms) ? [...new Set(input.platforms.map((value) => String(value).toLowerCase()))] : [];
    if (!platforms.length || platforms.length > 4 || platforms.some((platform) => !allowedPlatforms.has(platform))) {
      sendJson(res, 400, { error: 'Choose one or more supported generation platforms.' });
      return;
    }
    const executionValidation = strictBExecution(input);
    if (!executionValidation.ok) {
      sendJson(res, 400, { error: executionValidation.message, errorCode: executionValidation.code });
      return;
    }
    const bExecution = executionValidation.value;
    const bSource = input.bSnapshot && typeof input.bSnapshot === 'object' ? input.bSnapshot : input;
    const includePlatformOverridesInSnapshot = hasOwn(bSource, 'platform_overrides') || hasOwn(bSource, 'platformOverrides');
    const rawPositivePrompt = bSource.positive_prompt ?? bSource.positivePrompt ?? (input.bSnapshot ? '' : input.prompt);
    if (!bExecution.positivePrompt || typeof rawPositivePrompt !== 'string' || !rawPositivePrompt.trim() || rawPositivePrompt.length > 12000) {
      sendJson(res, 400, { error: 'A prompt of up to 12000 characters is required.' });
      return;
    }
    const rawIdempotencyKey = req.headers['idempotency-key'] || input.idempotencyKey || input.requestId || '';
    const idempotencyKey = String(rawIdempotencyKey || '').trim().slice(0, 200);
    if (idempotencyKey) {
      const existing = Object.values(jobs).find((candidate) => candidate && candidate.projectId === projectId && candidate.idempotencyKey === idempotencyKey);
      if (existing) { sendJson(res, 200, { job: existing, idempotent: true }); return; }
    }
    const now = new Date().toISOString();
    const jobId = `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      jobId,
      projectId,
      prompt: bExecution.positivePrompt,
      positivePrompt: bExecution.positivePrompt,
      negativePrompt: bExecution.negativePrompt,
      aspectRatio: bExecution.aspectRatio,
      platformParams: bExecution.platformParams,
      platformOverrides: bExecution.platformOverrides,
      bSnapshot: {
        positive_prompt: bExecution.positivePrompt,
        negative_prompt: bExecution.negativePrompt,
        aspect_ratio: bExecution.aspectRatio,
        platform_params: bExecution.platformParams,
        ...(includePlatformOverridesInSnapshot ? { platform_overrides: bExecution.platformOverrides } : {}),
        source: bExecution.source,
        version: bExecution.version
      },
      referenceImageUrl: normalizeReferenceImageUrl(input),
      productImageUrl: normalizeReferenceImageUrl({ productImageUrl: input.productImageUrl, referenceImageUrl: normalizeReferenceImageUrl(input) }),
      sourceJobId: typeof input.sourceJobId === 'string' ? input.sourceJobId.slice(0, 120) : '',
      resendType: typeof input.resendType === 'string' ? input.resendType.slice(0, 40) : '',
      ...(idempotencyKey ? { idempotencyKey } : {}),
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      status: 'queued',
      platforms: Object.fromEntries(platforms.map((platform) => ({
        platform,
        value: {
          status: 'queued',
          message: '等待平台响应',
          errorCode: '',
          errorMessage: '',
          attemptId: `${jobId}:${platform}:1`,
          attemptCount: 1,
          attempts: [],
          startedAt: null,
          lastAttemptAt: now,
          updatedAt: now,
          results: [],
          resultRefs: [],
          savedResults: [],
          platformParams: resolvePlatformParams(bExecution.platformParams, bExecution.platformOverrides, platform)
        }
      })).map(({ platform, value }) => [platform, value]))
    };
    jobs[`${projectId}:${jobId}`] = job;
    try { writeGenerationJobs(jobs); } catch (error) { sendJson(res, 500, { error: 'Generation task could not be saved.' }); return; }
    sendJson(res, 201, { job });
    return;
  }

  if (collectionMatch && req.method === 'GET') {
    const projectJobs = Object.values(jobs).filter((job) => job.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    sendJson(res, 200, { jobs: projectJobs });
    return;
  }

  if (!itemMatch) { sendJson(res, 405, { error: 'Method not allowed.' }); return; }
  const jobId = decodeURIComponent(itemMatch[2]);
  const jobKey = `${projectId}:${jobId}`;
  const job = jobs[jobKey];
  if (!job) { sendJson(res, 404, { error: 'Generation task not found.' }); return; }
  const platform = decodeURIComponent(itemMatch[3] || '').toLowerCase();
  const platformAction = itemMatch[4] || '';
  const resource = itemMatch[5] || '';
  const jobAction = itemMatch[6] || '';

  const expiresAtMs = Date.parse(job.expiresAt || '');
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now() && req.method !== 'GET') {
    expireGenerationJob(job);
    try { writeGenerationJobs(jobs); } catch { sendJson(res, 500, { error: 'Generation task could not be saved.' }); return; }
    sendJson(res, 409, { error: 'Generation task has expired.', job });
    return;
  }

  if (!resource && req.method === 'GET') { sendJson(res, 200, { job }); return; }
  const now = () => new Date().toISOString();
  const snapshotAttempt = (entry) => ({
    attemptId: entry.attemptId,
    attemptCount: entry.attemptCount,
    status: entry.status,
    message: entry.message || '',
    errorCode: entry.errorCode || '',
    errorMessage: entry.errorMessage || entry.message || '',
    startedAt: entry.startedAt || null,
    lastAttemptAt: entry.lastAttemptAt || null,
    updatedAt: entry.updatedAt || null,
    results: Array.isArray(entry.results) ? entry.results : [],
    savedResults: Array.isArray(entry.savedResults) ? entry.savedResults : []
  });
  const persistJob = (statusCode = 200, extra = {}) => {
    job.updatedAt = now();
    job.status = deriveGenerationJobStatus(job.platforms);
    try { writeGenerationJobs(jobs); } catch { sendJson(res, 500, { error: 'Generation task could not be saved.' }); return false; }
    sendJson(res, statusCode, { job, ...extra });
    return true;
  };
  const resetPlatformForRetry = (entry, platformName) => {
    const previous = snapshotAttempt(entry);
    const timestamp = now();
    entry.attempts = [...(Array.isArray(entry.attempts) ? entry.attempts : []), previous].slice(-12);
    entry.attemptCount = Math.max(1, Number(entry.attemptCount) || 1) + 1;
    entry.attemptId = `${job.jobId}:${platformName}:${entry.attemptCount}`;
    entry.status = 'queued';
    entry.message = '等待平台响应';
    entry.errorCode = '';
    entry.errorMessage = '';
    entry.startedAt = null;
    entry.lastAttemptAt = timestamp;
    entry.updatedAt = timestamp;
    entry.results = [];
    entry.resultRefs = [];
  };
  const setPlatformTerminal = (entry, status, message) => {
    const timestamp = now();
    entry.status = status;
    entry.message = message;
    entry.errorCode = status;
    entry.errorMessage = message;
    entry.updatedAt = timestamp;
  };

  if (platformAction && req.method === 'POST') {
    const entry = job.platforms[platform];
    if (!entry) { sendJson(res, 404, { error: 'Platform task not found.' }); return; }
    const input = await readJsonBody(req, res);
    if (!input) return;
    if (String(input.jobId || '') !== jobId || String(input.platform || '').toLowerCase() !== platform || !input.attemptId || String(input.attemptId) !== entry.attemptId) {
      sendJson(res, 409, { error: 'Mismatched or stale platform attempt.' });
      return;
    }
    if (platformAction === 'retry') {
      if (entry.status === 'completed') { sendJson(res, 409, { error: 'Completed platform tasks cannot be retried.' }); return; }
      resetPlatformForRetry(entry, platform);
      persistJob(200, { platform, attemptId: entry.attemptId });
      return;
    }
    if (platformAction === 'cancel') {
      if (isPlatformTerminal(entry.status) && entry.status !== 'cancelled') { sendJson(res, 409, { error: 'Terminal platform task cannot be cancelled.' }); return; }
      setPlatformTerminal(entry, 'cancelled', '已取消该平台任务');
      persistJob(200, { platform });
      return;
    }
    if (platformAction === 'expire') {
      if (isPlatformTerminal(entry.status) && entry.status !== 'expired') { sendJson(res, 409, { error: 'Terminal platform task cannot be expired.' }); return; }
      setPlatformTerminal(entry, 'expired', '该平台任务已过期');
      persistJob(200, { platform });
      return;
    }
  }

  if (jobAction && req.method === 'POST') {
    const message = jobAction === 'cancel' ? '任务已取消' : '任务已过期';
    const status = jobAction === 'cancel' ? 'cancelled' : 'expired';
    Object.values(job.platforms).forEach((entry) => {
      if (!isPlatformTerminal(entry.status)) setPlatformTerminal(entry, status, message);
    });
    persistJob(200, { action: jobAction });
    return;
  }

  if (platform && !platformAction && req.method === 'PATCH') {
    const entry = job.platforms[platform];
    if (!entry) { sendJson(res, 404, { error: 'Platform task not found.' }); return; }
    const input = await readJsonBody(req, res);
    if (!input) return;
    if (String(input.jobId || '') !== jobId || String(input.platform || '').toLowerCase() !== platform) { sendJson(res, 409, { error: 'Mismatched generation job or platform.' }); return; }
    if (input.status && !PLATFORM_STATUSES.has(input.status)) { sendJson(res, 400, { error: 'Invalid platform task status.' }); return; }
    if (!input.attemptId || String(input.attemptId) !== entry.attemptId) { sendJson(res, 409, { error: 'Stale platform attempt.' }); return; }
    if (isPlatformTerminal(entry.status) && input.status && input.status !== entry.status) { sendJson(res, 409, { error: 'Terminal platform attempt cannot regress.' }); return; }
    if (input.status) entry.status = input.status;
    if (typeof input.message === 'string') entry.message = input.message.slice(0, 1000);
    if (typeof input.errorCode === 'string') entry.errorCode = input.errorCode.slice(0, 120);
    if (typeof input.errorMessage === 'string') entry.errorMessage = input.errorMessage.slice(0, 1000);
    if (PLATFORM_ACTIVE.has(entry.status) && !entry.startedAt) entry.startedAt = now();
    if (Array.isArray(input.results)) {
      entry.results = input.results.slice(0, 12).map(normalizeResultReference).filter(Boolean);
      entry.resultRefs = entry.results;
    }
    entry.updatedAt = now();
    entry.lastAttemptAt = entry.lastAttemptAt || entry.updatedAt;
    if (PLATFORM_TERMINAL_FAILURE.has(entry.status) && !entry.errorCode) entry.errorCode = entry.status;
    if (PLATFORM_TERMINAL_FAILURE.has(entry.status) && !entry.errorMessage) entry.errorMessage = entry.message;
    persistJob();
    return;
  }
  if (resource === 'results' && req.method === 'POST') {
    const input = await readJsonBody(req, res);
    if (!input) return;
    const platform = String(input.platform || '').toLowerCase();
    if (!job.platforms[platform]) { sendJson(res, 400, { error: 'Platform is not part of this task.' }); return; }
    if (String(input.jobId || '') !== jobId) { sendJson(res, 409, { error: 'Mismatched generation job.' }); return; }
    const entry = job.platforms[platform];
    if (!input.attemptId || String(input.attemptId) !== entry.attemptId) { sendJson(res, 409, { error: 'Stale platform attempt.' }); return; }
    const assetUrl = String(input.assetUrl || '');
    if (!assetUrl.startsWith(`/uploads/${encodeURIComponent(projectId)}/`) || assetUrl.includes('..')) {
      sendJson(res, 400, { error: 'Result image must be uploaded to this project first.' });
      return;
    }
    const saved = { id: String(input.id || input.candidateId || '').slice(0, 120), candidateId: String(input.candidateId || input.id || '').slice(0, 120), url: assetUrl, platform, savedAt: now() };
    saved.attemptId = entry.attemptId;
    if (hasOwn(input, 'promptVersion') && (!Number.isInteger(input.promptVersion) || input.promptVersion < 1)) {
      sendJson(res, 400, { error: 'promptVersion must be a positive integer.' }); return;
    }
    if (hasOwn(input, 'dimensions') && input.dimensions !== null && !normalizeAssetDimensions(input.dimensions)) {
      sendJson(res, 400, { error: 'dimensions must contain positive integer width and height.' }); return;
    }
    const assetStore = readResultAssets();
    const assetId = createResultAssetId();
    const asset = normalizeResultAsset({
      assetId, archivedUrl: assetUrl, thumbnailUrl: input.thumbnailUrl,
      sourceUrl: typeof input.sourceUrl === 'string' ? input.sourceUrl : assetUrl,
      jobId, platform, candidateId: saved.candidateId, attemptId: entry.attemptId,
      promptVersion: input.promptVersion || job.bSnapshot?.version || 1,
      dimensions: input.dimensions, createdAt: saved.savedAt, archivedAt: saved.savedAt,
      tags: [], favorite: false, status: 'archived'
    }, projectId, assetId);
    assetStore[projectId] = assetStore[projectId] || {};
    assetStore[projectId][assetId] = asset;
    saved.assetId = assetId;
    entry.savedResults = [...entry.savedResults, saved].slice(-12);
    entry.status = 'completed';
    entry.updatedAt = now();
    entry.errorCode = '';
    entry.errorMessage = '';
    job.updatedAt = now();
    job.status = deriveGenerationJobStatus(job.platforms);
    const originals = [resultAssetsPath, generationJobsPath].map((filePath) => [filePath, readFileState(filePath)]);
    try {
      writeResultAssets(assetStore);
      writeGenerationJobs(jobs);
    } catch (error) {
      for (const [filePath, original] of originals) {
        try { restoreFileState(filePath, original); }
        catch (rollbackError) { console.error('[result-assets] rollback failed:', rollbackError.message); }
        try { if (fs.existsSync(`${filePath}.tmp`)) fs.unlinkSync(`${filePath}.tmp`); } catch {}
      }
      console.error('[result-assets] failed to import result:', error.message);
      sendJson(res, 500, { error: 'Result asset could not be saved.' });
      return;
    }
    sendJson(res, 201, { job, result: saved, asset });
    return;
  }
  sendJson(res, 405, { error: 'Method not allowed.' });
};

let generationJobsMutationTail = Promise.resolve();
const handleGenerationJobs = (req, res) => {
  if (req.method === 'GET') return handleGenerationJobsUnsafe(req, res);
  const run = generationJobsMutationTail.then(() => handleGenerationJobsUnsafe(req, res));
  generationJobsMutationTail = run.catch(() => {});
  return run;
};

const readBinaryBody = (req, maxBytes = 8 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = [];
  let total = 0;
  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > maxBytes) {
      reject(new Error('file too large'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const assetPathFromRequest = (req) => {
  const match = req.url.match(/^\/api\/projects\/([^/?]+)\/assets(?:\?.*)?$/);
  return match ? decodeRoutePart(match[1]) : '';
};



const resultAssetsPathFromRequest = (req) => {
  const match = req.url.match(/^\/api\/projects\/([^/?]+)\/(?:result-assets|assets)(?:\/([^/?]+))?(?:\?.*)?$/);
  return { projectId: match ? decodeRoutePart(match[1]) : '', assetId: match?.[2] ? decodeRoutePart(match[2]) : '' };
};

const handleResultAssets = async (req, res) => {
  const { projectId, assetId } = resultAssetsPathFromRequest(req);
  if (!isValidProjectId(projectId)) { sendJson(res, 400, { error: 'Invalid project id.' }); return; }
  if (assetId === null || (assetId && !/^asset-[A-Za-z0-9-]{8,120}$/.test(assetId))) { sendJson(res, 400, { error: 'Invalid result asset id.' }); return; }
  const store = readResultAssets();
  const projectAssets = store[projectId] || {};
  if (!assetId && req.method === 'GET') {
    const query = new URL(req.url, 'http://127.0.0.1').searchParams;
    const status = query.get('status');
    if (status && !RESULT_ASSET_STATUSES.has(status)) { sendJson(res, 400, { error: 'Invalid result asset status.' }); return; }
    const includeDeleted = query.get('includeDeleted') === 'true';
    const favorite = query.get('favorite');
    if (favorite !== null && !['true', 'false'].includes(favorite)) { sendJson(res, 400, { error: 'favorite must be true or false.' }); return; }
    const version = query.get('promptVersion') ?? query.get('version');
    if (version !== null && (!/^\d+$/.test(version) || Number(version) < 1)) { sendJson(res, 400, { error: 'version must be a positive integer.' }); return; }
    const from = query.get('from') ?? query.get('createdAfter') ?? query.get('createdFrom') ?? query.get('since');
    const to = query.get('to') ?? query.get('createdBefore') ?? query.get('createdTo') ?? query.get('until');
    const parseAssetTimeFilter = (value, endOfDay = false) => {
      if (value === null) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const day = Date.parse(`${value}T00:00:00.000Z`);
        if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value) return NaN;
        return day + (endOfDay ? 24 * 60 * 60 * 1000 - 1 : 0);
      }
      return Date.parse(value);
    };
    const fromMs = parseAssetTimeFilter(from);
    const toMs = parseAssetTimeFilter(to, true);
    if ((fromMs !== null && !Number.isFinite(fromMs)) || (toMs !== null && !Number.isFinite(toMs)) || (fromMs !== null && toMs !== null && fromMs > toMs)) {
      sendJson(res, 400, { error: 'Invalid result asset time range.' }); return;
    }
    const platform = query.get('platform');
    const jobId = query.get('jobId') ?? query.get('job');
    const attemptId = query.get('attemptId') ?? query.get('attempt');
    const tag = query.get('tag');
    const assets = Object.values(projectAssets).filter((asset) => {
      if (status ? asset.status !== status : !includeDeleted && asset.status === 'deleted') return false;
      if (platform && asset.platform !== platform) return false;
      if (jobId && asset.jobId !== jobId) return false;
      if (attemptId && asset.attemptId !== attemptId) return false;
      if (version !== null && asset.promptVersion !== Number(version)) return false;
      if (favorite !== null && asset.favorite !== (favorite === 'true')) return false;
      if (tag && !asset.tags.includes(tag)) return false;
      const createdAtMs = Date.parse(asset.createdAt);
      return !(fromMs !== null && createdAtMs < fromMs) && !(toMs !== null && createdAtMs > toMs);
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    sendJson(res, 200, { projectId, assets });
    return;
  }
  if (!assetId) { sendJson(res, 405, { error: 'Method not allowed.' }); return; }
  const asset = projectAssets[assetId];
  if (!asset) { sendJson(res, 404, { error: 'Result asset not found.' }); return; }
  if (req.method === 'GET') { sendJson(res, 200, { asset }); return; }
  if (req.method === 'PATCH') {
    const input = await readJsonBody(req, res);
    if (!input) return;
    if (hasOwn(input, 'tags') && (!Array.isArray(input.tags) || input.tags.length > 30 || input.tags.some((tag) => typeof tag !== 'string' || tag.trim().length > 40))) {
      sendJson(res, 400, { error: 'tags must be an array of at most 30 strings of at most 40 characters.' }); return;
    }
    if (hasOwn(input, 'favorite') && typeof input.favorite !== 'boolean') { sendJson(res, 400, { error: 'favorite must be a boolean.' }); return; }
    if (hasOwn(input, 'status') && !RESULT_ASSET_STATUSES.has(input.status)) { sendJson(res, 400, { error: 'status must be temp, archived, invalid, or deleted.' }); return; }
    if (hasOwn(input, 'tags')) asset.tags = [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))];
    if (hasOwn(input, 'favorite')) asset.favorite = input.favorite;
    const timestamp = new Date().toISOString();
    if (hasOwn(input, 'status')) {
      asset.status = input.status;
      if (asset.status === 'deleted') asset.deletedAt = asset.deletedAt || timestamp;
      else delete asset.deletedAt;
      if (asset.status === 'archived' && !asset.archivedAt) asset.archivedAt = timestamp;
    }
    asset.updatedAt = timestamp;
    try { writeResultAssets(store); } catch (error) { sendJson(res, 500, { error: 'Result asset could not be saved.' }); return; }
    sendJson(res, 200, { asset });
    return;
  }
  if (req.method === 'DELETE') {
    asset.status = 'deleted';
    asset.deletedAt = asset.deletedAt || new Date().toISOString();
    asset.updatedAt = asset.deletedAt;
    try { writeResultAssets(store); } catch (error) { sendJson(res, 500, { error: 'Result asset could not be saved.' }); return; }
    sendJson(res, 200, { asset });
    return;
  }
  sendJson(res, 405, { error: 'Method not allowed.' });
};

const handleAssetUpload = async (req, res) => {
  const projectId = assetPathFromRequest(req);
  if (!isValidProjectId(projectId)) { sendJson(res, 400, { error: 'Invalid project id.' }); return; }
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  const allowed = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
  const extension = allowed[contentType];
  if (!extension) { sendJson(res, 415, { error: 'Only PNG, JPEG, and WebP images are supported.' }); return; }
  try {
    const bytes = await readBinaryBody(req);
    if (!bytes.length) { sendJson(res, 400, { error: 'Empty image upload.' }); return; }
    const projectDir = path.join(uploadsDir, projectId);
    fs.mkdirSync(projectDir, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${extension}`;
    const outputPath = path.join(projectDir, filename);
    fs.writeFileSync(outputPath, bytes);
    sendJson(res, 201, { url: `/uploads/${encodeURIComponent(projectId)}/${filename}`, filename, contentType, size: bytes.length });
  } catch (error) {
    console.error('[assets] failed to save upload:', error.message);
    sendJson(res, 500, { error: 'Image upload failed.' });
  }
};

const callDeepSeek = (messages) => new Promise((resolve, reject) => {
  const target = new URL('/chat/completions', deepseekBaseUrl);
  const request = https.request(target, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${deepseekApiKey}`,
      'Content-Type': 'application/json'
    }
  }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const error = new Error(`DeepSeek request failed (${response.statusCode})`);
        error.code = AGENT_ERROR_CODES.MODEL_REQUEST_FAILED;
        reject(error);
        return;
      }
      const content = parsed?.choices?.[0]?.message?.content;
      if (!content) {
        const error = new Error('DeepSeek returned an empty response');
        error.code = AGENT_ERROR_CODES.MODEL_EMPTY_RESPONSE;
        reject(error);
        return;
      }
      resolve(content);
    });
  });
  request.setTimeout(45000, () => {
    const error = new Error('DeepSeek request timed out');
    error.code = AGENT_ERROR_CODES.MODEL_TIMEOUT;
    request.destroy(error);
  });
  request.on('error', reject);
  request.write(JSON.stringify({ model: deepseekModel, messages, temperature: 0.4, response_format: { type: 'json_object' } }));
  request.end();
});

const runAgentRequest = async (requestBody, { projectId = '', runId = '' } = {}) => {
  const validation = validateAgentInput({ ...requestBody, projectId: projectId || requestBody?.projectId || '' });
  if (!validation.ok) return { ok: false, statusCode: 400, errorCode: validation.code, error: validation.message };
  if (!deepseekApiKey) return { ok: false, statusCode: 503, errorCode: AGENT_ERROR_CODES.AGENT_NOT_CONFIGURED, error: 'DeepSeek 未配置，请检查服务端 API Key。', input: validation.value };
  try {
    const result = parseModelJson(await callDeepSeek(buildAgentMessages(validation.value)));
    const output = normalizeAgentOutput(result, validation.value, { runId: runId || createRunId() });
    output.model = deepseekModel;
    if (validation.value.task === 'description_a' && !output.descriptionA) {
      return { ok: false, statusCode: 502, errorCode: AGENT_ERROR_CODES.MODEL_SCHEMA_INVALID, error: 'DeepSeek 未返回有效的 A 版草稿，请稍后重试。', input: validation.value, output };
    }
    return { ok: true, statusCode: 200, input: validation.value, output };
  } catch (error) {
    const errorCode = Object.values(AGENT_ERROR_CODES).includes(error.code) ? error.code : AGENT_ERROR_CODES.MODEL_REQUEST_FAILED;
    console.error('[agent]', errorCode);
    return {
      ok: false,
      statusCode: errorCode === AGENT_ERROR_CODES.MODEL_TIMEOUT ? 504 : 502,
      errorCode,
      error: 'DeepSeek 暂时不可用，请稍后重试。'
    };
  }
};

const handleAgent = async (req, res) => {
  let requestBody;
  try { requestBody = JSON.parse(await readBody(req)); } catch {
    sendJson(res, 400, { error: 'Invalid JSON request.', errorCode: AGENT_ERROR_CODES.INVALID_REQUEST });
    return;
  }
  const result = await runAgentRequest(requestBody);
  if (!result.ok) {
    sendJson(res, result.statusCode, { error: result.error, errorCode: result.errorCode });
    return;
  }
  sendJson(res, 200, result.output);
};

const projectAgentCollectionMatch = (req) => req.url.match(/^\/api\/projects\/([^/?]+)\/agent-runs(?:\?.*)?$/);
const projectAgentItemMatch = (req) => req.url.match(/^\/api\/projects\/([^/?]+)\/agent-runs\/([^/?]+)(?:\/(accept|restore|cancel))?(?:\?.*)?$/);

const readProjectAgentState = (project) => {
  const agent = project?.agent && typeof project.agent === 'object' && !Array.isArray(project.agent) ? project.agent : {};
  const runs = Array.isArray(agent.runs) ? agent.runs.filter((run) => run && typeof run === 'object').slice(-50) : [];
  const acceptedRun = runs.find((run) => run.accepted && run.output?.draft);
  return {
    schemaVersion: 1,
    latestRunId: typeof agent.latestRunId === 'string' ? agent.latestRunId : '',
    acceptedRunId: typeof agent.acceptedRunId === 'string' && agent.acceptedRunId ? agent.acceptedRunId : acceptedRun?.runId || '',
    latestDraftVersion: Math.max(0, Number(agent.latestDraftVersion) || 0),
    runs
  };
};

const persistProjectAgentRun = (projectId, run, { isNewRun = false, acceptDraft = false, allocateDraftVersion = false, rejectCancelled = false } = {}) => {
  const store = readProjectStore();
  const project = store[projectId];
  if (!project) return { ok: false, code: AGENT_ERROR_CODES.PROJECT_NOT_FOUND };
  const agent = readProjectAgentState(project);
  const existingRun = agent.runs.find((item) => item.runId === run.runId);
  if (rejectCancelled && existingRun?.status === 'cancelled' && run.status !== 'cancelled') {
    return { ok: false, code: AGENT_ERROR_CODES.AGENT_CANCELLED, run: existingRun };
  }
  if (allocateDraftVersion && run.status === 'completed' && run.output?.draft) {
    run.version = agent.latestDraftVersion + 1;
    run.output.version = run.version;
    Object.values(run.output.draft.fields || {}).forEach((field) => {
      if (!field || typeof field !== 'object') return;
      field.version = run.version;
      field.updatedAt = run.updatedAt || nowIso();
    });
  }
  const nextRuns = [...agent.runs.filter((item) => item.runId !== run.runId), run].slice(-50);
  project.agent = {
    schemaVersion: 1,
    latestRunId: isNewRun ? run.runId : (agent.latestRunId || run.runId),
    acceptedRunId: acceptDraft ? run.runId : (agent.acceptedRunId === run.runId && !run.accepted ? '' : agent.acceptedRunId),
    latestDraftVersion: Math.max(agent.latestDraftVersion, run.status === 'completed' && run.output?.draft ? Number(run.version) || 0 : 0),
    runs: nextRuns
  };
  if (acceptDraft && run.output?.draft) {
    project.descriptionA = run.output.draft.rawText;
    project.descriptionAStructured = legacyStructured(run.output.draft);
    project.descriptionADraft = run.output.draft;
  }
  project.updatedAt = nowIso();
  store[projectId] = project;
  try {
    writeProjectStore(store);
    return { ok: true, project, run };
  } catch (error) {
    console.error('[agent] failed to persist project run:', error.message);
    return { ok: false, code: AGENT_ERROR_CODES.PERSIST_FAILED };
  }
};

const handleAgentRuns = async (req, res) => {
  const collectionMatch = projectAgentCollectionMatch(req);
  const itemMatch = projectAgentItemMatch(req);
  const projectId = decodeURIComponent(collectionMatch?.[1] || itemMatch?.[1] || '');
  if (!isValidProjectId(projectId)) { sendJson(res, 400, { error: 'Invalid project id.', errorCode: AGENT_ERROR_CODES.INVALID_REQUEST }); return; }
  const store = readProjectStore();
  const project = store[projectId];
  if (!project) { sendJson(res, 404, { error: 'Project not found.', errorCode: AGENT_ERROR_CODES.PROJECT_NOT_FOUND }); return; }
  const agent = readProjectAgentState(project);
  if (itemMatch) {
    const runId = decodeURIComponent(itemMatch[2]);
    const run = agent.runs.find((item) => item.runId === runId);
    if (!run) { sendJson(res, 404, { error: 'Agent run not found.', errorCode: AGENT_ERROR_CODES.RUN_NOT_FOUND }); return; }
    if (req.method === 'GET' && !itemMatch[3]) {
      sendJson(res, 200, { projectId, run });
      return;
    }
    if (req.method === 'POST' && itemMatch[3] === 'restore') {
      if (run.task !== 'description_a' || run.status !== 'completed' || !run.output?.draft) {
        sendJson(res, 409, { error: 'Only a completed A版 draft can be restored.', errorCode: AGENT_ERROR_CODES.MODEL_SCHEMA_INVALID });
        return;
      }
      const timestamp = nowIso();
      const restoredRunId = createRunId();
      const restoredVersion = agent.latestDraftVersion + 1;
      const output = JSON.parse(JSON.stringify(run.output));
      output.runId = restoredRunId;
      output.version = restoredVersion;
      if (output.draft.fields && typeof output.draft.fields === 'object') {
        Object.values(output.draft.fields).forEach((field) => {
          if (!field || typeof field !== 'object' || !Object.prototype.hasOwnProperty.call(field, 'value')) return;
          field.version = restoredVersion;
          field.updatedAt = timestamp;
        });
      }
      const allowIncompleteSemanticMinimum = Boolean(run.accepted && validateAgentDraftSemantics(run.output.draft).length);
      const restoredRun = {
        ...createAgentRunRecord({
          runId: restoredRunId,
          input: run.input,
          output,
          status: 'completed',
          version: restoredVersion,
          createdAt: timestamp
        }),
        restoredFromRunId: run.runId,
        ...(allowIncompleteSemanticMinimum ? { legacyCompatibility: { allowIncompleteSemanticMinimum: true, sourceRunId: run.runId } } : {})
      };
      const persisted = persistProjectAgentRun(projectId, restoredRun, { isNewRun: true });
      if (!persisted.ok) { sendJson(res, 500, { error: 'Restored Agent run could not be saved.', errorCode: persisted.code }); return; }
      sendJson(res, 201, { projectId, sourceRunId: run.runId, run: restoredRun });
      return;
    }
    if (req.method === 'POST' && itemMatch[3] === 'accept') {
      if (run.status !== 'completed' || !run.output?.draft) {
        sendJson(res, 409, { error: 'Only a completed A版 draft can be accepted.', errorCode: AGENT_ERROR_CODES.MODEL_SCHEMA_INVALID });
        return;
      }
      if (!run.accepted && !run.legacyCompatibility?.allowIncompleteSemanticMinimum) {
        const semanticErrors = validateAgentDraftSemantics(run.output.draft);
        if (semanticErrors.length) {
          sendJson(res, 409, { error: semanticErrors[0].message, errorCode: AGENT_ERROR_CODES.MODEL_SCHEMA_INVALID, fields: semanticErrors });
          return;
        }
      }
      const timestamp = nowIso();
      run.accepted = true;
      run.acceptedAt = timestamp;
      run.acceptedVersion = run.version;
      run.updatedAt = timestamp;
      const persisted = persistProjectAgentRun(projectId, run, { acceptDraft: true });
      if (!persisted.ok) { sendJson(res, 500, { error: 'Agent run could not be saved.', errorCode: persisted.code }); return; }
      sendJson(res, 200, { projectId, run });
      return;
    }
    if (req.method === 'POST' && itemMatch[3] === 'cancel') {
      if (run.status === 'cancelled') {
        sendJson(res, 200, { projectId, run });
        return;
      }
      if (!['queued', 'running'].includes(run.status)) {
        sendJson(res, 409, { error: 'Only queued or running Agent runs can be cancelled.', errorCode: AGENT_ERROR_CODES.MODEL_SCHEMA_INVALID, run });
        return;
      }
      const timestamp = nowIso();
      run.status = 'cancelled';
      run.cancelledAt = timestamp;
      run.completedAt = timestamp;
      run.errorCode = AGENT_ERROR_CODES.AGENT_CANCELLED;
      run.errorMessage = 'Agent run cancelled by user.';
      run.updatedAt = timestamp;
      const persisted = persistProjectAgentRun(projectId, run);
      if (!persisted.ok) { sendJson(res, 500, { error: 'Agent run could not be saved.', errorCode: persisted.code }); return; }
      sendJson(res, 200, { projectId, run });
      return;
    }
    if (req.method === 'PATCH' && !itemMatch[3]) {
      const patch = await readJsonBody(req, res);
      if (!patch) return;
      if (run.status !== 'completed' || !run.output?.draft) {
        sendJson(res, 409, { error: 'Only a completed A版 draft can be edited.', errorCode: AGENT_ERROR_CODES.MODEL_SCHEMA_INVALID });
        return;
      }
      const timestamp = nowIso();
      const nextVersion = Math.max(Number(run.version) || 1, Number(run.output.version) || 1) + 1;
      run.revisions = Array.isArray(run.revisions) ? run.revisions : [];
      run.revisions.push({
        version: run.version,
        output: JSON.parse(JSON.stringify(run.output)),
        accepted: Boolean(run.accepted),
        acceptedAt: run.acceptedAt || null,
        acceptedVersion: run.acceptedVersion || null,
        archivedAt: timestamp
      });
      const nextDraft = applyUserDraftEdits(run.output.draft, patch.draft || patch, { version: nextVersion, updatedAt: timestamp });
      run.version = nextVersion;
      run.output.version = nextVersion;
      run.output.draft = nextDraft;
      run.output.descriptionA = nextDraft.rawText;
      run.output.descriptionAStructured = legacyStructured(nextDraft);
      const modelFields = Object.fromEntries(Object.entries(nextDraft.fields)
        .filter(([, field]) => field?.source === 'agent')
        .map(([name, field]) => [name, field.value]));
      run.output.warnings = collectWarnings({
        descriptionA: nextDraft.rawText,
        descriptionAStructured: modelFields
      }, run.input, nextDraft);
      run.accepted = false;
      run.acceptedAt = null;
      run.acceptedVersion = null;
      run.updatedAt = timestamp;
      const persisted = persistProjectAgentRun(projectId, run);
      if (!persisted.ok) { sendJson(res, 500, { error: 'Agent run could not be saved.', errorCode: persisted.code }); return; }
      sendJson(res, 200, { projectId, run });
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  if (req.method === 'GET') {
    sendJson(res, 200, { schemaVersion: 1, projectId, latestRunId: agent.latestRunId, acceptedRunId: agent.acceptedRunId, latestDraftVersion: agent.latestDraftVersion, runs: [...agent.runs].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))) });
    return;
  }
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed.' }); return; }
  const requestBody = await readJsonBody(req, res);
  if (!requestBody) return;
  const createdAt = nowIso();
  const requestedInput = validateAgentInput({ ...requestBody, projectId });
  const runId = createRunId();
  const input = requestedInput.ok
    ? requestedInput.value
    : { task: String(requestBody.task || ''), projectId, product: {}, creativeDirection: { scene: '', note: '' }, conversation: [] };
  const hasDraftTask = requestedInput.ok && requestedInput.value.task === 'description_a';
  const version = 0;
  const queuedRun = createAgentRunRecord({
    runId,
    input,
    status: requestedInput.ok ? 'queued' : 'failed',
    errorCode: requestedInput.ok ? '' : requestedInput.code,
    errorMessage: requestedInput.ok ? '' : requestedInput.message,
    version,
    createdAt,
    completedAt: requestedInput.ok ? null : createdAt
  });
  const initialPersisted = persistProjectAgentRun(projectId, queuedRun, { isNewRun: true });
  if (!initialPersisted.ok) {
    sendJson(res, initialPersisted.code === AGENT_ERROR_CODES.PROJECT_NOT_FOUND ? 404 : 500, { error: 'Agent run could not be saved.', errorCode: initialPersisted.code });
    return;
  }
  if (!requestedInput.ok) {
    sendJson(res, 400, { error: requestedInput.message, errorCode: requestedInput.code, run: queuedRun });
    return;
  }

  const runningTimestamp = nowIso();
  const runningRun = { ...queuedRun, status: 'running', startedAt: runningTimestamp, updatedAt: runningTimestamp };
  const runningPersisted = persistProjectAgentRun(projectId, runningRun);
  if (!runningPersisted.ok) {
    sendJson(res, 500, { error: 'Agent run could not be saved.', errorCode: runningPersisted.code });
    return;
  }

  const result = await runAgentRequest({ ...requestBody, projectId }, { projectId, runId });
  const latestStore = readProjectStore();
  const latestProject = latestStore[projectId];
  const latestAgent = readProjectAgentState(latestProject);
  const latestRun = latestAgent.runs.find((item) => item.runId === runId);
  if (latestRun?.status === 'cancelled') {
    sendJson(res, 409, { error: 'Agent run was cancelled.', errorCode: AGENT_ERROR_CODES.AGENT_CANCELLED, run: latestRun });
    return;
  }
  const finalRun = {
    ...(latestRun || runningRun),
    output: result.output || null,
    status: result.ok ? 'completed' : 'failed',
    errorCode: result.errorCode || '',
    errorMessage: result.ok ? '' : result.error,
    completedAt: nowIso(),
    updatedAt: nowIso()
  };
  const hasDraft = Boolean(result.ok && hasDraftTask && finalRun.output?.draft);
  finalRun.version = 0;
  const persisted = persistProjectAgentRun(projectId, finalRun, { allocateDraftVersion: hasDraft, rejectCancelled: true });
  if (!persisted.ok && persisted.code === AGENT_ERROR_CODES.AGENT_CANCELLED) {
    sendJson(res, 409, { error: 'Agent run was cancelled.', errorCode: AGENT_ERROR_CODES.AGENT_CANCELLED, run: persisted.run });
    return;
  }
  if (!persisted.ok) {
    sendJson(res, 500, { error: 'Agent run could not be saved.', errorCode: persisted.code });
    return;
  }
  if (!result.ok) {
    sendJson(res, result.statusCode, { error: result.error, errorCode: result.errorCode, run: finalRun });
    return;
  }
  sendJson(res, 201, { projectId, run: persisted.run || finalRun });
};

const serveStatic = (req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(404); res.end('Not found'); return; }
  if (urlPath.startsWith('/uploads/')) {
    const relativeUploadPath = path.relative(uploadsDir, path.resolve(uploadsDir, `.${urlPath.slice('/uploads'.length)}`));
    if (relativeUploadPath.startsWith('..') || path.isAbsolute(relativeUploadPath)) { res.writeHead(404); res.end('Not found'); return; }
    const uploadPath = path.join(uploadsDir, relativeUploadPath);
    if (!fs.existsSync(uploadPath) || fs.statSync(uploadPath).isDirectory()) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(uploadPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(uploadPath).pipe(res);
    return;
  }
  const isAssetPath = urlPath === '/assets' || urlPath.startsWith('/assets/');
  if (urlPath !== '/' && !publicRootFiles.has(urlPath) && !isAssetPath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end('Not found');
    return;
  }
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  const baseRoot = isAssetPath ? assetsDir : root;
  const assetRequested = isAssetPath ? requested.slice('/assets'.length) || '/' : requested;
  const filePath = path.resolve(baseRoot, `.${assetRequested}`);
  const relativePath = path.relative(baseRoot, filePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' }); res.end(); return; }
  if (req.method === 'GET' && req.url === '/api/health') { sendJson(res, 200, { ok: true, provider: 'deepseek', configured: Boolean(deepseekApiKey), imageProvider: 'multi-platform-extension' }); return; }
  if (req.method === 'POST' && req.url === '/api/agent') { await handleAgent(req, res); return; }
  if (/^\/api\/projects\/[^/?]+\/agent-runs(?:\/[^/?]+(?:\/(?:accept|restore|cancel))?)?(?:\?.*)?$/.test(req.url)) { await handleAgentRuns(req, res); return; }
  if (/^\/(api\/projects\/[^/?]+\/generation-jobs)/.test(req.url)) { await handleGenerationJobs(req, res); return; }
  if (/^\/api\/projects\/[^/?]+\/(?:result-assets|assets)(?:\/|\?|$)/.test(req.url) && !(req.method === 'POST' && /^\/api\/projects\/[^/?]+\/assets(?:\?|$)/.test(req.url))) {
    if (req.method === 'GET') { await handleResultAssets(req, res); return; }
    const run = generationJobsMutationTail.then(() => handleResultAssets(req, res));
    generationJobsMutationTail = run.catch(() => {});
    await run;
    return;
  }
  if (/^\/api\/projects\/[^/?]+\/versions(?:\/[^/?]+\/(?:diff|restore))?(?:\?.*)?$/.test(req.url)) { await handleProjectVersions(req, res); return; }
  if (req.method === 'POST' && /^\/api\/projects\/[^/?]+\/assets/.test(req.url)) { await handleAssetUpload(req, res); return; }
  if ((req.method === 'GET' || req.method === 'PUT') && /^\/api\/projects\//.test(req.url)) { await handleProject(req, res); return; }
  if (req.method === 'GET') { serveStatic(req, res); return; }
  sendJson(res, 405, { error: 'Method not allowed.' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`zaotu server listening at http://127.0.0.1:${port}`);
});
