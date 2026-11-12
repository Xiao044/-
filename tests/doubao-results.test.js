const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixtureFile = fs.readFileSync(path.join(__dirname, 'extension-adapters.test.js'), 'utf8');
const { makeFixture, FixtureElement, add, makeImage, load } = new Function('require', '__dirname', fixtureFile.slice(0, fixtureFile.indexOf("\ntest('protocol")) + '\nreturn {makeFixture,FixtureElement,add,makeImage,load};')(require, __dirname);
const imageUrl = (id, variant = 'cgen', host = 'p26') => `https://${host}-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/${id}.jpeg~tplv-a9rns2rl98-${variant}_lwm3.png?x-signature=fixture`;
const setup = () => {
  const fixture = makeFixture({ platform: 'doubao', generatedOnClick: false });
  const intervals = [];
  fixture.context.setInterval = (callback) => { const timer = { callback, cleared: false }; intervals.push(timer); return timer; };
  fixture.context.clearInterval = (timer) => { if (timer) timer.cleared = true; };
  fixture.context.FileReader = class { readAsDataURL() { this.result = 'data:image/jpeg;base64,UkVTVUxU'; this.onload?.(); } };
  load(fixture, 'protocol.js', 'content-doubao.js');
  const message = (role) => add(fixture.document.querySelector('main'), new FixtureElement('div', {
    'data-testid': role === 'user' ? 'send_message' : 'receive_message', 'data-message-role': role
  }));
  const generated = (parent, id, variant = 'cgen', options = {}) => {
    let grid = parent.querySelector('[data-testid="message_image_content"]');
    if (!grid) grid = add(parent, new FixtureElement('div', { 'data-testid': 'message_image_content' }));
    const cell = add(grid, new FixtureElement('div'));
    return add(cell, makeImage({ src: imageUrl(id, variant, variant === 'cthumb' ? 'p3' : 'p26'), alt: 'image' }, options));
  };
  const collect = (previous = new Set(), context) => {
    fixture.context.previousUrls = previous; fixture.context.resultContext = context;
    return vm.runInContext('imageCandidates(previousUrls, resultContext)', fixture.context);
  };
  const snapshot = (job = {}) => { fixture.context.jobInput = job; return vm.runInContext('captureDoubaoResultContext(jobInput)', fixture.context); };
  const monitor = (context = {}) => {
    fixture.context.resultContext = context;
    vm.runInContext("activeDoubaoJobId='job-result'; activeDoubaoAttemptId='attempt-result'; monitorResults(new Set(), 'job-result', 'attempt-result', resultContext)", fixture.context);
    return intervals.at(-1);
  };
  return { ...fixture, message, generated, collect, snapshot, monitor, intervals };
};

test('Doubao result collection excludes the uploaded user original and SVG sizing placeholder', () => {
  const s = setup();
  add(s.message('user'), makeImage({ src: 'blob:https://www.doubao.com/user-original', alt: '' }));
  const reply = s.message('assistant');
  const full = s.generated(reply, 'generated-asset', 'cgen', { naturalWidth: 1792, naturalHeight: 1344 });
  s.generated(reply, 'generated-asset', 'cthumb', { naturalWidth: 384, naturalHeight: 288 });
  add(full.parentElement, makeImage({ src: 'data:image/svg+xml,%3csvg%20width=%221792%22/%3e', 'aria-hidden': 'true' }));
  const found = s.collect();
  assert.equal(found.length, 1);
  assert.equal(found[0].url, full.src);
});

test('Doubao result collection rejects input previews, user copies, lightboxes and unowned page images', () => {
  const s = setup();
  for (const parent of [s.message('user'), s.prompt.parentElement, s.document.body]) add(parent, makeImage({ src: imageUrl('input-copy') }));
  const dialog = add(s.document.body, new FixtureElement('div', { role: 'dialog' }));
  add(dialog, makeImage({ src: imageUrl('lightbox') }));
  const reply = s.message('assistant');
  add(reply, makeImage({ src: 'https://cdn.example/article-illustration.png' }));
  assert.equal(s.collect().length, 0, 'only assistant generation grids are results, not arbitrary assistant illustrations');
});

test('Doubao output deduplication uses the generated asset path across CDN hosts and signing changes', () => {
  const s = setup(), reply = s.message('assistant');
  const first = s.generated(reply, 'same-asset', 'cthumb', { naturalWidth: 384, naturalHeight: 288 });
  const full = s.generated(reply, 'same-asset', 'cgen', { naturalWidth: 1792, naturalHeight: 1344 });
  s.generated(reply, 'different-asset', 'cgen');
  const found = s.collect();
  assert.equal(found.length, 2);
  assert.ok(found.some(row => row.url === full.src));
  assert.equal(found.some(row => row.url === first.src), false);
  const baseline = new Set([first.src.replace('x-signature=fixture', 'x-signature=old')]);
  assert.equal(s.collect(baseline).length, 1, 'a re-signed larger copy of an earlier result is not a new output');
});

test('Doubao snapshot excludes prior assistant replies even when their images load after submission', () => {
  const s = setup(), old = s.message('assistant');
  const context = s.snapshot();
  s.generated(old, 'late-old-image');
  s.message('user'); const current = s.message('assistant'); s.generated(current, 'new-image');
  const found = s.collect(new Set(), context);
  assert.equal(found.length, 1); assert.match(found[0].url, /new-image/);
});

test('Doubao input URL exclusion is refreshed from user message images even when echoed by the assistant', () => {
  const s = setup(), context = s.snapshot({ imageDataUrl: 'data:image/jpeg;base64,T1JJR0lOQUw=' });
  const user = s.message('user'); add(user, makeImage({ src: imageUrl('original-rehosted') }));
  const reply = s.message('assistant'); s.generated(reply, 'original-rehosted');
  s.generated(reply, 'actual-output');
  const grid = reply.querySelector('[data-testid="message_image_content"]');
  add(grid, makeImage({ src: 'data:image/jpeg;base64,T1JJR0lOQUw=' }));
  const found = s.collect(new Set(), context);
  assert.equal(found.length, 1); assert.match(found[0].url, /actual-output/);
});

test('Doubao leaves incomplete, hidden, SVG and tiny images out of result counts', () => {
  const s = setup(), reply = s.message('assistant');
  s.generated(reply, 'not-loaded', 'cgen', { complete: false });
  s.generated(reply, 'hidden', 'cgen', { style: { display: 'none' } });
  s.generated(reply, 'tiny', 'cgen', { naturalWidth: 20, naturalHeight: 20 });
  const svg = s.generated(reply, 'svg'); svg.src = svg.currentSrc = 'data:image/svg+xml;base64,PHN2Zy8+';
  assert.equal(s.collect().length, 0);
});

test('Doubao same-cell thumbnail to full-size upgrade has a stable candidate identity', () => {
  const s = setup(), reply = s.message('assistant');
  const thumb = s.generated(reply, 'upgrade', 'cthumb', { naturalWidth: 384, naturalHeight: 288 });
  const first = s.collect()[0];
  add(thumb.parentElement, makeImage({ src: imageUrl('upgrade'), alt: '' }, { naturalWidth: 1792, naturalHeight: 1344 }));
  const second = s.collect()[0];
  assert.equal(first.candidateId, second.candidateId);
  assert.ok(first.candidateId, 'candidate id must not use Date.now or image URL prefix');
  assert.notEqual(first.url, second.url);
});

test('Doubao result monitor emits only one high-resolution generated candidate and stable counts', async () => {
  const s = setup(), reply = s.message('assistant');
  add(s.message('user'), makeImage({ src: 'https://cdn.example/original.png' }));
  s.generated(reply, 'monitor-output', 'cthumb', { naturalWidth: 384, naturalHeight: 288 });
  s.generated(reply, 'monitor-output', 'cgen', { naturalWidth: 1792, naturalHeight: 1344 });
  const timer = s.monitor();
  await timer.callback(); await timer.callback();
  const events = s.chrome.runtime.sent.filter(e => e.type === 'ZAOTU_RESULT_CANDIDATES');
  assert.equal(events.length, 1); assert.equal(events[0].results.length, 1);
  assert.equal(events[0].results[0].origin, 'assistant-generated');
  assert.match(events[0].results[0].url, /cgen/);
  assert.match(s.chrome.runtime.sent.at(-1).message, /1 张/);
});

test('Doubao async result conversion cannot emit after cancellation or a newer attempt', async () => {
  for (const cancel of [false, true]) {
    const s = setup(), reply = s.message('assistant');
    const image = s.generated(reply, 'blob-output'); image.src = image.currentSrc = 'blob:https://www.doubao.com/generated';
    let resolve;
    s.context.fetch = () => new Promise(yes => { resolve = yes; });
    const timer = s.monitor(), pending = timer.callback();
    if (cancel) vm.runInContext("activeDoubaoJobId=''; activeDoubaoAttemptId=''", s.context);
    else vm.runInContext("activeDoubaoJobId='job-result'; activeDoubaoAttemptId='new-attempt'", s.context);
    resolve({ ok: true, blob: async () => ({ type: 'image/jpeg' }) }); await pending;
    assert.equal(s.chrome.runtime.sent.filter(e => e.type === 'ZAOTU_RESULT_CANDIDATES').length, 0);
    assert.equal(s.chrome.runtime.sent.some(e => e.state === 'result_ready'), false);
  }
});

test('Doubao result monitor serializes in-flight reads and retries a failed read without announcing it', async () => {
  const s = setup(), reply = s.message('assistant');
  const image = s.generated(reply, 'blob-read'); image.src = image.currentSrc = 'blob:https://www.doubao.com/output';
  let resolve, requests = 0;
  const read = new Promise(yes => { resolve = yes; });
  s.context.fetch = () => { requests++; return read; };
  const timer = s.monitor(), pending = timer.callback(), repeated = timer.callback();
  resolve({ ok: false, status: 503 }); await Promise.all([pending, repeated]);
  assert.equal(requests, 1);
  assert.equal(s.chrome.runtime.sent.some(e => e.state === 'result_ready'), false);
  s.context.fetch = async () => ({ ok: true, blob: async () => ({ type: 'image/jpeg' }) });
  await timer.callback();
  assert.equal(s.chrome.runtime.sent.filter(e => e.type === 'ZAOTU_RESULT_CANDIDATES').length, 1);
});

test('Doubao failed and slow candidates do not suppress later successful reads of another image', async () => {
  const s = setup(), reply = s.message('assistant');
  const image = s.generated(reply, 'one-blob'); image.src = image.currentSrc = 'blob:https://www.doubao.com/blob-result';
  s.generated(reply, 'one-http');
  s.context.fetch = async () => ({ ok: false, status: 503 });
  const timer = s.monitor(); await timer.callback();
  assert.equal(s.chrome.runtime.sent.filter(e => e.type === 'ZAOTU_RESULT_CANDIDATES').at(-1).results.length, 1);
  s.context.fetch = async () => ({ ok: true, blob: async () => ({ type: 'image/jpeg' }) }); await timer.callback();
  assert.equal(s.chrome.runtime.sent.filter(e => e.type === 'ZAOTU_RESULT_CANDIDATES').at(-1).results.length, 2);
});

test('workbench replaces a Doubao thumbnail with the same generated asset full-size URL rather than appending a duplicate', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const declaration = (name) => { const start = html.indexOf(`      const ${name} =`); assert.ok(start >= 0); return html.slice(start, html.indexOf('\n      const ', start + 12)); };
  const c = { URL, window: { location: { href: 'http://localhost:5173/' } }, generatedResults: [], resultSelected: -1, generationJobId: 'job' };
  vm.createContext(c);
  vm.runInContext(['normalizeResultUrl','normalizeResult','resultKey','mergePlatformResults'].map(declaration).join('\n'),c);
  c.batch = [{ id: 'thumb', url: imageUrl('same') .replace('-cgen_', '-cthumb_'), platform: 'doubao' }];
  vm.runInContext("mergePlatformResults('doubao', batch, 'job', 'attempt')",c);
  c.resultSelected = 0; c.batch = [{ id: 'full', url: imageUrl('same'), platform: 'doubao' }];
  const changed = vm.runInContext("mergePlatformResults('doubao', batch, 'job', 'attempt')",c);
  assert.equal(c.generatedResults.length,1); assert.equal(c.resultSelected,0); assert.equal(changed.length,1);
  assert.equal(c.generatedResults[0].url, c.batch[0].url);
});


test('Doubao inline raster candidate identifiers remain compact and do not contain image data', () => {
  const s = setup(), reply = s.message('assistant');
  const image = s.generated(reply, 'inline'); image.src = image.currentSrc = `data:image/jpeg;base64,${'a'.repeat(10000)}`;
  const candidate = s.collect()[0];
  assert.ok(candidate.candidateId.length < 120);
  assert.equal(candidate.candidateId.includes('base64'), false);
});

test('Doubao generation grids explicitly still running are not announced until finished', () => {
  const s = setup(), reply = s.message('assistant'); s.generated(reply, 'still-running');
  const grid = reply.querySelector('[data-testid="message_image_content"]');
  grid.setAttribute('data-finished', 'false'); assert.equal(s.collect().length, 0);
  grid.setAttribute('data-finished', 'true'); assert.equal(s.collect().length, 1);
});

test('Doubao URL keys cannot collapse unrelated hosts merely containing the generated path', () => {
  const s = setup(), reply = s.message('assistant');
  const a = s.generated(reply, 'source'); a.src = a.currentSrc = 'https://example.test/rc_gen_image/same.png?v=1';
  const b = s.generated(reply, 'source'); b.src = b.currentSrc = 'https://other.test/rc_gen_image/same.png?v=1';
  assert.equal(s.collect().length, 2);
});

test('workbench retains the full-size generated asset when a later poll only sees its thumbnail', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const declaration = (name) => { const start = html.indexOf(`      const ${name} =`); return html.slice(start, html.indexOf('\n      const ', start + 12)); };
  const original = { id:'full',url:imageUrl('keep-full'),platform:'doubao',jobId:'job',attemptId:'attempt',saved:true,dimensions:{width:1792,height:1344} };
  const c = { URL,window:{location:{href:'http://localhost:5173/'}},generatedResults:[original],resultSelected:0,generationJobId:'job' };
  vm.createContext(c); vm.runInContext(['normalizeResultUrl','normalizeResult','resultKey','mergePlatformResults'].map(declaration).join('\n'),c);
  c.batch=[{id:'thumb',url:imageUrl('keep-full','cthumb'),platform:'doubao',dimensions:{width:384,height:288}}];
  const changed=vm.runInContext("mergePlatformResults('doubao',batch,'job','attempt')",c);
  assert.equal(c.generatedResults.length,1); assert.equal(c.generatedResults[0].url,original.url); assert.equal(changed.length,0);
  assert.equal(c.generatedResults[0].saved,true); assert.equal(c.resultSelected,0);
});

test('Doubao pending image reads cannot publish after monitor timeout or replacement with the same job ids', async () => {
  for (const expired of [true, false]) {
    const s = setup(), reply = s.message('assistant');
    const image = s.generated(reply, 'delayed'); image.src = image.currentSrc = 'blob:https://www.doubao.com/slow-result';
    let resolve, now = Date.now();
    s.context.Date = class extends Date { static now() { return now; } };
    s.context.fetch = () => new Promise(yes => { resolve = yes; });
    const timer = s.monitor(), pending = timer.callback();
    if (expired) { now += 10 * 60 * 1000 + 1; await timer.callback(); }
    else s.monitor();
    resolve({ ok: true, blob: async () => ({ type: 'image/jpeg' }) }); await pending;
    assert.equal(s.chrome.runtime.sent.some(e => e.type === 'ZAOTU_RESULT_CANDIDATES'), false);
    assert.equal(s.chrome.runtime.sent.some(e => e.state === 'result_ready'), false);
  }
});
