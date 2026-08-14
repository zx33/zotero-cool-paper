import type { CacheEntry, PaperReference, PapersCoolBranch } from "./types";

const TABLE_NAME = "paperscool_cache";
const UPDATED_AT_INDEX = "paperscool_cache_updated_at";
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ROWS = 500;
const CACHE_ROW_RETENTION_MS = 90 * DAY_MS;

export const CACHE_TTL_MS = {
  metadata: 7 * DAY_MS,
  kimi: 30 * DAY_MS,
  related: 7 * DAY_MS,
} as const;

let initialized = false;
let writeQueue: Promise<void> = Promise.resolve();

export async function initPapersCoolCache() {
  if (initialized) {
    return;
  }

  await Zotero.DB.queryAsync(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      cache_key TEXT PRIMARY KEY,
      branch TEXT NOT NULL,
      paper_key TEXT NOT NULL,
      metadata_json TEXT,
      kimi_html TEXT,
      related_json TEXT,
      metadata_fetched_at INTEGER,
      kimi_fetched_at INTEGER,
      related_fetched_at INTEGER,
      updated_at INTEGER NOT NULL
    )
  `);
  await Zotero.DB.queryAsync(
    `CREATE INDEX IF NOT EXISTS ${UPDATED_AT_INDEX} ON ${TABLE_NAME}(updated_at)`,
  );
  await pruneCacheRows();

  initialized = true;
}

export function getCacheKey(reference: Pick<PaperReference, "branch" | "key">) {
  return `${reference.branch}:${reference.key}`;
}

export async function getCache(
  reference: Pick<PaperReference, "branch" | "key">,
): Promise<CacheEntry | undefined> {
  await initPapersCoolCache();
  const rows = (await Zotero.DB.queryAsync(
    `SELECT * FROM ${TABLE_NAME} WHERE cache_key = ?`,
    [getCacheKey(reference)],
  )) as Array<Record<string, unknown>>;

  if (!rows.length) {
    return undefined;
  }

  return applyCacheTTL(rowToCache(rows[0]));
}

export function saveCachePatch(
  reference: Pick<PaperReference, "branch" | "key">,
  patch: Partial<CacheEntry>,
) {
  return enqueueWrite(() => saveCachePatchNow(reference, patch));
}

export function clearPapersCoolCache() {
  return enqueueWrite(async () => {
    await initPapersCoolCache();
    await Zotero.DB.queryAsync(`DELETE FROM ${TABLE_NAME}`);
  });
}

export function applyCacheTTL(cache: CacheEntry, now = Date.now()) {
  const metadataFresh = isFresh(
    cache.metadata,
    cache.metadataFetchedAt,
    CACHE_TTL_MS.metadata,
    now,
  );
  const kimiFresh = isFresh(
    cache.kimiHTML,
    cache.kimiFetchedAt,
    CACHE_TTL_MS.kimi,
    now,
  );
  const relatedFresh = isFresh(
    cache.related,
    cache.relatedFetchedAt,
    CACHE_TTL_MS.related,
    now,
  );

  return {
    ...cache,
    metadata: metadataFresh ? cache.metadata : undefined,
    metadataFetchedAt: metadataFresh ? cache.metadataFetchedAt : undefined,
    kimiHTML: kimiFresh ? cache.kimiHTML : undefined,
    kimiFetchedAt: kimiFresh ? cache.kimiFetchedAt : undefined,
    related: relatedFresh ? cache.related : undefined,
    relatedFetchedAt: relatedFresh ? cache.relatedFetchedAt : undefined,
  };
}

async function saveCachePatchNow(
  reference: Pick<PaperReference, "branch" | "key">,
  patch: Partial<CacheEntry>,
) {
  await initPapersCoolCache();

  const current = (await getCache(reference)) ?? {
    cacheKey: getCacheKey(reference),
    branch: reference.branch as PapersCoolBranch,
    key: reference.key,
  };
  const next: CacheEntry = {
    ...current,
    ...patch,
    cacheKey: getCacheKey(reference),
    branch: reference.branch as PapersCoolBranch,
    key: reference.key,
    updatedAt: Date.now(),
  };

  await Zotero.DB.queryAsync(
    `
      INSERT INTO ${TABLE_NAME} (
        cache_key,
        branch,
        paper_key,
        metadata_json,
        kimi_html,
        related_json,
        metadata_fetched_at,
        kimi_fetched_at,
        related_fetched_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        branch = excluded.branch,
        paper_key = excluded.paper_key,
        metadata_json = excluded.metadata_json,
        kimi_html = excluded.kimi_html,
        related_json = excluded.related_json,
        metadata_fetched_at = excluded.metadata_fetched_at,
        kimi_fetched_at = excluded.kimi_fetched_at,
        related_fetched_at = excluded.related_fetched_at,
        updated_at = excluded.updated_at
    `,
    [
      next.cacheKey,
      next.branch,
      next.key,
      toJSON(next.metadata),
      next.kimiHTML ?? null,
      toJSON(next.related),
      next.metadataFetchedAt ?? null,
      next.kimiFetchedAt ?? null,
      next.relatedFetchedAt ?? null,
      next.updatedAt ?? Date.now(),
    ],
  );
  await pruneCacheRows();
}

async function pruneCacheRows(now = Date.now()) {
  await Zotero.DB.queryAsync(`DELETE FROM ${TABLE_NAME} WHERE updated_at < ?`, [
    now - CACHE_ROW_RETENTION_MS,
  ]);
  await Zotero.DB.queryAsync(`
    DELETE FROM ${TABLE_NAME}
    WHERE cache_key IN (
      SELECT cache_key
      FROM ${TABLE_NAME}
      ORDER BY updated_at DESC, cache_key ASC
      LIMIT -1 OFFSET ${CACHE_MAX_ROWS}
    )
  `);
}

function enqueueWrite<T>(operation: () => Promise<T>) {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isFresh(
  value: unknown,
  fetchedAt: number | undefined,
  ttl: number,
  now: number,
) {
  return (
    value !== undefined && fetchedAt !== undefined && now - fetchedAt < ttl
  );
}

function rowToCache(row: Record<string, unknown>): CacheEntry {
  return {
    cacheKey: String(row.cache_key),
    branch: row.branch as PapersCoolBranch,
    key: String(row.paper_key),
    metadata: fromJSON(row.metadata_json),
    kimiHTML:
      typeof row.kimi_html === "string" ? String(row.kimi_html) : undefined,
    related: fromJSON(row.related_json),
    metadataFetchedAt: toNumber(row.metadata_fetched_at),
    kimiFetchedAt: toNumber(row.kimi_fetched_at),
    relatedFetchedAt: toNumber(row.related_fetched_at),
    updatedAt: toNumber(row.updated_at),
  };
}

function toJSON(value: unknown) {
  return value === undefined ? null : JSON.stringify(value);
}

function fromJSON<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    ztoolkit.log("Failed to parse papers.cool cache JSON", error);
    return undefined;
  }
}

function toNumber(value: unknown) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value) {
    return Number(value);
  }
  return undefined;
}
