import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCUMENTS = ['README.md', 'PRIVACY.md', 'LICENSE'];
const EXTENSION_FILES = new Set([
  'background.js', 'core.js', 'demo.js',
  'icons/icon-128.png', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon.svg',
  'manifest.json', 'runner.js', 'window.css', 'window.html', 'window.js',
]);
const EXTENSION_DIRECTORIES = new Set(['icons']);
const FIXED_BUILD_DATE = new Date('2026-01-01T00:00:00Z');
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

/** IEEE CRC-32, as required by the ZIP file format. */
export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function safeName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\\') || name.includes('\0')) {
    throw new Error(`Invalid archive path: ${JSON.stringify(name)}`);
  }
  if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe archive path: ${name}`);
  }
  return name;
}

/** Build a deterministic, UTF-8 ZIP using STORE (no compression), without dependencies. */
export function createZip(entries, { date = FIXED_BUILD_DATE } = {}) {
  if (entries.length > 65535) throw new Error('ZIP64 is not supported: too many files.');
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1980 || date.getUTCFullYear() > 2107) {
    throw new Error('ZIP timestamps must be between 1980 and 2107.');
  }
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const localParts = [];
  const centralParts = [];
  const names = new Set();
  let localOffset = 0;
  let centralSize = 0;

  for (const entry of entries) {
    const name = safeName(entry.name);
    if (names.has(name.toLowerCase())) throw new Error(`Duplicate archive path: ${name}`);
    names.add(name.toLowerCase());
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    if (nameBytes.length > 65535 || data.length > 0xffffffff) throw new Error(`File is too large for ZIP32: ${name}`);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // Minimum reader version 2.0.
    local.writeUInt16LE(0x0800, 6); // UTF-8 filenames.
    local.writeUInt16LE(0, 8); // STORE: compressed bytes are the original bytes.
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // Made by ZIP 2.0, portable DOS attributes.
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);

    localParts.push(local, nameBytes, data);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + data.length;
    centralSize += central.length + nameBytes.length;
    if (localOffset + centralSize + 22 > 0xffffffff) throw new Error('ZIP64 is not supported: archive too large.');
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export async function collectPackageEntries(root = PROJECT_ROOT) {
  const entries = [];
  root = path.resolve(root);
  const extensionRoot = path.join(root, 'extension');
  async function checkInput(fullPath, label, kind) {
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) throw new Error(`Symlinks are not packaged: ${label}`);
    if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) {
      throw new Error(`Expected a regular ${kind}: ${label}`);
    }
  }
  async function addFile(fullPath, name) {
    await checkInput(fullPath, name, 'file');
    entries.push({ name: safeName(name), data: await readFile(fullPath) });
  }
  async function walk(directory, relative = '') {
    // Check each directory from the selected project root down to the input.
    await checkInput(directory, relative || 'extension', 'directory');
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const child of children) {
      const relativeName = relative ? `${relative}/${child.name}` : child.name;
      // Dotfiles and dot-directories are excluded, including local metadata.
      if (child.name.startsWith('.')) continue;
      if (child.isSymbolicLink()) throw new Error(`Symlinks are not packaged: ${relativeName}`);
      const fullPath = path.join(directory, child.name);
      if (child.isDirectory()) {
        if (!EXTENSION_DIRECTORIES.has(relativeName)) {
          throw new Error(`Unexpected directory inside extension: ${relativeName}`);
        }
        await walk(fullPath, relativeName);
      } else if (child.isFile() && EXTENSION_FILES.has(relativeName)) {
        await addFile(fullPath, relativeName);
      } else {
        throw new Error(`Unexpected file inside extension: ${relativeName}`);
      }
    }
  }
  await checkInput(root, 'project root', 'directory');
  await walk(extensionRoot);
  const found = new Set(entries.map(entry => entry.name));
  for (const name of EXTENSION_FILES) {
    if (!found.has(name)) throw new Error(`Required extension resource is missing: ${name}`);
  }
  for (const name of DOCUMENTS) await addFile(path.join(root, name), name);
  return entries;
}

export async function packageExtension(root = PROJECT_ROOT) {
  const entries = await collectPackageEntries(root);
  const manifest = JSON.parse(entries.find(entry => entry.name === 'manifest.json').data.toString('utf8'));
  if (manifest.manifest_version !== 3 || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version)) {
    throw new Error('Expected a Manifest V3 extension with a numeric version.');
  }
  const archive = createZip(entries);
  const outputPath = path.join(root, 'dist', `x-follow-cleaner-v${manifest.version}.zip`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, archive);
  return { outputPath, files: entries.map(entry => entry.name), bytes: archive.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await packageExtension();
    console.log(`Packaged ${result.files.length} files (${result.bytes} bytes): ${result.outputPath}`);
  } catch (error) {
    console.error(`Packaging failed: ${error.message}`);
    process.exitCode = 1;
  }
}
