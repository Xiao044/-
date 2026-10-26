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

const FACT_VALUE_GROUPS = {
  material: [
    { id: 'pearl', label: '珍珠类', terms: ['淡水珍珠', '海水珍珠', '天然珍珠', '珍珠', '贝母'] },
    { id: 'gold', label: '黄金类', terms: ['18k金', '24k金', '足金', '千足金', '纯金', '黄金', '镀金'] },
    { id: 'silver', label: '白银类', terms: ['925银', '纯银', '足银', '银饰', '银质'] },
    { id: 'platinum', label: '铂金类', terms: ['pt950', '铂金'] },
    { id: 'steel', label: '不锈钢', terms: ['不锈钢', '钢制'] },
    { id: 'alloy', label: '合金', terms: ['锌合金', '合金'] },
    { id: 'jade', label: '玉石类', terms: ['和田玉', '翡翠', '玉石'] },
    { id: 'crystal', label: '水晶', terms: ['水晶'] },
    { id: 'glass', label: '玻璃', terms: ['玻璃'] },
    { id: 'resin', label: '树脂', terms: ['树脂'] },
    { id: 'acrylic', label: '亚克力', terms: ['亚克力'] },
    { id: 'leather', label: '皮革', terms: ['真皮', '皮革', 'pu皮'] },
    { id: 'cotton', label: '棉', terms: ['纯棉', '棉质'] },
    { id: 'ceramic', label: '陶瓷', terms: ['陶瓷', '瓷质'] },
    { id: 'plastic', label: '塑料', terms: ['塑料', 'pvc'] },
    { id: 'diamond', label: '钻石', terms: ['天然钻石', '钻石'] },
    { id: 'wood', label: '木质', terms: ['实木', '木质'] }
  ],
  color: [
    { id: 'white', label: '白色', terms: ['乳白色', '珍珠白', '象牙白', '米白色', '纯白色', '白色'] },
    { id: 'black', label: '黑色', terms: ['纯黑色', '乌黑色', '黑色'] },
    { id: 'gold', label: '金色', terms: ['玫瑰金色', '香槟金色', '金色'] },
    { id: 'silver', label: '银色', terms: ['银白色', '银色'] },
    { id: 'red', label: '红色', terms: ['酒红色', '正红色', '红色'] },
    { id: 'pink', label: '粉色', terms: ['粉红色', '樱花粉', '粉色'] },
    { id: 'blue', label: '蓝色', terms: ['深蓝色', '浅蓝色', '蓝色'] },
    { id: 'green', label: '绿色', terms: ['墨绿色', '浅绿色', '绿色'] },
    { id: 'yellow', label: '黄色', terms: ['明黄色', '浅黄色', '黄色'] },
    { id: 'purple', label: '紫色', terms: ['浅紫色', '紫色'] },
    { id: 'brown', label: '棕色', terms: ['咖啡色', '棕色'] },
    { id: 'transparent', label: '透明', terms: ['透明色', '透明'] }
  ],
  productType: [
    { id: 'necklace', label: '项链', terms: ['锁骨链', '项链'] },
    { id: 'earring', label: '耳饰', terms: ['耳钉', '耳坠', '耳环', '耳饰'] },
    { id: 'bracelet', label: '手链/手镯', terms: ['手镯', '手链'] },
    { id: 'ring', label: '戒指', terms: ['戒指'] },
    { id: 'pendant', label: '吊坠', terms: ['吊坠'] },
    { id: 'brooch', label: '胸针', terms: ['胸针'] },
    { id: 'hairpin', label: '发饰', terms: ['发夹', '发簪', '发饰'] },
    { id: 'bag', label: '包', terms: ['手提包', '背包', '包袋', '包'] },
    { id: 'shoes', label: '鞋', terms: ['运动鞋', '皮鞋', '鞋子', '鞋'] }
  ],
  brand: [
    { id: 'chowtaifook', label: '周大福', terms: ['周大福'] },
    { id: 'chowsangsang', label: '周生生', terms: ['周生生'] },
    { id: 'laofengxiang', label: '老凤祥', terms: ['老凤祥'] },
    { id: 'pandora', label: '潘多拉', terms: ['pandora', '潘多拉'] },
    { id: 'swarovski', label: '施华洛世奇', terms: ['施华洛世奇', 'swarovski'] },
    { id: 'tiffany', label: '蒂芙尼', terms: ['蒂芙尼', 'tiffany'] },
    { id: 'cartier', label: '卡地亚', terms: ['卡地亚', 'cartier'] },
    { id: 'chanel', label: '香奈儿', terms: ['香奈儿', 'chanel'] },
    { id: 'gucci', label: 'Gucci', terms: ['gucci'] },
    { id: 'xiaomi', label: '小米', terms: ['小米', 'xiaomi'] },
    { id: 'huawei', label: '华为', terms: ['华为', 'huawei'] },
    { id: 'apple', label: 'Apple', terms: ['apple'] }
  ]
};

const FACT_DOMAIN_BY_KEY = new Map([
  ['material', 'material'], ['材质', 'material'], ['材料', 'material'],
  ['color', 'color'], ['颜色', 'color'], ['色彩', 'color'],
  ['category', 'productType'], ['品类', 'productType'], ['品类名称', 'productType'], ['structure', 'productType'], ['结构', 'productType'], ['商品结构', 'productType'],
  ['brand', 'brand'], ['品牌', 'brand']
]);
const FACT_LABELS = { material: '材质', color: '颜色', size: '尺寸', productType: '品类/结构', brand: '品牌' };
const normalizeFactText = (value) => String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[\s，,。；;:：、“”"'‘’（）()《》【】\[\]{}]/g, '');
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const knownFactGroup = (value, groups) => {
  const normalized = normalizeFactText(value);
  return groups.find((group) => group.terms.some((term) => normalized.includes(normalizeFactText(term)))) || null;
};

const measurementMatches = (value) => {
  const normalized = String(value ?? '').normalize('NFKC').toLocaleLowerCase();
  const matches = [];
  const pattern = /(\d+(?:\.\d+)?)\s*(毫米|mm|厘米|cm|米|m|英寸|inch|in|寸|号)/giu;
  for (const match of normalized.matchAll(pattern)) {
    const unit = match[2].toLocaleLowerCase();
    const factor = ({ 毫米: 1, mm: 1, 厘米: 10, cm: 10, 米: 1000, m: 1000, 英寸: 25.4, inch: 25.4, in: 25.4, 寸: 33.333333, 号: 1 })[unit];
    const before = normalized.slice(Math.max(0, match.index - 12), match.index);
    const after = normalized.slice(match.index + match[0].length, match.index + match[0].length + 8);
    const dimension = /(?:直径|珠径)/u.test(before) ? 'diameter'
      : /(?:链长|长度)/u.test(before) ? 'length'
        : /(?:宽度|宽)/u.test(before) ? 'width'
          : /(?:高度|高)/u.test(before) ? 'height'
            : /(?:厚度|厚)/u.test(before) ? 'thickness'
              : /(?:圈口|戒围)/u.test(before) || unit === '号' ? 'ring'
                : /(?:直径|珠径)/u.test(after) ? 'diameter'
                  : /(?:链长|长度)/u.test(after) ? 'length'
                    : /(?:宽度|宽)/u.test(after) ? 'width'
                      : /(?:高度|高)/u.test(after) ? 'height'
                        : /(?:厚度|厚)/u.test(after) ? 'thickness' : 'generic';
    matches.push({
      value: Number(match[1]) * factor,
      unit,
      dimension,
      source: match[0],
      context: normalized.slice(Math.max(0, match.index - 14), Math.min(normalized.length, match.index + match[0].length + 10))
    });
  }
  return matches;
};

const isProductFactClaim = (text, domain, term) => {
  const normalized = normalizeFactText(text);
  const escaped = escapeRegExp(normalizeFactText(term));
  if (domain === 'material') {
    return new RegExp(`(?:材质|材料|主体材质)(?:为|是)?${escaped}`).test(normalized)
      || new RegExp(`(?:由|采用|选用|使用)(?:了)?${escaped}(?:材质|作为材质|制成|制作|打造|镶嵌)`).test(normalized)
      || new RegExp(`${escaped}(?:(?:材质|制成|制作|打造|镶嵌|配以)(?:的)?)?(?:项链|吊坠|耳环|耳饰|手链|手镯|戒指|胸针|发饰|饰品|商品|产品|主体)`).test(normalized)
      || new RegExp(`(?:项链|吊坠|耳环|耳饰|手链|手镯|戒指|饰品|商品|产品)(?:采用|为|是)(?:由|以)?${escaped}(?:制成|制作|打造|材质)?(?!色)`).test(normalized);
  }
  if (domain === 'color') {
    return new RegExp(`(?:颜色|色泽|整体|主体|商品|产品|项链|吊坠|耳环|耳饰|手链|手镯|戒指|珍珠|饰品|表面)(?:的)?(?:颜色|色泽)?(?:为|是|呈|呈现|保持)?${escaped}(?:色)?`).test(normalized)
      || new RegExp(`${escaped}(?:色)?(?:的)?(?:商品|产品|主体|项链|吊坠|耳环|耳饰|手链|手镯|戒指|珍珠|饰品|表面)`).test(normalized);
  }
  if (domain === 'productType') {
    return new RegExp(`(?:品类|类别|商品|产品|主体|结构)(?:为|是|呈现|保持)?${escaped}`).test(normalized)
      || new RegExp(`${escaped}(?:类|款)?(?:商品|产品|主体|结构|首饰|饰品|置于|位于|呈现|展示|摆放|佩戴|悬挂|陈列|居中|在|于)`).test(normalized);
  }
  if (domain === 'brand') {
    return new RegExp(`(?:品牌|商标|出品方)(?:为|是|：|:)?${escaped}`).test(normalized)
      || new RegExp(`${escaped}(?:品牌|项链|吊坠|耳环|耳饰|手链|手镯|戒指|商品|产品|饰品)`).test(normalized);
  }
  return false;
};

const detectUserFactConflict = ({ key, value, text }) => {
  const normalizedKey = String(key ?? '').trim().toLocaleLowerCase();
  const domain = FACT_DOMAIN_BY_KEY.get(normalizedKey) || (/^(?:size|尺寸|大小|规格)$/u.test(normalizedKey) ? 'size' : null);
  if (!domain || !String(value ?? '').trim()) return null;
  if (domain === 'size') {
    const userMeasurements = measurementMatches(value);
    const modelMeasurements = measurementMatches(text);
    for (const userMeasurement of userMeasurements) {
      for (const modelMeasurement of modelMeasurements) {
        const sameDimension = userMeasurement.dimension === modelMeasurement.dimension
          || (userMeasurement.dimension === 'generic' && modelMeasurement.dimension === 'generic');
        const productContext = /(?:尺寸|规格|直径|珠径|长度|链长|宽度|高度|厚度|圈口|戒围|大小|商品|产品|项链|珍珠|吊坠)/u.test(modelMeasurement.context);
        if (sameDimension && productContext && Math.abs(userMeasurement.value - modelMeasurement.value) > 0.01) {
          return { domain, detectedValue: modelMeasurement.source };
        }
      }
    }
    return null;
  }
  const groups = FACT_VALUE_GROUPS[domain] || [];
  const userGroup = knownFactGroup(value, groups);
  if (!userGroup) return null;
  for (const group of groups) {
    if (group.id === userGroup.id) continue;
    for (const term of group.terms) {
      if (isProductFactClaim(text, domain, term)) return { domain, detectedValue: term, detectedGroup: group.label };
    }
  }
  return null;
};

const modelOutputFactText = (result) => {
  const values = [result?.descriptionA];
  const structured = isPlainObject(result?.descriptionAStructured) ? result.descriptionAStructured : {};
  for (const value of Object.values(structured)) {
    if (Array.isArray(value)) values.push(...value);
    else values.push(value);
  }
  return values.filter((value) => ['string', 'number'].includes(typeof value)).join('\n');
};

const factIsMentioned = (key, value, text) => {
  const normalizedText = normalizeFactText(text);
  const normalizedValue = normalizeFactText(value);
  if (/^(?:size|尺寸|大小|规格)$/u.test(String(key ?? '').trim().toLocaleLowerCase())) {
    const wanted = measurementMatches(value);
    return wanted.some((measure) => measurementMatches(text).some((found) => {
      const sameDimension = measure.dimension === 'generic' || found.dimension === measure.dimension;
      return sameDimension && Math.abs(found.value - measure.value) <= 0.01;
    }));
  }
  const domain = FACT_DOMAIN_BY_KEY.get(String(key ?? '').trim().toLocaleLowerCase());
  if (domain && FACT_VALUE_GROUPS[domain]) {
    const group = knownFactGroup(value, FACT_VALUE_GROUPS[domain]);
    if (group) return group.terms.some((term) => isProductFactClaim(text, domain, term));
    return isProductFactClaim(text, domain, value);
  }
  if (domain) return isProductFactClaim(text, domain, value);
  if (normalizedValue && normalizedText.includes(normalizedValue)) return true;
  return false;
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
  const rawText = String(result?.descriptionA || '');
  const structuredText = modelOutputFactText({ descriptionAStructured: result?.descriptionAStructured });
  const modelText = [rawText, structuredText].filter(Boolean).join('\n');
  for (const { key, value } of userFactEntries(input.product)) {
    if (!value) continue;
    const conflictLocations = [];
    let conflict = detectUserFactConflict({ key, value, text: rawText });
    if (conflict) conflictLocations.push('descriptionA');
    const structuredConflict = detectUserFactConflict({ key, value, text: structuredText });
    if (structuredConflict) {
      conflict ||= structuredConflict;
      conflictLocations.push('descriptionAStructured');
    }
    if (conflict) {
      warnings.push({
        code: ERROR_CODES.FACT_CONFLICT,
        field: key,
        reason: 'contradiction',
        userValue: value,
        detectedValue: conflict.detectedValue,
        locations: conflictLocations,
        message: `模型输出将${FACT_LABELS[conflict.domain] || key}写成“${conflict.detectedValue}”，与用户填写的“${value}”矛盾；请修订 A 版后再确认。`
      });
      continue;
    }
    const sensitiveFact = /^(?:material|材质|材料|color|颜色|色彩|brand|品牌|structure|结构|商品结构|category|品类|品类名称|size|尺寸|大小|规格)$/iu.test(key);
    if (sensitiveFact && !factIsMentioned(key, value, modelText)) {
      warnings.push({
        code: ERROR_CODES.FACT_CONFLICT,
        field: key,
        reason: 'not_mentioned',
        userValue: value,
        locations: ['descriptionA', 'descriptionAStructured'],
        message: `模型输出未能核实用户填写的${FACT_LABELS[FACT_DOMAIN_BY_KEY.get(String(key).trim().toLocaleLowerCase())] || key}“${value}”，请检查 A 版是否保留该事实。`
      });
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
  collectWarnings,
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
