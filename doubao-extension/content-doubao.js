const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DOUBAO_ADAPTER_VERSION = '0.5.1';
const DOUBAO_COMPOSER_SELECTOR = '[data-testid="chat_input"]';
const DOUBAO_SEND_SELECTOR = '[data-testid="chat_input_send_button"], #flow-end-msg-send';
let activeDoubaoJobId = '';
let activeDoubaoAttemptId = '';
let activeMonitorTimer = null;
let activeDoubaoOperation = null;
const DOUBAO_ERROR_CODES = { login_required: 'LOGIN_REQUIRED', upload_error: 'UPLOAD_FAILED', submit_error: 'SUBMIT_FAILED', result_timeout: 'RESULT_TIMEOUT', adapter_error: 'ADAPTER_ERROR', cancelled: 'CANCELLED', failed: 'PLATFORM_FAILED' };
const sendStatus = (state, message, jobId = activeDoubaoJobId, errorCode = DOUBAO_ERROR_CODES[state] || '', operation = activeDoubaoOperation) => {
  if (operation && (operation !== activeDoubaoOperation || (operation.cancelled && state !== 'cancelled'))) return;
  if (operation && ['result_ready','cancelled','failed','adapter_error','submit_error','upload_error','login_required','result_timeout'].includes(state) && window.__zaotuActionLock === operation.key) window.__zaotuActionLock = null;
  const payload = { type: 'ZAOTU_STATUS', platform: 'doubao', jobId, attemptId: operation?.attemptId || activeDoubaoAttemptId, state, message, errorCode };
  chrome.runtime.sendMessage(typeof ZaotuProtocol !== 'undefined' ? ZaotuProtocol.normalizeEvent(payload) : { ...payload, timestamp: new Date().toISOString() });
};

const isDisabled = (element) => Boolean(
  element?.disabled
  || element?.getAttribute?.('aria-disabled') === 'true'
  || element?.getAttribute?.('data-disabled') === 'true'
  || element?.getAttribute?.('data-state') === 'disabled'
  || /(^|\s)(disabled|is-disabled)(\s|$)/i.test(element?.className || '')
);

const isVisible = (element) => {
  const rect = element.getBoundingClientRect();
  return !isDisabled(element) && rect.width > 0 && rect.height > 0
    && getComputedStyle(element).visibility !== 'hidden'
    && getComputedStyle(element).display !== 'none';
};

const DOUBAO_PROMPT_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';
const DOUBAO_DIALOG_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
const findBlockingDialog = () => [...document.querySelectorAll(DOUBAO_DIALOG_SELECTOR)].find(isVisible) || null;
const stopForBlockingDialog = () => {
  sendStatus('adapter_error', '豆包页面有未关闭的弹窗。请先手动关闭弹窗，再回工作台重试；扩展不会新建项目或自动确认、关闭弹窗。');
  return { ok: false, state: 'adapter_error' };
};

const findPrompt = () => {
  const fields = [...document.querySelectorAll(DOUBAO_PROMPT_SELECTOR)]
    .filter((element) => !element.disabled && !element.readOnly && isVisible(element)
      && !element.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], nav, aside, [role="navigation"]'));
  const editableFields = fields.filter((element) => element.matches('textarea, [contenteditable="true"]'));
  const knownEditors = editableFields.filter((element) => element.closest(DOUBAO_COMPOSER_SELECTOR)
    && element.closest('[data-testid="chat_input_input"]'));
  if (knownEditors.length === 1) return knownEditors[0];
  if (knownEditors.length > 1) return null;
  const candidates = editableFields.length ? editableFields : fields;
  return candidates.find((element) => /描述|提示|输入|创作|画面/i.test(`${element.getAttribute('placeholder') || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('data-placeholder') || ''}`))
    || candidates.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]
    || null;
};
const findFileInput = () => document.querySelector('input[type="file"]');
const waitForUploadReady = async (input, timeout = 8000, current = () => true) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (input?.files?.length) return true;
    await wait(150);
    if (!current()) return false;
  }
  return current() && Boolean(input?.files?.length);
};

const loginState = () => {
  if (/\/(login|signin|sign-in|auth)(\/|\?|$)/i.test(location.pathname)) return false;
  const hasLoginAction = [...document.querySelectorAll('a, button')].some((element) => /登录|登陆|注册|sign in|log in/i.test(element.textContent || element.getAttribute('aria-label') || '') && isVisible(element));
  if (hasLoginAction) return false;
  return findPrompt() ? true : null;
};

const setText = (element, value) => {
  element.focus();
  if (element.matches('textarea, input')) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
      || Object.getOwnPropertyDescriptor(element, 'value')?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  let inserted = false;
  try {
    const selection = window.getSelection?.();
    const range = document.createRange?.();
    if (selection && range) {
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    inserted = document.execCommand?.('insertText', false, value) === true;
  } catch {}
  if (!inserted) element.textContent = value;
  element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: value }));
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
};

const toDataUrl = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`结果图片读取失败（${response.status}）。`);
  const blob = await response.blob();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) throw new Error('结果图片格式不受支持。');
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('结果图片读取失败。'));
    reader.readAsDataURL(blob);
  });
};

const findSubmitButton = () => {
  if (findBlockingDialog()) return null;
  const prompt = findPrompt();
  if (!prompt) return null;
  const composer = prompt.closest(DOUBAO_COMPOSER_SELECTOR);
  if (composer) {
    const sends = [...composer.querySelectorAll(DOUBAO_SEND_SELECTOR)]
      .filter((button) => button.closest(DOUBAO_COMPOSER_SELECTOR) === composer && isVisible(button)
        && button.matches('button, [role="button"], input[type="submit"]'));
    // Known Doubao UI: never substitute a skill, project or arbitrary icon.
    return sends.length === 1 ? sends[0] : null;
  }
  const promptRect = prompt.getBoundingClientRect();
  const form = prompt.closest('form');
  const actionLabel = (button) => `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${button.getAttribute('data-testid') || ''} ${button.getAttribute('data-e2e') || ''} ${button.textContent || ''} ${button.matches('input') ? button.value || '' : ''}`;
  const excludedAction = /新建|项目|创建对话|创建聊天|新对话|新聊天|停止|取消|登录|登陆|注册|上传|添加图片|附件|清除|关闭|更多|设置|(?:new|create)[\s_-]*(?:project|chat|conversation)|stop|cancel|sign[\s_-]*in|log[\s_-]*in|upload|attach|close|more|settings/i;
  const submitAction = /发送|生成|创作|提交|(?:^|[^a-z])(?:send|generate|submit)(?:[^a-z]|$)/i;

  // Never search the whole page: "create-project" is not a send action.
  // Only consider the current composer's small ancestors and nearby controls.
  let region = prompt.parentElement;
  for (let depth = 0; region && depth < 7; depth += 1, region = region.parentElement) {
    if (region.matches('body, html, main, nav, aside, [role="main"], [role="navigation"]')) break;
    const regionRect = region.getBoundingClientRect();
    if (regionRect.height > 600 || regionRect.width > window.innerWidth) break;
    const otherPrompt = [...region.querySelectorAll(DOUBAO_PROMPT_SELECTOR)]
      .some((element) => element !== prompt && !element.contains(prompt) && !prompt.contains(element)
        && !element.readOnly && isVisible(element));
    if (otherPrompt) break;
    const scored = [...region.querySelectorAll('button, [role="button"], input[type="submit"]')]
      .filter((button) => isVisible(button) && !excludedAction.test(actionLabel(button))
        && !button.closest('nav, aside, [role="navigation"], dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-component-type="skill-item"]')
        && !['menu', 'dialog', 'listbox'].includes(button.getAttribute('aria-haspopup'))
        && button.closest('form') === form)
      .map((button) => {
        const rect = button.getBoundingClientRect();
        const closeToComposer = rect.top >= promptRect.top - 32 && rect.top <= promptRect.bottom + 180
          && rect.left >= promptRect.left - 32 && rect.right <= promptRect.right + 180;
        if (!closeToComposer) return { button, score: 0 };
        const testId = `${button.getAttribute('data-testid') || ''} ${button.getAttribute('data-e2e') || ''}`;
        if (submitAction.test(testId)) return { button, score: 10 };
        if (submitAction.test(actionLabel(button))) return { button, score: 5 };
        const named = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${button.textContent || ''}`.trim();
        if (!named && form && button.matches('button[type="submit"], input[type="submit"]')) return { button, score: 4 };
        return { button, score: 0 };
      }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
    if (scored.length) return scored.length > 1 && scored[0].score === scored[1].score ? null : scored[0].button;
  }
  return null;
};

const waitForSubmitButton = async (timeout = 6000, current = () => true) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (!current() || findBlockingDialog()) return null;
    const button = findSubmitButton();
    if (button && !button.disabled) return button;
    await wait(250);
    if (!current()) return null;
  }
  return null;
};

const clickSubmit = (button) => {
  button.focus();
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  button.click();
};

const DOUBAO_ASSISTANT_SELECTOR = '[data-testid="receive_message"], [data-message-role="assistant"]';
const DOUBAO_INPUT_IMAGE_SELECTOR = '[data-testid="send_message"], [data-message-role="user"], [data-testid="chat_input"], [data-testid="attachment-image-card"]';
const doubaoImageKey = (url) => {
  const raw = String(url || '');
  const generated = raw.match(/^https:\/\/[^/]+\.byteimg\.com\/[^?#]*\/rc_gen_image\/([^/?#~]+)/i);
  return generated ? `doubao-generated:${generated[1]}` : raw;
};
const doubaoCandidateId = (key) => {
  let first = 2166136261, second = 5381;
  for (let index = 0; index < key.length; index += 1) {
    first = Math.imul(first ^ key.charCodeAt(index), 16777619);
    second = Math.imul(second, 33) ^ key.charCodeAt(index);
  }
  return `doubao-image-${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
};
const captureDoubaoResultContext = (job = {}) => ({
  previousReplies: new Set(document.querySelectorAll(DOUBAO_ASSISTANT_SELECTOR)),
  inputKeys: new Set([job.imageDataUrl, job.imageUrl, job.imageUrlAbsolute, job.referenceImageUrl, job.productImageUrl]
    .filter(Boolean).map(doubaoImageKey))
});
const imageCandidates = (previousUrls = new Set(), context = {}) => {
  const inputKeys = context.inputKeys || new Set();
  // A sent attachment often gets a fresh blob/CDN URL after submit. Role, not URL age,
  // is authoritative; remember those URLs too in case a reply reuses the original.
  for (const image of document.images) {
    if (!image.closest(DOUBAO_INPUT_IMAGE_SELECTOR)) continue;
    for (const url of [image.currentSrc, image.src]) if (url) inputKeys.add(doubaoImageKey(url));
  }
  const excluded = new Set([...previousUrls].map(doubaoImageKey));
  for (const key of inputKeys) excluded.add(key);
  const unique = new Map();
  for (const image of document.images) {
    const reply = image.closest(DOUBAO_ASSISTANT_SELECTOR);
    const grid = image.closest('[data-testid="message_image_content"]');
    if (!reply || !grid || !reply.contains(grid) || context.previousReplies?.has(reply)
      || grid.getAttribute('data-finished') === 'false') continue;
    if (image.closest(`${DOUBAO_INPUT_IMAGE_SELECTOR}, nav, aside, dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], [aria-hidden="true"]`)) continue;
    if (!image.complete || image.naturalWidth < 240 || image.naturalHeight < 240 || !isVisible(image)) continue;
    const url = image.currentSrc || image.src || '';
    const key = doubaoImageKey(url);
    const rect = image.getBoundingClientRect();
    if (!/^(https?:|blob:|data:image\/(?:png|jpe?g|webp);)/i.test(url)
      || rect.width * rect.height < 12000 || excluded.has(key)
      || /avatar|logo|icon|favicon|profile|emoji|sprite|placeholder/i.test(`${url} ${image.alt || ''}`)) continue;
    const candidateId = doubaoCandidateId(key);
    const item = { image, url, key, candidateId, rect, pixels: image.naturalWidth * image.naturalHeight,
      dimensions: { width: image.naturalWidth, height: image.naturalHeight } };
    // CDN shard, thumbnail/full-size transform and signature do not change the asset.
    if (!unique.has(key) || item.pixels > unique.get(key).pixels) unique.set(key, item);
  }
  return [...unique.values()].slice(0, 12);
};

const monitorResults = (previousUrls, jobId, attemptId = activeDoubaoAttemptId, context = {}) => {
  if (activeMonitorTimer) clearInterval(activeMonitorTimer);
  const startedAt = Date.now();
  let lastSignature = '', reading = false, stopped = false;
  const isCurrent = () => !stopped && activeMonitorTimer === timer
    && activeDoubaoJobId === jobId && activeDoubaoAttemptId === attemptId;
  const timer = setInterval(async () => {
    if (!isCurrent()) { clearInterval(timer); return; }
    if (Date.now() - startedAt > 10 * 60 * 1000) {
      stopped = true;
      clearInterval(timer);
      if (activeMonitorTimer === timer) activeMonitorTimer = null;
      sendStatus('result_timeout', '尚未检测到模型新生成的图片（已排除上传原图与预览）。可稍后重试或手动导入。', jobId);
      return;
    }
    if (reading) return;
    const candidates = imageCandidates(previousUrls, context);
    if (!candidates.length) return;
    const signature = candidates.map(({ key, url }) => `${key}|${url}`).join('\n');
    if (signature === lastSignature) return;
    reading = true;
    try {
      const results = await Promise.all(candidates.map(async ({ url, candidateId, dimensions }) => {
        try {
          return { id: candidateId, candidateId, url: url.startsWith('blob:') ? await toDataUrl(url) : url,
            sourceUrl: url, platform: 'doubao', origin: 'assistant-generated', dimensions };
        } catch { return null; }
      }));
      // Conversion awaits can outlive cancel, a new job or a newer attempt.
      if (!isCurrent()) return;
      const available = results.filter(Boolean);
      if (!available.length) return;
      // Mark only the successfully read subset, so a failed candidate is retried.
      lastSignature = candidates.filter((_, index) => results[index]).map(({ key, url }) => `${key}|${url}`).join('\n');
      chrome.runtime.sendMessage({ type: 'ZAOTU_RESULT_CANDIDATES', platform: 'doubao', jobId, attemptId, results: available });
      sendStatus('result_ready', `${available.length} 张生成结果已同步到工作台（已过滤上传原图和重复尺寸）。`, jobId);
    } finally { reading = false; }
  }, 2000);
  activeMonitorTimer = timer;
};

const runJob = async (job) => {
  if (activeMonitorTimer) {
    clearInterval(activeMonitorTimer);
    activeMonitorTimer = null;
  }
  if (activeDoubaoOperation) activeDoubaoOperation.cancelled = true;
  const operation = { cancelled: false, key: {}, jobId: job.jobId || '', attemptId: job.attemptId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` };
  activeDoubaoOperation = operation; window.__zaotuActionLock = operation.key;
  const current = () => !operation.cancelled && activeDoubaoOperation === operation && window.__zaotuActionLock === operation.key;
  const cancelled = () => ({ ok: false, state: 'cancelled' });
  const emit = (state, message) => sendStatus(state, message, operation.jobId, DOUBAO_ERROR_CODES[state] || '', operation);
  activeDoubaoJobId = operation.jobId;
  activeDoubaoAttemptId = operation.attemptId;
  emit('checking_login', '正在检查豆包登录状态…');
  await wait(600);
  if (!current()) return cancelled();
  const loggedIn = loginState();
  if (loggedIn === false) {
    emit('login_required', '豆包尚未登录。请在当前页面完成登录，再回工作台重试。');
    return { ok: false, state: 'login_required' };
  }

  if (findBlockingDialog()) return stopForBlockingDialog();
  emit('filling', job.imageDataUrl ? '已连接豆包，正在填入提示词和商品图…' : '已连接豆包，正在填入提示词…');
  const prompt = findPrompt();
  if (!prompt) {
    emit('adapter_error', '找不到提示词输入框，请检查豆包页面或手动填写。');
    return { ok: false, state: 'adapter_error' };
  }
  if (!current()) return cancelled();
  setText(prompt, job.prompt || '');
  if (findBlockingDialog()) return stopForBlockingDialog();

  if (job.imageDataUrl) {
    // 只有有商品图时才等待上传控件；无图任务直接继续提交提示词。
    const fileInput = await new Promise((resolve) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (!current()) { clearInterval(timer); resolve(null); return; }
        const input = findFileInput();
        if (findBlockingDialog() || input || Date.now() - startedAt > 8000) {
          clearInterval(timer);
          resolve(input);
        }
      }, 250);
    });
    if (!current()) return cancelled();
    if (findBlockingDialog()) return stopForBlockingDialog();
    if (!fileInput) {
      emit('upload_error', '找不到商品图上传控件，请在豆包页面手动上传。');
      return { ok: false, state: 'upload_error' };
    }
    try {
      const response = await fetch(job.imageDataUrl);
      if (!current()) return cancelled();
      const blob = await response.blob();
      if (!current()) return cancelled();
      if (findBlockingDialog()) return stopForBlockingDialog();
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) throw new Error('请使用 PNG、JPEG 或 WebP 商品图。');
      const file = new File([blob], `product-image.${blob.type.split('/')[1]}`, { type: blob.type });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      if (!current()) return cancelled();
      fileInput.files = transfer.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      const uploadReady = await waitForUploadReady(fileInput, 8000, current);
      if (!current()) return cancelled();
      if (!uploadReady) throw new Error('豆包页面未确认商品图上传完成。');
    } catch (error) {
      if (!current()) return cancelled();
      if (findBlockingDialog()) return stopForBlockingDialog();
      emit('upload_error', error.message || '商品图上传失败，请在豆包页面手动上传。');
      return { ok: false, state: 'upload_error' };
    }
  }

  const submit = await waitForSubmitButton(6000, current);
  if (!current()) return cancelled();
  if (!submit) {
    if (findBlockingDialog()) return stopForBlockingDialog();
    emit('submit_error', job.imageDataUrl
      ? '无法唯一定位当前输入区域的发送按钮。提示词和商品图已填入，请检查页面后手动提交。'
      : '无法唯一定位当前输入区域的发送按钮。提示词已填入，请检查页面后手动提交。');
    return { ok: false, state: 'submit_error' };
  }
  const previousUrls = new Set([...document.images].map((image) => image.currentSrc || image.src));
  const resultContext = captureDoubaoResultContext(job);
  if (!current()) return cancelled();
  clickSubmit(submit);
  await wait(400);
  if (!current()) return cancelled();
  if (findBlockingDialog()) {
    emit('submit_error', '豆包提交后出现弹窗，尚未确认发送成功。请先检查平台是否已收到内容，再手动处理；扩展不会自动再次点击。');
    return { ok: false, state: 'submit_error' };
  }
  emit('submitted', '已提交豆包生成任务，工作台会在检测到新图片后同步结果。');
  monitorResults(previousUrls, job.jobId || activeDoubaoJobId, activeDoubaoAttemptId, resultContext);
  return { ok: true, state: 'submitted' };
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ZAOTU_DOUBAO_PING') {
    sendResponse({ ok: true, url: location.href, adapterVersion: DOUBAO_ADAPTER_VERSION });
    return false;
  }
  if (message?.type !== 'ZAOTU_RUN_DOUBAO_JOB') return;
  if (window.__zaotuActionLock) { sendResponse({ ok: false, state: 'adapter_error', message: 'TAB_BUSY' }); return false; }
  const pending = runJob(message.job), operation = activeDoubaoOperation;
  pending.then(sendResponse).catch((error) => {
    if (operation.cancelled || operation !== activeDoubaoOperation) { sendResponse({ ok: false, state: 'cancelled' }); return; }
    sendStatus('adapter_error', error.message || '豆包页面操作失败。', operation.jobId, 'ADAPTER_ERROR', operation);
    sendResponse({ ok: false, state: 'adapter_error', message: error.message });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ZAOTU_CANCEL_PLATFORM_JOB' || message.platform !== 'doubao') return;
  if (message.jobId && message.attemptId && message.jobId === activeDoubaoJobId && message.attemptId === activeDoubaoAttemptId) {
    if (activeMonitorTimer) clearInterval(activeMonitorTimer);
    activeMonitorTimer = null;
    if (activeDoubaoOperation) activeDoubaoOperation.cancelled = true;
    sendStatus('cancelled', '已取消豆包当前任务。');
    activeDoubaoJobId = '';
    activeDoubaoAttemptId = '';
    sendResponse({ ok: true, state: 'cancelled' });
  } else {
    sendResponse({ ok: false, message: '取消任务的 jobId 或 attemptId 不匹配。' });
  }
  return false;
});
