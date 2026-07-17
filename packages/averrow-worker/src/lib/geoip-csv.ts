/**
 * GeoLite2-City CSV parsing helpers.
 *
 * The two CSVs we consume:
 *   1. GeoLite2-City-Locations-en.csv (~150K rows, ~10MB)
 *      Headers: geoname_id, locale_code, continent_code,
 *               continent_name, country_iso_code, country_name,
 *               subdivision_1_iso_code, subdivision_1_name,
 *               subdivision_2_iso_code, subdivision_2_name,
 *               city_name, metro_code, time_zone, is_in_european_union
 *
 *   2. GeoLite2-City-Blocks-IPv4.csv (~3.5M rows, ~250MB)
 *      Headers: network, geoname_id, registered_country_geoname_id,
 *               represented_country_geoname_id, is_anonymous_proxy,
 *               is_satellite_provider, postal_code, latitude,
 *               longitude, accuracy_radius
 *
 * The blocks CSV already has lat/lng — we only consult locations
 * to resolve geoname_id → city_name + region. country_iso_code
 * isn't on the blocks row directly so we always join.
 *
 * Why not a fancy CSV library: GeoLite2 CSVs are well-formed RFC
 * 4180 with a fixed schema. A 30-line hand-rolled parser handles
 * the edge cases we care about (quoted strings with commas) and
 * keeps us off another npm dep + bundle size.
 */

export interface LocationRow {
  geonameId: string;
  countryCode: string | null;     // e.g. "US"
  countryName: string | null;
  region: string | null;          // subdivision_1_name (state/province)
  city: string | null;
  // Other columns parsed but not yet stored — kept available for
  // future enrichment (timeZone, continentCode, etc.).
}

export interface BlockRow {
  /** CIDR string from MaxMind, e.g. "1.0.0.0/24". */
  network: string;
  geonameId: string | null;       // null when MaxMind has range data but no city match
  registeredCountryGeonameId: string | null;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
  /** MaxMind's accuracy radius in km. Useful for "this is a
   *  CDN/anycast" detection (very high radius) but not stored
   *  in geo_ip_ranges yet. */
  accuracyRadius: number | null;
}

// ─── Public parsers ───────────────────────────────────────────────

/**
 * Parse the entire Locations CSV into a Map. Locations is small
 * (~150K rows, ~10MB) so loading it whole is the simplest path.
 * Worker memory budget (128MB) handles this comfortably.
 */
export function parseLocationsCsv(text: string): Map<string, LocationRow> {
  const map = new Map<string, LocationRow>();
  const lines = text.split('\n');
  if (lines.length === 0) return map;

  // Skip header. We hard-code column order (matches MaxMind's
  // documented schema) instead of header sniffing — if MaxMind
  // ever reorders columns, the operator notices via wrong values
  // showing up in lookups, and we update the indexes here.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cells = parseCsvLine(line);
    if (cells.length < 11) continue;
    const geonameId = cells[0];
    if (!geonameId) continue;
    map.set(geonameId, {
      geonameId,
      countryCode: cells[4] || null,    // country_iso_code
      countryName: cells[5] || null,    // country_name
      region: cells[7] || null,         // subdivision_1_name
      city: cells[10] || null,          // city_name
    });
  }
  return map;
}

/**
 * Parse a slice of the Blocks CSV (start..end byte offsets are
 * caller-managed via R2 range reads). Returns parsed rows and the
 * residual partial line at the end of the slice — caller stitches
 * residuals between slices.
 *
 * For Phase 3 chunk 2, callers can read the full Blocks CSV into
 * memory (250MB exceeds the budget — so chunked reads are needed),
 * or use this helper on each chunk and stitch leftover lines.
 */
export function parseBlocksCsvChunk(text: string, startsWithHeader: boolean): {
  rows: BlockRow[];
  /** Partial line at the end of the chunk that didn't terminate
   *  in `\n` — caller should prepend to the next chunk's text
   *  before calling parseBlocksCsvChunk again. */
  residual: string;
} {
  const rows: BlockRow[] = [];
  const lines = text.split('\n');
  if (lines.length === 0) return { rows, residual: '' };

  // Last line may be partial (chunk boundary mid-line). Hold it
  // back; caller stitches.
  const residual = lines[lines.length - 1] ?? '';
  const completeLines = lines.slice(0, -1);

  const startIdx = startsWithHeader ? 1 : 0;
  for (let i = startIdx; i < completeLines.length; i++) {
    const line = completeLines[i];
    if (!line) continue;
    const cells = parseCsvLine(line);
    if (cells.length < 10) continue;
    const network = cells[0];
    if (!network) continue;
    const lat = cells[7] ? parseFloat(cells[7]) : NaN;
    const lng = cells[8] ? parseFloat(cells[8]) : NaN;
    const accuracy = cells[9] ? parseInt(cells[9], 10) : NaN;
    rows.push({
      network,
      geonameId: cells[1] || null,
      registeredCountryGeonameId: cells[2] || null,
      postalCode: cells[6] || null,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      accuracyRadius: Number.isFinite(accuracy) ? accuracy : null,
    });
  }
  return { rows, residual };
}

/**
 * Convert MaxMind's CIDR network notation into the (start_int,
 * end_int) range we store in geo_ip_ranges.
 *
 * Implementation note: JavaScript bitwise operators (`&`, `~`,
 * `<<`) coerce to signed 32-bit integers, which silently wraps
 * IPs ≥ 2^31 (e.g. 192.168.x.x → negative). We use plain
 * arithmetic with Math.pow so the full IPv4 space (0..2^32-1)
 * round-trips correctly.
 */
export function cidrToIntRange(cidr: string): { start: number; end: number } | null {
  const parts = cidr.split('/');
  if (parts.length !== 2) return null;
  const ipPart = parts[0];
  const prefixPart = parts[1];
  if (!ipPart || !prefixPart) return null;
  const prefix = parseInt(prefixPart, 10);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const ipInt = ipv4ToInt(ipPart);
  if (ipInt == null) return null;
  const hostBits = 32 - prefix;
  // networkSize = 2^hostBits is the count of addresses in the block.
  // Floor-divide ipInt by networkSize to drop the host portion.
  const networkSize = Math.pow(2, hostBits);
  const start = Math.floor(ipInt / networkSize) * networkSize;
  const end = start + networkSize - 1;
  return { start, end };
}

// ─── Internals ─────────────────────────────────────────────────────

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = n * 256 + o;
  }
  return n;
}

// ─── Stream-based parsers (used by the in-Worker MaxMind import) ─────

/**
 * Stream the entire Locations CSV from a `ReadableStream<Uint8Array>`
 * and return a `Map<geonameId, LocationRow>`. Locations is small
 * enough (~10MB uncompressed, ~150K rows) that we still load it all
 * into memory — the streaming form just avoids first having to
 * concat the bytes into a single string.
 */
export async function streamLocationsCsv(
  stream: ReadableStream<Uint8Array>,
): Promise<Map<string, LocationRow>> {
  const map = new Map<string, LocationRow>();
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();
  let buf = '';
  let isFirstLine = true;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let newlineIdx: number;
    while ((newlineIdx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, newlineIdx);
      buf = buf.slice(newlineIdx + 1);
      if (isFirstLine) {
        isFirstLine = false;
        continue;
      }
      consumeLocationLine(line, map);
    }
  }
  // Flush the decoder to capture any trailing UTF-8 multi-byte
  // sequence that landed across the final chunk boundary.
  buf += decoder.decode();
  if (buf.trim().length > 0 && !isFirstLine) {
    consumeLocationLine(buf, map);
  }
  return map;
}

function consumeLocationLine(line: string, map: Map<string, LocationRow>): void {
  if (!line) return;
  const cells = parseCsvLine(line);
  if (cells.length < 11) return;
  const geonameId = cells[0];
  if (!geonameId) return;
  map.set(geonameId, {
    geonameId,
    countryCode: cells[4] || null,
    countryName: cells[5] || null,
    region: cells[7] || null,
    city: cells[10] || null,
  });
}

/**
 * Stream the Blocks CSV row-by-row, calling `onRow` for each parsed
 * record. Internal newline-buffered, never holds more than a few KB
 * of text in memory at any time. Use this to chunk-import the
 * 3.5M-row Blocks file without buffering it whole.
 *
 * `onRow` may be async — the parser awaits it before reading the
 * next chunk, so the caller controls back-pressure (e.g. flush a
 * D1 batch every N rows).
 */
export async function streamBlocksCsv(
  stream: ReadableStream<Uint8Array>,
  onRow: (row: BlockRow) => Promise<void> | void,
): Promise<{ rowsParsed: number }> {
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();
  let buf = '';
  let isFirstLine = true;
  let rowsParsed = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let newlineIdx: number;
    while ((newlineIdx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, newlineIdx);
      buf = buf.slice(newlineIdx + 1);
      if (isFirstLine) {
        isFirstLine = false;
        continue;
      }
      const row = parseBlockLine(line);
      if (row) {
        rowsParsed++;
        await onRow(row);
      }
    }
  }
  buf += decoder.decode();
  if (buf.length > 0 && !isFirstLine) {
    const row = parseBlockLine(buf);
    if (row) {
      rowsParsed++;
      await onRow(row);
    }
  }
  return { rowsParsed };
}

function parseBlockLine(line: string): BlockRow | null {
  if (!line) return null;
  const cells = parseCsvLine(line);
  if (cells.length < 10) return null;
  const network = cells[0];
  if (!network) return null;
  const lat = cells[7] ? parseFloat(cells[7]) : NaN;
  const lng = cells[8] ? parseFloat(cells[8]) : NaN;
  const accuracy = cells[9] ? parseInt(cells[9], 10) : NaN;
  return {
    network,
    geonameId: cells[1] || null,
    registeredCountryGeonameId: cells[2] || null,
    postalCode: cells[6] || null,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    accuracyRadius: Number.isFinite(accuracy) ? accuracy : null,
  };
}

/**
 * RFC 4180 single-line parser. Handles double-quoted fields with
 * embedded commas and `""` escapes. Rejects multi-line quoted
 * fields — GeoLite2 CSVs don't use them, and our line-split
 * caller would mis-frame them anyway.
 */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        // Look-ahead for escaped quote
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === ',') {
        cells.push(current);
        current = '';
      } else if (ch === '"' && current === '') {
        inQuotes = true;
      } else {
        current += ch;
      }
    }
  }
  cells.push(current);
  return cells;
}
