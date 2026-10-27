(() => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let activeMonitorCancel = null;
  let activeJobId = '';
  let activeAttemptId = '';
  const ERROR_CODES = {
    login_required: 'LOGIN_REQUIRED',
    not_open: 'PAGE_NOT_OPEN',
    upload_error: 'UPLOAD_FAILED',
    submit_error: 'SUBMIT_FAILED',
    result_timeout: 'RESULT_TIMEOUT',
    adapter_error: 'ADAPTER_ERROR',
    import_error: 'IMPORT_FAILED',
    cancelled: 'CANCELLED',
    failed: 'PLATFORM_FAILED'
  };
  const errorCodeFor = (state) => ERROR_CODES[state] || '';
  const isDisabled = (element) => Boolean(
    element?.disabled
    || element?.getAttribute?.('aria-disabled') === 'true'
    || element?.getAttribute?.('data-disabled') === 'true'
    || element?.getAttribute?.('data-state') === 'disabled'
    || /(^|\s)(disabled|is-disabled)(\s|$)/i.test(element?.className || '')
  );
  const visible = (element) => {
    if (!element || isDisabled(element) || element.readOnly) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
      && getComputedStyle(element).visibility !== 'hidden'
      && getComputedStyle(element).display !== 'none';
  };
  const fields = () => [...document.querySelectorAll('textarea, input:not([type=file]), [contenteditable="true"], [role="textbox"]')].filter(visible);
  const buttons = () => [...document.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(visible);
  const label = (element) => `${element.getAttribute('aria-label') || ''} ${element.getAttribute('placeholder') || ''} ${element.getAttribute('title') || ''} ${element.getAttribute('data-testid') || ''} ${element.textContent || ''}`;
  const findPrompt = (config = {}) => {
    const matcher = config.promptLabels || /prompt|描述|提示|输入|创作|画面|message|ask|text/i;
    return fields().find((element) => matcher.test(label(element))) || fields().sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0] || null;
  };
  const setText = (element, value) => {
    element.focus();
    if (element.matches('textarea, input')) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
        || Object.getOwnPropertyDescriptor(element, 'value')?.set;
      setter?.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
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
    }
  };
  const findFileInput = (config = {}) => {
    const selectors = Array.isArray(config.fileInputSelectors) && config.fileInputSelectors.length ? config.fileInputSelectors : ['input[type="file"]'];
    return selectors.flatMap((selector) => {
      try { return [...document.querySelectorAll(selector)]; } catch { return []; }
    }).find((input) => input instanceof HTMLInputElement && input.type === 'file' && !isDisabled(input)) || null;
  };
  const waitForUploadReady = async (input, config = {}) => {
    const timeout = Math.max(500, Number(config.uploadReadyTimeoutMs) || 8000);
    const selectors = Array.isArray(config.uploadReadySelectors) ? config.uploadReadySelectors : [];
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const hasFile = Boolean(input?.files?.length);
      const readyMarker = selectors.some((selector) => {
        try { return [...document.querySelectorAll(selector)].some((element) => visible(element)); } catch { return false; }
      });
      if (hasFile && (!selectors.length || readyMarker)) return true;
      await wait(150);
    }
    return Boolean(input?.files?.length);
  };
  const findSubmit = (config = {}, prompt) => {
    const preferred = buttons().map((button) => ({ button, text: label(button) })).filter(({ text }) => !/停止|取消|登录|注册|上传|附件|清除|stop|cancel|sign in|log in/i.test(text));
    const explicit = preferred.find(({ text }) => (config.submitLabels || /send|generate|create|submit|发送|生成|创作|提交/i).test(text));
    if (explicit) return explicit.button;
    const near = preferred.filter(({ button }) => {
      const a = button.getBoundingClientRect(); const b = prompt?.getBoundingClientRect();
      return b && a.width < 100 && a.height < 100 && a.top >= b.top - 40 && a.top <= b.bottom + 180;
    });
    return near[near.length - 1]?.button || null;
  };
  const clickSubmit = (button) => {
    button.focus();
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    button.click();
  };
  const loginState = (config = {}) => {
    if (config.loginPath && config.loginPath.test(location.pathname)) return false;
    if (config.loginLabels && buttons().some((button) => config.loginLabels.test(label(button)))) return false;
    return findPrompt(config) ? true : null;
  };
  const imageCandidates = (previous, config = {}) => {
    const selectors = Array.isArray(config.resultSelectors) && config.resultSelectors.length
      ? config.resultSelectors
      : ['img'];
    const candidates = selectors.flatMap((selector) => {
      try { return [...document.querySelectorAll(selector)]; } catch { return []; }
    });
    return candidates
    .filter((image, index, items) => items.indexOf(image) === index)
    .filter((image) => image.tagName === 'IMG' && image.complete && image.naturalWidth >= (config.minWidth || 240) && image.naturalHeight >= (config.minHeight || 240) && visible(image))
    .map((image) => ({ image, url: image.currentSrc || image.src, area: image.getBoundingClientRect().width * image.getBoundingClientRect().height, alt: image.alt || '' }))
    .filter(({ url, area, alt }) => /^(https?:|blob:|data:image\/)/.test(url) && area >= (config.minArea || 12000) && !previous.has(url))
    .filter(({ url, alt }) => !/(avatar|logo|icon|favicon|profile|emoji|sprite|placeholder|headshot)/i.test(`${url} ${alt}`))
    .filter(({ url }) => !(config.excludeUrl && config.excludeUrl.test(url)))
    .sort((a, b) => b.area - a.area)
    .reduce((unique, item) => unique.has(item.url) ? unique : unique.set(item.url, item), new Map())
    .values();
  };
  const resultCandidates = (items) => [...items].slice(0, 12).map(({ url }, index) => ({ id: `${Date.now()}-${index}`, url }));
  const makeReadable = async (url) => {
    if (!url.startsWith('blob:')) return url;
    const blob = await (await fetch(url)).blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('无法读取平台结果图片。')); reader.readAsDataURL(blob);
    });
  };
  const cancel = (reason = 'cancelled', requestedJobId = '', requestedAttemptId = '') => {
    if (!requestedJobId || !requestedAttemptId || requestedJobId !== activeJobId || requestedAttemptId !== activeAttemptId) {
      return { ok: false, reason: 'mismatched_attempt' };
    }
    if (activeMonitorCancel) activeMonitorCancel();
    activeMonitorCancel = null;
    const cancelledJobId = activeJobId;
    activeJobId = '';
    activeAttemptId = '';
    return { ok: Boolean(cancelledJobId), jobId: cancelledJobId, reason };
  };
  const emitStatus = (status, state, message, results, errorCode) => {
    status(state, message, results, errorCode || errorCodeFor(state), {
      attemptId: activeAttemptId,
      timestamp: new Date().toISOString()
    });
  };
  const run = async ({ platform, job, config, status }) => {
    if (activeMonitorCancel) {
      activeMonitorCancel();
      activeMonitorCancel = null;
    }
    activeJobId = job.jobId || '';
    activeAttemptId = job.attemptId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const attemptId = activeAttemptId;
    emitStatus(status, 'checking_login', '正在检查登录状态…');
    await wait(500);
    if (loginState(config) === false) { emitStatus(status, 'login_required', '当前平台未登录，请登录后重试。'); return { ok: false, state: 'login_required', errorCode: errorCodeFor('login_required') }; }
    const prompt = findPrompt(config);
    if (!prompt) { emitStatus(status, 'adapter_error', '找不到提示词输入框，请检查平台页面。'); return { ok: false, state: 'adapter_error', errorCode: errorCodeFor('adapter_error') }; }
    emitStatus(status, 'filling', job.imageDataUrl ? '正在填入提示词和商品图…' : '正在填入提示词…');
    setText(prompt, job.prompt || '');
    if (job.imageDataUrl) {
        const input = findFileInput(config);
      if (!input) { emitStatus(status, 'upload_error', '找不到商品图上传控件；已保留提示词。'); return { ok: false, state: 'upload_error', errorCode: errorCodeFor('upload_error') }; }
      try {
        const blob = await (await fetch(job.imageDataUrl)).blob();
        const file = new File([blob], `product-image.${blob.type.split('/')[1] || 'png'}`, { type: blob.type });
          const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
          if (!await waitForUploadReady(input, config)) throw new Error('平台未确认商品图上传完成。');
      } catch (error) { emitStatus(status, 'upload_error', error.message || '商品图上传失败。'); return { ok: false, state: 'upload_error', errorCode: errorCodeFor('upload_error') }; }
    }
    const submit = findSubmit(config, prompt);
    if (!submit) { emitStatus(status, 'submit_error', '找不到提交或生成按钮；提示词已填入。'); return { ok: false, state: 'submit_error', errorCode: errorCodeFor('submit_error') }; }
    const previous = new Set([...document.images].map((image) => image.currentSrc || image.src));
    clickSubmit(submit);
    await wait(400);
    if (config.allowEnterFallback === true && !isDisabled(submit) && visible(submit) && prompt.matches('[contenteditable="true"], [role="textbox"]')) {
      prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      prompt.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    }
    emitStatus(status, 'submitted', '已提交生成任务，正在等待结果…');
    const started = Date.now(); let last = '';
    const timer = setInterval(() => {
      if (activeJobId !== job.jobId || activeAttemptId !== attemptId) {
        clearInterval(timer);
        return;
      }
      if (Date.now() - started > 10 * 60 * 1000) {
        clearInterval(timer);
        if (activeMonitorCancel === cancel) activeMonitorCancel = null;
        emitStatus(status, 'result_timeout', '暂未检测到新图片，可稍后重试或手动导入。');
        return;
      }
      const results = resultCandidates(imageCandidates(previous, config)); const signature = results.map((item) => item.url).join('|');
      if (!results.length || signature === last) return;
      last = signature; Promise.all(results.map(async (result) => ({ ...result, url: await makeReadable(result.url) }))).then((readable) => {
        if (activeJobId !== job.jobId || activeAttemptId !== attemptId) return;
        chrome.runtime.sendMessage({ type: 'ZAOTU_RESULT_CANDIDATES', platform, jobId: job.jobId, attemptId, results: readable });
        emitStatus(status, 'result_ready', `${readable.length} 张结果已同步到工作台。`, readable);
      }).catch((error) => {
        if (activeJobId === job.jobId && activeAttemptId === attemptId) emitStatus(status, 'result_timeout', error.message || '平台结果图片读取失败，可手动导入。');
      });
    }, 2000);
    const cancel = () => clearInterval(timer);
    activeMonitorCancel = cancel;
    return { ok: true, state: 'submitted', attemptId: activeAttemptId };
  };
  window.ZaotuPlatform = { run, cancel, errorCodeFor };
})();
