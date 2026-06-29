import type { CacheEntry, PaperReference, PapersCoolBranch } from "./types";

const TABLE_NAME = "paperscool_cache";

let initialized = false;

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

  return rowToCache(rows[0]);
}

export async function saveCachePatch(
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
