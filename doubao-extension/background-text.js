// Dedicated text routes: no latest-tab fallback, no image routing, no content preparation.
const TEXT_VERSION = '0.5.1';
const TEXT_ROUTE = 'zaotuTextRoute:';
let textRouteTail = Promise.resolve();
const serialText = (operation) => { const result = textRouteTail.then(operation); textRouteTail = result.catch(() => {}); return result; };
const textIdentityMatches = (route, message) => route && message.kind === 'prompt_b' && message.protocolVersion === 'text-v1' && ['projectId', 'jobId', 'attemptId', 'routeSession', 'sourceFingerprint', 'platform'].every((key) => message[key] === route[key]);
const isWorkbenchSender = (sender) => Boolean(sender.tab?.id && /^http:\/\/(localhost|127\.0\.0\.1):(5173|5174)\//.test(sender.url || sender.tab.url || ''));
const textLeaseForTab = async (tabId) => {
  const stored = await chrome.storage.session.get(null);
  return Object.entries(stored).find(([key, route]) => key.startsWith(TEXT_ROUTE) && route.platformTabId === tabId && !route.terminal && Date.now() < route.expiresAt)?.[1];
};
const prepareText = (message, sender) => serialText(async () => {
  const job = message.job;
  if (!isWorkbenchSender(sender) || job?.kind !== 'prompt_b' || job.protocolVersion !== 'text-v1' || job.model !== 'current-page' || !['doubao', 'chatgpt'].includes(job.platform) || !job.jobId || !job.attemptId || !job.projectId || !job.routeSession || !job.source?.fingerprint || job.status !== 'preparing' || !Number.isFinite(Date.parse(job.expiresAt)) || Date.parse(job.expiresAt) <= Date.now()) throw new Error('INVALID_TEXT_ROUTE');
  const key = TEXT_ROUTE + job.jobId;
  if ((await chrome.storage.session.get(key))[key]) throw new Error('DUPLICATE_PREPARE');
  const tabs = await chrome.tabs.query({ url: PLATFORM_URLS[job.platform] });
  const ready = tabs.filter((tab) => tab.status === 'complete');
  const active = ready.filter((tab) => tab.active);
  const tab = ready.length === 1 ? ready[0] : active.length === 1 ? active[0] : null;
  if (!tab?.id) throw new Error('AMBIGUOUS_OR_MISSING_TEXT_TAB');
  if (await textLeaseForTab(tab.id)) throw new Error('TAB_BUSY');
  const ping = await sendTabMessage(tab.id, { type: 'ZAOTU_TEXT_PING' });
  if (!ping?.ok || ping.adapterVersion !== TEXT_VERSION || ping.protocolVersion !== 'text-v1' || ping.platform !== job.platform || !ping.capabilities?.includes('prompt_b') || !ping.pageUrl || !(job.platform === 'doubao' ? /^https:\/\/(?:[a-z0-9-]+\.)*doubao\.com\//i : /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//i).test(ping.pageUrl)) throw new Error('TEXT_ADAPTER_VERSION_MISMATCH');
  const route = { kind: 'prompt_b', protocolVersion: 'text-v1', platform: job.platform, projectId: job.projectId, jobId: job.jobId, attemptId: job.attemptId, routeSession: job.routeSession, sourceFingerprint: job.source.fingerprint, pageUrl: ping.pageUrl, sourceTabId: sender.tab.id, platformTabId: tab.id, expiresAt: Date.parse(job.expiresAt), terminal: false };
  await chrome.storage.session.set({ [key]: route });
  const response = await sendTabMessage(tab.id, { type: 'ZAOTU_RUN_TEXT', job, expectedPageUrl: route.pageUrl });
  if (!response?.ok) { route.terminal = true; await chrome.storage.session.set({ [key]: route }); throw new Error(response?.errorCode || 'TEXT_PREPARE_FAILED'); }
  return { ok: true, protocolVersion: 'text-v1', adapterVersion: TEXT_VERSION };
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'ZAOTU_PREPARE_TEXT') { prepareText(message, sender).then(respond).catch((error) => respond({ ok: false, errorCode: error.message })); return true; }
  if (!['ZAOTU_TEXT_EVENT', 'ZAOTU_CANCEL_TEXT', 'ZAOTU_REPLAY_TEXT', 'ZAOTU_ACK_TEXT'].includes(message?.type)) return;
  serialText(async () => {
    const key = TEXT_ROUTE + message.jobId, route = (await chrome.storage.session.get(key))[key];
    if (!textIdentityMatches(route, message)) return { ok: false, errorCode: 'TEXT_ROUTE_MISMATCH' };
    if (['ZAOTU_REPLAY_TEXT', 'ZAOTU_ACK_TEXT'].includes(message.type)) {
      if (!isWorkbenchSender(sender) || sender.tab.id !== route.sourceTabId) return { ok: false };
      if (message.type === 'ZAOTU_REPLAY_TEXT') {
        for (const event of route.pendingEvents || []) await toWorkbench(route, event);
      } else {
        const acknowledged = (route.pendingEvents || []).find((event) => event.eventId === message.eventId);
        route.pendingEvents = acknowledged && ['completed', 'failed'].includes(acknowledged.state) ? [] : (route.pendingEvents || []).filter((event) => event.eventId !== message.eventId);
        await chrome.storage.session.set({ [key]: route });
      }
      return { ok: true };
    }
    if (route.terminal || Date.now() >= route.expiresAt) return { ok: false, errorCode: 'TEXT_ROUTE_MISMATCH' };
    if (message.type === 'ZAOTU_CANCEL_TEXT') {
      if (!isWorkbenchSender(sender) || sender.tab.id !== route.sourceTabId) return { ok: false };
      route.terminal = true; await chrome.storage.session.set({ [key]: route });
      await sendTabMessage(route.platformTabId, message); return { ok: true };
    }
    if ((sender.url || sender.tab?.url) !== route.pageUrl || sender.tab?.id !== route.platformTabId || !PLATFORM_URLS[route.platform]?.some((pattern) => { try { const host = new URL(sender.url || sender.tab.url).hostname; return route.platform === 'doubao' ? /(^|\.)doubao\.com$/.test(host) : /^(chatgpt\.com|chat\.openai\.com)$/.test(host); } catch { return false; } })) return { ok: false, errorCode: 'WRONG_SENDER' };
    if (!['submitted', 'running', 'completed', 'failed'].includes(message.state)) return { ok: false };
    const event = { ...message, eventId: `${route.attemptId}:${(route.eventSequence || 0) + 1}` };
    route.eventSequence = (route.eventSequence || 0) + 1;
    route.pendingEvents = [...(route.pendingEvents || []), event].slice(-100);
    if (['completed', 'failed'].includes(message.state)) route.terminal = true;
    // Durable transport survives workbench reload or an offline server. ACK only after API save.
    await chrome.storage.session.set({ [key]: route });
    await toWorkbench(route, event); return { ok: true };
  }).then(respond).catch((error) => respond({ ok: false, errorCode: error.message }));
  return true;
});
