const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const extensionRoot = path.join(root, 'doubao-extension');

const source = (name) => fs.readFileSync(path.join(extensionRoot, name), 'utf8');

class FixtureEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

class FixtureElement {
  constructor(tagName, attrs = {}, options = {}) {
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map(Object.entries(attrs));
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.textContent = options.textContent || '';
    this.style = options.style || {};
    this.rect = { width: 720, height: 100, top: 100, left: 100, ...(options.rect || {}) };
    this.disabled = Boolean(options.disabled);
    this.readOnly = Boolean(options.readOnly);
    this.value = options.value || '';
    this.files = options.files || [];
    this.type = this.getAttribute('type') || '';
    this.checked = Boolean(options.checked);
    this.complete = options.complete !== false;
    this.naturalWidth = options.naturalWidth || 0;
    this.naturalHeight = options.naturalHeight || 0;
    this.src = options.src || this.getAttribute('src') || '';
    this.currentSrc = options.currentSrc || this.getAttribute('src') || this.src;
    this.alt = options.alt || this.getAttribute('alt') || '';
    this.focused = false;
    this.clicked = false;
    this.clickCount = 0;
    this.onClick = options.onClick || null;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? String(this.attributes.get(name)) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'type') this.type = String(value);
    if (name === 'src') this.src = this.currentSrc = String(value);
    if (name === 'alt') this.alt = String(value);
  }

  addEventListener(type, listener) {
    const current = this.listeners.get(type) || [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
    return true;
  }

  focus() {
    this.focused = true;
  }

  click() {
    this.clicked = true;
    this.clickCount += 1;
    this.dispatchEvent(new FixtureEvent('click', { bubbles: true }));
    this.onClick?.(this);
  }

  getBoundingClientRect() {
    const rect = { ...this.rect };
    rect.right = rect.right ?? rect.left + rect.width;
    rect.bottom = rect.bottom ?? rect.top + rect.height;
    return rect;
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  contains(element) {
    return collect(this).includes(element);
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    return collect(this).filter((element) => element !== this && matchesSelector(element, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FixtureInput extends FixtureElement {
  constructor(attrs, options) {
    super('input', attrs, options);
  }
  get value() {
    return this._value || '';
  }
  set value(value) {
    this._value = String(value);
  }
}

class FixtureTextArea extends FixtureElement {
  constructor(attrs, options) {
    super('textarea', attrs, options);
  }
  get value() {
    return this._value || '';
  }
  set value(value) {
    this._value = String(value);
  }
}

class FixtureDocument {
  constructor() {
    this.body = new FixtureElement('body', {}, { rect: { width: 1200, height: 900, top: 0, left: 0 } });
    this.documentElement = this.body;
  }

  createElement(tagName) {
    if (String(tagName).toLowerCase() === 'input') return new FixtureInput();
    if (String(tagName).toLowerCase() === 'textarea') return new FixtureTextArea();
    return new FixtureElement(tagName);
  }

  querySelectorAll(selector) {
    return collect(this.body).filter((element) => matchesSelector(element, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  get images() {
    return this.querySelectorAll('img');
  }

  createRange() {
    return { selectNodeContents() {} };
  }

  execCommand() {
    return false;
  }
}

const collect = (root) => {
  const result = [];
  const visit = (element) => {
    result.push(element);
    for (const child of element.children) visit(child);
  };
  visit(root);
  return result;
};

const splitSelectorList = (selector) => {
  const result = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (const char of String(selector)) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === '[' || char === '(') {
      depth += 1;
      current += char;
    } else if (char === ']' || char === ')') {
      depth -= 1;
      current += char;
    } else if (char === ',' && depth === 0) {
      if (current.trim()) result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
};

const splitDescendant = (selector) => {
  const result = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (const char of String(selector).trim()) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === '[' || char === '(') {
      depth += 1;
      current += char;
    } else if (char === ']' || char === ')') {
      depth -= 1;
      current += char;
    } else if (/\s/.test(char) && depth === 0) {
      if (current.trim()) result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
};

const unquote = (value) => value.replace(/^['"]|['"]$/g, '');

const matchAttribute = (element, expression) => {
  const match = expression.match(/^([\w-]+)(?:\s*(=|\^=|\$=|\*=|~=)\s*(["']?[^"']*?["']?)(?:\s+i)?\s*)?$/i);
  if (!match) return false;
  const [, name, operator, rawExpected] = match;
  const actual = element.getAttribute(name);
  if (actual === null) return false;
  if (!operator) return true;
  const expected = unquote(String(rawExpected).trim());
  if (operator === '=') return actual === expected;
  if (operator === '^=') return actual.startsWith(expected);
  if (operator === '$=') return actual.endsWith(expected);
  if (operator === '*=') return actual.toLowerCase().includes(expected.toLowerCase());
  if (operator === '~=') return actual.split(/\s+/).includes(expected);
  return false;
};

const matchesSimple = (element, selector) => {
  let rest = selector.trim();
  if (!rest) return false;

  const notExpressions = [];
  rest = rest.replace(/:not\(([^()]*)\)/gi, (_, expression) => {
    notExpressions.push(expression);
    return '';
  });
  if (notExpressions.some((expression) => matchesSimple(element, expression))) return false;

  const attributes = [];
  rest = rest.replace(/\[([^\]]+)\]/g, (_, expression) => {
    attributes.push(expression.trim());
    return '';
  });
  if (attributes.some((expression) => !matchAttribute(element, expression))) return false;

  const ids = [];
  rest = rest.replace(/#([\w-]+)/g, (_, value) => {
    ids.push(value);
    return '';
  });
  if (ids.some((value) => element.getAttribute('id') !== value)) return false;

  const classes = [];
  rest = rest.replace(/\.([\w-]+)/g, (_, value) => {
    classes.push(value);
    return '';
  });
  const classNames = (element.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  if (classes.some((value) => !classNames.includes(value))) return false;

  const tag = rest.trim();
  return !tag || tag === '*' || tag.toLowerCase() === element.tagName.toLowerCase();
};

const matchesSelector = (element, selector) => splitSelectorList(selector).some((branch) => {
  const parts = splitDescendant(branch);
  if (!parts.length || !matchesSimple(element, parts[parts.length - 1])) return false;
  let ancestor = element.parentElement;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    while (ancestor && !matchesSimple(ancestor, parts[index])) ancestor = ancestor.parentElement;
    if (!ancestor) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
});

const add = (parent, element) => parent.appendChild(element);

const makeImage = (attrs, options = {}) => new FixtureElement('img', attrs, {
  rect: { width: 640, height: 640, top: 260, left: 120 },
  naturalWidth: 1024,
  naturalHeight: 1024,
  ...options
});

const makeFixture = ({ pathname = '/create', platform, generatedOnClick = true } = {}) => {
  const document = new FixtureDocument();
  const main = add(document.body, new FixtureElement('main', {}, { rect: { width: 1000, height: 800, top: 0, left: 0 } }));
  const composer = add(main, new FixtureElement('section', {}, { rect: { width: 900, height: 300, top: 50, left: 50 } }));
  const prompt = platform === 'doubao'
    ? new FixtureTextArea({ placeholder: '请输入描述' }, { rect: { width: 720, height: 160, top: 100, left: 100 } })
    : new FixtureTextArea({ placeholder: platform === 'gemini' ? 'Enter a prompt' : 'Describe your image' }, { rect: { width: 720, height: 160, top: 100, left: 100 } });
  add(composer, prompt);

  const buttonAttrs = platform === 'chatgpt'
    ? { 'aria-label': 'Send' }
    : platform === 'gemini'
      ? { 'data-testid': 'generate-button' }
      : { 'data-testid': platform === 'doubao' ? 'generate-submit' : 'generate-button' };
  const button = new FixtureElement('button', buttonAttrs, {
    textContent: platform === 'chatgpt' ? 'Send' : platform === 'doubao' ? '生成' : 'Generate',
    rect: { width: 72, height: 40, top: 290, left: 760 }
  });
  add(composer, button);

  const existingAvatar = makeImage({ src: 'https://cdn.example/avatar.png', alt: 'avatar' }, { rect: { width: 300, height: 300, top: 400, left: 100 } });
  add(main, existingAvatar);
  let generated;
  button.onClick = () => {
    if (generatedOnClick) {
      generated = makeImage({ src: `https://cdn.example/${platform}-generated.png`, alt: 'generated result' }, { rect: { width: 640, height: 640, top: 420, left: 200 } });
      add(main, generated);
    }
  };

  const chrome = {
    runtime: {
      listeners: [],
      sent: [],
      onMessage: {
        addListener(listener) {
          chrome.runtime.listeners.push(listener);
        }
      },
      sendMessage(message, callback) {
        chrome.runtime.sent.push(message);
        callback?.();
      },
      lastError: null
    }
  };
  const window = {
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    addEventListener() {},
    postMessage() {},
    innerWidth: 1200
  };
  const fixtureSetInterval = (...args) => {
    const timer = setInterval(...args);
    timer.unref?.();
    return timer;
  };
  const context = {
    console,
    document,
    window,
    chrome,
    location: { pathname, href: `https://example.test${pathname}` },
    getComputedStyle: (element) => ({ visibility: element.style.visibility || 'visible', display: element.style.display || 'block' }),
    Event: FixtureEvent,
    InputEvent: FixtureEvent,
    MouseEvent: FixtureEvent,
    KeyboardEvent: FixtureEvent,
    HTMLInputElement: FixtureInput,
    File: class File {},
    FileReader: class FileReader {},
    DataTransfer: class DataTransfer {},
    fetch: async () => ({ ok: true, blob: async () => ({ type: 'image/png' }) }),
    setTimeout,
    clearTimeout,
    setInterval: fixtureSetInterval,
    clearInterval,
    Date,
    Math,
    Promise
  };
  context.window = window;
  window.document = document;
  window.location = context.location;
  window.chrome = chrome;
  window.getComputedStyle = context.getComputedStyle;
  window.Event = FixtureEvent;
  window.InputEvent = FixtureEvent;
  window.MouseEvent = FixtureEvent;
  window.KeyboardEvent = FixtureEvent;
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  window.setInterval = fixtureSetInterval;
  window.clearInterval = clearInterval;
  vm.createContext(context);
  return { context, document, prompt, button, chrome, generated };
};

const load = (fixture, ...files) => {
  for (const file of files) vm.runInContext(source(file), fixture.context, { filename: file });
};

const dispatchRuntimeMessage = (fixture, message) => new Promise((resolve) => {
  let settled = false;
  let timeout;
  const sendResponse = (response) => {
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      resolve(response);
    }
  };
  for (const listener of fixture.chrome.runtime.listeners) {
    const result = listener(message, {}, sendResponse);
    if (result === false && !settled) {
      settled = true;
      resolve(undefined);
    }
  }
  if (!settled) timeout = setTimeout(() => sendResponse(undefined), 10000);
});

const statusStates = (fixture) => fixture.chrome.runtime.sent.filter((message) => message.type === 'ZAOTU_STATUS').map((message) => message.state);

const adapterCases = [
  { platform: 'chatgpt', script: 'content-chatgpt.js' },
  { platform: 'gemini', script: 'content-gemini.js' },
  { platform: 'lovart', script: 'content-lovart.js' }
];

test('protocol normalizes bridge fields and maps terminal errors', () => {
  const fixture = makeFixture({ platform: 'chatgpt' });
  load(fixture, 'protocol.js');
  const protocol = fixture.context.ZaotuProtocol;
  const normalized = protocol.normalizeEvent({ type: 'PLATFORM_ERROR', platform: 'Gemini', state: 'extension_disconnected' }, { jobId: 'job-1', attemptId: 'attempt-1' });
  assert.equal(normalized.platform, 'gemini');
  assert.equal(normalized.jobId, 'job-1');
  assert.equal(normalized.attemptId, 'attempt-1');
  assert.equal(normalized.errorCode, 'EXTENSION_DISCONNECTED');
  assert.match(normalized.timestamp, /^20\d\d-\d\d-\d\dT/);
  assert.equal(protocol.isProtocolEvent('PLATFORM_RESULT_CANDIDATES'), true);
  assert.equal(protocol.isProtocolEvent('UNRELATED'), false);
});

test('platform-common detects a login page before touching the prompt', async () => {
  const fixture = makeFixture({ platform: 'chatgpt', pathname: '/auth/login' });
  load(fixture, 'platform-common.js');
  const statuses = [];
  const result = await fixture.context.window.ZaotuPlatform.run({
    platform: 'chatgpt',
    job: { jobId: 'login-job', attemptId: 'login-attempt', prompt: 'should stay empty' },
    config: { loginPath: /login|auth/i, submitLabels: /send/i },
    status: (...args) => statuses.push(args)
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'login_required');
  assert.equal(result.errorCode, 'LOGIN_REQUIRED');
  assert.equal(fixture.prompt.value, '');
  assert.equal(statuses.at(-1)[0], 'login_required');
});

test('each shared platform adapter discovers its prompt, chooses submit, and can be cancelled by matching attempt', async (t) => {
  for (const { platform, script } of adapterCases) {
    await t.test(platform, async () => {
      const fixture = makeFixture({ platform });
      load(fixture, 'protocol.js', 'platform-common.js', script);
      fixture.context.ZaotuPlatform = fixture.context.window.ZaotuPlatform;
      const job = { jobId: `${platform}-job`, attemptId: `${platform}-attempt`, prompt: `prompt for ${platform}` };
      const runResult = await dispatchRuntimeMessage(fixture, { type: 'ZAOTU_RUN_PLATFORM_JOB', platform, job });
      assert.equal(runResult.ok, true);
      assert.equal(runResult.state, 'submitted');
      assert.equal(fixture.prompt.value, job.prompt);
      assert.equal(fixture.button.clicked, true);
      assert.deepEqual(statusStates(fixture).slice(0, 3), ['checking_login', 'filling', 'submitted']);

      const mismatched = await dispatchRuntimeMessage(fixture, {
        type: 'ZAOTU_CANCEL_PLATFORM_JOB', platform, jobId: job.jobId, attemptId: 'wrong-attempt'
      });
      assert.equal(mismatched.ok, false);

      const cancelled = await dispatchRuntimeMessage(fixture, {
        type: 'ZAOTU_CANCEL_PLATFORM_JOB', platform, jobId: job.jobId, attemptId: job.attemptId
      });
      assert.equal(cancelled.ok, true);
      assert.equal(cancelled.state, 'cancelled');
      assert.equal(statusStates(fixture).at(-1), 'cancelled');
    });
  }
});

test('shared result filtering ignores previous and decorative images and emits a new generated result', async () => {
  const fixture = makeFixture({ platform: 'gemini' });
  load(fixture, 'protocol.js', 'platform-common.js', 'content-gemini.js');
  fixture.context.ZaotuPlatform = fixture.context.window.ZaotuPlatform;
  const job = { jobId: 'result-job', attemptId: 'result-attempt', prompt: 'a product scene' };
  const result = await dispatchRuntimeMessage(fixture, { type: 'ZAOTU_RUN_PLATFORM_JOB', platform: 'gemini', job });
  assert.equal(result.ok, true);
  try {
    const deadline = Date.now() + 6000;
    let candidateMessages = [];
    while (Date.now() < deadline && !candidateMessages.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      candidateMessages = fixture.chrome.runtime.sent.filter((message) => message.type === 'ZAOTU_RESULT_CANDIDATES');
    }
    assert.equal(candidateMessages.length, 1);
    assert.deepEqual(candidateMessages[0].results.map((item) => item.url), ['https://cdn.example/gemini-generated.png']);
    assert.equal(candidateMessages[0].jobId, job.jobId);
    assert.equal(candidateMessages[0].attemptId, job.attemptId);
    assert.equal(candidateMessages[0].platform, 'gemini');
  } finally {
    await dispatchRuntimeMessage(fixture, { type: 'ZAOTU_CANCEL_PLATFORM_JOB', platform: 'gemini', jobId: job.jobId, attemptId: job.attemptId });
  }
});

test('Doubao adapter discovers prompt and submit button, then requires both ids to cancel', async () => {
  const fixture = makeFixture({ platform: 'doubao' });
  load(fixture, 'protocol.js', 'content-doubao.js');
  const job = { jobId: 'doubao-job', attemptId: 'doubao-attempt', prompt: 'doubao prompt' };
  const runResult = await dispatchRuntimeMessage(fixture, { type: 'ZAOTU_RUN_DOUBAO_JOB', job });
  assert.equal(runResult.ok, true);
  assert.equal(runResult.state, 'submitted');
  assert.equal(fixture.prompt.value, job.prompt);
  assert.equal(fixture.button.clicked, true);
  assert.deepEqual(statusStates(fixture).slice(0, 3), ['checking_login', 'filling', 'submitted']);

  const mismatched = await dispatchRuntimeMessage(fixture, {
    type: 'ZAOTU_CANCEL_PLATFORM_JOB', platform: 'doubao', jobId: job.jobId, attemptId: 'wrong-attempt'
  });
  assert.equal(mismatched.ok, false);
  const cancelled = await dispatchRuntimeMessage(fixture, {
    type: 'ZAOTU_CANCEL_PLATFORM_JOB', platform: 'doubao', jobId: job.jobId, attemptId: job.attemptId
  });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(statusStates(fixture).at(-1), 'cancelled');
});

const addDoubaoPageAction = (fixture, attrs, textContent = '') => {
  const navigation = new FixtureElement('nav', {}, { rect: { width: 240, height: 500, top: 0, left: 0 } });
  const action = add(navigation, new FixtureElement('button', attrs, { textContent, rect: { width: 120, height: 40, top: 20, left: 20 } }));
  fixture.document.body.children.unshift(navigation);
  navigation.parentElement = fixture.document.body;
  return action;
};

const addDoubaoDialog = (fixture, attrs = { role: 'dialog', 'aria-modal': 'true' }, hidden = false) => {
  const dialog = add(fixture.document.body, new FixtureElement('div', attrs, {
    style: { display: hidden ? 'none' : 'block' }, rect: { width: 600, height: 400, top: 50, left: 100 }
  }));
  const name = add(dialog, new FixtureTextArea({ placeholder: '请输入项目描述' }));
  const create = add(dialog, new FixtureElement('button', { type: 'submit' }, { textContent: '创建项目' }));
  const close = add(dialog, new FixtureElement('button', { 'aria-label': '关闭弹窗' }));
  return { dialog, name, create, close };
};

test('Doubao submit lookup ignores page-level project creation and uses the current composer', async () => {
  const fixture = makeFixture({ platform: 'doubao' });
  const create = addDoubaoPageAction(fixture, { 'data-testid': 'create-project-button' }, '新建项目');
  create.onClick = () => addDoubaoDialog(fixture);
  load(fixture, 'protocol.js', 'content-doubao.js');
  const result = await dispatchRuntimeMessage(fixture, {
    type: 'ZAOTU_RUN_DOUBAO_JOB', job: { jobId: 'safe-submit', attemptId: 'safe-submit-1', prompt: 'only send this prompt' }
  });
  assert.equal(create.clicked, false, 'sending must never open the new-project dialog');
  assert.equal(fixture.button.clicked, true, 'the composer send button must be used');
  assert.equal(fixture.button.clickCount, 1, 'the prompt must only be submitted once');
  assert.equal(result.state, 'submitted');
  assert.equal(fixture.prompt.value, 'only send this prompt');
});

test('Doubao never treats new-project labels or test ids as composer submit actions', () => {
  for (const attrs of [
    { 'data-testid': 'create-project-button' },
    { 'data-e2e': 'newProject', 'aria-label': '创建项目' },
    { 'aria-label': '新建对话', title: 'Send' },
    { 'data-testid': 'send-create-project' },
    { 'aria-label': 'New chat' },
    { 'aria-label': 'Create' }
  ]) {
    const fixture = makeFixture({ platform: 'doubao' });
    const composer = fixture.prompt.parentElement;
    composer.children.splice(composer.children.indexOf(fixture.button), 1);
    const create = add(composer, new FixtureElement('button', attrs, {
      rect: { width: 40, height: 40, top: 290, left: 760 }
    }));
    add(create, new FixtureElement('svg'));
    load(fixture, 'protocol.js', 'content-doubao.js');
    assert.equal(vm.runInContext('findSubmitButton()', fixture.context), null, JSON.stringify(attrs));
    assert.equal(create.clicked, false);
  }
});

test('Doubao prefers a form-local submit over unrelated page generation controls', () => {
  const fixture = makeFixture({ platform: 'doubao' });
  const unrelated = addDoubaoPageAction(fixture, { 'aria-label': 'Generate' }, '生成视频');
  fixture.prompt.parentElement.tagName = 'FORM';
  fixture.button.attributes.clear();
  fixture.button.setAttribute('type', 'submit');
  fixture.button.textContent = '';
  load(fixture, 'protocol.js', 'content-doubao.js');
  assert.equal(vm.runInContext('findSubmitButton()', fixture.context), fixture.button);
  assert.equal(unrelated.clicked, false);
});

test('Doubao does not fall back to page-wide or navigation submit buttons', () => {
  const fixture = makeFixture({ platform: 'doubao' });
  fixture.button.disabled = true;
  addDoubaoPageAction(fixture, { 'aria-label': '发送' });
  add(fixture.document.body, new FixtureElement('button', { 'aria-label': 'Generate' }));
  load(fixture, 'protocol.js', 'content-doubao.js');
  assert.equal(vm.runInContext('findSubmitButton()', fixture.context), null);
});

test('Doubao refuses unnamed icons without a stable send identity', () => {
  const fixture = makeFixture({ platform: 'doubao' });
  fixture.button.attributes.clear();
  fixture.button.textContent = '';
  add(fixture.button, new FixtureElement('svg'));
  const attachment = add(fixture.prompt.parentElement, new FixtureElement('button', { 'aria-label': '添加附件' }, {
    rect: { width: 40, height: 40, top: 290, left: 700 }
  }));
  add(attachment, new FixtureElement('svg'));
  load(fixture, 'protocol.js', 'content-doubao.js');
  assert.equal(vm.runInContext('findSubmitButton()', fixture.context), null);
  fixture.button.setAttribute('aria-disabled', 'true');
  assert.equal(vm.runInContext('findSubmitButton()', fixture.context), null);
});

test('Doubao treats nested textbox wrappers as one editor and will not cross a second composer', () => {
  const fixture = makeFixture({ platform: 'doubao' });
  const composer = fixture.prompt.parentElement;
  composer.children.splice(composer.children.indexOf(fixture.prompt), 1);
  const wrapper = add(composer, new FixtureElement('div', { role: 'textbox', 'aria-label': '输入描述' }, {
    rect: { width: 720, height: 160, top: 100, left: 100 }
  }));
  add(wrapper, fixture.prompt);
  load(fixture, 'protocol.js', 'content-doubao.js');
  assert.ok(vm.runInContext('findPrompt()', fixture.context) === fixture.prompt, 'fill the editable field, not its labeled wrapper');
  assert.ok(vm.runInContext('findSubmitButton()', fixture.context) === fixture.button);
  fixture.button.disabled = true;
  const main = composer.parentElement;
  main.tagName = 'DIV';
  main.rect.height = 500;
  const second = add(main, new FixtureElement('section', {}, { rect: { width: 900, height: 300, top: 50, left: 50 } }));
  add(second, new FixtureTextArea({ placeholder: '描述另一个任务' }));
  add(second, new FixtureElement('button', { 'aria-label': 'Send' }, { rect: { width: 72, height: 40, top: 290, left: 760 } }));
  assert.ok(vm.runInContext('findSubmitButton()', fixture.context) === null);
});

test('Doubao refuses ambiguous composer send buttons instead of choosing the first', () => {
  const fixture = makeFixture({ platform: 'doubao' });
  add(fixture.prompt.parentElement, new FixtureElement('button', { 'data-testid': 'generate-submit' }, {
    textContent: '生成', rect: { width: 72, height: 40, top: 290, left: 680 }
  }));
  load(fixture, 'protocol.js', 'content-doubao.js');
  assert.equal(vm.runInContext('findSubmitButton()', fixture.context), null);
});

test('Doubao blocks an open project dialog before filling or clicking any controls', async () => {
  const fixture = makeFixture({ platform: 'doubao' });
  const modal = addDoubaoDialog(fixture);
  load(fixture, 'protocol.js', 'content-doubao.js');
  const result = await dispatchRuntimeMessage(fixture, {
    type: 'ZAOTU_RUN_DOUBAO_JOB', job: { jobId: 'blocked-dialog', attemptId: 'blocked-dialog-1', prompt: 'must not be injected' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'adapter_error');
  assert.equal(fixture.prompt.value, '');
  assert.equal(modal.name.value, '');
  assert.equal(modal.create.clicked, false);
  assert.equal(modal.close.clicked, false, 'the adapter must not dismiss user dialogs automatically');
  assert.equal(fixture.button.clicked, false);
  assert.match(fixture.chrome.runtime.sent.at(-1).message, /弹窗/);
  assert.equal(statusStates(fixture).includes('submitted'), false);
  modal.dialog.style.display = 'none'; // The user, not the adapter, dismisses the dialog.
  const retried = await dispatchRuntimeMessage(fixture, {
    type: 'ZAOTU_RUN_DOUBAO_JOB', job: { jobId: 'blocked-dialog', attemptId: 'blocked-dialog-2', prompt: 'send only after dismissal' }
  });
  assert.equal(retried.state, 'submitted');
  assert.equal(fixture.prompt.value, 'send only after dismissal');
  assert.equal(modal.create.clicked, false);
  assert.equal(modal.close.clicked, false);
});

test('Doubao recognizes alert, native and aria-modal dialogs, but ignores hidden dialogs', () => {
  for (const attrs of [{ role: 'alertdialog' }, { 'aria-modal': 'true' }, { open: '' }]) {
    const fixture = makeFixture({ platform: 'doubao' });
    const modal = addDoubaoDialog(fixture, attrs);
    if (Object.hasOwn(attrs, 'open')) modal.dialog.tagName = 'DIALOG';
    load(fixture, 'protocol.js', 'content-doubao.js');
    assert.equal(vm.runInContext('findSubmitButton()', fixture.context), null, JSON.stringify(attrs));
  }
  const fixture = makeFixture({ platform: 'doubao' });
  addDoubaoDialog(fixture, { role: 'dialog', 'aria-modal': 'true' }, true);
  load(fixture, 'protocol.js', 'content-doubao.js');
  assert.equal(vm.runInContext('findSubmitButton()', fixture.context), fixture.button);
});

test('Doubao stops when a dialog appears while filling and does not report submission', async () => {
  const fixture = makeFixture({ platform: 'doubao' });
  fixture.prompt.addEventListener('input', () => addDoubaoDialog(fixture));
  load(fixture, 'protocol.js', 'content-doubao.js');
  const result = await dispatchRuntimeMessage(fixture, {
    type: 'ZAOTU_RUN_DOUBAO_JOB', job: { jobId: 'dialog-on-input', attemptId: 'dialog-on-input-1', prompt: 'preserve the input' }
  });
  assert.equal(result.ok, false);
  assert.equal(fixture.button.clicked, false);
  assert.equal(statusStates(fixture).includes('submitted'), false);
  assert.match(fixture.chrome.runtime.sent.at(-1).message, /弹窗/);
});

test('Doubao does not upload an image when a dialog opens during image preparation', async () => {
  const fixture = makeFixture({ platform: 'doubao' });
  const input = add(fixture.prompt.parentElement, new FixtureInput({ type: 'file' }));
  fixture.context.DataTransfer = class DataTransfer {
    constructor() {
      this.files = [];
      this.items = { add: (file) => this.files.push(file) };
    }
  };
  fixture.context.fetch = async () => {
    addDoubaoDialog(fixture);
    return { ok: true, blob: async () => ({ type: 'image/png' }) };
  };
  load(fixture, 'protocol.js', 'content-doubao.js');
  const result = await dispatchRuntimeMessage(fixture, {
    type: 'ZAOTU_RUN_DOUBAO_JOB', job: { jobId: 'dialog-on-image', attemptId: 'dialog-on-image-1', prompt: 'preserve the input', imageDataUrl: 'data:image/png;base64,AA==' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'adapter_error');
  assert.equal(input.files.length, 0, 'do not mutate the upload control behind a dialog');
  assert.equal(fixture.button.clicked, false);
  assert.equal(statusStates(fixture).includes('submitted'), false);
});

test('Doubao reports a dialog after clicking as an unconfirmed send instead of submitted', async () => {
  const fixture = makeFixture({ platform: 'doubao' });
  fixture.button.onClick = () => addDoubaoDialog(fixture);
  load(fixture, 'protocol.js', 'content-doubao.js');
  const result = await dispatchRuntimeMessage(fixture, {
    type: 'ZAOTU_RUN_DOUBAO_JOB', job: { jobId: 'dialog-on-submit', attemptId: 'dialog-on-submit-1', prompt: 'check delivery before retry' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'submit_error');
  assert.equal(statusStates(fixture).includes('submitted'), false);
  assert.match(fixture.chrome.runtime.sent.at(-1).message, /弹窗/);
});

// Structural fixture based on the inspected 2026-11-12 Doubao chat input.
const makeObservedDoubaoComposer = () => {
  const fixture = makeFixture({ platform: 'doubao' });
  const composer = fixture.prompt.parentElement;
  composer.setAttribute('data-testid', 'chat_input');
  composer.children.splice(composer.children.indexOf(fixture.prompt), 1);
  let wrapper = composer;
  for (let depth = 0; depth < 9; depth += 1) {
    wrapper = add(wrapper, new FixtureElement('div', depth === 7 ? { 'data-testid': 'chat_input_input' } : {}, {
      rect: { width: 720, height: 24, top: 100, left: 100 }
    }));
  }
  fixture.prompt = add(wrapper, new FixtureElement('div', { contenteditable: 'true', class: 'tiptap ProseMirror' }, {
    rect: { width: 720, height: 24, top: 100, left: 100 }
  }));
  fixture.button.attributes.clear();
  fixture.button.setAttribute('id', 'flow-end-msg-send');
  fixture.button.setAttribute('data-testid', 'chat_input_send_button');
  fixture.button.setAttribute('aria-label', '');
  fixture.button.textContent = '';
  add(fixture.button, new FixtureElement('svg'));
  const skill = add(composer, new FixtureElement('button', { 'data-component-type': 'skill-item', 'data-testid': 'skill_bar_button_3' }, {
    textContent: '图像生成', rect: { width: 72, height: 32, top: 140, left: 650 }
  }));
  const unnamed = add(composer, new FixtureElement('button', { 'aria-haspopup': 'dialog' }, {
    rect: { width: 36, height: 36, top: 140, left: 700 }
  }));
  add(unnamed, new FixtureElement('svg'));
  return { ...fixture, composer, skill, unnamed };
};

test('Doubao observed deeply nested Tiptap composer resolves only its exact send control', async () => {
  const fixture = makeObservedDoubaoComposer();
  load(fixture, 'protocol.js', 'content-doubao.js');
  assert.ok(vm.runInContext('findSubmitButton()', fixture.context) === fixture.button);
  const result = await dispatchRuntimeMessage(fixture, { type: 'ZAOTU_RUN_DOUBAO_JOB', job: { jobId: 'actual-composer', attemptId: 'actual-composer-1', prompt: 'synthetic prompt only' } });
  assert.equal(result.state, 'submitted');
  assert.equal(fixture.button.clickCount, 1);
  assert.equal(fixture.skill.clicked, false);
  assert.equal(fixture.unnamed.clicked, false);
});

test('Doubao known composer never falls back to a skill or unnamed project icon when send is missing or disabled', () => {
  for (const absent of [false, true]) {
    const fixture = makeObservedDoubaoComposer();
    if (absent) fixture.composer.children.splice(fixture.composer.children.indexOf(fixture.button), 1);
    else fixture.button.setAttribute('aria-disabled', 'true');
    load(fixture, 'protocol.js', 'content-doubao.js');
    assert.ok(vm.runInContext('findSubmitButton()', fixture.context) === null);
    assert.equal(fixture.skill.clicked, false);
    assert.equal(fixture.unnamed.clicked, false);
  }
});

test('Doubao known composer refuses duplicate send controls and ignores another composer', () => {
  const fixture = makeObservedDoubaoComposer();
  const other = add(fixture.document.body, new FixtureElement('div', { 'data-testid': 'chat_input' }));
  const duplicate = add(fixture.composer, new FixtureElement('button', { 'data-testid': 'chat_input_send_button' }));
  load(fixture, 'protocol.js', 'content-doubao.js');
  assert.ok(vm.runInContext('findSubmitButton()', fixture.context) === null);
  fixture.composer.children.splice(fixture.composer.children.indexOf(duplicate), 1);
  add(other, duplicate);
  assert.ok(vm.runInContext('findSubmitButton()', fixture.context) === fixture.button);
});

test('Doubao ping reports the adapter build used for background compatibility checks', async () => {
  const fixture = makeFixture({ platform: 'doubao' });
  load(fixture, 'protocol.js', 'content-doubao.js');
  const ping = await dispatchRuntimeMessage(fixture, { type: 'ZAOTU_DOUBAO_PING' });
  assert.equal(ping.adapterVersion, '0.5.1');
});

const backgroundConnectionFixture = (adapterVersion, initiallyMissing = false) => {
  const calls = [];
  let injected = false;
  const context = {
    REQUIRED_DOUBAO_ADAPTER_VERSION: '0.5.1', adapterFiles: { doubao: ['content-doubao.js'] },
    chrome: {
      runtime: { lastError: null },
      tabs: { sendMessage(tabId, message, callback) {
        calls.push(['message', message.type]);
        if (message.type === 'ZAOTU_DOUBAO_PING') callback(initiallyMissing && !injected ? undefined : { ok: true, adapterVersion });
        else callback({ ok: true, state: 'submitted' });
      } },
      scripting: { executeScript: async () => { injected = true; calls.push(['inject']); } }
    },
    textLeaseForTab: async () => null,
    PLATFORM_URLS: { doubao: [] },
    findPlatformTab: async () => ({ id: 7 }),
    prepareImageForPlatform: async (payload) => { calls.push(['image']); return payload; },
    saveRoute: async () => calls.push(['route'])
  };
  vm.createContext(context);
  const code = source('background.js');
  const send = code.slice(code.indexOf('const sendTabMessage ='), code.indexOf('const findPlatformTab ='));
  const connect = code.slice(code.indexOf('const connectPlatformTab ='), code.indexOf('const blobToDataUrl ='));
  const prepare = code.slice(code.indexOf('const preparePlatformJob ='), code.indexOf('const readSelectedImage ='));
  vm.runInContext(`${send}\n${connect}\n${prepare}`, context);
  return { context, calls };
};

test('Doubao background refuses stale or unversioned adapters before image preparation and job dispatch', async () => {
  for (const version of [undefined, '0.4.1', '0.4.2', '0.4.3', '0.5.0']) {
    const fixture = backgroundConnectionFixture(version);
    await assert.rejects(vm.runInContext("preparePlatformJob('doubao', {jobId:'j',attemptId:'a'}, 1)", fixture.context), /版本|刷新|重载/);
    assert.deepEqual(fixture.calls, [['message', 'ZAOTU_DOUBAO_PING']]);
  }
});

test('Doubao background injects a missing adapter once and validates its build before dispatch', async () => {
  const fixture = backgroundConnectionFixture('0.5.1', true);
  const response = await vm.runInContext("preparePlatformJob('doubao', {jobId:'j',attemptId:'a'}, 1)", fixture.context);
  assert.equal(response.ok, true);
  assert.deepEqual(fixture.calls.map(call => call[0]), ['message', 'inject', 'message', 'image', 'route', 'message']);
});

test('workbench extension readiness announces the actual loaded manifest version', () => {
  const fixture = makeFixture({ platform: 'doubao' });
  const messages = [];
  fixture.context.chrome.runtime.getManifest = () => ({ version: '0.5.1' });
  fixture.context.window.postMessage = (message) => messages.push(message);
  load(fixture, 'protocol.js', 'content-workbench.js');
  assert.equal(messages.find(message => message.type === 'DOUBAO_EXTENSION_READY')?.extensionVersion, '0.5.1');
});

test('updated workbench bridge refuses legacy Doubao send messages and accepts the versioned channel', async () => {
  const fixture = makeFixture({ platform: 'doubao' }), messages = [], sent = [];
  let listener;
  fixture.context.window.addEventListener = (type, callback) => { if (type === 'message') listener = callback; };
  fixture.context.window.postMessage = (message) => messages.push(message);
  fixture.context.chrome.runtime.getManifest = () => ({ version: '0.5.1' });
  fixture.context.chrome.runtime.sendMessage = (message, callback) => { sent.push(message); callback({ ok: true, tabId: 7 }); };
  load(fixture, 'protocol.js', 'content-workbench.js');
  const message = { source: 'zaotu-workbench', type: 'PLATFORM_PREPARE', platform: 'doubao', payload: { jobId: 'j', attemptId: 'a' } };
  listener({ source: fixture.context.window, data: message });
  await Promise.resolve();
  assert.equal(sent.length, 0);
  assert.equal(messages.at(-1).errorCode, 'ADAPTER_VERSION_MISMATCH');
  listener({ source: fixture.context.window, data: { ...message, type: 'PLATFORM_PREPARE_V2' } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'ZAOTU_PREPARE_DOUBAO');
  assert.equal(messages.at(-1).type, 'PLATFORM_OPENED');
});

test('workbench blocks stale Doubao bridges on both send and retry dispatch without blocking other platforms', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const start = html.indexOf('      const dispatchPlatformPrepare =');
  assert.ok(start >= 0, 'missing central version-checked dispatch');
  const end = html.indexOf('\n      const ', start + 12);
  const calls = [], status = { textContent: '' }, action = { disabled: true };
  const context = {
    doubaoExtensionVersion: '0.4.2', doubaoBridgeState: 'idle', generationPlatforms: { doubao: { state: 'queued', message: '' } },
    window: { postMessage: (message) => calls.push(['post', message]) },
    renderPlatformStatuses() {}, persistState() {},
    detailContent: { querySelector: (selector) => selector === '#generation-bridge-status' ? status : action },
    syncGenerationStatus: (...args) => calls.push(['status', ...args]), showToast: (text) => calls.push(['toast', text])
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  assert.equal(vm.runInContext("dispatchPlatformPrepare('doubao', {jobId:'j',attemptId:'a'})", context), false);
  assert.equal(calls.filter(call => call[0] === 'post').length, 0);
  assert.equal(context.generationPlatforms.doubao.state, 'adapter_error');
  assert.equal(action.disabled, false);
  assert.match(status.textContent, /0\.5\.1/);
  assert.equal(vm.runInContext("dispatchPlatformPrepare('chatgpt', {jobId:'j',attemptId:'b'})", context), true);
  context.doubaoExtensionVersion = '0.5.1';
  assert.equal(vm.runInContext("dispatchPlatformPrepare('doubao', {jobId:'j',attemptId:'c'})", context), true);
  assert.equal(calls.filter(call => call[0] === 'post').length, 2);
  assert.equal(calls.filter(call => call[0] === 'post').at(-1)[1].type, 'PLATFORM_PREPARE_V2', 'legacy Doubao bridges must not recognize the new send command');
  const generate = html.slice(html.indexOf('      const generateResults ='), html.indexOf('      const copyText ='));
  const retry = html.slice(html.indexOf('      const handleTaskAction ='), html.indexOf('\n      const ', html.indexOf('      const handleTaskAction =') + 12));
  assert.match(generate, /dispatchPlatformPrepare\(platform,/);
  assert.match(retry, /dispatchPlatformPrepare\(platform,/);
});

test('Doubao adapter detects login state before filling', async () => {
  const fixture = makeFixture({ platform: 'doubao', pathname: '/signin' });
  load(fixture, 'protocol.js', 'content-doubao.js');
  const job = { jobId: 'doubao-login', attemptId: 'doubao-login-attempt', prompt: 'must remain empty' };
  const result = await dispatchRuntimeMessage(fixture, { type: 'ZAOTU_RUN_DOUBAO_JOB', job });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'login_required');
  assert.equal(fixture.prompt.value, '');
  assert.equal(statusStates(fixture).at(-1), 'login_required');
});


test('selected result image measures fetched blob dimensions and safely falls back', async () => {
  const body = source('background.js').match(/const readSelectedImage = async \(result\) => \{[\s\S]*?\n\};/);
  assert.ok(body, 'selected image reader must be present');
  const blob = new Blob(['image-bytes'], { type: 'image/png' });
  const loadReader = (decoder) => {
    const context = {
      fetch: async () => ({ ok: true, blob: async () => blob }),
      blobToDataUrl: async () => 'data:image/png;base64,aW1hZ2U=',
      ...(decoder ? { createImageBitmap: decoder } : {})
    };
    vm.runInNewContext(`${body[0]}\nglobalThis.reader = readSelectedImage;`, context);
    return context.reader;
  };
  let closed = false;
  const measured = await loadReader(async (input) => {
    assert.equal(input, blob);
    return { width: 1024, height: 1536, close: () => { closed = true; } };
  })({ url: 'https://source.example.test/generated.png', sourceUrl: 'original-source' });
  assert.equal(measured.dimensions.width, 1024);
  assert.equal(measured.dimensions.height, 1536);
  assert.equal(measured.sourceUrl, 'original-source');
  assert.equal(measured.imageMimeType, 'image/png');
  assert.equal(closed, true);
  const unavailable = await loadReader()({ url: 'https://source.example.test/generated.png' });
  assert.equal(unavailable.dimensions, null);
  assert.match(unavailable.imageDataUrl, /^data:image\/png/);
  const failed = await loadReader(async () => { throw new Error('decode failed'); })({ url: 'https://source.example.test/generated.png' });
  assert.equal(failed.dimensions, null);
  assert.match(failed.imageDataUrl, /^data:image\/png/);
});

test('image preparation refuses a tab leased to text before adapter or image preparation', async () => {
  const fixture = backgroundConnectionFixture('0.5.1');
  fixture.context.textLeaseForTab = async () => ({ jobId: 'active-text' });
  await assert.rejects(vm.runInContext("preparePlatformJob('doubao', {jobId:'j',attemptId:'a'}, 1)", fixture.context), /文本任务/);
  assert.deepEqual(fixture.calls, []);
});

test('ChatGPT background rejects pre-cancellation-token image adapters before any preparation', async () => {
  const fixture = backgroundConnectionFixture('0.5.1');
  fixture.context.PLATFORM_URLS.chatgpt = [];
  fixture.context.chrome.tabs.sendMessage = (tabId, message, callback) => {
    fixture.calls.push(['message', message.type]);
    callback({ ok: true, platform: 'chatgpt', adapterVersion: '0.5.0' });
  };
  await assert.rejects(vm.runInContext("preparePlatformJob('chatgpt', {jobId:'j',attemptId:'a'}, 1)", fixture.context), /版本|刷新|重载/);
  assert.deepEqual(fixture.calls, [['message', 'ZAOTU_PLATFORM_PING']]);
});
