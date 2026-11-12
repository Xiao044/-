const crypto = require('node:crypto');
const PROTOCOL = 'text-v1';
const INSTRUCTION_VERSION = 'prompt-b-v1';
const MAX_TEXT_PROMPT_LENGTH = 100000;
const validTextPrompt = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_PROMPT_LENGTH;
const INSTRUCTION = '将以下已确认的创意简报 A 转换为可直接用于生图的正向提示词 B。只输出提示词纯文本，不调用工具，不生成图片，不添加解释。保留商品事实、场景、构图、光线和约束，不编造商品属性。';
const PROVIDERS = ['doubao', 'chatgpt'];
const active = (job) => ['queued', 'preparing', 'submitted', 'running'].includes(job.status);
const id = () => crypto.randomUUID();
const canonical = (value) => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(canonical(value[key]))])) : Array.isArray(value) ? value.map((item) => JSON.parse(canonical(item))) : value ?? null);
const FIELD_NAMES = ['productFactsSummary', 'scene', 'composition', 'lightingMood', 'mustKeep', 'forbidden'];
const ARRAY_FIELDS = new Set(['mustKeep', 'forbidden']);
const fieldValue = (key, field) => {
  const value = field && typeof field === 'object' && Object.hasOwn(field, 'value') ? field.value : field;
  return ARRAY_FIELDS.has(key)
    ? (Array.isArray(value) ? value : String(value ?? '').split(/\r?\n|[，,；;]/)).map((item) => String(item).trim()).filter(Boolean)
    : String(value ?? '').trim();
};
const normalizeA = (draft = {}, structured = {}) => ({
  rawText: String(draft.rawText ?? '').trim(),
  fields: Object.fromEntries(FIELD_NAMES.map((key) => [key, fieldValue(key, draft.fields?.[key] ?? structured[key] ?? (key === 'productFactsSummary' ? structured.subject : undefined))]))
});
const sourceOf = (project) => {
  if (!project || typeof project.descriptionA !== 'string' || !project.descriptionA.trim()) return null;
  const draft = project.descriptionADraft || {}, structured = project.descriptionAStructured || {};
  const saved = normalizeA({ rawText: project.descriptionARawEdit ?? project.descriptionA, fields: draft.fields }, structured);
  for (const key of FIELD_NAMES) if (project.descriptionAFieldEdits && Object.hasOwn(project.descriptionAFieldEdits, key)) saved.fields[key] = fieldValue(key, project.descriptionAFieldEdits[key]);
  let accepted;
  if (project.acceptedASnapshot && typeof project.acceptedASnapshot === 'object' && !Array.isArray(project.acceptedASnapshot)) accepted = normalizeA(project.acceptedASnapshot);
  // Pre-confirmation-schema local/manual projects had only progress as confirmation evidence.
  // Do not grant that exemption to explicit null snapshots or agent-backed drafts.
  else if (!Object.hasOwn(project, 'acceptedASnapshot') && !project.currentAgentRunId && Number(project.progress) >= 3 && project.descriptionARawEdit == null && !Object.keys(project.descriptionAFieldEdits || {}).length) accepted = saved;
  else return null;
  if (canonical(saved) !== canonical(accepted) || project.descriptionA.trim() !== accepted.rawText) return null;
  if (typeof draft.rawText === 'string' && draft.rawText.trim() !== accepted.rawText) return null;
  // Compare populated semantic representations independently so a stale draft cannot mask
  // edits saved in the legacy structured representation (or the reverse).
  for (const key of FIELD_NAMES) {
    const structuredValue = structured[key] ?? (key === 'productFactsSummary' ? structured.subject : undefined);
    if (structuredValue !== undefined && canonical(fieldValue(key, structuredValue)) !== canonical(accepted.fields[key])) return null;
  }
  const snapshot = { content: accepted, descriptionA: project.descriptionA, runId: project.currentAgentRunId || '', version: Number(project.currentAgentRunVersion) || 0 };
  return { ...snapshot, fingerprint: crypto.createHash('sha256').update(canonical(snapshot)).digest('hex') };
};
const providerPage = (value, platform) => {
  if (typeof value !== 'string' || !value || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && (platform === 'doubao' ? /(^|\.)doubao\.com$/.test(url.hostname) : platform === 'chatgpt' && /^(chatgpt\.com|chat\.openai\.com)$/.test(url.hostname));
  } catch { return false; }
};
const container = (project) => project.textWorkflow ||= { schemaVersion: 1, epoch: id(), sourceFingerprint: sourceOf(project)?.fingerprint || null, selection: { platform: 'doubao', model: 'current-page' }, jobs: [] };
const invalidate = (project, reason = 'source_changed', replace = false) => {
  if (!project.textWorkflow) return;
  const workflow = container(project), source = sourceOf(project);
  const changed = workflow.sourceFingerprint !== (source?.fingerprint || null);
  workflow.sourceFingerprint = source?.fingerprint || null;
  for (const job of workflow.jobs) if (active(job) && (replace || changed || job.source.fingerprint !== source?.fingerprint)) {
    job.status = 'cancelled'; job.errorCode = reason; job.updatedAt = new Date().toISOString();
  }
  if (replace || changed) workflow.epoch = id();
};
const validateImported = (value, projectId) => {
  if (value === undefined) return;
  const object = (item) => item && typeof item === 'object' && !Array.isArray(item);
  const string = (item, max = 200) => typeof item === 'string' && item.length > 0 && item.length <= max;
  if (!object(value) || value.schemaVersion !== 1 || !string(value.epoch) || !Array.isArray(value.jobs) || value.jobs.length > 500 || !PROVIDERS.includes(value.selection?.platform) || value.selection.model !== 'current-page') throw new Error('Invalid imported text workflow.');
  const seen = new Set();
  for (const job of value.jobs) {
    if (!object(job) || job.kind !== 'prompt_b' || job.protocolVersion !== PROTOCOL || job.projectId !== projectId || !string(job.jobId) || seen.has(job.jobId) || !string(job.attemptId) || !string(job.routeSession) || !string(job.epoch) || !string(job.idempotencyKey) || !PROVIDERS.includes(job.platform) || job.model !== 'current-page' || !string(job.instructionVersion) || !validTextPrompt(job.prompt) || !object(job.source) || !object(job.source.content) || typeof job.source.descriptionA !== 'string' || typeof job.source.runId !== 'string' || !Number.isFinite(job.source.version) || !/^[a-f0-9]{64}$/.test(job.source.fingerprint) || !['queued', 'preparing', 'submitted', 'running', 'completed', 'failed', 'cancelled', 'timeout'].includes(job.status) || !Number.isFinite(Date.parse(job.expiresAt)) || !Array.isArray(job.events) || job.events.length > 100 || job.events.some((event) => !object(event) || !string(event.state) || !Number.isFinite(Date.parse(event.at))) || (job.rawReply !== undefined && (typeof job.rawReply !== 'string' || job.rawReply.length > 12000))) throw new Error('Invalid imported text job.');
    if (job.status === 'completed' && (!job.rawReply?.trim() || !object(job.candidate) || !string(job.candidate.candidateId) || job.candidate.text !== job.rawReply || job.candidate.sourceFingerprint !== job.source.fingerprint || !providerPage(job.pageUrl, job.platform) || !string(job.userAnchor, 300) || job.completionEvidence !== 'new-assistant-action-bar-stable')) throw new Error('Invalid imported text candidate.');
    seen.add(job.jobId);
  }
};
const sanitizeImported = (project, projectId) => {
  validateImported(project.textWorkflow, projectId);
  if (project.textWorkflow) invalidate(project, 'import_replaced', true);
};
const imageSourceValid = (project, provenance) => {
  const workflow = project?.textWorkflow;
  const job = workflow?.jobs.find((item) => item.jobId === provenance?.jobId && item.attemptId === provenance?.attemptId);
  return Boolean(job && provenance.kind === 'prompt_b' && provenance.protocolVersion === PROTOCOL && provenance.projectId === job.projectId && provenance.routeSession === job.routeSession && job.status === 'completed' && workflow.epoch === job.epoch && workflow.selection.platform === job.platform && job.source.fingerprint === sourceOf(project)?.fingerprint && provenance.sourceFingerprint === job.source.fingerprint);
};
const createHandler = ({ read, write, readBody, send, queue, timeoutMs = 180000 }) => (req, res) => queue(async () => {
  const match = new URL(req.url, 'http://local').pathname.match(/^\/api\/projects\/([^/]+)\/text-jobs(?:\/([^/]+)(?:\/(events|cancel|retry|dispatch))?)?$/);
  if (!match) return send(res, 404, { error: 'Text route not found.' });
  let projectId;
  try { projectId = decodeURIComponent(match[1]); } catch { return send(res, 400, { error: 'Invalid project id.' }); }
  const store = read(), project = Object.hasOwn(store, projectId) && store[projectId];
  if (!project) return send(res, 404, { error: 'Project not found.' });
  const workflow = container(project);
  invalidate(project);
  for (const job of workflow.jobs) if (active(job) && Date.now() >= Date.parse(job.expiresAt)) { job.status = 'timeout'; job.errorCode = 'TEXT_TIMEOUT'; }
  // Read also persists timeout/source invalidation, under the same mutation queue.
  write(store);
  const job = workflow.jobs.find((item) => item.jobId === match[2]);
  if (req.method === 'GET') return send(res, match[2] && !job ? 404 : 200, match[2] ? { job } : { workflow, providers: PROVIDERS, protocolVersion: PROTOCOL });
  const body = await readBody(req, res); if (!body) return;
  const fail = (error, status = 409) => send(res, status, { error });
  if (!match[2] && req.method === 'PATCH') {
    if (!PROVIDERS.includes(body.platform) || body.model !== 'current-page') return fail('Unsupported text provider/model.', 400);
    if (workflow.selection.platform !== body.platform) invalidate(project, 'platform_changed', true);
    workflow.selection = { platform: body.platform, model: body.model }; write(store);
    return send(res, 200, { workflow });
  }
  const create = (parent) => {
    const source = sourceOf(project);
    if (!source) return fail('Confirm A before generating B.');
    if (!parent && (!body.idempotencyKey || typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length > 200)) return fail('idempotencyKey required.', 400);
    const key = parent ? `${parent.jobId}:${parent.attemptId}:retry` : body.idempotencyKey;
    const old = workflow.jobs.find((item) => item.idempotencyKey === key);
    if (old) return send(res, 200, { job: old, workflow });
    if (workflow.jobs.some(active)) return fail('Another text job is active.');
    if (workflow.jobs.length >= 500) return fail('Text history limit reached. Export this project before continuing.');
    // Validate the exact persisted/sent string, not raw A: instruction and JSON escaping
    // contribute to the same size invariant enforced when importing text history.
    const prompt = `${INSTRUCTION}\n\n${canonical(source.content)}`;
    if (!validTextPrompt(prompt)) return fail(`Text prompt exceeds ${MAX_TEXT_PROMPT_LENGTH} characters after instruction and JSON encoding; shorten confirmed A.`, 400);
    const now = new Date().toISOString();
    const next = { kind: 'prompt_b', protocolVersion: PROTOCOL, projectId, jobId: id(), attemptId: id(), routeSession: id(), epoch: workflow.epoch, idempotencyKey: key, parentJobId: parent?.jobId || workflow.jobs.at(-1)?.jobId || null, platform: workflow.selection.platform, model: workflow.selection.model, source, instructionVersion: INSTRUCTION_VERSION, prompt, status: 'queued', createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + timeoutMs).toISOString(), events: [] };
    workflow.jobs.push(next); write(store); return send(res, 201, { job: next, workflow });
  };
  if (!match[2] && req.method === 'POST') return create(null);
  if (!job) return fail('Text job not found.', 404);
  if (req.method !== 'POST') return fail('Method not allowed.', 405);
  if (body.kind !== 'prompt_b' || body.projectId !== projectId || body.jobId !== job.jobId || body.attemptId !== job.attemptId || body.routeSession !== job.routeSession || body.sourceFingerprint !== job.source.fingerprint || body.protocolVersion !== PROTOCOL) return fail('Text route identity mismatch.');
  if (match[3] === 'retry') {
    if (!['failed', 'cancelled', 'timeout'].includes(job.status)) return fail('Only terminal failures may retry.');
    return create(job);
  }
  if (!active(job)) return fail('Text job is terminal.');
  if (job.epoch !== workflow.epoch || job.platform !== workflow.selection.platform || job.source.fingerprint !== sourceOf(project)?.fingerprint) return fail('Stale text source.');
  if (match[3] === 'cancel') { job.status = 'cancelled'; job.errorCode = 'USER_CANCELLED'; }
  else if (match[3] === 'dispatch') {
    if (job.status !== 'queued') return fail('Already dispatched; never submit again automatically.');
    job.status = 'preparing';
  } else if (match[3] === 'events') {
    const transitions = { preparing: ['submitted', 'failed'], submitted: ['running', 'completed', 'failed'], running: ['running', 'completed', 'failed'] };
    if (!transitions[job.status]?.includes(body.state)) return fail('Invalid text state transition.');
    if (body.state === 'completed') {
      if (typeof body.rawReply !== 'string' || !body.rawReply.trim() || body.rawReply.length > 12000 || !providerPage(body.pageUrl, job.platform) || body.completionEvidence !== 'new-assistant-action-bar-stable' || typeof body.userAnchor !== 'string' || !body.userAnchor.trim() || body.userAnchor.length > 300) return fail('Explicit completed assistant reply required.', 400);
      job.rawReply = body.rawReply; job.pageUrl = String(body.pageUrl).slice(0, 2000); job.userAnchor = body.userAnchor.slice(0, 300); job.completionEvidence = body.completionEvidence;
      job.candidate = { candidateId: id(), text: job.rawReply, parentJobId: job.parentJobId, sourceFingerprint: job.source.fingerprint };
    }
    job.status = body.state;
    if (body.state === 'failed') job.errorCode = String(body.errorCode || 'ADAPTER_ERROR').slice(0, 100);
  } else return fail('Unknown action.', 404);
  job.updatedAt = new Date().toISOString();
  job.events.push({ state: job.status, at: job.updatedAt });
  if (job.events.length > 100) job.events.splice(0, job.events.length - 100);
  write(store); send(res, 200, { job, workflow });
}).catch(() => { if (!res.headersSent) send(res, 500, { error: 'Text job could not be persisted.' }); });
module.exports = { createHandler, sourceOf, container, invalidate, sanitizeImported, imageSourceValid, PROTOCOL };
