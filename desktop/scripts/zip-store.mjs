// A folder as one zip, stored (no compression): the desktop package carries
// the CLI as `cli.zip` instead of ~1,650 loose files. Velopack writes every
// file of a package on each update (and the antivirus scans each), so one file
// installs in seconds where the folder took a minute and a half; the app
// unpacks it once into ~/.work/runtime/<version> (runtime.rs). Stored, because
// Velopack compresses the package anyway, and uncompressed bytes diff well for
// its delta updates.
//
// The zip spec's plain subset: no zip64 (the CLI is far below 4 GB and
// 65,535 entries; refused otherwise), UTF-8 names, fixed timestamps (the same
// input gives the same bytes), each file's Unix mode in the external
// attributes (node-pty's spawn-helper must stay executable on macOS).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const UTF8 = 0x0800;
const MADE_BY_UNIX = (3 << 8) | 20;

/** Every file under `dir`, as forward-slash paths, sorted (the same order on every OS). */
export function listFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  })(dir);
  return out.sort();
}

/** Write `dir` as a stored zip at `file`. Returns the number of entries. */
export function zipDirectory(dir, file) {
  const names = listFiles(dir);
  if (names.length > 0xffff) throw new Error(`${names.length} files: more than a zip without zip64 holds`);
  const fd = fs.openSync(file, 'w');
  const central = [];
  let offset = 0;
  const write = (buf) => {
    fs.writeSync(fd, buf);
    offset += buf.length;
  };
  try {
    for (const name of names) {
      const full = path.join(dir, ...name.split('/'));
      const data = fs.readFileSync(full);
      const mode = fs.statSync(full).mode & 0o777;
      const crc = zlib.crc32(data);
      const nameBuf = Buffer.from(name, 'utf8');
      if (offset + 30 + nameBuf.length + data.length > 0xffffffff) throw new Error('over 4 GB: more than a zip without zip64 holds');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(UTF8, 6);
      local.writeUInt16LE(0, 8); // stored
      local.writeUInt16LE(DOS_TIME, 10);
      local.writeUInt16LE(DOS_DATE, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      const at = offset;
      write(local);
      write(nameBuf);
      write(data);

      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(MADE_BY_UNIX, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(UTF8, 8);
      c.writeUInt16LE(0, 10);
      c.writeUInt16LE(DOS_TIME, 12);
      c.writeUInt16LE(DOS_DATE, 14);
      c.writeUInt32LE(crc, 16);
      c.writeUInt32LE(data.length, 20);
      c.writeUInt32LE(data.length, 24);
      c.writeUInt16LE(nameBuf.length, 28);
      c.writeUInt16LE(0, 30); // extra
      c.writeUInt16LE(0, 32); // comment
      c.writeUInt16LE(0, 34); // disk
      c.writeUInt16LE(0, 36); // internal attributes
      c.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38); // a regular file, its mode
      c.writeUInt32LE(at, 42);
      central.push(c, nameBuf);
    }
    const cdStart = offset;
    for (const b of central) write(b);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(names.length, 8);
    end.writeUInt16LE(names.length, 10);
    end.writeUInt32LE(offset - cdStart, 12);
    end.writeUInt32LE(cdStart, 16);
    end.writeUInt16LE(0, 20);
    write(end);
  } finally {
    fs.closeSync(fd);
  }
  return names.length;
}

/**
 * Read a zip this module wrote: each entry's name, mode and data, from the
 * central directory, with each CRC checked. For the packaging script's
 * check before the folder goes, and for tests.
 */
export function readStoredZip(file) {
  const buf = fs.readFileSync(file);
  const end = buf.length - 22;
  if (buf.readUInt32LE(end) !== 0x06054b50) throw new Error('no end of central directory (or a comment, which this never writes)');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`central directory entry ${i} is damaged`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const mode = (buf.readUInt32LE(p + 38) >>> 16) & 0o777;
    const at = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (method !== 0) throw new Error(`${name}: compressed, not stored`);
    const dataAt = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const data = buf.subarray(dataAt, dataAt + size);
    if (zlib.crc32(data) !== crc) throw new Error(`${name}: CRC mismatch`);
    entries.push({ name, mode, data });
    p += 46 + nameLen + extra + comment;
  }
  return entries;
}
