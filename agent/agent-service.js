const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const TASKS = new Set(['follow_up', 'description_a']);
const SOURCES = new Set(['user', 'agent']);
const FIELD_NAMES = ['productFactsSummary', 'scene', 'composition', 'lightingMood', 'mustKeep', 'forbidden'];
const ARRAY_FIELDS = new Set(['mustKeep', 'forbidden']);
const MAX_TEXT_LENGTH = 12000;
const MAX_NOTE_LENGTH = 2000;
const MAX_CONVERSATION_ITEMS = 12;

const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNSUPPORTED_TASK: 'UNSUPPORTED_TASK',
  AGENT_NOT_CONFIGURED: 'AGENT_NOT_CONFIGURED',
  MODEL_TIMEOUT: 'MODEL_TIMEOUT',
  MODEL_EMPTY_RESPONSE: 'MODEL_EMPTY_RESPONSE',
  MODEL_INVALID_JSON: 'MODEL_INVALID_JSON',
  MODEL_SCHEMA_INVALID: 'MODEL_SCHEMA_INVALID',
  MODEL_REQUEST_FAILED: 'MODEL_REQUEST_FAILED',
  FACT_CONFLICT: 'FACT_CONFLICT',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  RUN_NOT_FOUND: 'RUN_NOT_FOUND',
  PERSIST_FAILED: 'PERSIST_FAILED'
});

const isPlainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const nowIso = () => new Date().toISOString();
const createRunId = () => `agent-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
const limitString = (value, max) => String(value ?? '').trim().slice(0, max);
const uniqueStrings = (values, max = 40) => [...new Set((Array.isArray(values) ? values : [values])
  .flatMap((value) => String(value ?? '').split(/[,\n，；;]/))
  .map((value) => value.trim())
  .filter(Boolean)
  .slice(0, max))];

const userFactEntries = (product = {}) => {
  const facts = isPlainObject(product.facts) ? product.facts : {};
  const entries = [];
  const knownKeys = ['category', 'material', 'color', 'size', 'brand', 'effect', 'structure', 'function', '功效', '材质', '颜色', '尺寸', '品牌', '结构'];
  for (const key of knownKeys) {
    const value = product[key] ?? facts[key];
    if (value !== undefined && value !== null && String(value).trim()) entries.push({ key, value: limitString(value, 500) });
  }
  for (const [key, value] of Object.entries(facts)) {
    if (knownKeys.includes(key) || value === undefined || value === null || !String(value).trim()) continue;
    entries.push({ key: limitString(key, 80), value: limitString(value, 500) });
  }
  return entries;
};

const sanitizeProduct = (product) => {
  const source = isPlainObject(product) ? product : {};
  const facts = isPlainObject(source.facts)
    ? Object.fromEntries(Object.entries(source.facts).slice(0, 40)
      .filter(([key, value]) => !/(image|图片|url|平台|platform|prompt|提示词)/i.test(key) && ['string', 'number', 'boolean'].includes(typeof value))
      .map(([key, value]) => [limitString(key, 80), limitString(value, 500)])
      .filter(([key, value]) => key && value))
    : {};
  return {
    name: limitString(source.name, 300),
    subtitle: limitString(source.subtitle, 500),
    description: limitString(source.description, MAX_TEXT_LENGTH),
    facts
  };
};

const validateAgentInput = (input) => {
  if (!isPlainObject(input)) return { ok: false, code: ERROR_CODES.INVALID_REQUEST, message: 'Agent request must be an object.' };
  if (input.task !== undefined && typeof input.task !== 'string') return { ok: false, code: ERROR_CODES.INVALID_REQUEST, message: 'Agent task must be a string.' };
  const task = String(input.task || '').trim();
  if (!TASKS.has(task)) return { ok: false, code: ERROR_CODES.UNSUPPORTED_TASK, message: 'Unsupported Agent task.' };
  const productSource = isPlainObject(input.product) ? input.product : {};
  const directionSource = isPlainObject(input.creativeDirection) ? input.creativeDirection : input;
  const textFields = [
    [productSource.name, 300], [productSource.subtitle, 500], [productSource.description, MAX_TEXT_LENGTH],
    [directionSource.scene, 300], [directionSource.note, MAX_NOTE_LENGTH]
  ];
  if (textFields.some(([value, limit]) => value !== undefined && value !== null && (typeof value !== 'string' || value.length > limit))) {
    return { ok: false, code: ERROR_CODES.INVALID_REQUEST, message: 'Agent text input is invalid or too long.' };
  }
  const product = sanitizeProduct(input.product);
  const creativeDirection = directionSource;
  const scene = limitString(creativeDirection.scene, 300);
  const note = limitString(creativeDirection.note, MAX_NOTE_LENGTH);
  const conversation = Array.isArray(input.conversation)
    ? input.conversation.slice(-MAX_CONVERSATION_ITEMS).map((item) => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: limitString(item?.content, 1200)
    })).filter((item) => item.content)
    : [];
  const projectId = limitString(input.projectId, 80);
  const previousRunId = limitString(input.previousRunId, 160);
  return {
    ok: true,
    value: {
      task,
      projectId,
      previousRunId,
      product,
      creativeDirection: { scene, note },
      conversation
    }
  };
};

const buildMessages = (input) => {
  const product = sanitizeProduct(input.product);
  const scene = limitString(input.creativeDirection?.scene ?? input.scene, 300);
  const note = limitString(input.creativeDirection?.note ?? input.note, MAX_NOTE_LENGTH);
  const task = TASKS.has(input.task) ? input.task : 'follow_up';
  const system = [
    '你是商品生图工作台中的中文创作 Agent，只处理文字，不识别图片。',
    '你的任务是把用户提供的商品事实和画面方向整理成 A 版简单结构化提示词。',
    '必须返回 JSON，不要 Markdown，不要额外解释。',
    'JSON 字段固定为：reply、followUpQuestion、descriptionA、descriptionAStructured。',
    'descriptionAStructured 只允许包含 subject、productFactsSummary、scene、composition、lightingMood、mustKeep、forbidden 六类字段，其中 mustKeep 和 forbidden 必须是字符串数组。',
    '只有 description_a 任务可以输出 descriptionA 和 descriptionAStructured；follow_up 任务必须将它们设为空字符串和空对象。',
    '不得生成提示词 B，不得选择平台参数，不得识别图片。',
    '不得虚构商品材质、颜色、尺寸、品牌、功效或商品结构，不得改变用户明确要求保留的事实。',
    '用户明确输入的事实优先级最高；不确定的信息留空或提出一个追问。'
  ].join('\n');
  const user = JSON.stringify({
    task,
    product,
    creativeDirection: { scene, note },
    conversation: Array.isArray(input.conversation) ? input.conversation : [],
    requestedOutput: task === 'description_a'
      ? '整理成 A 版创作简报，包含商品事实摘要、主体、场景、构图、光线与氛围、保留约束和禁止项。'
      : '判断信息是否足够；不足时提出一个最有价值的追问。'
  });
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
};

const parseModelJson = (content) => {
  if (!String(content || '').trim()) {
    const error = new Error('DeepSeek returned an empty response');
    error.code = ERROR_CODES.MODEL_EMPTY_RESPONSE;
    throw error;
  }
  const cleaned = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(cleaned);
    if (!isPlainObject(parsed)) throw new Error('Model response must be an object');
    return parsed;
  } catch (error) {
    const wrapped = new Error('DeepSeek returned invalid JSON');
    wrapped.code = ERROR_CODES.MODEL_INVALID_JSON;
    wrapped.cause = error;
    throw wrapped;
  }
};

const fieldEnvelope = (value, source = 'agent', version = 1, updatedAt = nowIso()) => ({
  value,
  source: SOURCES.has(source) ? source : 'agent',
  updatedAt,
  version: Math.max(1, Number(version) || 1)
});

const fieldValue = (value) => (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, 'value') ? value.value : value);

const userFactsSummary = (product) => {
  const parts = [product.name, product.subtitle, product.description].filter(Boolean);
  const facts = userFactEntries(product).map(({ key, value }) => `${key}：${value}`);
  return [...parts, ...facts].join('；').slice(0, 2000);
};

const normalizeField = (name, value, source = 'agent', version = 1, updatedAt = nowIso()) => {
  if (ARRAY_FIELDS.has(name)) return fieldEnvelope(uniqueStrings(fieldValue(value)), source, version, updatedAt);
  return fieldEnvelope(limitString(fieldValue(value), 3000), source, version, updatedAt);
};

const normalizeAgentDraft = (result, input, { version = 1, updatedAt = nowIso() } = {}) => {
  const source = isPlainObject(result?.descriptionAStructured) ? result.descriptionAStructured : {};
  const product = input.product || {};
  const userSummary = userFactsSummary(product);
  const modelSummary = fieldValue(source.productFactsSummary ?? source.subject);
  const modelMustKeep = uniqueStrings(fieldValue(source.mustKeep));
  const explicitFacts = userFactEntries(product).map(({ key, value }) => `${key}：${value}`);
  const mergedMustKeep = uniqueStrings([...modelMustKeep, ...explicitFacts]);
  const fields = {
    productFactsSummary: normalizeField('productFactsSummary', userSummary || modelSummary, userSummary ? 'user' : 'agent', version, updatedAt),
    scene: normalizeField('scene', source.scene, 'agent', version, updatedAt),
    composition: normalizeField('composition', source.composition, 'agent', version, updatedAt),
    lightingMood: normalizeField('lightingMood', source.lightingMood, 'agent', version, updatedAt),
    mustKeep: normalizeField('mustKeep', mergedMustKeep, explicitFacts.length ? 'user' : 'agent', version, updatedAt),
    forbidden: normalizeField('forbidden', source.forbidden, 'agent', version, updatedAt)
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    rawText: limitString(result?.descriptionA, MAX_TEXT_LENGTH),
    fields,
    userFacts: Object.fromEntries(userFactEntries(product).map(({ key, value }) => [key, value]))
  };
};

const legacyStructured = (draft) => ({
  subject: draft.fields.productFactsSummary.value,
  productFactsSummary: draft.fields.productFactsSummary.value,
  scene: draft.fields.scene.value,
  composition: draft.fields.composition.value,
  lightingMood: draft.fields.lightingMood.value,
  mustKeep: draft.fields.mustKeep.value,
  forbidden: draft.fields.forbidden.value
});

const collectWarnings = (result, input, draft) => {
  const warnings = [];
  const raw = JSON.stringify(result || '');
  for (const { key, value } of userFactEntries(input.product)) {
    if (value && raw.includes(value) === false && (key === 'material' || key === 'color' || key === 'brand' || key === 'structure' || key === '材质' || key === '颜色' || key === '品牌' || key === '结构')) {
      warnings.push({ code: ERROR_CODES.FACT_CONFLICT, field: key, message: `模型输出未完整保留用户事实：${key}` });
    }
  }
  if (!draft.rawText && input.task === 'description_a') warnings.push({ code: ERROR_CODES.MODEL_SCHEMA_INVALID, field: 'descriptionA', message: '模型未返回 A 版原始文本。' });
  return warnings.slice(0, 20);
};

const normalizeAgentOutput = (result, input, { runId = createRunId(), version = 1, updatedAt = nowIso() } = {}) => {
  const draft = input.task === 'description_a' ? normalizeAgentDraft(result, input, { version, updatedAt }) : null;
  const warnings = draft ? collectWarnings(result, input, draft) : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    task: input.task,
    reply: limitString(result?.reply, 2000),
    followUpQuestion: limitString(result?.followUpQuestion, 1000),
    descriptionA: draft?.rawText || '',
    descriptionAStructured: draft ? legacyStructured(draft) : {},
    draft,
    warnings,
    model: ''
  };
};

const applyUserDraftEdits = (draft, patch, { version, updatedAt = nowIso() } = {}) => {
  const base = isPlainObject(draft) ? JSON.parse(JSON.stringify(draft)) : { schemaVersion: SCHEMA_VERSION, rawText: '', fields: {}, userFacts: {} };
  base.schemaVersion = SCHEMA_VERSION;
  base.fields = isPlainObject(base.fields) ? base.fields : {};
  const nextVersion = Math.max(Number(version) || 1, ...FIELD_NAMES.map((name) => Number(base.fields[name]?.version) || 1));
  if (typeof patch.rawText === 'string') base.rawText = patch.rawText.slice(0, MAX_TEXT_LENGTH);
  const incomingFields = isPlainObject(patch.fields) ? patch.fields : patch;
  for (const name of FIELD_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(incomingFields || {}, name)) continue;
    const value = fieldValue(incomingFields[name]);
    base.fields[name] = normalizeField(name, value, 'user', nextVersion + 1, updatedAt);
  }
  return base;
};

const normalizeAgentInputForStorage = (input) => ({
  task: input.task,
  projectId: input.projectId || '',
  previousRunId: input.previousRunId || '',
  product: sanitizeProduct(input.product),
  creativeDirection: {
    scene: limitString(input.creativeDirection?.scene, 300),
    note: limitString(input.creativeDirection?.note, MAX_NOTE_LENGTH)
  },
  conversation: Array.isArray(input.conversation) ? input.conversation.slice(-MAX_CONVERSATION_ITEMS) : []
});

const createAgentRunRecord = ({ runId = createRunId(), input, output = null, status = 'completed', errorCode = '', errorMessage = '', version = 1, createdAt = nowIso(), completedAt = null } = {}) => ({
  runId,
  schemaVersion: SCHEMA_VERSION,
  task: input.task,
  status,
  version,
  input: normalizeAgentInputForStorage(input),
  output,
  accepted: false,
  errorCode: limitString(errorCode, 120),
  errorMessage: limitString(errorMessage, 1000),
  createdAt,
  completedAt: completedAt || (status === 'completed' ? createdAt : null),
  updatedAt: createdAt
});

module.exports = {
  ARRAY_FIELDS,
  ERROR_CODES,
  FIELD_NAMES,
  SCHEMA_VERSION,
  TASKS,
  applyUserDraftEdits,
  buildMessages,
  createAgentRunRecord,
  createRunId,
  fieldEnvelope,
  isPlainObject,
  legacyStructured,
  normalizeAgentInputForStorage,
  normalizeAgentOutput,
  normalizeAgentDraft,
  nowIso,
  parseModelJson,
  sanitizeProduct,
  userFactEntries,
  validateAgentInput
};
