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
