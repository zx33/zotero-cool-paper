import { KimiClient, type ReadingClient } from "./client";
import { getAPIKey } from "./credentials";
import {
  decodeExtraction,
  makeSources,
  messagesFor,
  MODEL,
  preflight,
  PROTOCOL,
  validate,
} from "./protocol";
import { io, ReadingError, runtime, safeError, sha256 } from "./runtime";
import { readingStore, type ReadingRun, type ReadingStore } from "./store";

const MAX_PDF = 100 * 1024 * 1024;
export interface PDFIdentity {
  identity: string;
  hash: string;
  attachmentID: number;
  path: string;
}
export interface Job {
  run: ReadingRun;
  controller: AbortController;
  done: Promise<ReadingRun>;
}

export async function readPDF(path: string): Promise<Uint8Array> {
  if ((await io().stat(path)).size > MAX_PDF)
    throw new ReadingError("PDF 超过本版支持的 100 MiB。");
  const bytes = await io().read(path);
  if (
    bytes.length > MAX_PDF ||
    !new (runtime().TextDecoder)()
      .decode(bytes.slice(0, 1024))
      .includes("%PDF-")
  )
    throw new ReadingError("附件不是有效 PDF，或文件过大。");
  return bytes;
}

export async function identifyPDF(
  attachment: Zotero.Item,
): Promise<PDFIdentity> {
  const path = await attachment.getFilePathAsync();
  if (!path)
    throw new ReadingError("PDF 尚未下载到本机，请先在 Zotero 中打开附件。");
  const hash = await sha256(await readPDF(path));
  return {
    identity: `${attachment.libraryID}:${attachment.key}:${hash}`,
    hash,
    path,
    attachmentID: attachment.id,
  };
}

export class ReadingService {
  private jobs = new Map<string, Job>();
  private listeners = new Set<() => void>();
  constructor(
    readonly store: ReadingStore = readingStore,
    private key: () => string = getAPIKey,
    private client: (key: string) => ReadingClient = (key) =>
      new KimiClient(key),
    private read: (path: string) => Promise<Uint8Array> = readPDF,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* UI teardown must not interrupt a paid request. */
      }
    }
  }
  job(identity: string): Job | undefined {
    return this.jobs.get(identity);
  }
  busy(): boolean {
    return this.jobs.size > 0;
  }
  cancel(identity: string): void {
    const job = this.jobs.get(identity);
    if (job) {
      job.run.message =
        "正在取消并清理云端文件；上传中的请求会先取得文件编号。";
      job.controller.abort();
      this.notify();
    }
  }
  shutdown(): void {
    for (const id of this.jobs.keys()) this.cancel(id);
    this.listeners.clear();
  }

  start(pdf: PDFIdentity, limit: number): Promise<ReadingRun> {
    const active = this.jobs.get(pdf.identity);
    if (active) return active.done;
    if (this.busy())
      return Promise.reject(
        new ReadingError("另一篇论文正在生成，请先等待完成或取消。"),
      );
    const run: ReadingRun = {
      id: Zotero.Utilities.randomString(24),
      identity: pdf.identity,
      hash: pdf.hash,
      model: MODEL,
      protocol: PROTOCOL,
      started: Date.now(),
      status: "running",
      completion: { content: "", done: false },
      message: "正在检查 PDF 与 API Key…",
    };
    const controller = new (runtime().AbortController)();
    const job = { run, controller, done: Promise.resolve(run) };
    this.jobs.set(pdf.identity, job);
    // Defer work so the job is visible before listeners or a second click run.
    job.done = Promise.resolve()
      .then(() => this.execute(pdf, limit, job))
      .finally(() => {
        this.jobs.delete(pdf.identity);
        this.notify();
      });
    this.notify();
    return job.done;
  }

  async cleanup(): Promise<number> {
    if (this.busy()) throw new ReadingError("生成完成后才能手动清理云端文件。");
    const key = this.key();
    if (!key) throw new ReadingError("请先保存 API Key。");
    const account = await sha256(new (runtime().TextEncoder)().encode(key));
    const client = this.client(key);
    let failed = 0;
    for (const file of await this.store.pending(account)) {
      try {
        await client.remove(file.id);
        await this.store.removeRemote(file.id);
      } catch {
        failed++;
      }
    }
    return failed;
  }

  private async execute(
    pdf: PDFIdentity,
    limit: number,
    job: Job,
  ): Promise<ReadingRun> {
    const { run, controller } = job;
    let remote: string | undefined;
    let client: ReadingClient | undefined;
    let account: string | undefined;
    const check = () => {
      if (controller.signal.aborted)
        throw new ReadingError("已取消；已送出的请求仍可能计费。");
    };
    const update = (message: string) => {
      if (!controller.signal.aborted) run.message = message;
      this.notify();
    };
    try {
      await this.store.save(run);
      const key = this.key();
      if (!key) throw new ReadingError("请在此页的设置中保存 Kimi API Key。");
      client = this.client(key);
      const bytes = await this.read(pdf.path);
      if ((await sha256(bytes)) !== pdf.hash)
        throw new ReadingError("PDF 已发生变化，请重新选择附件后生成。");
      check();
      account = await sha256(new (runtime().TextEncoder)().encode(key));
      for (const file of await this.store.pending(account)) {
        try {
          await client.remove(file.id);
          await this.store.removeRemote(file.id);
        } catch {
          run.cleanupPending = true;
        }
        check();
      }
      let text = await this.store.getText(pdf.hash);
      if (!text) {
        update("正在向 Kimi 上传所选 PDF…");
        remote = await client.upload(bytes);
        await this.store.addRemote({ id: remote, account });
        check();
        update("正在读取 PDF 解析结果…");
        const raw = await client.extract(remote, controller.signal);
        try {
          text = decodeExtraction(raw);
        } catch {
          throw new ReadingError("文件解析未返回可读正文，无法生成解读。");
        }
        await this.store.putText(pdf.hash, text);
        // Delete as soon as extraction is safely persisted; generation uses cached text.
        try {
          await client.remove(remote);
          await this.store.removeRemote(remote);
          remote = undefined;
        } catch {
          run.cleanupPending = true;
        }
      }
      check();
      const sources = makeSources(text);
      const messages = messagesFor(sources);
      update("正在估算 token 用量与费用…");
      const tokens = await client.estimate(messages, controller.signal);
      try {
        run.estimate = preflight(tokens, limit);
      } catch (error) {
        throw new ReadingError((error as Error).message);
      }
      await this.store.save(run);
      check();
      update(`正在生成六问，预估费用上界 ¥${run.estimate.toFixed(3)}…`);
      let lastUpdate = 0;
      await client.complete(
        messages,
        controller.signal,
        run.completion,
        (chars) => {
          if (Date.now() - lastUpdate > 500) {
            lastUpdate = Date.now();
            update(`正在生成六问，已收到 ${chars.toLocaleString()} 字符…`);
          }
        },
      );
      check();
      const result = validate(run.completion, sources);
      run.checks = result.checks;
      if (!result.answers)
        throw new ReadingError(
          `本次响应未通过完整性检查：${result.checks.errors.join(" ")} 原始草稿已保留，上一版解读不变。`,
        );
      run.answers = result.answers;
      run.status = "complete";
      run.message = result.checks.warnings.length
        ? "解读已保存，请检查提示。"
        : "解读已保存到本机。";
    } catch (error) {
      run.status = controller.signal.aborted ? "cancelled" : "failed";
      run.message = controller.signal.aborted
        ? "已取消；已送出的请求仍可能计费，上一版解读保留。"
        : safeError(error);
    } finally {
      if (remote && client) {
        try {
          await client.remove(remote);
          await this.store.removeRemote(remote);
          remote = undefined;
        } catch {
          run.cleanupPending = true;
        }
      }
      run.ended = Date.now();
      if (account) {
        try {
          run.cleanupPending =
            Boolean(remote) || (await this.store.pending(account)).length > 0;
        } catch {
          run.cleanupPending = true;
        }
      }
      try {
        await this.store.save(run);
      } catch {
        run.status = "failed";
        run.message = "本机保存失败，请保留此页；再次生成会重新计费。";
      }
    }
    return run;
  }
}

export const readingService = new ReadingService();
