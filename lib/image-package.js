const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_LIMITS = Object.freeze({ maxFileBytes: 8 * 1024 * 1024, maxZipBytes: 64 * 1024 * 1024, maxAssets: 1000 });
const fail = (code, message, status = 413) => Object.assign(new Error(message), { code, status });
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

// ZIP32, STORE: image formats are already compressed. Names are generated below.
const createZip = (entries, maxBytes = DEFAULT_LIMITS.maxZipBytes) => {
  if (entries.length > 65535) throw fail('IMAGE_EXPORT_LIMIT', 'Too many ZIP entries.');
  const locals = [], central = [], names = new Set();
  let offset = 0, centralSize = 0;
  for (const { name, bytes } of entries) {
    const filename = Buffer.from(name, 'utf8');
    if (!Buffer.isBuffer(bytes) || !name || names.has(name) || name.startsWith('/') || name.includes('\\') || name.split('/').some((part) => !part || part === '.' || part === '..') || /[:\u0000-\u001f\u007f]/.test(name)) throw fail('INVALID_ZIP_ENTRY', 'Invalid ZIP entry.', 500);
    names.add(name);
    const size = bytes.length;
    if (filename.length > 65535 || size > 0xffffffff || offset > 0xffffffff) throw fail('IMAGE_EXPORT_LIMIT', 'ZIP64 is not supported.');
    if (offset + 30 + filename.length + size + centralSize + 46 + filename.length + 22 > maxBytes) throw fail('IMAGE_EXPORT_LIMIT', 'Image package exceeds its size limit.');
    const checksum = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0x0021, 12); // 1980-01-01, 00:00:00
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(size, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(0x0021, 14); directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(size, 20); directory.writeUInt32LE(size, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    locals.push(header, filename, bytes); central.push(directory, filename);
    offset += header.length + filename.length + size; centralSize += directory.length + filename.length;
  }
  if (offset + centralSize + 22 > maxBytes || offset + centralSize > 0xffffffff) throw fail('IMAGE_EXPORT_LIMIT', 'Image package exceeds its size limit.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end], offset + centralSize + 22);
};

const reject = (code, message) => { throw fail(code, message, 400); };
const within = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const safeImagePath = (uploadsDir, projectId, reference) => {
  const prefix = `/uploads/${encodeURIComponent(projectId)}/`;
  if (typeof reference !== 'string' || !reference.startsWith(prefix) || /[\u0000-\u001f\u007f?#\\]/.test(reference)) reject('UNSAFE_REFERENCE', 'Image reference is not a safe project upload.');
  let relative;
  try { relative = decodeURIComponent(reference.slice(prefix.length)); } catch { reject('UNSAFE_REFERENCE', 'Image reference has invalid encoding.'); }
  if (!relative || relative.includes('..') || /[\u0000-\u001f\u007f\\:?#]/.test(relative) || relative.startsWith('/') || path.posix.normalize(relative) !== relative) reject('UNSAFE_REFERENCE', 'Image reference is not a safe relative path.');
  const ext = path.extname(relative).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) reject('UNSUPPORTED_IMAGE', 'Only PNG, JPEG and WebP images can be exported.');
  const root = path.resolve(uploadsDir);
  const projectRoot = path.join(root, projectId);
  const candidate = path.resolve(projectRoot, relative);
  if (!within(projectRoot, candidate)) reject('UNSAFE_REFERENCE', 'Image reference is outside the project.');
  // Reject every symlink, including a project directory pointing at another project.
  const components = [root, projectRoot, ...relative.split('/').map((_, index, parts) => path.join(projectRoot, ...parts.slice(0, index + 1)))];
  for (let index = 0; index < components.length; index++) {
    const stat = fs.lstatSync(components[index]);
    if (stat.isSymbolicLink() || (index < components.length - 1 && !stat.isDirectory())) reject('UNSAFE_REFERENCE', 'Image path contains an unsafe directory or link.');
    if (index === components.length - 1 && !stat.isFile()) reject('UNSAFE_REFERENCE', 'Image reference is not a regular file.');
  }
  const realRoot = fs.realpathSync(root), realProject = fs.realpathSync(projectRoot), realFile = fs.realpathSync(candidate);
  if (path.relative(realRoot, realProject) !== projectId || !within(realProject, realFile)) reject('UNSAFE_REFERENCE', 'Image real path is outside the expected project.');
  return { filename: candidate, realFile, ext };
};
const readImage = (uploadsDir, projectId, reference, maxBytes) => {
  const safe = safeImagePath(uploadsDir, projectId, reference);
  const before = fs.statSync(safe.filename);
  if (before.size > maxBytes) throw fail('IMAGE_EXPORT_FILE_LIMIT', 'An archived image exceeds the 8 MiB file limit.');
  const fd = fs.openSync(safe.filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(fd);
    const after = safeImagePath(uploadsDir, projectId, reference);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || after.realFile !== safe.realFile) reject('UNSAFE_REFERENCE', 'Image changed during export.');
    if (opened.size > maxBytes) throw fail('IMAGE_EXPORT_FILE_LIMIT', 'An archived image exceeds the 8 MiB file limit.');
    const bytes = Buffer.alloc(opened.size);
    let read = 0;
    while (read < bytes.length) {
      const length = fs.readSync(fd, bytes, read, bytes.length - read, read);
      if (!length) reject('IMAGE_CHANGED', 'Image changed during export.');
      read += length;
    }
    const final = fs.fstatSync(fd);
    if (final.size !== opened.size || final.mtimeMs !== opened.mtimeMs) reject('IMAGE_CHANGED', 'Image changed during export.');
    return { ...safe, bytes };
  } finally { fs.closeSync(fd); }
};

const makeImagePackage = ({ projectId, assets, uploadsDir, limits = DEFAULT_LIMITS }) => {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,80}$/.test(projectId) || ['__proto__', 'constructor', 'prototype'].includes(projectId)) throw fail('INVALID_IMAGE_EXPORT_INPUT', 'Invalid project id.', 400);
  if (!assets || typeof assets !== 'object' || Array.isArray(assets) || !limits || typeof limits !== 'object' || Array.isArray(limits)) throw fail('INVALID_IMAGE_EXPORT_INPUT', 'Invalid asset map or limits.', 400);
  const caps = { ...DEFAULT_LIMITS, ...limits };
  if (Object.keys(caps).some((key) => !Object.hasOwn(DEFAULT_LIMITS, key) || !Number.isSafeInteger(caps[key]) || caps[key] <= 0 || caps[key] > DEFAULT_LIMITS[key])) throw fail('INVALID_IMAGE_EXPORT_INPUT', 'Limits must be positive integers no greater than the defaults.', 400);
  // Match the asset API's legacy default: absent/unknown lifecycle means archived.
  const selected = Object.entries(assets).filter(([, asset]) => asset && typeof asset === 'object' && !Array.isArray(asset) && !['temp', 'invalid', 'deleted'].includes(asset.status));
  if (selected.length > caps.maxAssets) throw fail('IMAGE_EXPORT_LIMIT', 'Too many archived assets; export supports at most 1000.');
  const manifest = { schemaVersion: 1, type: 'zaotu-image-package', projectId, exportedAt: new Date().toISOString(), scope: 'archived-result-assets', assets: [], warnings: [], summary: {} };
  const images = [], byFile = new Map();
  let imageBytes = 0;
  for (const [key, asset] of selected) {
    const text = (value, max = 2048) => typeof value === 'string' ? value.slice(0, max) : '';
    const reference = asset.archivedUrl || asset.url;
    const item = { assetId: text(asset.assetId || key, 120), projectId, archivePath: null, exportStatus: 'skipped', archivedUrl: text(reference), promptVersion: Number.isInteger(asset.promptVersion) && asset.promptVersion > 0 ? asset.promptVersion : 1, favorite: Boolean(asset.favorite) };
    for (const [field, max] of Object.entries({ jobId: 120, attemptId: 160, platform: 40, candidateId: 120, sourceUrl: 2048, createdAt: 40, archivedAt: 40 })) item[field] = text(asset[field], max);
    item.dimensions = asset.dimensions && Number.isInteger(asset.dimensions.width) && Number.isInteger(asset.dimensions.height) && asset.dimensions.width > 0 && asset.dimensions.height > 0 && asset.dimensions.width <= 100000 && asset.dimensions.height <= 100000 ? { width: asset.dimensions.width, height: asset.dimensions.height } : null;
    item.tags = [...new Set((Array.isArray(asset.tags) ? asset.tags : []).filter((tag) => typeof tag === 'string').slice(0, 30).map((tag) => tag.trim().slice(0, 40)).filter(Boolean))];
    item.qualityLabels = [...new Set((Array.isArray(asset.qualityLabels) ? asset.qualityLabels : []).filter((label) => ['usable', 'discarded', 'subject_complete', 'structure_preserved', 'clear'].includes(label)))];
    if (item.qualityLabels.includes('usable') && item.qualityLabels.includes('discarded')) item.qualityLabels.splice(item.qualityLabels.indexOf('discarded'), 1);
    manifest.assets.push(item);
    try {
      if (asset.projectId && asset.projectId !== projectId) reject('PROJECT_OWNERSHIP_CONFLICT', 'Asset ownership does not match this project.');
      const safe = safeImagePath(uploadsDir, projectId, reference);
      let image = byFile.get(safe.realFile);
      if (!image) {
        image = readImage(uploadsDir, projectId, reference, caps.maxFileBytes);
        if (imageBytes + image.bytes.length > caps.maxZipBytes) throw fail('IMAGE_EXPORT_LIMIT', 'Image package exceeds its size limit.');
        imageBytes += image.bytes.length;
        image.name = `images/${String(images.length + 1).padStart(6, '0')}${safe.ext}`;
        image.sha256 = crypto.createHash('sha256').update(image.bytes).digest('hex');
        byFile.set(safe.realFile, image); images.push(image);
      }
      item.archivePath = image.name; item.size = image.bytes.length; item.sha256 = image.sha256; item.exportStatus = 'exported';
    } catch (error) {
      if (error.status === 413) throw error;
      const missing = error.code === 'ENOENT';
      item.exportStatus = missing ? 'missing' : 'skipped';
      const code = missing ? 'IMAGE_MISSING' : error.status === 400 ? error.code : 'IMAGE_READ_FAILED';
      manifest.warnings.push({ assetId: item.assetId, code, message: missing ? 'Archived image file is missing.' : error.status === 400 ? error.message : 'Archived image could not be read.' });
    }
  }
  manifest.summary = { archivedAssets: selected.length, exportedAssets: manifest.assets.filter((item) => item.exportStatus === 'exported').length, imageFiles: images.length, warningCount: manifest.warnings.length };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  if (manifestBytes.length > caps.maxZipBytes - imageBytes) throw fail('IMAGE_EXPORT_LIMIT', 'Image package manifest exceeds its size limit.');
  const bytes = createZip([{ name: 'manifest.json', bytes: manifestBytes }, ...images.map((image) => ({ name: image.name, bytes: image.bytes }))], caps.maxZipBytes);
  return { bytes, manifest };
};

module.exports = { DEFAULT_LIMITS, crc32, createZip, makeImagePackage };
