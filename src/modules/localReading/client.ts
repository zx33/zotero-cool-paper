import {
  MAX_OUTPUT,
  MODEL,
  messagesFor,
  responseFormat,
  usageFrom,
  type Completion,
} from "./protocol";
import { ReadingError, runtime } from "./runtime";

const BASE = "https://api.moonshot.cn/v1";
type Messages = ReturnType<typeof messagesFor>;
export interface ReadingClient {
  upload(bytes: Uint8Array): Promise<string>;
  extract(id: string, signal: AbortSignal): Promise<string>;
  remove(id: string): Promise<void>;
  estimate(messages: Messages, signal: AbortSignal): Promise<number>;
  complete(
    messages: Messages,
    signal: AbortSignal,
    result: Completion,
    progress: (chars: number) => void,
  ): Promise<void>;
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
      !/^\/(files(?:\/[a-zA-Z0-9_-]+(?:\/content)?)?|tokenizers\/estimate-token-count|chat\/completions)$/.test(
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
        headers: { ...init.headers, Authorization: `Bearer ${this.key}` },
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      });
      if (!response.ok) {
        // Never read or log server error bodies; they may echo private input.
        await response.body?.cancel();
        if (init.method === "DELETE" && response.status === 404)
          return undefined as T;
        const hints: Record<number, string> = {
          401: "API Key 无效",
          403: "API Key 权限不足",
          429: "余额不足或请求过于频繁",
        };
        throw new ReadingError(
          `Kimi 请求失败（HTTP ${response.status}${hints[response.status] ? `，${hints[response.status]}` : ""}）。未自动重试。`,
        );
      }
      return await read(response);
    } catch (error) {
      if (error instanceof ReadingError) throw error;
      throw new ReadingError(
        signal?.aborted
          ? "已取消；已送出的请求仍可能计费。"
          : "Kimi 请求超时、网络中断或响应无效。未自动重试。",
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
    // Finish an in-flight upload to obtain its ID for deletion, even after Cancel.
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
      `/files/${id}/content`,
      { method: "GET" },
      (r) => r.text(),
      signal,
    );
  }

  remove(id: string): Promise<void> {
    return this.request(
      `/files/${id}`,
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

  estimate(messages: Messages, signal: AbortSignal): Promise<number> {
    return this.request(
      "/tokenizers/estimate-token-count",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages }),
      },
      async (response) => {
        const value = (await response.json()) as unknown as {
          data?: { total_tokens: number };
          total_tokens: number;
        };
        return value.data?.total_tokens ?? value.total_tokens;
      },
      signal,
    );
  }

  complete(
    messages: Messages,
    signal: AbortSignal,
    result: Completion,
    progress: (chars: number) => void,
  ): Promise<void> {
    return this.request(
      "/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages,
          thinking: { type: "disabled" },
          max_tokens: MAX_OUTPUT,
          response_format: responseFormat(),
          stream: true,
          stream_options: { include_usage: true },
        }),
      },
      async (response) => {
        if (!response.body) throw new ReadingError("Kimi 未返回响应流。");
        const reader =
          response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
        const decoder = new (runtime().TextDecoder)();
        const parser = new CompletionStream(result, progress);
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            parser.feed(decoder.decode(chunk.value, { stream: true }));
          }
          parser.feed(decoder.decode(new Uint8Array()) + "\n\n");
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      },
      signal,
      300_000,
    );
  }
}

export class CompletionStream {
  private buffer = "";
  private event: string[] = [];
  private size = 0;
  constructor(
    private result: Completion,
    private progress: (chars: number) => void = () => {},
  ) {}

  feed(text: string): void {
    this.size += text.length;
    if (this.size > 2_000_000)
      throw new ReadingError("响应流过大，已停止读取。");
    this.buffer += text;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (!line) this.dispatch();
      else if (line.startsWith("data:"))
        this.event.push(line.slice(5).trimStart());
    }
  }

  private dispatch(): void {
    const data = this.event.join("\n");
    this.event = [];
    if (!data) return;
    if (data === "[DONE]") {
      this.result.done = true;
      return;
    }
    if (this.result.done) throw new ReadingError("响应结束后仍有数据。");
    let value;
    try {
      value = JSON.parse(data);
    } catch {
      throw new ReadingError("响应流格式异常。");
    }
    if (value.error) throw new ReadingError("Kimi 在生成过程中返回错误。");
    const usage = usageFrom(value.usage);
    if (usage) this.result.usage = usage;
    for (const choice of value.choices ?? []) {
      if (choice.index !== undefined && choice.index !== 0) continue;
      if (typeof choice.delta?.content === "string")
        this.result.content += choice.delta.content;
      if (typeof choice.finish_reason === "string")
        this.result.finish = choice.finish_reason;
    }
    this.progress(this.result.content.length);
  }
}
