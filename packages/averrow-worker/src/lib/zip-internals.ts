// ZIP central-directory parsing primitives, factored out of
// zip-reader.ts so both the HTTP-backed and R2-backed readers can
// share them. Pure functions only — no I/O. The two reader classes
// own the byte-fetch behavior and call into these helpers to make
// sense of the bytes.

export interface ZipEntry {
  name: string;
  /** Compression method per ZIP spec — 0 = stored, 8 = deflate.
   *  We throw on anything else so a malformed archive doesn't
   *  silently produce garbage rows. */
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the local file header (NOT the data) in the archive.
   *  We have to re-read the local header at this offset to compute
   *  the actual data offset because filename / extra field lengths
   *  in the local header CAN differ from the central directory's. */
  localHeaderOffset: number;
}

export const EOCD_SIGNATURE = 0x06054b50; // PK\x05\x06
export const CDIR_ENTRY_SIGNATURE = 0x02014b50; // PK\x01\x02
export const LFH_SIGNATURE = 0x04034b50; // PK\x03\x04

export function readUint16LE(buf: Uint8Array, offset: number): number {
  return (buf[offset] ?? 0) | ((buf[offset + 1] ?? 0) << 8);
}

export function readUint32LE(buf: Uint8Array, offset: number): number {
  // Use unsigned right shift to prevent sign extension on 4-byte
  // sizes ≥ 2^31. Without `>>> 0` a 3GB compressedSize would land
  // as a negative number and break Range header math downstream.
  return (
    ((buf[offset] ?? 0) |
      ((buf[offset + 1] ?? 0) << 8) |
      ((buf[offset + 2] ?? 0) << 16) |
      ((buf[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

/**
 * Locate the EOCD record by scanning backwards from the end of the
 * provided buffer. Returns the offset within `buf` or -1 if not found.
 * The EOCD is variable-length (trailing comment) but the signature
 * is fixed.
 */
export function findEocdOffset(buf: Uint8Array): number {
  // EOCD is at least 22 bytes; comment can extend it but is rare.
  for (let i = buf.length - 22; i >= 0; i--) {
    if (
      buf[i] === 0x50 &&
      buf[i + 1] === 0x4b &&
      buf[i + 2] === 0x05 &&
      buf[i + 3] === 0x06
    ) {
      return i;
    }
  }
  return -1;
}

/** Parse a ZIP central directory blob into a list of entries. */
export function parseCentralDirectory(cdir: Uint8Array): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let pos = 0;
  const decoder = new TextDecoder("utf-8");

  while (pos + 46 <= cdir.length) {
    if (readUint32LE(cdir, pos) !== CDIR_ENTRY_SIGNATURE) {
      // Either we've walked off the end or the archive is corrupt.
      break;
    }
    const compressionMethod = readUint16LE(cdir, pos + 10);
    const compressedSize = readUint32LE(cdir, pos + 20);
    const uncompressedSize = readUint32LE(cdir, pos + 24);
    const fileNameLen = readUint16LE(cdir, pos + 28);
    const extraLen = readUint16LE(cdir, pos + 30);
    const commentLen = readUint16LE(cdir, pos + 32);
    const localHeaderOffset = readUint32LE(cdir, pos + 42);
    const nameStart = pos + 46;
    const name = decoder.decode(
      cdir.subarray(nameStart, nameStart + fileNameLen),
    );
    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    pos = nameStart + fileNameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Parse the local file header at the start of `lfh` and return the
 * length of the header (i.e. the byte offset where the entry's
 * compressed data begins, relative to the LFH start). Throws on
 * signature mismatch or if the probe was too small.
 */
export function parseLocalHeaderLength(
  lfh: Uint8Array,
  entryName: string,
  probeSize: number,
): number {
  if (readUint32LE(lfh, 0) !== LFH_SIGNATURE) {
    throw new Error(
      `Local file header signature mismatch for ${entryName}`,
    );
  }
  const fileNameLen = readUint16LE(lfh, 26);
  const extraLen = readUint16LE(lfh, 28);
  const headerLen = 30 + fileNameLen + extraLen;
  if (headerLen > probeSize) {
    throw new Error(
      `Local header for ${entryName} is unexpectedly large (${headerLen}b > probe ${probeSize}b)`,
    );
  }
  return headerLen;
}
