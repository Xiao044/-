// Text-only adapters. Deliberately independent of ZaotuPlatform and all image/upload code.
(() => {
  if (window.__zaotuTextAdapter) return;
  const VERSION = '0.5.1', PROTOCOL = 'text-v1';
  const platform = /(^|\.)doubao\.com$/.test(location.hostname) ? 'doubao' : /^(chatgpt\.com|chat\.openai\.com)$/.test(location.hostname) ? 'chatgpt' : '';
  if (!platform) return;
  const configs = {
    doubao: { composer: '[data-testid="chat_input"] [data-testid="chat_input_input"] [contenteditable="true"], [data-testid="chat_input"] [contenteditable="true"][data-testid="chat_input_input"]', scope: '[data-testid="chat_input"]', send: '[data-testid="chat_input_send_button"], #flow-end-msg-send', user: '[data-testid="send_message"][data-message-role="user"]', assistant: '[data-testid="receive_message"][data-message-role="assistant"]', done: '[data-testid="message_action_bar"], [data-testid="message_action_copy"]', stop: '[data-testid="chat_input_stop_button"], [data-testid="stop_generate"]' },
    chatgpt: { composer: '#prompt-textarea[contenteditable="true"]', scope: 'form', send: '[data-testid="send-button"]', user: '[data-message-author-role="user"]', assistant: '[data-message-author-role="assistant"]', done: '[data-testid="copy-turn-action-button"]', stop: '[data-testid="stop-button"]' }
  };
  const config = configs[platform];
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const visible = (node) => Boolean(node && node.getBoundingClientRect().width && node.getBoundingClientRect().height && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none');
  const text = (node) => String(node?.innerText || node?.textContent || '').trim();
  const replyText = (node) => {
    if (typeof node?.cloneNode !== 'function') return text(node);
    const copy = node.cloneNode(true); all(config.done, copy).forEach((control) => control.remove());
    return text(copy);
  };
  const one = (selector, root = document) => { const nodes = all(selector, root).filter(visible); if (nodes.length !== 1) throw new Error('AMBIGUOUS_CONTROL'); return nodes[0]; };
  let current = null;
  const seen = new Set();
  const identity = (job) => ({ kind: job.kind, protocolVersion: PROTOCOL, projectId: job.projectId, jobId: job.jobId, attemptId: job.attemptId, routeSession: job.routeSession, sourceFingerprint: job.source.fingerprint, platform });
  const emit = (job, state, extra = {}) => chrome.runtime.sendMessage({ type: 'ZAOTU_TEXT_EVENT', ...identity(job), state, ...extra });
  const release = (operation) => {
    if (operation.timer) clearInterval(operation.timer);
    if (current === operation) current = null;
    if (window.__zaotuActionLock === operation.key) window.__zaotuActionLock = null;
  };
  const fail = (operation, errorCode) => { if (!operation.cancelled) emit(operation.job, 'failed', { errorCode }); release(operation); };
  const run = (job, expectedPageUrl) => {
    if (expectedPageUrl && expectedPageUrl !== location.href) throw new Error('PAGE_CHANGED');
    if (job?.kind !== 'prompt_b' || job.protocolVersion !== PROTOCOL || job.platform !== platform || job.model !== 'current-page' || !job.projectId || !job.jobId || !job.attemptId || !job.routeSession || !job.source?.fingerprint || typeof job.prompt !== 'string' || !job.prompt.trim()) throw new Error('INVALID_TEXT_IDENTITY');
    const key = `${job.jobId}:${job.attemptId}:${job.routeSession}`;
    if (seen.has(key)) throw new Error('DUPLICATE_PREPARE');
    if (current || window.__zaotuActionLock) throw new Error('TAB_BUSY');
    if (all('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]').some(visible)) throw new Error('DIALOG_OPEN');
    const composer = one(config.composer), scope = composer.closest(config.scope);
    if (!scope || text(composer)) throw new Error('FOREIGN_COMPOSER');
    if (all(config.stop).some(visible)) throw new Error('GENERATION_RUNNING');
    if (all('[data-testid*="attachment"], [data-testid*="file-preview"], [data-testid*="image-preview"], [data-testid="remove-file"], [data-testid="remove-attachment"], [data-testid="tool-pill"], [data-testid="tool-selected"], [aria-pressed="true"][data-testid*="tool"], [data-testid="image-mode"], [data-testid="image_generation"]', scope).some(visible)) throw new Error('ATTACHMENT_OR_TOOL_MODE');
    const send = one(config.send, scope);
    const operation = { key, job, href: location.href, users: new Set(all(config.user)), assistants: new Set(all(config.assistant)), user: null, reply: null, stable: 0, last: '', startedAt: Date.now() };
    seen.add(key); current = operation; window.__zaotuActionLock = key;
    try {
      composer.focus(); composer.textContent = job.prompt;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: job.prompt }));
      if (send.disabled || send.getAttribute('aria-disabled') === 'true') throw new Error('SEND_DISABLED');
      // Recheck exact scope/control after reactive composer updates; never fall back to Enter.
      if (one(config.send, scope) !== send || location.href !== operation.href) throw new Error('PAGE_CHANGED');
      send.click(); emit(job, 'submitted');
      operation.timer = setInterval(() => {
        if (current !== operation) return;
        try {
          if (location.href !== operation.href || !composer.isConnected || (operation.user && !operation.user.isConnected)) throw new Error('PAGE_CHANGED');
          if (Date.now() - operation.startedAt > 180000) throw new Error('TEXT_TIMEOUT');
          if (!operation.user) {
            const users = all(config.user).filter((node) => !operation.users.has(node) && text(node) === job.prompt.trim());
            if (users.length > 1) throw new Error('AMBIGUOUS_USER_TURN');
            if (!users.length) return;
            operation.user = users[0]; if (!operation.cancelled) emit(job, 'running');
          }
          const replies = all(config.assistant).filter((node) => !operation.assistants.has(node) && (operation.user.compareDocumentPosition(node) & 4));
          if (replies.length > 1) throw new Error('AMBIGUOUS_ASSISTANT');
          const reply = replies[0]; if (!reply) return;
          if (operation.reply && operation.reply !== reply) throw new Error('ASSISTANT_REPLACED');
          operation.reply = reply;
          const value = replyText(reply);
          const turn = platform === 'chatgpt' ? reply.closest('article') : reply;
          const marker = turn && all(config.done, turn).some(visible);
          const streaming = all(config.stop).some(visible) || reply.getAttribute('data-is-streaming') === 'true' || reply.getAttribute('aria-busy') === 'true';
          if (!value || !marker || streaming) { operation.stable = 0; operation.last = value; return; }
          operation.stable = value === operation.last ? operation.stable + 1 : 0; operation.last = value;
          if (operation.stable < 3) return;
          if (!operation.cancelled) emit(job, 'completed', { rawReply: value, pageUrl: operation.href, userAnchor: operation.user.getAttribute('data-message-id') || operation.user.id || `new-user-${operation.users.size + 1}`, completionEvidence: 'new-assistant-action-bar-stable' });
          release(operation);
        } catch (error) { fail(operation, error.message); }
      }, 1000);
      return { ok: true, adapterVersion: VERSION, protocolVersion: PROTOCOL };
    } catch (error) { release(operation); throw error; }
  };
  window.__zaotuTextAdapter = { version: VERSION };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type === 'ZAOTU_TEXT_PING') { respond({ ok: true, platform, adapterVersion: VERSION, protocolVersion: PROTOCOL, pageUrl: location.href, capabilities: ['prompt_b'] }); return false; }
    if (message?.type === 'ZAOTU_RUN_TEXT') { try { respond(run(message.job, message.expectedPageUrl)); } catch (error) { respond({ ok: false, errorCode: error.message, message: error.message }); } return false; }
    if (message?.type === 'ZAOTU_CANCEL_TEXT') {
      const job = current?.job;
      if (!job || message.jobId !== job.jobId || message.attemptId !== job.attemptId || message.routeSession !== job.routeSession || message.projectId !== job.projectId) { respond({ ok: false }); return false; }
      // Cancellation stops delivery, not the webpage's model. Retain the tab lease until
      // positive completion or timeout so an image action cannot overwrite a live text turn.
      current.cancelled = true; respond({ ok: true }); return false;
    }
  });
})();
