const PLATFORM = 'chatgpt';
const CHATGPT_ADAPTER_VERSION = '0.5.1';
const CONFIG = { loginPath: /login|auth/i, loginLabels: /log in|sign up|登录|注册/i, submitLabels: /send|生成|create/i, resultSelectors: ['main article img', '[data-message-author-role="assistant"] img', 'main img'], minArea: 16000, excludeUrl: /avatar|profile|logo|icon/i };
let activeChatgptOperation = null;
const postStatus = (state, message, results, errorCode, meta = {}, operation = activeChatgptOperation) => {
  if (!operation || operation !== activeChatgptOperation || (operation.cancelled && state !== 'cancelled')) return;
  if (['result_ready','cancelled','failed','adapter_error','submit_error','upload_error','login_required','result_timeout'].includes(state) && window.__zaotuActionLock === operation.key) window.__zaotuActionLock = null;
  return chrome.runtime.sendMessage({ type: 'ZAOTU_STATUS', platform: PLATFORM, jobId: operation.jobId, attemptId: operation.attemptId, timestamp: meta.timestamp || new Date().toISOString(), state, message, errorCode: errorCode || ZaotuPlatform.errorCodeFor(state), results });
};
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ZAOTU_PLATFORM_PING') { sendResponse({ ok: true, platform: PLATFORM, adapterVersion: CHATGPT_ADAPTER_VERSION }); return false; }
  if (message?.type !== 'ZAOTU_RUN_PLATFORM_JOB' || message.platform !== PLATFORM) return;
  if (window.__zaotuActionLock) { sendResponse({ ok: false, message: 'TAB_BUSY' }); return false; }
  const operation = { key: {}, cancelled: false, jobId: message.job.jobId, attemptId: message.job.attemptId || `${Date.now().toString(36)}-chatgpt` };
  activeChatgptOperation = operation;
  window.__zaotuActionLock = operation.key;
  window.__zaotuJobId = message.job.jobId;
  window.__zaotuAttemptId = operation.attemptId;
  ZaotuPlatform.run({ platform: PLATFORM, job: message.job, config: CONFIG, status: (...args) => postStatus(...args, operation) }).then(sendResponse).catch((error) => { if (operation.cancelled || operation !== activeChatgptOperation) { sendResponse({ ok: false, state: 'cancelled' }); return; } postStatus('adapter_error', error.message || 'ChatGPT 页面操作失败。', undefined, 'ADAPTER_ERROR', {}, operation); sendResponse({ ok: false, state: 'adapter_error' }); });
  return true;
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ZAOTU_CANCEL_PLATFORM_JOB' || message.platform !== PLATFORM) return;
  if (message.jobId && message.attemptId && message.jobId === window.__zaotuJobId && message.attemptId === window.__zaotuAttemptId) {
    const cancelled = ZaotuPlatform.cancel('cancelled', message.jobId, message.attemptId);
    if (!cancelled.ok) { sendResponse({ ok: false, message: '取消任务的 jobId 或 attemptId 不匹配。' }); return false; }
    activeChatgptOperation.cancelled = true;
    postStatus('cancelled', '已取消 ChatGPT 当前任务。', undefined, 'CANCELLED');
    sendResponse({ ok: true, state: 'cancelled' });
  } else {
    sendResponse({ ok: false, message: '取消任务的 jobId 或 attemptId 不匹配。' });
  }
  return false;
});
