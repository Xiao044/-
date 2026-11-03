const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { crc32, createZip, makeImagePackage } = require('../lib/image-package');

const root = path.resolve(__dirname, '..');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXkAAAAASUVORK5CYII=', 'base64');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Read the central directory independently; use Node's native CRC for all payloads.
const unzip = (bytes) => {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 4), 0);
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const files = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    assert.equal(bytes.readUInt16LE(cursor + 8), 0x0800);
    assert.equal(bytes.readUInt16LE(cursor + 10), 0);
    const size = bytes.readUInt32LE(cursor + 24), length = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 46, cursor + 46 + length).toString('utf8');
    const local = bytes.readUInt32LE(cursor + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt32LE(local + 22), size);
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(dataStart, dataStart + size);
    assert.equal(zlib.crc32(data), bytes.readUInt32LE(cursor + 16));
    assert.equal(bytes.readUInt32LE(local + 14), zlib.crc32(data));
    assert.equal(files.has(name), false);
    assert.ok(!name.includes('..') && !name.includes('\\') && !name.startsWith('/'));
    files.set(name, data);
    cursor += 46 + length + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, end);
  return files;
};

const waitExit = (child, timeout = 2000) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
  const listener = () => { clearTimeout(timer); resolve(true); };
  const timer = setTimeout(() => { child.removeListener('exit', listener); resolve(false); }, timeout);
  child.once('exit', listener);
});
const fixture = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaotu-image-package-test-'));
  const uploadsDir = path.join(dir, 'uploads');
  const children = [];
  fs.mkdirSync(uploadsDir);
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ alpha: { projectId: 'alpha', projectName: '图片包' }, beta: { projectId: 'beta' }, '中文项目': { projectId: '中文项目' } }));
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        if (!await waitExit(child)) { child.kill('SIGKILL'); assert.ok(await waitExit(child), 'server did not stop; keep fixture'); }
      }
    }
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('zaotu-image-package-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return {
    dir, uploadsDir, children,
    image(name, bytes = png, projectId = 'alpha') {
      const file = path.join(uploadsDir, projectId, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      return `/uploads/${encodeURIComponent(projectId)}/${name.split('/').map(encodeURIComponent).join('/')}`;
    },
    save(assets) { fs.writeFileSync(path.join(dir, 'result-assets.json'), JSON.stringify(assets)); }
  };
};
const asset = (reference, extra = {}) => ({ assetId: 'asset-image-0001', projectId: 'alpha', status: 'archived', archivedUrl: reference, jobId: 'gen-1', attemptId: 'gen-1:doubao:1', platform: 'doubao', candidateId: 'candidate-1', promptVersion: 3, sourceUrl: 'https://never-fetch.invalid/result.png', dimensions: { width: 1, height: 1 }, tags: ['样品'], qualityLabels: ['clear'], ...extra });
const startServer = async (fixture) => {
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close((error) => error ? reject(error) : resolve(port)); });
  });
  const child = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, env: { ...process.env, PORT: String(port), ZAOTU_DATA_DIR: fixture.dir, DEEPSEEK_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  fixture.children.push(child);
  let logs = '', failure;
  child.stdout.on('data', (bytes) => { logs += bytes; }); child.stderr.on('data', (bytes) => { logs += bytes; }); child.once('error', (error) => { failure = error; });
  const base = `http://127.0.0.1:${port}`;
  for (let tries = 0; tries < 100; tries++) {
    if (failure) throw failure;
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(`${base}/api/health`)).ok) return base; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Image package test server did not start');
};
const snapshot = (dir) => {
  const data = [];
  const visit = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file); else data.push([path.relative(dir, file), stat.isSymbolicLink() ? fs.readlinkSync(file) : hash(fs.readFileSync(file))]);
    }
  };
  visit(dir); return data;
};

test('ZIP STORE supports UTF-8 names, correct CRC32 and safe ZIP32 limits', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const zip = createZip([{ name: '清单.json', bytes: Buffer.from('中文') }]);
  assert.equal(unzip(zip).get('清单.json').toString(), '中文');
  assert.throws(() => createZip([{ name: '../escape', bytes: png }]), /Invalid ZIP entry/);
  assert.throws(() => createZip([{ name: 'image.png', bytes: png }], 30), { code: 'IMAGE_EXPORT_LIMIT' });
});

test('image package preserves bytes, sources, hashes and all asset mappings while deduplicating files', (t) => {
  const f = fixture(t), reference = f.image('嵌套/珍珠.png');
  const assets = { first: asset(reference), second: asset(reference, { assetId: 'untrusted/../id', jobId: 'gen-2' }), temporary: asset(reference, { status: 'temp' }), deleted: asset(reference, { status: 'deleted' }), invalid: asset(reference, { status: 'invalid' }) };
  const before = snapshot(f.dir);
  const result = makeImagePackage({ projectId: 'alpha', assets, uploadsDir: f.uploadsDir });
  const files = unzip(result.bytes), manifest = JSON.parse(files.get('manifest.json'));
  assert.deepEqual([...files.keys()], ['manifest.json', 'images/000001.png']);
  assert.deepEqual(files.get('images/000001.png'), png);
  assert.equal(manifest.assets.length, 2);
  assert.equal(manifest.assets[0].sha256, hash(png));
  assert.equal(manifest.assets[0].size, png.length);
  assert.equal(manifest.assets[1].archivePath, manifest.assets[0].archivePath);
  for (const field of ['jobId', 'attemptId', 'platform', 'candidateId', 'promptVersion', 'sourceUrl', 'archivedUrl', 'dimensions', 'tags', 'qualityLabels']) assert.deepEqual(manifest.assets[0][field], assets.first[field]);
  assert.equal(manifest.summary.imageFiles, 1);
  assert.deepEqual(snapshot(f.dir), before);
});

test('legacy url-only assets match the asset API archived default and metadata is bounded', (t) => {
  const f = fixture(t), reference = f.image('legacy.png');
  const result = makeImagePackage({ projectId: 'alpha', uploadsDir: f.uploadsDir, assets: { legacy: { url: reference, tags: [{ nested: true }, '可用'], dimensions: { width: {}, height: 2 }, sourceUrl: { secret: true } } } });
  assert.equal(result.manifest.summary.imageFiles, 1);
  assert.equal(result.manifest.assets[0].archivedUrl, reference);
  assert.equal(result.manifest.assets[0].assetId, 'legacy');
  assert.deepEqual(result.manifest.assets[0].tags, ['可用']);
  assert.equal(result.manifest.assets[0].dimensions, null);
  assert.equal(result.manifest.assets[0].sourceUrl, '');
});

test('missing, foreign ownership, external and encoded traversal references produce explicit warnings', (t) => {
  const f = fixture(t);
  const reference = f.image('present.webp', Buffer.from('RIFFimageWEBP'));
  const result = makeImagePackage({ projectId: 'alpha', uploadsDir: f.uploadsDir, assets: {
    good: asset(reference), missing: asset('/uploads/alpha/missing.jpg'), foreign: asset(reference, { projectId: 'beta' }),
    external: asset('https://never-fetch.invalid/image.png'), traversal: asset('/uploads/alpha/%2e%2e/beta/secret.png'), cross: asset('/uploads/beta/secret.png'), unsupported: asset('/uploads/alpha/file.txt')
  } });
  const files = unzip(result.bytes);
  assert.equal(files.size, 2);
  assert.equal(result.manifest.summary.warningCount, 6);
  const codes = result.manifest.warnings.map((item) => item.code);
  for (const code of ['IMAGE_MISSING', 'PROJECT_OWNERSHIP_CONFLICT', 'UNSAFE_REFERENCE', 'UNSUPPORTED_IMAGE']) assert.ok(codes.includes(code));
  assert.equal(result.manifest.assets.find((item) => item.exportStatus === 'missing').archivePath, null);
});

test('empty projects and all-missing images return a valid manifest-only package', (t) => {
  const f = fixture(t);
  for (const assets of [{}, { missing: asset('/uploads/alpha/missing.png') }]) {
    const result = makeImagePackage({ projectId: 'alpha', assets, uploadsDir: f.uploadsDir });
    assert.deepEqual([...unzip(result.bytes).keys()], ['manifest.json']);
    assert.equal(result.manifest.summary.imageFiles, 0);
  }
});

test('single-image, complete ZIP and asset-count limits fail before a partial archive is returned', (t) => {
  const f = fixture(t), reference = f.image('image.png');
  const input = { projectId: 'alpha', assets: { one: asset(reference) }, uploadsDir: f.uploadsDir };
  assert.throws(() => makeImagePackage({ ...input, limits: { maxFileBytes: 1 } }), { status: 413, code: 'IMAGE_EXPORT_FILE_LIMIT' });
  assert.throws(() => makeImagePackage({ ...input, limits: { maxZipBytes: png.length + 50 } }), { status: 413, code: 'IMAGE_EXPORT_LIMIT' });
  assert.throws(() => makeImagePackage({ ...input, assets: { one: asset(reference), two: asset(reference) }, limits: { maxAssets: 1 } }), { status: 413, code: 'IMAGE_EXPORT_LIMIT' });
  for (const limits of [{ maxAssets: 0 }, { maxZipBytes: Infinity }, { maxFileBytes: 9000000 }]) assert.throws(() => makeImagePackage({ ...input, limits }), { code: 'INVALID_IMAGE_EXPORT_INPUT' });
  assert.throws(() => makeImagePackage({ ...input, projectId: '../alpha' }), { code: 'INVALID_IMAGE_EXPORT_INPUT' });
  assert.throws(() => makeImagePackage({ ...input, assets: [] }), { code: 'INVALID_IMAGE_EXPORT_INPUT' });
});

test('directory links into another project and directories pretending to be files are rejected', (t) => {
  const f = fixture(t);
  f.image('secret.png', Buffer.from('private beta bytes'), 'beta');
  fs.symlinkSync(path.join(f.uploadsDir, 'beta'), path.join(f.uploadsDir, 'alpha'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = makeImagePackage({ projectId: 'alpha', assets: { link: asset('/uploads/alpha/secret.png') }, uploadsDir: f.uploadsDir });
  assert.equal(unzip(result.bytes).size, 1);
  assert.equal(result.manifest.warnings[0].code, 'UNSAFE_REFERENCE');
  const other = fixture(t);
  fs.mkdirSync(path.join(other.uploadsDir, 'alpha', 'directory.png'), { recursive: true });
  const directory = makeImagePackage({ projectId: 'alpha', assets: { dir: asset('/uploads/alpha/directory.png') }, uploadsDir: other.uploadsDir });
  assert.equal(directory.manifest.warnings[0].code, 'UNSAFE_REFERENCE');
});

test('file symlinks cannot leak another project image', (t) => {
  const f = fixture(t);
  f.image('secret.png', png, 'beta');
  fs.mkdirSync(path.join(f.uploadsDir, 'alpha'));
  try { fs.symlinkSync(path.join(f.uploadsDir, 'beta', 'secret.png'), path.join(f.uploadsDir, 'alpha', 'link.png')); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('file symlinks unavailable on this host'); return; } throw error; }
  const result = makeImagePackage({ projectId: 'alpha', assets: { link: asset('/uploads/alpha/link.png') }, uploadsDir: f.uploadsDir });
  assert.equal(result.manifest.warnings[0].code, 'UNSAFE_REFERENCE');
  assert.equal(unzip(result.bytes).size, 1);
});

test('HTTP image export is a read-only ZIP download with counts, ownership and unchanged JSON export', async (t) => {
  const f = fixture(t);
  const reference = f.image('product.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  f.save({ alpha: { first: asset(reference), missing: asset('/uploads/alpha/missing.png') }, beta: { secret: asset(f.image('beta.png', png, 'beta'), { projectId: 'beta' }) } });
  const base = await startServer(f), before = snapshot(f.dir);
  const response = await fetch(`${base}/api/projects/alpha/export-images`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-disposition'), /attachment; filename="project-images.zip"/);
  assert.equal(response.headers.get('x-export-image-count'), '1');
  assert.equal(response.headers.get('x-export-warning-count'), '1');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(Number(response.headers.get('content-length')), bytes.length);
  const files = unzip(bytes);
  assert.deepEqual(files.get('images/000001.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal(JSON.parse(files.get('manifest.json')).assets.length, 2);
  assert.deepEqual(snapshot(f.dir), before);
  assert.equal((await fetch(`${base}/api/projects/alpha/export`)).status, 200);
  assert.equal((await fetch(`${base}/api/projects/missing/export-images`)).status, 404);
  assert.equal((await fetch(`${base}/api/projects/%ZZ/export-images`)).status, 400);
  const unicode = await fetch(`${base}/api/projects/${encodeURIComponent('中文项目')}/export-images`);
  assert.equal(unicode.status, 200);
  assert.match(unicode.headers.get('content-disposition'), /filename\*=UTF-8''%/);
});

test('HTTP empty image exports do not read inherited properties for valid project ids', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'projects.json'), JSON.stringify({ toString: { projectId: 'toString' }, valueOf: { projectId: 'valueOf' } }));
  const base = await startServer(f);
  for (const store of [null, { alpha: {} }]) {
    if (store === null) assert.equal(fs.existsSync(path.join(f.dir, 'result-assets.json')), false);
    else f.save(store);
    for (const projectId of ['toString', 'valueOf']) {
      const response = await fetch(`${base}/api/projects/${projectId}/export-images`);
      assert.equal(response.status, 200, `${projectId}: ${store === null ? 'missing store' : 'other project only'}`);
      const files = unzip(Buffer.from(await response.arrayBuffer()));
      assert.deepEqual([...files.keys()], ['manifest.json']);
      const manifest = JSON.parse(files.get('manifest.json'));
      assert.equal(manifest.projectId, projectId);
      assert.equal(manifest.summary.archivedAssets, 0);
      assert.equal(manifest.summary.warningCount, 0);
    }
  }
});

test('HTTP image export reports corrupted stores and oversized files as JSON errors', async (t) => {
  const f = fixture(t), reference = f.image('large.png');
  fs.truncateSync(path.join(f.uploadsDir, 'alpha', 'large.png'), 8 * 1024 * 1024 + 1);
  f.save({ alpha: { large: asset(reference) } });
  const base = await startServer(f);
  const large = await fetch(`${base}/api/projects/alpha/export-images`);
  assert.equal(large.status, 413);
  assert.equal((await large.json()).errorCode, 'IMAGE_EXPORT_FILE_LIMIT');
  fs.writeFileSync(path.join(f.dir, 'result-assets.json'), '{invalid');
  const corrupt = await fetch(`${base}/api/projects/alpha/export-images`);
  assert.equal(corrupt.status, 500);
  assert.equal((await corrupt.json()).errorCode, 'IMAGE_EXPORT_FAILED');
});
