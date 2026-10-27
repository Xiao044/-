const PLATFORM = 'chatgpt';
const CONFIG = { loginPath: /login|auth/i, loginLabels: /log in|sign up|登录|注册/i, submitLabels: /send|生成|create/i, resultSelectors: ['main article img', '[data-message-author-role="assistant"] img', 'main img'], minArea: 16000, excludeUrl: /avatar|profile|logo|icon/i };
const postStatus = (state, message, results, errorCode, meta = {}) => chrome.runtime.sendMessage({ type: 'ZAOTU_STATUS', platform: PLATFORM, jobId: window.__zaotuJobId, attemptId: meta.attemptId || window.__zaotuAttemptId, timestamp: meta.timestamp || new Date().toISOString(), state, message, errorCode: errorCode || ZaotuPlatform.errorCodeFor(state), results });
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ZAOTU_PLATFORM_PING') { sendResponse({ ok: true, platform: PLATFORM }); return false; }
  if (message?.type !== 'ZAOTU_RUN_PLATFORM_JOB' || message.platform !== PLATFORM) return;
  window.__zaotuJobId = message.job.jobId;
  window.__zaotuAttemptId = message.job.attemptId || `${Date.now().toString(36)}-chatgpt`;
  ZaotuPlatform.run({ platform: PLATFORM, job: message.job, config: CONFIG, status: postStatus }).then(sendResponse).catch((error) => { postStatus('adapter_error', error.message || 'ChatGPT 页面操作失败。'); sendResponse({ ok: false, state: 'adapter_error' }); });
  return true;
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ZAOTU_CANCEL_PLATFORM_JOB' || message.platform !== PLATFORM) return;
  if (message.jobId && message.attemptId && message.jobId === window.__zaotuJobId && message.attemptId === window.__zaotuAttemptId) {
    const cancelled = ZaotuPlatform.cancel('cancelled', message.jobId, message.attemptId);
    if (!cancelled.ok) { sendResponse({ ok: false, message: '取消任务的 jobId 或 attemptId 不匹配。' }); return false; }
    postStatus('cancelled', '已取消 ChatGPT 当前任务。', undefined, 'CANCELLED');
    sendResponse({ ok: true, state: 'cancelled' });
  } else {
    sendResponse({ ok: false, message: '取消任务的 jobId 或 attemptId 不匹配。' });
  }
  return false;
});
