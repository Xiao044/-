const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyUserDraftEdits,
  buildMessages,
  createAgentRunRecord,
  normalizeAgentOutput,
  parseModelJson,
  validateAgentInput
} = require('../agent/agent-service');

const validInput = {
  task: 'description_a',
  projectId: 'demo-pearl-necklace',
  product: {
    name: '春日珍珠项链',
    subtitle: '温润珠光',
    description: '项链结构和吊坠形状需要保持。',
    facts: { material: '淡水珍珠', color: '乳白色', imageUrl: 'secret-image-url' }
  },
  creativeDirection: { scene: '自然窗边', note: '柔和自然光' },
  imageUrl: 'secret-root-image-url',
  platform: 'doubao',
  promptB: 'secret-b-prompt'
};

test('validates supported requests and drops non-Agent input fields', () => {
  const result = validateAgentInput(validInput);
  assert.equal(result.ok, true);
  assert.equal(result.value.task, 'description_a');
  assert.equal(result.value.product.facts.material, '淡水珍珠');
  assert.equal('imageUrl' in result.value, false);
  assert.equal('platform' in result.value, false);
  assert.equal('imageUrl' in result.value.product, false);
  assert.equal('imageUrl' in result.value.product.facts, false);
});

test('rejects unsupported tasks and oversized text instead of truncating silently', () => {
  assert.equal(validateAgentInput({ ...validInput, task: 'generate_b' }).code, 'UNSUPPORTED_TASK');
  assert.equal(validateAgentInput({ ...validInput, task: 12 }).code, 'INVALID_REQUEST');
  assert.equal(validateAgentInput({ ...validInput, creativeDirection: { note: 'x'.repeat(2001) } }).code, 'INVALID_REQUEST');
});

test('DeepSeek messages contain only supported text fields', () => {
  const normalized = validateAgentInput(validInput).value;
  const serialized = JSON.stringify(buildMessages(normalized));
  assert.match(serialized, /淡水珍珠/);
  assert.doesNotMatch(serialized, /secret-image-url|secret-root-image-url|secret-b-prompt|doubao/);
});

test('normalizes model output into versioned field envelopes and protects explicit facts', () => {
  const input = validateAgentInput(validInput).value;
  const output = normalizeAgentOutput({
    reply: '已整理。',
    followUpQuestion: '',
    descriptionA: '珍珠项链置于自然窗边，采用柔和光线。',
    descriptionAStructured: {
      productFactsSummary: '黄金项链',
      scene: '自然窗边',
      composition: '项链居中',
      lightingMood: '柔和明亮',
      mustKeep: ['黄金材质'],
      forbidden: ['添加水印'],
      unexpected: 'drop me'
    }
  }, input, { runId: 'agent-test', version: 3, updatedAt: '2026-10-26T00:00:00.000Z' });

  assert.equal(output.schemaVersion, 1);
  assert.equal(output.runId, 'agent-test');
  assert.equal(output.draft.fields.productFactsSummary.source, 'user');
  assert.match(output.draft.fields.productFactsSummary.value, /淡水珍珠/);
  assert.equal(output.draft.fields.mustKeep.source, 'user');
  assert.ok(output.draft.fields.mustKeep.value.includes('material：淡水珍珠'));
  assert.ok(output.draft.fields.mustKeep.value.includes('color：乳白色'));
  assert.equal(output.draft.fields.scene.version, 3);
  assert.equal(output.descriptionAStructured.scene, '自然窗边');
  assert.equal('unexpected' in output.descriptionAStructured, false);
  assert.equal(output.warnings.some((warning) => warning.code === 'FACT_CONFLICT'), true);
});

test('reports direct material and color contradictions in product claims', () => {
  const input = validateAgentInput(validInput).value;
  const materialConflict = normalizeAgentOutput({
    descriptionA: '黄金项链置于自然窗边，商品主体清晰呈现。',
    descriptionAStructured: { scene: '自然窗边' }
  }, input);
  const materialWarning = materialConflict.warnings.find((warning) => warning.field === 'material');
  assert.equal(materialWarning.reason, 'contradiction');
  assert.equal(materialWarning.detectedValue, '黄金');
  assert.match(materialWarning.message, /淡水珍珠/);
  assert.match(materialConflict.draft.fields.productFactsSummary.value, /淡水珍珠/);

  const backgroundContrast = normalizeAgentOutput({
    descriptionA: '乳白色珍珠项链置于黑色背景，柔光表现珠面。',
    descriptionAStructured: {}
  }, input);
  assert.equal(backgroundContrast.warnings.some((warning) => warning.field === 'color' && warning.reason === 'contradiction'), false);

  const colorConflict = normalizeAgentOutput({
    descriptionA: '黑色项链置于乳白色背景，商品主体清晰呈现。',
    descriptionAStructured: {}
  }, input);
  assert.equal(colorConflict.warnings.some((warning) => warning.field === 'color' && warning.reason === 'contradiction'), true);
});

test('flags conflicting product dimensions but ignores a different measurement dimension', () => {
  const input = validateAgentInput({
    ...validInput,
    product: { ...validInput.product, facts: { size: '珍珠直径8mm' } }
  }).value;
  const conflict = normalizeAgentOutput({
    descriptionA: '珍珠直径10mm，项链在自然窗边呈现。',
    descriptionAStructured: {}
  }, input);
  assert.equal(conflict.warnings.some((warning) => warning.field === 'size' && warning.reason === 'contradiction'), true);

  const distinctDimensions = normalizeAgentOutput({
    descriptionA: '项链链长50cm，珍珠直径8mm，置于自然窗边。',
    descriptionAStructured: {}
  }, input);
  assert.equal(distinctDimensions.warnings.some((warning) => warning.field === 'size' && warning.reason === 'contradiction'), false);
});

test('does not treat a matching number in another dimension as a preserved size fact', () => {
  const input = validateAgentInput({
    ...validInput,
    product: { ...validInput.product, facts: { size: '珍珠直径8mm' } }
  }).value;
  const output = normalizeAgentOutput({
    descriptionA: '项链链长8mm，置于自然窗边。',
    descriptionAStructured: {}
  }, input);
  const sizeWarning = output.warnings.find((warning) => warning.field === 'size');

  assert.equal(sizeWarning.reason, 'not_mentioned');
});

test('does not treat a background color as a verified product color', () => {
  const input = validateAgentInput({
    ...validInput,
    product: { ...validInput.product, facts: { color: '黑色' } }
  }).value;
  const backgroundOnly = normalizeAgentOutput({
    descriptionA: '黑色背景衬托商品主体，画面置于自然窗边。',
    descriptionAStructured: {}
  }, input);
  const colorWarning = backgroundOnly.warnings.find((warning) => warning.field === 'color');

  assert.equal(colorWarning.reason, 'not_mentioned');

  const productColor = normalizeAgentOutput({
    descriptionA: '黑色项链作为画面主体，置于自然窗边。',
    descriptionAStructured: {}
  }, input);
  assert.equal(productColor.warnings.some((warning) => warning.field === 'color'), false);
});

test('recognizes explicitly stated facts outside the known vocabulary', () => {
  const input = validateAgentInput({
    ...validInput,
    product: { ...validInput.product, facts: { material: '黄铜' } }
  }).value;
  const output = normalizeAgentOutput({
    descriptionA: '黄铜耳环作为画面主体，置于自然窗边。',
    descriptionAStructured: {}
  }, input);

  assert.equal(output.warnings.some((warning) => warning.field === 'material'), false);
});

test('does not infer product material from a similarly named background color', () => {
  const input = validateAgentInput({
    ...validInput,
    product: { ...validInput.product, facts: { material: '淡水珍珠' } }
  }).value;
  for (const descriptionA of [
    '黄金色背景衬托项链，商品主体清晰呈现。',
    '采用黄金色背景衬托项链，商品主体清晰呈现。',
    '由黄金色背景衬托项链，商品主体清晰呈现。'
  ]) {
    const output = normalizeAgentOutput({ descriptionA, descriptionAStructured: {} }, input);
    const materialWarning = output.warnings.find((warning) => warning.field === 'material');
    assert.equal(materialWarning.reason, 'not_mentioned', descriptionA);
  }
});

test('recognizes a product category stated in the product description', () => {
  const input = validateAgentInput({
    ...validInput,
    product: { ...validInput.product, facts: { category: '项链' } }
  }).value;
  const output = normalizeAgentOutput({
    descriptionA: '珍珠项链在自然窗边呈现。',
    descriptionAStructured: {}
  }, input);

  assert.equal(output.warnings.some((warning) => warning.field === 'category'), false);
});

test('parses JSON objects and rejects invalid or non-object model output', () => {
  assert.deepEqual(parseModelJson('{"reply":"ok"}'), { reply: 'ok' });
  assert.throws(() => parseModelJson('not json'), { code: 'MODEL_INVALID_JSON' });
  assert.throws(() => parseModelJson(''), { code: 'MODEL_EMPTY_RESPONSE' });
  assert.throws(() => parseModelJson('[]'), { code: 'MODEL_INVALID_JSON' });
});

test('user edits receive user source metadata and Agent run records keep an input snapshot', () => {
  const input = validateAgentInput(validInput).value;
  const output = normalizeAgentOutput({ descriptionA: '原稿', descriptionAStructured: {} }, input);
  const edited = applyUserDraftEdits(output.draft, {
    rawText: '用户修订稿',
    fields: { scene: '纯色静物台', mustKeep: ['项链结构'] }
  }, { version: 2, updatedAt: '2026-10-26T00:00:00.000Z' });
  const record = createAgentRunRecord({ runId: output.runId, input, output, version: 1 });

  assert.equal(edited.rawText, '用户修订稿');
  assert.equal(edited.fields.scene.source, 'user');
  assert.equal(edited.fields.mustKeep.source, 'user');
  assert.equal(record.input.product.facts.material, '淡水珍珠');
  assert.equal('imageUrl' in record.input.product, false);
  assert.equal(record.status, 'completed');
});
