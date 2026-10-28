import { type BatchRequest } from "./protocol";
import { ReadingError, runtime } from "./runtime";

const BASE = "https://api.moonshot.cn/v1";
export type BatchStatus =
  | "validating"
  | "in_progress"
  | "finalizing"
  | "completed"
  | "failed"
  | "expired"
  | "cancelling"
  | "cancelled";
export interface RemoteBatch {
  id: string;
  status: BatchStatus;
  input_file_id?: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
  request_counts?: { completed: number; failed: number; total: number };
}
export interface ReadingClient {
  upload(bytes: Uint8Array): Promise<string>;
  extract(id: string, signal: AbortSignal): Promise<string>;
  remove(id: string): Promise<void>;
  uploadBatch(requests: BatchRequest[]): Promise<string>;
  createBatch(inputFile: string): Promise<RemoteBatch>;
  getBatch(id: string, signal: AbortSignal): Promise<RemoteBatch>;
  findBatch(
    inputFile: string,
    signal: AbortSignal,
  ): Promise<RemoteBatch | undefined>;
  cancelBatch(id: string): Promise<RemoteBatch>;
}

export class KimiClient implements ReadingClient {
  constructor(
    private key: string,
    private fetcher: typeof fetch = runtime().fetch.bind(runtime()),
  ) {}

  private async request<T>(
    path: string,
    init: RequestInit,
    read: (response: Response) => Promise<T>,
    signal?: AbortSignal,
    timeout = 180_000,
  ): Promise<T> {
    if (
      !/^\/(files(?:\/[a-zA-Z0-9_-]+(?:\/content)?)?|batches(?:\/[a-zA-Z0-9_-]+(?:\/cancel)?|\?limit=100(?:&after=[a-zA-Z0-9_-]+)?)?)$/.test(
        path,
      )
    )
      throw new ReadingError("请求地址无效。");
    const win = runtime();
    const controller = new win.AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = win.setTimeout(abort, timeout);
    try {
      const response = await this.fetcher(BASE + path, {
        ...init,
        headers: { ...init.headers, Authorization: "Bearer " + this.key },
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (init.method === "DELETE" && response.status === 404)
          return undefined as T;
        const hints: Record<number, string> = {
          401: "API Key 无效",
          403: "API Key 权限不足",
          429: "余额不足或请求过于频繁",
        };
        throw new ReadingError(
          "Kimi 请求失败（HTTP " +
            response.status +
            (hints[response.status] ? "，" + hints[response.status] : "") +
            "）。",
          response.status,
        );
      }
      return await read(response);
    } catch (error) {
      if (error instanceof ReadingError) throw error;
      throw new ReadingError(
        signal?.aborted
          ? "已停止本次查询。"
          : "Kimi 请求超时、网络中断或响应无效。",
      );
    } finally {
      win.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async upload(bytes: Uint8Array): Promise<string> {
    const win = runtime();
    const data = new win.FormData();
    data.append("purpose", "file-extract");
    data.append(
      "file",
      new win.Blob([bytes as Uint8Array<ArrayBuffer>], {
        type: "application/pdf",
      }),
      "paper.pdf",
    );
    // Complete uploads to obtain an ID even if the user cancels meanwhile.
    return this.request(
      "/files",
      { method: "POST", body: data },
      async (response) => {
        const value = (await response.json()) as unknown as { id: unknown };
        if (typeof value.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value.id))
          throw new ReadingError("上传没有返回有效文件编号。");
        return value.id;
      },
    );
  }

  extract(id: string, signal: AbortSignal): Promise<string> {
    return this.request(
      "/files/" + id + "/content",
      { method: "GET" },
      (r) => r.text(),
      signal,
    );
  }

  remove(id: string): Promise<void> {
    return this.request(
      "/files/" + id,
      { method: "DELETE" },
      async (r) => {
        const result = (await r.json()) as unknown as { deleted: unknown };
        if (result.deleted !== true)
          throw new ReadingError("云端文件尚未确认删除。");
      },
      undefined,
      30_000,
    );
  }

  uploadBatch(requests: BatchRequest[]): Promise<string> {
    const win = runtime();
    const file = new win.Blob(
      [requests.map((r) => JSON.stringify(r)).join("\n") + "\n"],
      { type: "application/jsonl" },
    );
    if (file.size > 100_000_000)
      throw new ReadingError(
        "六问请求文件超过 Batch 接口的 100 MB 限制，正文未被裁剪。",
      );
    const data = new win.FormData();
    data.append("purpose", "batch");
    data.append("file", file, "questions.jsonl");
    return this.request("/files", { method: "POST", body: data }, async (r) => {
      const value = (await r.json()) as unknown as { id: unknown };
      if (typeof value.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value.id))
        throw new ReadingError("批次上传没有返回有效文件编号。");
      return value.id;
    });
  }

  createBatch(inputFile: string): Promise<RemoteBatch> {
    // Do not abort submission: the returned ID is needed to resume or cancel.
    return this.request(
      "/batches",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input_file_id: inputFile,
          endpoint: "/v1/chat/completions",
          completion_window: "24h",
        }),
      },
      readBatch,
    );
  }

  getBatch(id: string, signal: AbortSignal): Promise<RemoteBatch> {
    return this.request(
      "/batches/" + id,
      { method: "GET" },
      readBatch,
      signal,
      30_000,
    );
  }

  async findBatch(
    inputFile: string,
    signal: AbortSignal,
  ): Promise<RemoteBatch | undefined> {
    let after = "";
    while (true) {
      const page = (await this.request(
        "/batches?limit=100" + (after ? "&after=" + after : ""),
        { method: "GET" },
        (r) => r.json(),
        signal,
        30_000,
      )) as unknown as {
        data: RemoteBatch[];
        has_more: boolean;
        last_id?: string;
      };
      if (!Array.isArray(page.data))
        throw new ReadingError("批次列表格式无效。");
      const match = page.data.find(
        (batch) => batch.input_file_id === inputFile,
      );
      if (match) return match;
      if (!page.has_more) return;
      const next = page.last_id ?? page.data.at(-1)?.id;
      if (!next || next === after)
        throw new ReadingError("批次列表未能完整读取。");
      after = next;
    }
  }

  cancelBatch(id: string): Promise<RemoteBatch> {
    return this.request(
      "/batches/" + id + "/cancel",
      { method: "POST" },
      readBatch,
      undefined,
      30_000,
    );
  }
}

async function readBatch(response: Response): Promise<RemoteBatch> {
  const batch = (await response.json()) as unknown as RemoteBatch;
  const statuses: string[] = [
    "validating",
    "in_progress",
    "finalizing",
    "completed",
    "failed",
    "expired",
    "cancelling",
    "cancelled",
  ];
  if (
    typeof batch.id !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(batch.id) ||
    !statuses.includes(batch.status)
  )
    throw new ReadingError("Kimi 未返回有效批次状态。");
  return batch;
}
