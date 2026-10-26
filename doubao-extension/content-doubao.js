const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let activeDoubaoJobId = '';
let activeDoubaoAttemptId = '';
let activeMonitorTimer = null;
const DOUBAO_ERROR_CODES = { login_required: 'LOGIN_REQUIRED', upload_error: 'UPLOAD_FAILED', submit_error: 'SUBMIT_FAILED', result_timeout: 'RESULT_TIMEOUT', adapter_error: 'ADAPTER_ERROR', cancelled: 'CANCELLED', failed: 'PLATFORM_FAILED' };
const sendStatus = (state, message, jobId = activeDoubaoJobId, errorCode = DOUBAO_ERROR_CODES[state] || '') => chrome.runtime.sendMessage({ type: 'ZAOTU_STATUS', platform: 'doubao', jobId, attemptId: activeDoubaoAttemptId, timestamp: new Date().toISOString(), state, message, errorCode });

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

const findPrompt = () => {
  const fields = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
    .filter((element) => !element.disabled && !element.readOnly && isVisible(element));
  return fields.find((element) => /描述|提示|输入|创作|画面/i.test(`${element.getAttribute('placeholder') || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('data-placeholder') || ''}`))
    || fields.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]
    || null;
};
const findFileInput = () => document.querySelector('input[type="file"]');
const waitForUploadReady = async (input, timeout = 8000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (input?.files?.length) return true;
    await wait(150);
  }
  return Boolean(input?.files?.length);
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
  const prompt = findPrompt();
  if (!prompt) return null;
  const pageButtons = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
    .filter((button) => isVisible(button))
    .map((button) => ({
      button,
      label: `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${button.getAttribute('data-testid') || ''} ${button.getAttribute('data-e2e') || ''} ${button.textContent || ''}`
    }))
    .filter(({ label }) => !/停止|取消|登录|注册|上传|添加图片|附件|清除|stop|cancel|sign in|log in/i.test(label));
  const pageExplicit = pageButtons.find(({ label }) => /发送|生成|创作|提交|send|generate|create|submit/i.test(label));
  if (pageExplicit) return pageExplicit.button;
  const form = prompt.closest('form');
  if (form) {
    const submit = form.querySelector('button[type="submit"], input[type="submit"]');
    if (submit && !submit.disabled && isVisible(submit)) return submit;
  }

  let region = prompt.parentElement;
  for (let depth = 0; region && depth < 7; depth += 1, region = region.parentElement) {
    const regionRect = region.getBoundingClientRect();
    if (regionRect.height > 600 || regionRect.width > window.innerWidth) break;
    const buttons = [...region.querySelectorAll('button, [role="button"], input[type="submit"]')]
      .filter((button) => isVisible(button));
    const scored = buttons.map((button) => {
      const testId = `${button.getAttribute('data-testid') || ''} ${button.getAttribute('data-e2e') || ''}`;
      const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${testId} ${button.textContent || ''}`;
      if (/停止|取消|登录|注册|上传|添加图片|附件|清除/i.test(label)) return { button, score: -1 };
      if (/send|generate|submit/i.test(testId)) return { button, score: 10 };
      if (/发送|生成|创作|提交|send|generate|create|submit/i.test(label)) return { button, score: 5 };
      const rect = button.getBoundingClientRect();
      const promptRect = prompt.getBoundingClientRect();
      const closeToComposer = rect.width <= 72 && rect.height <= 72
        && rect.top >= promptRect.top - 32 && rect.top <= promptRect.bottom + 180
        && rect.left >= promptRect.left - 32 && rect.right <= promptRect.right + 180;
      if (button.querySelector('svg') && closeToComposer && buttons.length <= 4) return { button, score: 2 };
      return { button, score: 0 };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
    if (scored.length) return scored[0].button;
  }
  return null;
};

const waitForSubmitButton = async (timeout = 6000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const button = findSubmitButton();
    if (button && !button.disabled) return button;
    await wait(250);
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

const imageCandidates = (previousUrls) => [...document.images]
  .filter((image) => image.complete && image.naturalWidth >= 240 && image.naturalHeight >= 240 && isVisible(image))
  .map((image) => ({ image, url: image.currentSrc || image.src, rect: image.getBoundingClientRect(), alt: image.alt || '' }))
    .filter(({ url, rect, alt }) => /^(https?:|blob:|data:image\/)/.test(url) && rect.width * rect.height >= 12000 && !previousUrls.has(url) && !/(avatar|logo|icon|favicon|profile|emoji|sprite|placeholder)/i.test(`${url} ${alt}`))
  .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))
  .filter((item, index, items) => items.findIndex((candidate) => candidate.url === item.url) === index)
  .slice(0, 12);

const monitorResults = (previousUrls, jobId, attemptId = activeDoubaoAttemptId) => {
  if (activeMonitorTimer) clearInterval(activeMonitorTimer);
  const startedAt = Date.now();
  let lastSignature = '';
  const timer = setInterval(async () => {
    if (activeDoubaoJobId !== jobId || activeDoubaoAttemptId !== attemptId) {
      clearInterval(timer);
      return;
    }
    if (Date.now() - startedAt > 10 * 60 * 1000) {
      clearInterval(timer);
      if (activeMonitorTimer === timer) activeMonitorTimer = null;
      sendStatus('result_timeout', '暂未检测到新图片。任务可能仍在平台运行，可稍后重新同步。', jobId);
      return;
    }
    const candidates = imageCandidates(previousUrls);
    if (!candidates.length) return;
    const results = await Promise.all(candidates.map(async ({ url }, index) => {
      try {
        return { id: `${Date.now()}-${index}`, url: url.startsWith('blob:') ? await toDataUrl(url) : url, platform: 'doubao' };
      } catch {
        return null;
      }
    }));
    const available = results.filter(Boolean);
    const signature = available.map((item) => item.url.slice(0, 180)).join('|');
    if (!available.length || signature === lastSignature) return;
    lastSignature = signature;
    chrome.runtime.sendMessage({ type: 'ZAOTU_RESULT_CANDIDATES', platform: 'doubao', jobId, attemptId, results: available });
    sendStatus('result_ready', `${available.length} 张结果已同步到工作台，可选择要保存的图片。`, jobId);
  }, 2000);
  activeMonitorTimer = timer;
};

const runJob = async (job) => {
  if (activeMonitorTimer) {
    clearInterval(activeMonitorTimer);
    activeMonitorTimer = null;
  }
  activeDoubaoJobId = job.jobId || '';
  activeDoubaoAttemptId = job.attemptId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  sendStatus('checking_login', '正在检查豆包登录状态…');
  await wait(600);
  const loggedIn = loginState();
  if (loggedIn === false) {
    sendStatus('login_required', '豆包尚未登录。请在当前页面完成登录，再回工作台重试。');
    return { ok: false, state: 'login_required' };
  }

  sendStatus('filling', job.imageDataUrl ? '已连接豆包，正在填入提示词和商品图…' : '已连接豆包，正在填入提示词…');
  const prompt = findPrompt();
  if (!prompt) {
    sendStatus('adapter_error', '找不到提示词输入框，请检查豆包页面或手动填写。');
    return { ok: false, state: 'adapter_error' };
  }
  setText(prompt, job.prompt || '');

  if (job.imageDataUrl) {
    // 只有有商品图时才等待上传控件；无图任务直接继续提交提示词。
    const fileInput = await new Promise((resolve) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const input = findFileInput();
        if (input || Date.now() - startedAt > 8000) {
          clearInterval(timer);
          resolve(input);
        }
      }, 250);
    });
    if (!fileInput) {
      sendStatus('upload_error', '找不到商品图上传控件，请在豆包页面手动上传。');
      return { ok: false, state: 'upload_error' };
    }
    try {
      const response = await fetch(job.imageDataUrl);
      const blob = await response.blob();
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) throw new Error('请使用 PNG、JPEG 或 WebP 商品图。');
      const file = new File([blob], `product-image.${blob.type.split('/')[1]}`, { type: blob.type });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      fileInput.files = transfer.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      if (!await waitForUploadReady(fileInput)) throw new Error('豆包页面未确认商品图上传完成。');
    } catch (error) {
      sendStatus('upload_error', error.message || '商品图上传失败，请在豆包页面手动上传。');
      return { ok: false, state: 'upload_error' };
    }
  }

  const submit = await waitForSubmitButton();
  if (!submit) {
    sendStatus('submit_error', job.imageDataUrl
      ? '找不到生成按钮。提示词和商品图已填入，请检查页面后手动提交。'
      : '找不到生成按钮。提示词已填入，请检查页面后手动提交。');
    return { ok: false, state: 'submit_error' };
  }
  const previousUrls = new Set([...document.images].map((image) => image.currentSrc || image.src));
  clickSubmit(submit);
  await wait(400);
  sendStatus('submitted', '已提交豆包生成任务，工作台会在检测到新图片后同步结果。');
  monitorResults(previousUrls, job.jobId || activeDoubaoJobId, activeDoubaoAttemptId);
  return { ok: true, state: 'submitted' };
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ZAOTU_DOUBAO_PING') {
    sendResponse({ ok: true, url: location.href });
    return false;
  }
  if (message?.type !== 'ZAOTU_RUN_DOUBAO_JOB') return;
  runJob(message.job).then(sendResponse).catch((error) => {
    sendStatus('adapter_error', error.message || '豆包页面操作失败。');
    sendResponse({ ok: false, state: 'adapter_error', message: error.message });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ZAOTU_CANCEL_PLATFORM_JOB' || message.platform !== 'doubao') return;
  if (!message.jobId || message.jobId === activeDoubaoJobId) {
    if (activeMonitorTimer) clearInterval(activeMonitorTimer);
    activeMonitorTimer = null;
    sendStatus('cancelled', '已取消豆包当前任务。');
    activeDoubaoJobId = '';
    activeDoubaoAttemptId = '';
    sendResponse({ ok: true, state: 'cancelled' });
  }
  return false;
});
