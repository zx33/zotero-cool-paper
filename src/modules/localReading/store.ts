import type { Answers, Checks, Completion } from "./protocol";
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

export interface ReadingRun {
  id: string;
  identity: string;
  hash: string;
  model: string;
  protocol: string;
  started: number;
  ended?: number;
  status: "running" | "complete" | "failed" | "cancelled";
  message?: string;
  estimate?: number;
  completion: Completion;
  answers?: Answers;
  checks?: Checks;
  cleanupPending?: boolean;
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
}
export interface ReadingStore {
  getText(hash: string): Promise<string | undefined>;
  putText(hash: string, text: string): Promise<void>;
  save(run: ReadingRun): Promise<void>;
  latest(
    identity: string,
    completeOnly?: boolean,
  ): Promise<ReadingRun | undefined>;
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
      "CREATE TABLE IF NOT EXISTS pcp_reading_remote (id TEXT PRIMARY KEY, account TEXT NOT NULL)",
    );
    // Interrupted attempts must never appear as active jobs after restarting.
    const rows = (await privateQuery(
      "SELECT payload FROM pcp_reading_runs WHERE status = 'running'",
    )) as { payload: string }[];
    for (const row of rows) {
      const run = parseRun(row.payload);
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
      "SELECT id, account FROM pcp_reading_remote WHERE account = ?",
      [account],
    )) as RemoteFile[];
  },
  async addRemote(file) {
    await initReadingStore();
    await privateQuery(
      "INSERT OR REPLACE INTO pcp_reading_remote VALUES (?, ?)",
      [file.id, file.account],
    );
  },
  async removeRemote(id) {
    await initReadingStore();
    await privateQuery("DELETE FROM pcp_reading_remote WHERE id = ?", [id]);
  },
};
