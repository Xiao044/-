const post = (type, payload = {}) => window.postMessage({ source: 'zaotu-doubao-extension', type, ...payload }, '*');

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== 'zaotu-workbench') return;
  if (event.data.type === 'DOUBAO_PREPARE' || event.data.type === 'PLATFORM_PREPARE') {
    const platform = event.data.platform || 'doubao';
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: platform === 'doubao' ? 'ZAOTU_PREPARE_DOUBAO' : 'ZAOTU_PREPARE_PLATFORM', platform, payload: event.data.payload }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(`扩展后台通信失败：${chrome.runtime.lastError.message}`));
        else if (!response) reject(new Error('扩展后台未返回连接结果，请重新加载扩展并刷新平台页面。'));
        else if (!response.ok) reject(Object.assign(new Error(response.message || `无法连接${platform}页面。`), { needsPage: response.needsPage || false }));
        else resolve(response);
      });
    }).then((response) => post('PLATFORM_OPENED', { platform, jobId: event.data.payload?.jobId, attemptId: event.data.payload?.attemptId, tabId: response.tabId }))
      .catch((error) => post('PLATFORM_ERROR', { platform, jobId: event.data.payload?.jobId, attemptId: event.data.payload?.attemptId, needsPage: Boolean(error.needsPage), message: error.message || `${platform} 页面连接失败。` }));
  }
  if (event.data.type === 'DOUBAO_OPEN_PAGE' || event.data.type === 'OPEN_PLATFORM') {
    const platform = event.data.platform || 'doubao';
    chrome.runtime.sendMessage({ type: platform === 'doubao' ? 'ZAOTU_OPEN_DOUBAO' : 'ZAOTU_OPEN_PLATFORM', platform }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) post('PLATFORM_ERROR', { platform, openEvent: true, message: response?.message || chrome.runtime.lastError?.message || `无法打开${platform}。` });
      else post('PLATFORM_PAGE_OPENED', { platform, tabId: response.tabId });
    });
  }
  if (event.data.type === 'DOUBAO_IMPORT_SELECTED' || event.data.type === 'IMPORT_SELECTED') {
    const platform = event.data.platform || event.data.result?.platform || 'doubao';
    chrome.runtime.sendMessage({ type: 'ZAOTU_IMPORT_SELECTED', platform, result: event.data.result }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) post('PLATFORM_STATUS', { platform, jobId: event.data.result?.jobId, attemptId: event.data.result?.attemptId, state: 'import_error', message: response?.message || chrome.runtime.lastError?.message || '结果图片读取失败。' });
      else post('PLATFORM_IMPORTED', { platform, result: { ...response.result, jobId: event.data.result?.jobId, attemptId: event.data.result?.attemptId } });
    });
  }
  if (event.data.type === 'PLATFORM_CANCEL' || event.data.type === 'CANCEL_PLATFORM_JOB') {
    const platform = event.data.platform || 'doubao';
    chrome.runtime.sendMessage({ type: 'ZAOTU_CANCEL_PLATFORM_JOB', platform, jobId: event.data.jobId, attemptId: event.data.attemptId }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) post('PLATFORM_ERROR', { platform, jobId: event.data.jobId, attemptId: event.data.attemptId, needsPage: false, message: response?.message || chrome.runtime.lastError?.message || '取消平台任务失败。' });
    });
  }
});

post('DOUBAO_EXTENSION_READY');

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'ZAOTU_RESULT_CANDIDATES') post('PLATFORM_RESULT_CANDIDATES', { platform: message.platform || 'doubao', jobId: message.jobId, attemptId: message.attemptId, results: message.results });
  if (message?.type === 'ZAOTU_IMPORTED_RESULT') post('DOUBAO_IMPORTED_RESULT', { result: message.result });
  if (message?.type === 'ZAOTU_STATUS') post('PLATFORM_STATUS', { platform: message.platform || 'doubao', jobId: message.jobId, attemptId: message.attemptId, timestamp: message.timestamp, state: message.state, message: message.message, errorCode: message.errorCode, results: message.results });
});
