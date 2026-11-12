const post = (type, payload = {}) => {
  const event = (typeof ZaotuProtocol !== 'undefined' && ZaotuProtocol.isProtocolEvent(type))
    ? ZaotuProtocol.normalizeEvent({ type, ...payload })
    : { type, ...payload };
  window.postMessage({ source: 'zaotu-doubao-extension', ...event }, '*');
};

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== 'zaotu-workbench') return;
  if (['TEXT_REPLAY', 'TEXT_ACK'].includes(event.data.type)) {
    const job = event.data.job;
    if (!job?.source) return;
    chrome.runtime.sendMessage({ type: event.data.type === 'TEXT_ACK' ? 'ZAOTU_ACK_TEXT' : 'ZAOTU_REPLAY_TEXT', kind: 'prompt_b', protocolVersion: 'text-v1', projectId: job.projectId, jobId: job.jobId, attemptId: job.attemptId, routeSession: job.routeSession, sourceFingerprint: job.source.fingerprint, platform: job.platform, eventId: event.data.eventId });
  }
  if (['TEXT_PREPARE', 'TEXT_CANCEL'].includes(event.data.type)) {
  const job = event.data.job;
  chrome.runtime.sendMessage(event.data.type === 'TEXT_PREPARE'
    ? { type: 'ZAOTU_PREPARE_TEXT', job }
    : { type: 'ZAOTU_CANCEL_TEXT', kind: 'prompt_b', protocolVersion: 'text-v1', projectId: job.projectId, jobId: job.jobId, attemptId: job.attemptId, routeSession: job.routeSession, sourceFingerprint: job.source.fingerprint, platform: job.platform }, (response) => {
      if (event.data.type === 'TEXT_PREPARE' && (chrome.runtime.lastError || !response?.ok)) post('TEXT_EVENT', { kind: 'prompt_b', protocolVersion: 'text-v1', projectId: job.projectId, jobId: job.jobId, attemptId: job.attemptId, routeSession: job.routeSession, sourceFingerprint: job.source.fingerprint, platform: job.platform, state: 'failed', errorCode: response?.errorCode || 'EXTENSION_DISCONNECTED' });
    });
  }
  if (event.data.type === 'DOUBAO_PREPARE' || event.data.type === 'PLATFORM_PREPARE' || event.data.type === 'PLATFORM_PREPARE_V2') {
    const platform = event.data.platform || 'doubao';
    if (platform === 'doubao' && event.data.type !== 'PLATFORM_PREPARE_V2') {
      post('PLATFORM_ERROR', { platform, jobId: event.data.payload?.jobId, attemptId: event.data.payload?.attemptId, state: 'adapter_error', errorCode: 'ADAPTER_VERSION_MISMATCH', message: '工作台仍在使用旧版豆包发送协议，请保存编辑并刷新工作台页面；本次未发送。' });
      return;
    }
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: platform === 'doubao' ? 'ZAOTU_PREPARE_DOUBAO' : 'ZAOTU_PREPARE_PLATFORM', platform, payload: event.data.payload }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(`扩展后台通信失败：${chrome.runtime.lastError.message}`));
        else if (!response) reject(new Error('扩展后台未返回连接结果，请重新加载扩展并刷新平台页面。'));
        else if (!response.ok) reject(Object.assign(new Error(response.message || `无法连接${platform}页面。`), { needsPage: response.needsPage || false }));
        else resolve(response);
      });
    }).then((response) => post('PLATFORM_OPENED', { platform, jobId: event.data.payload?.jobId, attemptId: event.data.payload?.attemptId, tabId: response.tabId, platformTabId: response.platformTabId || response.tabId, state: 'page_opened', message: '已连接平台页面。' }))
      .catch((error) => post('PLATFORM_ERROR', { platform, jobId: event.data.payload?.jobId, attemptId: event.data.payload?.attemptId, needsPage: Boolean(error.needsPage), state: error.needsPage ? 'not_open' : 'extension_disconnected', errorCode: error.needsPage ? 'PAGE_NOT_OPEN' : 'EXTENSION_DISCONNECTED', message: error.message || `${platform} 页面连接失败。` }));
  }
  if (event.data.type === 'DOUBAO_OPEN_PAGE' || event.data.type === 'OPEN_PLATFORM') {
    const platform = event.data.platform || 'doubao';
    chrome.runtime.sendMessage({ type: platform === 'doubao' ? 'ZAOTU_OPEN_DOUBAO' : 'ZAOTU_OPEN_PLATFORM', platform }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) post('PLATFORM_ERROR', { platform, openEvent: true, state: 'not_open', errorCode: 'PAGE_NOT_OPEN', message: response?.message || chrome.runtime.lastError?.message || `无法打开${platform}。` });
      else post('PLATFORM_PAGE_OPENED', { platform, tabId: response.tabId, platformTabId: response.tabId, state: 'page_opened', message: '平台页面已打开。' });
    });
  }
  if (event.data.type === 'DOUBAO_IMPORT_SELECTED' || event.data.type === 'IMPORT_SELECTED') {
    const platform = event.data.platform || event.data.result?.platform || 'doubao';
    chrome.runtime.sendMessage({ type: 'ZAOTU_IMPORT_SELECTED', platform, result: event.data.result }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) post('PLATFORM_STATUS', { platform, jobId: event.data.result?.jobId, attemptId: event.data.result?.attemptId, state: 'import_error', errorCode: 'IMPORT_FAILED', message: response?.message || chrome.runtime.lastError?.message || '结果图片读取失败。' });
      else post('PLATFORM_IMPORTED', { platform, result: { ...response.result, jobId: event.data.result?.jobId, attemptId: event.data.result?.attemptId } });
    });
  }
  if (event.data.type === 'PLATFORM_CANCEL' || event.data.type === 'CANCEL_PLATFORM_JOB') {
    const platform = event.data.platform || 'doubao';
    chrome.runtime.sendMessage({ type: 'ZAOTU_CANCEL_PLATFORM_JOB', platform, jobId: event.data.jobId, attemptId: event.data.attemptId }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) post('PLATFORM_ERROR', { platform, jobId: event.data.jobId, attemptId: event.data.attemptId, needsPage: false, state: 'extension_disconnected', errorCode: 'EXTENSION_DISCONNECTED', message: response?.message || chrome.runtime.lastError?.message || '取消平台任务失败。' });
    });
  }
});

post('DOUBAO_EXTENSION_READY', { extensionVersion: chrome.runtime.getManifest().version, textProtocolVersion: 'text-v1', textAdapterVersion: '0.5.1' });

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'ZAOTU_RESULT_CANDIDATES') post('PLATFORM_RESULT_CANDIDATES', { platform: message.platform || 'doubao', jobId: message.jobId, attemptId: message.attemptId, state: 'result_ready', message: '平台结果已同步。', results: message.results });
  if (message?.type === 'ZAOTU_IMPORTED_RESULT') post('DOUBAO_IMPORTED_RESULT', { result: message.result });
  if (message?.type === 'ZAOTU_STATUS') post('PLATFORM_STATUS', { platform: message.platform || 'doubao', jobId: message.jobId, attemptId: message.attemptId, timestamp: message.timestamp, state: message.state, message: message.message, errorCode: message.errorCode, results: message.results });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'ZAOTU_TEXT_EVENT') post('TEXT_EVENT', { ...message, type: 'TEXT_EVENT' });
});
