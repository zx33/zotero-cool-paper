import type {
  Answers,
  BatchResult,
  Checks,
  Completion,
  Question,
} from "./protocol";
import type { BatchStatus } from "./client";
import { ReadingError } from "./runtime";

// Zotero logs SQL parameters in debug mode, and includes them in SQL errors.
// Keep paper text, responses, and remote-file identifiers out of both paths.
async function privateQuery(
  sql: string,
  params?: Parameters<typeof Zotero.DB.queryAsync>[1],
) {
  const options: NonNullable<Parameters<typeof Zotero.DB.queryAsync>[2]> & {
    debug: false;
  } = { debug: false };
  try {
    return await Zotero.DB.queryAsync(sql, params, options);
  } catch {
    throw new ReadingError(
      "本地解读数据库读写失败，请检查数据目录权限和剩余磁盘空间。",
    );
  }
}

export interface QuestionProgress {
  status: "pending" | "complete" | "failed";
  parts: Completion[];
  error?: string;
}
export interface ReadingBatch {
  id?: string;
  inputFile?: string;
  outputFile?: string;
  errorFile?: string;
  submitting?: boolean;
  status?: BatchStatus;
  requests: { customID: string; question: Question }[];
  results?: BatchResult[];
}
export interface ReadingRun {
  id: string;
  identity: string;
  hash: string;
  model: string;
  protocol: string;
  started: number;
  ended?: number;
  status: "running" | "complete" | "partial" | "failed" | "cancelled";
  message?: string;
  estimate?: number;
  completion: Completion;
  answers?: Answers;
  checks?: Checks;
  cleanupPending?: boolean;
  account?: string;
  batches?: ReadingBatch[];
  questions?: Partial<Record<Question, QuestionProgress>>;
  cancelRequested?: boolean;
  usageIncomplete?: boolean;
}

function parseRun(payload: string): ReadingRun {
  try {
    return JSON.parse(payload) as ReadingRun;
  } catch {
    // JSON parse errors can include a fragment of a damaged private record.
    throw new ReadingError("本地解读记录损坏，请检查数据库或从备份恢复。");
  }
}

export interface RemoteFile {
  id: string;
  account: string;
  runID?: string;
}
export interface ReadingStore {
  getText(hash: string): Promise<string | undefined>;
  putText(hash: string, text: string): Promise<void>;
  save(run: ReadingRun): Promise<void>;
  latest(
    identity: string,
    completeOnly?: boolean,
  ): Promise<ReadingRun | undefined>;
  active(): Promise<ReadingRun[]>;
  pending(account: string): Promise<RemoteFile[]>;
  addRemote(file: RemoteFile): Promise<void>;
  removeRemote(id: string): Promise<void>;
}

let ready: Promise<void> | undefined;
export function initReadingStore(): Promise<void> {
  return (ready ??= (async () => {
    await privateQuery(
      "CREATE TABLE IF NOT EXISTS pcp_reading_text (hash TEXT PRIMARY KEY, content TEXT NOT NULL)",
    );
    await privateQuery(
      "CREATE TABLE IF NOT EXISTS pcp_reading_runs (id TEXT PRIMARY KEY, identity TEXT NOT NULL, status TEXT NOT NULL, started INTEGER NOT NULL, payload TEXT NOT NULL)",
    );
    await privateQuery(
      "CREATE INDEX IF NOT EXISTS pcp_reading_identity ON pcp_reading_runs(identity, started)",
    );
    await privateQuery(
      "CREATE TABLE IF NOT EXISTS pcp_reading_remote (id TEXT PRIMARY KEY, account TEXT NOT NULL, run_id TEXT)",
    );
    const columns = (await privateQuery(
      "PRAGMA table_info(pcp_reading_remote)",
    )) as { name: string }[];
    if (!columns.some((column) => column.name === "run_id"))
      await privateQuery(
        "ALTER TABLE pcp_reading_remote ADD COLUMN run_id TEXT",
      );
    // Submitted batches continue on Kimi and can be resumed after restart.
    const rows = (await privateQuery(
      "SELECT payload FROM pcp_reading_runs WHERE status = 'running'",
    )) as { payload: string }[];
    for (const row of rows) {
      const run = parseRun(row.payload);
      if (run.batches?.length) continue;
      run.status = "failed";
      run.message = "上次运行被中断；用量可能不完整。可按需重新生成。";
      await privateQuery(
        "UPDATE pcp_reading_runs SET status = ?, payload = ? WHERE id = ?",
        [run.status, JSON.stringify(run), run.id],
      );
    }
  })().catch((error) => {
    ready = undefined;
    throw error;
  }));
}

export const readingStore: ReadingStore = {
  async getText(hash) {
    await initReadingStore();
    const rows = (await privateQuery(
      "SELECT content FROM pcp_reading_text WHERE hash = ?",
      [hash],
    )) as { content: string }[];
    return rows[0]?.content;
  },
  async putText(hash, text) {
    await initReadingStore();
    await privateQuery(
      "INSERT OR REPLACE INTO pcp_reading_text VALUES (?, ?)",
      [hash, text],
    );
  },
  async save(run) {
    await initReadingStore();
    await privateQuery(
      "INSERT OR REPLACE INTO pcp_reading_runs VALUES (?, ?, ?, ?, ?)",
      [run.id, run.identity, run.status, run.started, JSON.stringify(run)],
    );
  },
  async latest(identity, completeOnly = false) {
    await initReadingStore();
    const rows = (await privateQuery(
      `SELECT payload FROM pcp_reading_runs WHERE identity = ? ${completeOnly ? "AND status = 'complete'" : ""} ORDER BY started DESC, rowid DESC LIMIT 1`,
      [identity],
    )) as { payload: string }[];
    return rows.length ? parseRun(rows[0].payload) : undefined;
  },
  async pending(account) {
    await initReadingStore();
    return (await privateQuery(
      "SELECT id, account, run_id AS runID FROM pcp_reading_remote WHERE account = ? AND (run_id IS NULL OR NOT EXISTS (SELECT 1 FROM pcp_reading_runs r WHERE r.id = run_id AND r.status = 'running'))",
      [account],
    )) as RemoteFile[];
  },
  async addRemote(file) {
    await initReadingStore();
    await privateQuery(
      "INSERT OR REPLACE INTO pcp_reading_remote (id, account, run_id) VALUES (?, ?, ?)",
      [file.id, file.account, file.runID ?? null],
    );
  },
  async removeRemote(id) {
    await initReadingStore();
    await privateQuery("DELETE FROM pcp_reading_remote WHERE id = ?", [id]);
  },
  async active() {
    await initReadingStore();
    const rows = (await privateQuery(
      "SELECT payload FROM pcp_reading_runs WHERE status = 'running'",
    )) as { payload: string }[];
    return rows.map((row) => parseRun(row.payload));
  },
};
