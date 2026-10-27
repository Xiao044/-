(() => {
  const ERROR_CODES = {
    login_required: 'LOGIN_REQUIRED',
    not_open: 'PAGE_NOT_OPEN',
    extension_disconnected: 'EXTENSION_DISCONNECTED',
    upload_error: 'UPLOAD_FAILED',
    submit_error: 'SUBMIT_FAILED',
    result_timeout: 'RESULT_TIMEOUT',
    adapter_error: 'ADAPTER_ERROR',
    import_error: 'IMPORT_FAILED',
    cancelled: 'CANCELLED',
    failed: 'PLATFORM_FAILED'
  };
  const text = (value, max = 1000) => String(value ?? '').slice(0, max);
  const timestamp = (value) => {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
  };
  const errorCodeFor = (state) => ERROR_CODES[String(state || '')] || '';
  const normalizeEvent = (event = {}, defaults = {}) => {
    const source = event && typeof event === 'object' ? event : {};
    const state = text(source.state || defaults.state || '', 80);
    const normalized = {
      ...source,
      type: source.type || defaults.type || 'PLATFORM_STATUS',
      timestamp: timestamp(source.timestamp || defaults.timestamp),
      jobId: text(source.jobId || defaults.jobId, 160),
      platform: text(source.platform || defaults.platform, 40).toLowerCase(),
      attemptId: text(source.attemptId || defaults.attemptId, 160),
      state,
      message: text(source.message || defaults.message, 1000),
      errorCode: text(source.errorCode || defaults.errorCode || errorCodeFor(state), 120)
    };
    if (Array.isArray(source.results) || Array.isArray(defaults.results)) normalized.results = Array.isArray(source.results) ? source.results : defaults.results;
    return normalized;
  };
  const isProtocolEvent = (type) => new Set(['PLATFORM_STATUS', 'PLATFORM_RESULT_CANDIDATES', 'PLATFORM_ERROR', 'PLATFORM_OPENED', 'PLATFORM_PAGE_OPENED', 'DOUBAO_STATUS', 'DOUBAO_RESULT_CANDIDATES', 'DOUBAO_ERROR']).has(type);
  const api = { ERROR_CODES, errorCodeFor, normalizeEvent, isProtocolEvent };
  if (typeof globalThis !== 'undefined') globalThis.ZaotuProtocol = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
