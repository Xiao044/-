importScripts('protocol.js');
const PLATFORM_URLS = {
  chatgpt: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  gemini: ['https://gemini.google.com/*'],
  lovart: ['https://lovart.ai/*', 'https://www.lovart.ai/*'],
  doubao: ['https://www.doubao.com/*', 'https://doubao.com/*', 'https://*.doubao.com/*']
};
const ROUTE_PREFIX = 'zaotuBridgeRoute:';
const JOB_ROUTE_PREFIX = 'zaotuBridgeJob:';

const sendTabMessage = (tabId, message) => new Promise((resolve, reject) => {
  chrome.tabs.sendMessage(tabId, message, (response) => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(response);
  });
});

const findPlatformTab = async (platform) => {
  const tabs = await chrome.tabs.query({ url: PLATFORM_URLS[platform] || [] });
  return tabs.find((tab) => tab.active && tab.status === 'complete') || tabs.find((tab) => tab.status === 'complete') || tabs[0] || null;
};

const adapterFiles = {
  chatgpt: ['platform-common.js', 'content-chatgpt.js'],
  gemini: ['platform-common.js', 'content-gemini.js'],
  lovart: ['platform-common.js', 'content-lovart.js'],
  doubao: ['content-doubao.js']
};

const connectPlatformTab = async (platform, tab) => {
  if (!tab?.id) throw Object.assign(new Error(`请先打开${platform}网页并登录。`), { needsPage: true });
  const ping = platform === 'doubao' ? 'ZAOTU_DOUBAO_PING' : 'ZAOTU_PLATFORM_PING';
  try {
    const response = await sendTabMessage(tab.id, { type: ping });
    if (response?.ok && (platform === 'doubao' || response.platform === platform)) return tab;
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: adapterFiles[platform] });
  const response = await sendTabMessage(tab.id, { type: ping });
  if (!response?.ok) throw new Error(`${platform} 页面桥接脚本未就绪，请刷新页面后重试。`);
  return tab;
};

const blobToDataUrl = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:${blob.type};base64,${btoa(binary)}`;
};

const isExampleProductImage = (url) =>
  /(?:^|\/)assets\/pearl-necklace\.svg(?:[?#].*)?$/i.test(String(url || ''));

const prepareImageForPlatform = async (payload) => {
  const sourceUrl = payload.imageDataUrl || (isExampleProductImage(payload.imageUrlAbsolute) ? '' : payload.imageUrlAbsolute);
  if (!sourceUrl) return payload;
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`商品图片读取失败（${response.status}）。`);
  const blob = await response.blob();
  if (['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) {
    return { ...payload, imageDataUrl: payload.imageDataUrl || await blobToDataUrl(blob), imageMimeType: blob.type };
  }
  if (blob.type !== 'image/svg+xml') throw new Error('商品图片只支持 PNG、JPEG、WebP 或 SVG。');
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (error) {
    throw new Error('商品 SVG 图片无法解码，请改用 PNG、JPEG 或 WebP 格式。');
  }
  const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法转换 SVG 商品图片。');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const png = await canvas.convertToBlob({ type: 'image/png' });
  if (png.size > 8 * 1024 * 1024) throw new Error('转换后的商品图片超过 8MB。');
  return { ...payload, imageDataUrl: await blobToDataUrl(png), imageMimeType: 'image/png' };
};

const saveRoute = async (job, sourceTabId, platformTabId) => {
  const route = { jobId: job.jobId, platform: job.platform, attemptId: job.attemptId || '', sourceTabId, platformTabId, createdAt: Date.now() };
  await chrome.storage.session.set({ [`${ROUTE_PREFIX}${platformTabId}`]: route, [`${JOB_ROUTE_PREFIX}${job.jobId}:${job.platform}`]: route });
};

const findRoute = async (message, sender) => {
  if (message.jobId) {
    if (!message.platform) return null;
    const key = `${JOB_ROUTE_PREFIX}${message.jobId}:${String(message.platform).toLowerCase()}`;
    const stored = await chrome.storage.session.get(key);
    const route = stored[key];
    if (!route || route.jobId !== String(message.jobId) || route.platform !== String(message.platform).toLowerCase()) return null;
    return route;
  }
  if (sender.tab?.id) {
    const stored = await chrome.storage.session.get(`${ROUTE_PREFIX}${sender.tab.id}`);
    if (stored[`${ROUTE_PREFIX}${sender.tab.id}`]) return stored[`${ROUTE_PREFIX}${sender.tab.id}`];
  }
  return null;
};

const routesForPlatformTab = async (platformTabId) => {
  const stored = await chrome.storage.session.get(null);
  return Object.entries(stored).filter(([key, value]) => (key.startsWith(JOB_ROUTE_PREFIX) || key.startsWith(ROUTE_PREFIX))
    && value && Number(value.platformTabId) === Number(platformTabId));
};

const protocolEvent = (message = {}, defaults = {}) => ZaotuProtocol.normalizeEvent(message, defaults);

const toWorkbench = async (route, message) => {
  if (!route?.sourceTabId) return false;
  try { await chrome.tabs.sendMessage(route.sourceTabId, message); return true; }
  catch (error) { console.warn('[造图扩展] 工作台回传失败', error.message); return false; }
};

const preparePlatformJob = async (platform, payload, sourceTabId) => {
  if (!PLATFORM_URLS[platform]) throw new Error('不支持的生图平台。');
  const tab = await findPlatformTab(platform);
  await connectPlatformTab(platform, tab);
  const job = { ...await prepareImageForPlatform(payload), platform };
  await saveRoute(job, sourceTabId, tab.id);
  const type = platform === 'doubao' ? 'ZAOTU_RUN_DOUBAO_JOB' : 'ZAOTU_RUN_PLATFORM_JOB';
  const response = await sendTabMessage(tab.id, { type, platform, job });
  if (!response || response.ok !== true) throw Object.assign(new Error(response?.message || `${platform} 页面适配器未确认任务已发送。`), { needsPage: false });
  return { ...response, platform, tabId: tab.id, platformTabId: tab.id };
};

const readSelectedImage = async (result) => {
  if (!result?.url) throw new Error('没有选择结果图片。');
  const response = await fetch(result.url);
  if (!response.ok) throw new Error(`结果图片读取失败（${response.status}）。`);
  const blob = await response.blob();
  const type = blob.type.split(';')[0].toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new Error('结果图片格式不受支持。');
  if (blob.size > 8 * 1024 * 1024) throw new Error('单张结果图片不能超过 8MB。');
  return { ...result, imageDataUrl: await blobToDataUrl(blob), imageMimeType: type };
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ZAOTU_PREPARE_DOUBAO' || message?.type === 'ZAOTU_PREPARE_PLATFORM') {
    const platform = message.type === 'ZAOTU_PREPARE_DOUBAO' ? 'doubao' : String(message.platform || '').toLowerCase();
    preparePlatformJob(platform, message.payload || {}, sender.tab?.id)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, platform, needsPage: Boolean(error.needsPage), message: error.message || `${platform} 页面连接失败。` }));
    return true;
  }

  if (message?.type === 'ZAOTU_OPEN_DOUBAO' || message?.type === 'ZAOTU_OPEN_PLATFORM') {
    const platform = message.type === 'ZAOTU_OPEN_DOUBAO' ? 'doubao' : String(message.platform || '').toLowerCase();
    const url = { chatgpt: 'https://chatgpt.com/', gemini: 'https://gemini.google.com/', lovart: 'https://lovart.ai/', doubao: 'https://www.doubao.com/' }[platform];
    if (!url) { sendResponse({ ok: false, message: '不支持的平台。' }); return false; }
    chrome.tabs.create({ url }, (tab) => sendResponse(chrome.runtime.lastError ? { ok: false, message: chrome.runtime.lastError.message } : { ok: true, platform, tabId: tab?.id }));
    return true;
  }

  if (message?.type === 'ZAOTU_RESULT_CANDIDATES' || message?.type === 'ZAOTU_STATUS') {
    findRoute(message, sender).then((route) => toWorkbench(route, protocolEvent(message, { platform: route?.platform || 'doubao', jobId: route?.jobId, attemptId: route?.attemptId, type: message.type }))).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === 'ZAOTU_CANCEL_PLATFORM_JOB') {
    const platform = String(message.platform || '').toLowerCase();
    findRoute(message, sender).then(async (route) => {
      const tabId = route?.platformTabId || (!message.jobId ? (await findPlatformTab(platform))?.id : null);
      if (!tabId) throw Object.assign(new Error('目标平台页面未打开。'), { needsPage: true });
      if (route && route.platform !== platform) throw Object.assign(new Error('取消任务的平台路由不匹配。'), { needsPage: false });
      const response = await sendTabMessage(tabId, message);
      if (!response || response.ok !== true) throw Object.assign(new Error(response?.message || '平台适配器未确认取消任务。'), { needsPage: false });
      return response;
    }).then((response) => sendResponse(response))
      .catch(async (error) => {
        const route = await findRoute(message, sender).catch(() => null);
        if (route) await toWorkbench(route, protocolEvent({ type: 'PLATFORM_STATUS', platform, jobId: message.jobId, attemptId: message.attemptId, state: error.needsPage ? 'not_open' : 'extension_disconnected', message: error.message || '扩展与平台页面连接已断开。' }));
        sendResponse({ ok: false, platform, needsPage: Boolean(error.needsPage), message: error.message || '取消平台任务失败。' });
      });
    return true;
  }

  if (message?.type === 'ZAOTU_IMPORT_SELECTED') {
    readSelectedImage(message.result).then((result) => sendResponse({ ok: true, result })).catch((error) => {
      findRoute({ jobId: message.result?.jobId, platform: message.platform }, sender)
        .then((route) => toWorkbench(route, { type: 'ZAOTU_STATUS', platform: message.platform, jobId: message.result?.jobId, attemptId: message.result?.attemptId, timestamp: new Date().toISOString(), state: 'import_error', errorCode: 'IMPORT_FAILED', message: error.message || '结果图片读取失败。' }));
      sendResponse({ ok: false, message: error.message || '结果图片读取失败。' });
    });
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  routesForPlatformTab(tabId).then(async (entries) => {
    const keys = [...new Set(entries.map(([key]) => key).concat(`${ROUTE_PREFIX}${tabId}`))];
    const routes = [...new Map(entries.map(([, route]) => [`${route.jobId}:${route.platform}:${route.attemptId}:${route.sourceTabId}`, route])).values()];
    await Promise.all(routes.map((route) => toWorkbench(route, protocolEvent({
      type: 'PLATFORM_STATUS', platform: route.platform, jobId: route.jobId, attemptId: route.attemptId,
      platformTabId: tabId, state: 'not_open', errorCode: 'PAGE_NOT_OPEN', message: '平台页面已关闭，请重新打开并重试。'
    }))));
    return chrome.storage.session.remove(keys);
  }).catch((error) => console.warn('[造图扩展] 平台标签页移除处理失败', error.message));
});
