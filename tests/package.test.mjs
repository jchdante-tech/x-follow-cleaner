import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectPackageEntries, crc32, createZip, packageExtension } from '../scripts/package.mjs';

const releaseResources = [
  'background.js', 'core.js', 'demo.js',
  'icons/icon-128.png', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon.svg',
  'manifest.json', 'runner.js', 'window.css', 'window.html', 'window.js',
];

test('CRC-32 matches published IEEE check value and handles empty input', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('ZIP STORE headers, Unicode filenames, offsets and CRC form a valid archive', () => {
  const entries = [
    { name: 'manifest.json', data: Buffer.from('{"manifest_version":3}') },
    { name: '说明.txt', data: Buffer.from('你好\n') },
    { name: 'icons/empty.svg', data: Buffer.alloc(0) },
  ];
  const archive = createZip(entries);
  assert.deepEqual(archive, createZip(entries), 'identical inputs produce identical archives');
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  assert.equal(archive.readUInt16LE(end + 8), entries.length);
  assert.equal(archive.readUInt16LE(end + 10), entries.length);
  let centralOffset = archive.readUInt32LE(end + 16);
  const centralStart = centralOffset;
  let expectedLocalOffset = 0;
  for (const entry of entries) {
    assert.equal(archive.readUInt32LE(centralOffset), 0x02014b50);
    const nameLength = archive.readUInt16LE(centralOffset + 28);
    const name = archive.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8');
    assert.equal(name, entry.name);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    assert.equal(localOffset, expectedLocalOffset);
    assert.equal(archive.readUInt32LE(localOffset), 0x04034b50);
    assert.equal(archive.readUInt16LE(localOffset + 6), 0x0800);
    assert.equal(archive.readUInt16LE(localOffset + 8), 0);
    assert.equal(archive.readUInt32LE(localOffset + 14), crc32(entry.data));
    assert.equal(archive.readUInt32LE(centralOffset + 16), crc32(entry.data));
    assert.equal(archive.readUInt32LE(localOffset + 18), entry.data.length);
    assert.equal(archive.readUInt32LE(centralOffset + 24), entry.data.length);
    const payloadOffset = localOffset + 30 + nameLength;
    assert.deepEqual(archive.subarray(payloadOffset, payloadOffset + entry.data.length), entry.data);
    expectedLocalOffset = payloadOffset + entry.data.length;
    centralOffset += 46 + nameLength;
  }
  assert.equal(expectedLocalOffset, centralStart);
  assert.equal(centralOffset, end);
  assert.equal(archive.readUInt32LE(end + 12), end - centralStart);
});

test('rejects extraction traversal and case-insensitive filename collisions', () => {
  for (const name of ['../secret', '/absolute', 'a/../b', 'C:/file', 'a\\b', 'a//b', './file', 'a\0b']) {
    assert.throws(() => createZip([{ name, data: '' }]), /archive path/);
  }
  assert.throws(() => createZip([{ name: 'A.js', data: '' }, { name: 'a.js', data: '' }]), /Duplicate/);
});

async function createFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'x-follow-cleaner-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'extension', 'icons'), { recursive: true });
  for (const name of releaseResources) await writeFile(path.join(root, 'extension', name), name);
  await writeFile(path.join(root, 'extension', 'manifest.json'), '{"manifest_version":3,"version":"0.1.0"}');
  for (const name of ['README.md', 'PRIVACY.md', 'LICENSE']) await writeFile(path.join(root, name), name);
  return root;
}

test('packages exactly thirteen extension resources and three documents, excluding hidden and unrelated files', async t => {
  const root = await createFixture(t);
  await mkdir(path.join(root, 'research'));
  await writeFile(path.join(root, 'research', 'private.json'), 'private account records');
  await writeFile(path.join(root, 'extension', '.DS_Store'), 'finder metadata');
  await mkdir(path.join(root, 'extension', '.private'));
  await writeFile(path.join(root, 'extension', '.private', 'account.json'), 'local account records');
  const result = await packageExtension(root);
  assert.equal(path.basename(result.outputPath), 'x-follow-cleaner-v0.1.0.zip');
  assert.deepEqual(result.files, [...releaseResources, 'README.md', 'PRIVACY.md', 'LICENSE']);
  assert.equal((await readFile(result.outputPath)).length, result.bytes);
  assert.ok(!result.files.some(name => name.startsWith('extension/')));
});

test('rejects undeclared JSON, images and other files rather than packaging them', async t => {
  const root = await createFixture(t);
  for (const name of ['credentials.txt', 'private-data.json', 'screenshot.png', 'icons/private-photo.jpg']) {
    const filename = path.join(root, 'extension', name);
    await writeFile(filename, 'do not package');
    await assert.rejects(collectPackageEntries(root), /Unexpected file/);
    await rm(filename);
  }
});

test('rejects undeclared directories and missing required resources', async t => {
  const root = await createFixture(t);
  await mkdir(path.join(root, 'extension', 'private'));
  await assert.rejects(collectPackageEntries(root), /Unexpected directory/);
  await rm(path.join(root, 'extension', 'private'), { recursive: true });
  await rm(path.join(root, 'extension', 'core.js'));
  await assert.rejects(collectPackageEntries(root), /Required extension resource is missing: core.js/);
});

async function linkOrSkip(t, target, link, type = 'file') {
  try {
    await symlink(target, link, type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('This Windows account cannot create symbolic links.');
      return false;
    }
    throw error;
  }
}

test('rejects a symlink at a declared extension resource path', async t => {
  const root = await createFixture(t);
  const resource = path.join(root, 'extension', 'core.js');
  await rm(resource);
  if (!await linkOrSkip(t, path.join(root, 'PRIVACY.md'), resource)) return;
  await assert.rejects(collectPackageEntries(root), /Symlinks/);
});

test('rejects a symlink at a declared document path', async t => {
  const root = await createFixture(t);
  const document = path.join(root, 'README.md');
  await rm(document);
  if (!await linkOrSkip(t, path.join(root, 'PRIVACY.md'), document)) return;
  await assert.rejects(collectPackageEntries(root), /Symlinks/);
});

test('rejects symlinks at the extension root and its resource directories', async t => {
  for (const relative of ['extension', 'extension/icons']) {
    const root = await createFixture(t);
    const directory = path.join(root, relative), moved = path.join(root, 'original-directory');
    await rename(directory, moved);
    if (!await linkOrSkip(t, moved, directory, 'dir')) return;
    await assert.rejects(collectPackageEntries(root), /Symlinks/);
  }
});

test('rejects a symlink used as the selected project root', async t => {
  const root = await createFixture(t);
  const link = `${root}-link`;
  t.after(() => rm(link, { force: true }));
  if (!await linkOrSkip(t, root, link, 'dir')) return;
  await assert.rejects(collectPackageEntries(link), /Symlinks/);
});

test('rejects a directory masquerading as a declared document', async t => {
  const root = await createFixture(t);
  await rm(path.join(root, 'README.md'));
  await mkdir(path.join(root, 'README.md'));
  await assert.rejects(collectPackageEntries(root), /Expected a regular file/);
});
