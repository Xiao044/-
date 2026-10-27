const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
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
  validateAgentInput
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
const generationJobsPath = path.join(dataDir, 'generation-jobs.json');
const uploadsDir = path.join(dataDir, 'uploads');
const assetsDir = path.join(root, 'assets');
const projectIdPattern = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,80}$/;
const isValidProjectId = (value) => Boolean(value && projectIdPattern.test(value));

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
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,OPTIONS'
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
    candidateId: String(result.candidateId || id).slice(0, 120),
    url,
    sourceUrl: typeof result.sourceUrl === 'string' ? result.sourceUrl.slice(0, 2048) : url,
    createdAt: String(result.createdAt || result.savedAt || new Date().toISOString()).slice(0, 40),
    ...(result.attemptId ? { attemptId: String(result.attemptId).slice(0, 160) } : {})
  };
};

const normalizePlatformEntry = (entry, jobId, platform) => {
  const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  const attemptCount = Math.max(1, Number(source.attemptCount) || 1);
  const status = PLATFORM_STATUSES.has(source.status) ? source.status : 'queued';
  const results = Array.isArray(source.results) ? source.results.map(normalizeResultReference).filter(Boolean).slice(0, 12) : [];
  const savedResults = Array.isArray(source.savedResults) ? source.savedResults.map(normalizeResultReference).filter(Boolean).slice(0, 12) : [];
  const attemptId = String(source.attemptId || `${jobId}:${platform}:${attemptCount}`).slice(0, 160);
  const attempts = Array.isArray(source.attempts) ? source.attempts.slice(-12) : [];
  return {
    ...source,
    status,
    message: String(source.message || '').slice(0, 1000),
    errorCode: String(source.errorCode || (status === 'extension_disconnected' ? 'EXTENSION_DISCONNECTED' : '')).slice(0, 120),
    errorMessage: String(source.errorMessage || source.message || '').slice(0, 1000),
    attemptId,
    attemptCount,
    attempts,
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
  const platforms = job.platforms && typeof job.platforms === 'object' && !Array.isArray(job.platforms)
    ? Object.fromEntries(Object.entries(job.platforms).map(([platform, entry]) => [platform, normalizePlatformEntry(entry, jobId, platform)]))
    : {};
  const normalized = {
    ...job,
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
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000) {
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
      prompt: input.prompt.trim(),
      productImageUrl: typeof input.productImageUrl === 'string' ? input.productImageUrl.slice(0, 2048) : '',
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
          savedResults: []
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
    entry.savedResults = [...entry.savedResults, saved].slice(-12);
    entry.status = 'completed';
    entry.updatedAt = now();
    entry.errorCode = '';
    entry.errorMessage = '';
    persistJob(201, { result: saved });
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
  return match ? decodeURIComponent(match[1]) : '';
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
      const restoredRun = {
        ...createAgentRunRecord({
          runId: restoredRunId,
          input: run.input,
          output,
          status: 'completed',
          version: restoredVersion,
          createdAt: timestamp
        }),
        restoredFromRunId: run.runId
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
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,OPTIONS' }); res.end(); return; }
  if (req.method === 'GET' && req.url === '/api/health') { sendJson(res, 200, { ok: true, provider: 'deepseek', configured: Boolean(deepseekApiKey), imageProvider: 'multi-platform-extension' }); return; }
  if (req.method === 'POST' && req.url === '/api/agent') { await handleAgent(req, res); return; }
  if (/^\/api\/projects\/[^/?]+\/agent-runs(?:\/[^/?]+(?:\/(?:accept|restore|cancel))?)?(?:\?.*)?$/.test(req.url)) { await handleAgentRuns(req, res); return; }
  if (/^\/(api\/projects\/[^/?]+\/generation-jobs)/.test(req.url)) { await handleGenerationJobs(req, res); return; }
  if (req.method === 'POST' && /^\/api\/projects\/[^/?]+\/assets/.test(req.url)) { await handleAssetUpload(req, res); return; }
  if ((req.method === 'GET' || req.method === 'PUT') && /^\/api\/projects\//.test(req.url)) { await handleProject(req, res); return; }
  if (req.method === 'GET') { serveStatic(req, res); return; }
  sendJson(res, 405, { error: 'Method not allowed.' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`zaotu server listening at http://127.0.0.1:${port}`);
});
