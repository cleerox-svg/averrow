import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";
import { readCappedText } from "../lib/capped-body";
import {
  INFOBLOX_FILES,
  INFOBLOX_INDEX_URL,
  INFOBLOX_MAX_FILE_BYTES,
  INFOBLOX_MAX_ROWS_PER_FILE,
  INFOBLOX_MAX_ROWS_TOTAL,
  INFOBLOX_RAW_BASE,
  parseInfobloxCsv,
  unlistedInfobloxFiles,
  type InfobloxFile,
  type InfobloxRow,
} from "../lib/infoblox-reference";

/**
 * Infoblox Threat Intel open indicators → `infoblox_reference` +
 * `infoblox_reference_files` (feed key `infoblox_reference`, migration 0336).
 *
 * Reference data, not IOCs (same pattern as spamhaus_asn_drop /
 * actor_reference): writes no threats and always reports itemsNew = 0, so it
 * never wakes Sentinel, creates no alerts and feeds no attribution, scoring
 * or triage. The one reader is the staff threat detail (lib/infoblox-reference.ts).
 *
 * Per file (INFOBLOX_FILES, one per Infoblox publication):
 *  - conditional GET with the stored ETag; 304 → nothing written;
 *  - a 200 whose sha256 equals the last fully loaded body → nothing written
 *    (one small update if only the ETag / label changed);
 *  - otherwise parse (domain + IP rows only, newest INFOBLOX_MAX_ROWS_PER_FILE,
 *    INFOBLOX_MAX_ROWS_TOTAL across files), read that file's stored rows
 *    once, and upsert only rows that are new or changed.
 *
 * Budget / resume: a run stops starting work after RUN_TIME_BUDGET_MS or
 * RUN_ROW_WRITE_BUDGET row writes (checked before each 560-row batch, so a
 * run can overshoot by at most one batch). A file cut short gets no ETag / sha
 * stamp, so the next run re-reads it, skips the rows already stored and
 * carries on. The first load (~99K rows on 2026-11-15) spans about two runs.
 *
 * Removal: a file's rows that left the file get removed_at only once every
 * upsert for that file landed, the body was read whole (no line cap), and the
 * body still holds >= MIN_RETAIN_RATIO of the file's live rows (counted
 * BEFORE our own row caps, so a row the per-file / total cap drops is removed
 * like any other). When that guard blocks removal the file gets NO ETag / sha
 * stamp, so every later run re-reads and re-checks it; the body's sha is kept
 * in `pending_sha256` / `pending_seen`, and once the SAME body has been seen
 * on INFOBLOX_SHRINK_CONFIRM_RUNS consecutive runs the shrink is accepted
 * (upstream really did shrink the file). A whole file's rows are removed
 * (file 404 upstream, or dropped from INFOBLOX_FILES) only on a COMPLETE
 * pull: every file answered, none failed or skipped, none deferred.
 *
 * Failure: a file that fails transiently (HTTP error other than 404, a 3xx —
 * redirects are not followed — network, every write batch of the file
 * failing) is skipped, the other files still run, and the pull then throws
 * (feed breaker applies). A file that fails permanently (body over
 * INFOBLOX_MAX_FILE_BYTES, unexpected header) is a per-file warning
 * (`filesSkipped`): the pull still succeeds but is not complete, so no
 * whole-file removal runs. More than half the files failing (either kind)
 * throws; more than half answering 404 also throws (the repository moved)
 * and removes nothing.
 *
 * Licence: CC BY 4.0 — docs/licences/infoblox.md.
 */

const FETCH_TIMEOUT_MS = 20_000;
/** Stop starting new work after this; the default feed timeout is 120 s. */
export const INFOBLOX_RUN_TIME_BUDGET_MS = 75_000;
/** Row writes (upserts + removals) per run. */
export const INFOBLOX_RUN_ROW_WRITE_BUDGET = 50_000;
/** Per-file removal needs the pull to keep ≥ this share of the file's live rows. */
export const INFOBLOX_MIN_RETAIN_RATIO = 0.5;
/** A shrink the retain guard blocked is accepted once the same body was seen on this many consecutive runs. */
export const INFOBLOX_SHRINK_CONFIRM_RUNS = 3;
const README_MAX_BYTES = 256 * 1024;
/** 7 binds per row; 14 rows = 98 binds (D1 caps a statement at 100). */
const ROWS_PER_INSERT = 14;
/** Statements per db.batch. */
const STATEMENTS_PER_BATCH = 40;
/** Indicators per removal UPDATE (plus 3 other binds). */
const REMOVAL_CHUNK = 90;
const UA = "Averrow-ThreatIntel/1.0";

function sqliteUtcStamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function insertSql(rows: number): string {
  return `INSERT INTO infoblox_reference
      (source_file, indicator, indicator_type, classification, detected_date, first_seen, updated_at, removed_at)
    VALUES ${Array.from({ length: rows }, () => "(?, ?, ?, ?, ?, ?, ?, NULL)").join(", ")}
    ON CONFLICT(source_file, indicator) DO UPDATE SET
      indicator_type = excluded.indicator_type,
      classification = excluded.classification,
      detected_date  = excluded.detected_date,
      updated_at     = excluded.updated_at,
      removed_at     = NULL`;
}

/**
 * ?5 / ?6 = etag / content_sha256: the stamp, or NULL when removal was skipped
 * (no stamp → the next run re-reads and re-checks the file). ?10 / ?11 =
 * pending_sha256 / pending_seen (NULL / 0 once a body is fully applied).
 */
const FILE_UPSERT_SQL = `INSERT INTO infoblox_reference_files
    (source_file, label, label_kind, publication_url, etag, content_sha256,
     rows_loaded, rows_capped, status, loaded_at, updated_at, pending_sha256, pending_seen)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'loaded', ?9, ?9, ?10, ?11)
  ON CONFLICT(source_file) DO UPDATE SET
    label = excluded.label, label_kind = excluded.label_kind,
    publication_url = excluded.publication_url, etag = excluded.etag,
    content_sha256 = excluded.content_sha256, rows_loaded = excluded.rows_loaded,
    rows_capped = excluded.rows_capped, status = 'loaded',
    loaded_at = excluded.loaded_at, updated_at = excluded.updated_at,
    pending_sha256 = excluded.pending_sha256, pending_seen = excluded.pending_seen`;

interface FileState {
  source_file: string;
  label: string;
  label_kind: string;
  publication_url: string | null;
  etag: string | null;
  content_sha256: string | null;
  rows_loaded: number;
  status: string;
  pending_sha256: string | null;
  pending_seen: number;
}

interface StoredRow {
  indicator: string;
  indicator_type: string;
  classification: string | null;
  detected_date: string | null;
  removed_at: string | null;
}

export interface InfobloxRunOptions {
  /** Defaults to INFOBLOX_FILES (tests pass a small list). */
  files?: readonly InfobloxFile[];
  now?: () => number;
  timeBudgetMs?: number;
  rowWriteBudget?: number;
  maxRowsPerFile?: number;
  maxRowsTotal?: number;
}

export interface InfobloxRunResult extends FeedResult {
  filesUnchanged: number;
  filesLoaded: number;
  filesDeferred: number;
  filesFailed: string[];
  /** Files skipped for a permanent per-file fault (oversize body, changed header): a warning, not a failure. */
  filesSkipped: string[];
  filesAbsent: string[];
  rowsWritten: number;
  rowsRemoved: number;
  complete: boolean;
}

/**
 * Pure: may this file's stale rows be removed after a full write?
 * `inFile` = valid rows the body holds before our own row caps;
 * `sameBodyRuns` = consecutive runs (this one included) that saw this exact
 * body with removal blocked. A blocked shrink is accepted once the same body
 * was seen INFOBLOX_SHRINK_CONFIRM_RUNS times in a row.
 */
export function infobloxFileRemovalAllowed(args: {
  inFile: number; liveBefore: number; lineCapped: boolean; sameBodyRuns?: number;
}): boolean {
  if ((args.sameBodyRuns ?? 0) >= INFOBLOX_SHRINK_CONFIRM_RUNS) return true;
  if (args.lineCapped) return false;
  return args.inFile >= Math.ceil(args.liveBefore * INFOBLOX_MIN_RETAIN_RATIO);
}

const isRedirect = (s: number) => s >= 300 && s < 400 && s !== 304;

function sameRow(a: InfobloxRow, b: StoredRow): boolean {
  return b.removed_at === null && b.indicator_type === a.type
    && b.classification === a.classification && b.detected_date === a.detectedDate;
}

export async function runInfobloxReference(env: Env, opts: InfobloxRunOptions = {}): Promise<InfobloxRunResult> {
  const db = env.DB;
  const files = opts.files ?? INFOBLOX_FILES;
  const now = opts.now ?? Date.now;
  const timeBudget = opts.timeBudgetMs ?? INFOBLOX_RUN_TIME_BUDGET_MS;
  const rowBudget = opts.rowWriteBudget ?? INFOBLOX_RUN_ROW_WRITE_BUDGET;
  const perFileCap = opts.maxRowsPerFile ?? INFOBLOX_MAX_ROWS_PER_FILE;
  const started = now();
  const stamp = sqliteUtcStamp(new Date());
  const warnings: string[] = [];

  const stateRows = await db.prepare(
    `SELECT source_file, label, label_kind, publication_url, etag, content_sha256, rows_loaded, status,
            pending_sha256, pending_seen
       FROM infoblox_reference_files`,
  ).all<FileState>();
  const state = new Map<string, FileState>();
  for (const r of stateRows.results ?? []) state.set(r.source_file, r);

  let totalLeft = opts.maxRowsTotal ?? INFOBLOX_MAX_ROWS_TOTAL;
  let rowsWritten = 0;
  let rowsRemoved = 0;
  let itemsFetched = 0;
  let itemsDuplicate = 0;
  let filesUnchanged = 0;
  let filesLoaded = 0;
  let filesDeferred = 0;
  const filesFailed: string[] = [];
  const filesSkipped: string[] = [];
  const filesAbsent: string[] = [];
  const outOfBudget = () => now() - started >= timeBudget || rowsWritten >= rowBudget;

  for (const f of files) {
    const prev = state.get(f.file);
    if (outOfBudget()) {
      filesDeferred++;
      totalLeft -= prev?.status === "loaded" ? prev.rows_loaded : 0;
      continue;
    }
    const loadedBefore = prev?.status === "loaded" && prev.content_sha256 !== null;
    let res: Response;
    try {
      const headers: Record<string, string> = { "User-Agent": UA, Accept: "text/csv, text/plain" };
      if (loadedBefore && prev?.etag) headers["If-None-Match"] = prev.etag;
      res = await fetch(INFOBLOX_RAW_BASE + f.file, { headers, redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (e) {
      filesFailed.push(`${f.file}: ${String(e).slice(0, 120)}`);
      continue;
    }
    const metaChanged = !prev || prev.label !== f.label || prev.label_kind !== f.kind || prev.publication_url !== f.publication;
    if (res.status === 304 && loadedBefore && prev) {
      filesUnchanged++;
      itemsDuplicate += prev.rows_loaded;
      totalLeft -= prev.rows_loaded;
      if (metaChanged) {
        await db.prepare(
          `UPDATE infoblox_reference_files SET label = ?, label_kind = ?, publication_url = ?, updated_at = ? WHERE source_file = ?`,
        ).bind(f.label, f.kind, f.publication, stamp, f.file).run();
      }
      continue;
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      filesAbsent.push(f.file);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      filesFailed.push(`${f.file}: HTTP ${res.status}${isRedirect(res.status) ? " (redirect not followed)" : ""}`);
      continue;
    }
    const text = await readCappedText(res, INFOBLOX_MAX_FILE_BYTES);
    if (text === null) {
      filesSkipped.push(`${f.file}: body larger than ${INFOBLOX_MAX_FILE_BYTES} bytes`);
      continue;
    }
    const etag = res.headers.get("ETag");
    const sha = await sha256Hex(text);
    if (loadedBefore && prev && prev.content_sha256 === sha) {
      filesUnchanged++;
      itemsDuplicate += prev.rows_loaded;
      totalLeft -= prev.rows_loaded;
      if (metaChanged || (etag !== null && etag !== prev.etag)) {
        await db.prepare(
          `UPDATE infoblox_reference_files SET label = ?, label_kind = ?, publication_url = ?, etag = ?, updated_at = ? WHERE source_file = ?`,
        ).bind(f.label, f.kind, f.publication, etag ?? prev.etag, stamp, f.file).run();
      }
      continue;
    }

    const fileCap = Math.max(0, Math.min(perFileCap, totalLeft));
    let parsed;
    try {
      parsed = parseInfobloxCsv(text, fileCap);
    } catch (e) {
      filesSkipped.push(`${f.file}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    totalLeft -= parsed.rows.length;
    itemsFetched += parsed.rows.length;
    if (parsed.lineCapped) warnings.push(`${f.file}: line cap reached`);
    // The total cap squeezed this file (maxRows can reach 0): say so, and its
    // over-cap rows are removed below like any row the file no longer keeps.
    const squeezed = fileCap < perFileCap && parsed.capped > 0;
    if (squeezed) {
      warnings.push(`${f.file}: total row cap reached (kept ${parsed.rows.length}, ${parsed.capped} not kept)`);
    }

    const stored = await db.prepare(
      `SELECT indicator, indicator_type, classification, detected_date, removed_at
         FROM infoblox_reference WHERE source_file = ?`,
    ).bind(f.file).all<StoredRow>();
    const existing = new Map<string, StoredRow>();
    for (const r of stored.results ?? []) existing.set(r.indicator, r);
    const liveBefore = [...existing.values()].filter((r) => r.removed_at === null).length;
    const changed = parsed.rows.filter((r) => {
      const e = existing.get(r.indicator);
      return !e || !sameRow(r, e);
    });
    itemsDuplicate += parsed.rows.length - changed.length;

    // Upserts, chunked; stop at the run budget (the file is then resumed).
    let fileComplete = true;
    let batchFailures = 0;
    let firstError: string | null = null;
    for (let i = 0; i < changed.length; i += ROWS_PER_INSERT * STATEMENTS_PER_BATCH) {
      if (outOfBudget()) { fileComplete = false; break; }
      const slice = changed.slice(i, i + ROWS_PER_INSERT * STATEMENTS_PER_BATCH);
      const stmts: D1PreparedStatement[] = [];
      for (let j = 0; j < slice.length; j += ROWS_PER_INSERT) {
        const chunk = slice.slice(j, j + ROWS_PER_INSERT);
        const binds: unknown[] = [];
        for (const r of chunk) binds.push(f.file, r.indicator, r.type, r.classification, r.detectedDate, stamp, stamp);
        stmts.push(db.prepare(insertSql(chunk.length)).bind(...binds));
      }
      try {
        await db.batch(stmts);
        rowsWritten += slice.length;
      } catch (e) {
        batchFailures++;
        fileComplete = false;
        if (!firstError) firstError = String(e).slice(0, 160);
      }
    }
    if (batchFailures > 0) {
      filesFailed.push(`${f.file}: ${batchFailures} write batch(es) failed: ${firstError}`);
      continue;
    }
    if (!fileComplete) {
      filesDeferred++;
      continue;
    }

    // Rows that left the file (or that our caps no longer keep).
    const keep = new Set(parsed.rows.map((r) => r.indicator));
    const gone = [...existing.values()].filter((r) => r.removed_at === null && !keep.has(r.indicator)).map((r) => r.indicator);
    const live = new Set([...existing.values()].filter((r) => r.removed_at === null).map((r) => r.indicator));
    for (const k of keep) live.add(k);
    let removalSkipped = false;
    let sameBodyRuns = 0;
    let fileRemoved = 0;
    if (gone.length > 0) {
      sameBodyRuns = prev?.pending_sha256 === sha ? (prev.pending_seen ?? 0) + 1 : 1;
      const inFile = parsed.rows.length + parsed.capped;
      const guardOk = infobloxFileRemovalAllowed({ inFile, liveBefore, lineCapped: parsed.lineCapped });
      if (guardOk || infobloxFileRemovalAllowed({ inFile, liveBefore, lineCapped: parsed.lineCapped, sameBodyRuns })) {
        if (!guardOk) {
          warnings.push(`${f.file}: shrink accepted after ${sameBodyRuns} runs of the same body (${gone.length} removed)`);
        }
        for (let i = 0; i < gone.length; i += REMOVAL_CHUNK) {
          const chunk = gone.slice(i, i + REMOVAL_CHUNK);
          const r = await db.prepare(
            `UPDATE infoblox_reference SET removed_at = ?, updated_at = ?
              WHERE source_file = ? AND removed_at IS NULL AND indicator IN (${chunk.map(() => "?").join(",")})`,
          ).bind(stamp, stamp, f.file, ...chunk).run();
          const n = Number(r.meta?.changes ?? 0);
          rowsRemoved += n;
          rowsWritten += n;
          fileRemoved += n;
        }
      } else {
        removalSkipped = true;
        warnings.push(
          `${f.file}: removal skipped (${gone.length} missing; in file ${inFile}, live ${liveBefore}; ` +
          `same body ${sameBodyRuns}/${INFOBLOX_SHRINK_CONFIRM_RUNS}) — re-checked next run`,
        );
      }
    }

    // Removal skipped → no ETag / sha stamp, so the next run re-reads the
    // file and re-applies the guard; the body's sha + run count go to pending_*.
    await db.prepare(FILE_UPSERT_SQL).bind(
      f.file, f.label, f.kind, f.publication,
      // Squeezed by the total cap → no stamp either: the file is re-read
      // next run, so it picks up room freed by other files.
      removalSkipped || squeezed ? null : etag, removalSkipped || squeezed ? null : sha,
      live.size - fileRemoved, parsed.capped, stamp,
      removalSkipped ? sha : null, removalSkipped ? sameBodyRuns : 0,
    ).run();
    filesLoaded++;
  }

  // New upstream publications not in INFOBLOX_FILES (report only).
  if (!opts.files && !outOfBudget()) {
    try {
      const r = await fetch(INFOBLOX_INDEX_URL, { headers: { "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const t = r.ok ? await readCappedText(r, README_MAX_BYTES) : null;
      const unlisted = t ? unlistedInfobloxFiles(t) : [];
      if (unlisted.length > 0) warnings.push(`unlisted upstream files: ${unlisted.slice(0, 10).join(", ")}`);
    } catch {
      // best-effort
    }
  }

  if (filesAbsent.length > files.length / 2) {
    throw new Error(`infoblox_reference: ${filesAbsent.length}/${files.length} files answered 404 — repository moved? nothing removed`);
  }

  const failedCount = filesFailed.length + filesSkipped.length;
  if (failedCount > files.length / 2) {
    throw new Error(`infoblox_reference: ${failedCount}/${files.length} files failed: ${[...filesFailed, ...filesSkipped].slice(0, 5).join("; ")}`);
  }

  const complete = failedCount === 0 && filesDeferred === 0;
  if (complete) {
    // Whole files gone upstream (404) or dropped from the list.
    const listed = new Set(files.map((f) => f.file));
    const toClear: Array<{ file: string; status: "absent" | "retired" }> = [
      ...filesAbsent.filter((f) => state.get(f)?.status === "loaded").map((file) => ({ file, status: "absent" as const })),
      ...[...state.values()].filter((s) => s.status === "loaded" && !listed.has(s.source_file))
        .map((s) => ({ file: s.source_file, status: "retired" as const })),
    ];
    for (const c of toClear) {
      const r = await db.prepare(
        `UPDATE infoblox_reference SET removed_at = ?, updated_at = ? WHERE source_file = ? AND removed_at IS NULL`,
      ).bind(stamp, stamp, c.file).run();
      rowsRemoved += Number(r.meta?.changes ?? 0);
      await db.prepare(
        `UPDATE infoblox_reference_files SET status = ?, etag = NULL, content_sha256 = NULL, rows_loaded = 0, updated_at = ? WHERE source_file = ?`,
      ).bind(c.status, stamp, c.file).run();
    }
  } else if (filesAbsent.length > 0) {
    warnings.push(`file removal skipped (incomplete pull): ${filesAbsent.join(", ")}`);
  }

  if (filesDeferred > 0) warnings.push(`${filesDeferred} file(s) deferred to the next run (budget)`);
  if (filesAbsent.length > 0) warnings.push(`404 upstream: ${filesAbsent.join(", ")}`);
  if (filesSkipped.length > 0) warnings.unshift(`file(s) skipped: ${filesSkipped.slice(0, 5).join("; ")}`);
  if (filesFailed.length > 0) {
    throw new Error(`infoblox_reference: ${filesFailed.length} file(s) failed: ${filesFailed.slice(0, 5).join("; ")}`);
  }

  return {
    itemsFetched,
    // Context feed: never counts as new threat items (Sentinel stays asleep).
    itemsNew: 0,
    itemsDuplicate,
    itemsError: 0,
    ...(warnings.length > 0 ? { warning: `infoblox_reference: ${warnings.join("; ").slice(0, 900)}` } : {}),
    filesUnchanged,
    filesLoaded,
    filesDeferred,
    filesFailed,
    filesSkipped,
    filesAbsent,
    rowsWritten,
    rowsRemoved,
    complete,
  };
}

export const infoblox_reference: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const r = await runInfobloxReference(ctx.env);
    return {
      itemsFetched: r.itemsFetched,
      itemsNew: 0,
      itemsDuplicate: r.itemsDuplicate,
      itemsError: r.itemsError,
      ...(r.warning ? { warning: r.warning } : {}),
    };
  },
};
