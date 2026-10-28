import { KimiClient, type ReadingClient, type RemoteBatch } from "./client";
import { getAPIKey } from "./credentials";
import {
  batchRequest,
  decodeExtraction,
  MODEL,
  parseBatchResults,
  PROTOCOL,
  QUESTION_IDS,
  totalUsage,
  type Question,
} from "./protocol";
import { io, ReadingError, runtime, safeError, sha256 } from "./runtime";
import {
  readingStore,
  type QuestionProgress,
  type ReadingBatch,
  type ReadingRun,
  type ReadingStore,
} from "./store";

const MAX_PDF = 100 * 1024 * 1024;
const TERMINAL = new Set(["completed", "failed", "expired", "cancelled"]);
export interface PDFIdentity {
  identity: string;
  hash: string;
  path: string;
  attachmentID: number;
}
export interface Job {
  run: ReadingRun;
  controller: AbortController;
  done: Promise<ReadingRun>;
  wake?: () => void;
}

export async function readPDF(path: string): Promise<Uint8Array> {
  if ((await io().stat(path)).size > MAX_PDF)
    throw new ReadingError("PDF 超过文件接口支持的 100 MiB。");
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
    identity: attachment.libraryID + ":" + attachment.key + ":" + hash,
    hash,
    path,
    attachmentID: attachment.id,
  };
}

export class ReadingService {
  private jobs = new Map<string, Job>();
  private listeners = new Set<() => void>();
  private stopped = false;
  constructor(
    readonly store: ReadingStore = readingStore,
    private key: () => string = getAPIKey,
    private client: (key: string) => ReadingClient = (key) =>
      new KimiClient(key),
    private read: (path: string) => Promise<Uint8Array> = readPDF,
    private pollInterval = 30_000,
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
        /* Detached panes must not interrupt a batch. */
      }
    }
  }
  job(identity: string): Job | undefined {
    return this.jobs.get(identity);
  }
  busy(): boolean {
    return this.jobs.size > 0;
  }

  async cancel(identity: string): Promise<void> {
    let job = this.jobs.get(identity);
    const run = job?.run ?? (await this.store.latest(identity));
    if (!run || run.status !== "running") return;
    run.cancelRequested = true;
    run.message = "正在取消批次，已完成的问题会保留。";
    await this.store.save(run);
    if (!job) {
      this.launch(run);
      job = this.jobs.get(identity);
    }
    job?.wake?.();
    this.notify();
  }

  shutdown(): void {
    this.stopped = true;
    for (const job of this.jobs.values()) job.controller.abort();
    this.listeners.clear();
  }

  async resumeAll(): Promise<void> {
    if (this.stopped) return;
    let key: string;
    try {
      key = this.key();
    } catch {
      return;
    }
    if (!key) return;
    const account = await sha256(new (runtime().TextEncoder)().encode(key));
    for (const run of await this.store.active()) {
      if (
        !this.stopped &&
        run.account === account &&
        run.batches?.length &&
        !this.jobs.has(run.identity)
      )
        void this.launch(run);
    }
  }

  start(pdf: PDFIdentity): Promise<ReadingRun> {
    const active = this.jobs.get(pdf.identity);
    if (active) return active.done;
    const run: ReadingRun = {
      id: Zotero.Utilities.randomString(24),
      identity: pdf.identity,
      hash: pdf.hash,
      model: MODEL,
      protocol: PROTOCOL,
      started: Date.now(),
      status: "running",
      completion: { content: "", done: false },
      questions: Object.fromEntries(
        QUESTION_IDS.map((q) => [q, { status: "pending", parts: [] }]),
      ) as Partial<Record<Question, QuestionProgress>>,
      batches: [],
      answers: {},
      message: "正在准备论文全文与六个问题…",
    };
    return this.launch(run, pdf);
  }

  private launch(run: ReadingRun, pdf?: PDFIdentity): Promise<ReadingRun> {
    if (this.stopped)
      return Promise.reject(
        new ReadingError("插件已关闭，请重新打开 Zotero。"),
      );
    const existing = this.jobs.get(run.identity);
    if (existing) return existing.done;
    const job: Job = {
      run,
      controller: new (runtime().AbortController)(),
      done: Promise.resolve(run),
    };
    this.jobs.set(run.identity, job);
    job.done = Promise.resolve()
      .then(() => this.execute(job, pdf))
      .finally(() => {
        this.jobs.delete(run.identity);
        this.notify();
      });
    this.notify();
    return job.done;
  }

  async cleanup(): Promise<number> {
    const key = this.key();
    if (!key) throw new ReadingError("请先保存 API Key。");
    const account = await sha256(new (runtime().TextEncoder)().encode(key));
    const client = this.client(key);
    let failed = 0;
    // The store excludes files belonging to active batches.
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

  private async save(job: Job): Promise<void> {
    await this.store.save(job.run);
    this.notify();
  }

  private wait(job: Job): Promise<void> {
    const win = runtime();
    return new Promise((resolve) => {
      const done = () => {
        win.clearTimeout(timer);
        job.controller.signal.removeEventListener("abort", done);
        job.wake = undefined;
        resolve();
      };
      const timer = win.setTimeout(done, this.pollInterval);
      job.wake = done;
      job.controller.signal.addEventListener("abort", done, { once: true });
      if (job.controller.signal.aborted) done();
    });
  }

  private async deleteFile(client: ReadingClient, id: string, run: ReadingRun) {
    try {
      await client.remove(id);
      await this.store.removeRemote(id);
    } catch {
      run.cleanupPending = true;
    }
  }

  private async execute(job: Job, pdf?: PDFIdentity): Promise<ReadingRun> {
    let client: ReadingClient | undefined;
    let extractionFile: string | undefined;
    let run = job.run;
    const check = () => {
      if (job.controller.signal.aborted)
        throw new ReadingError("本地查询已暂停。");
    };
    try {
      const key = this.key();
      const account = key
        ? await sha256(new (runtime().TextEncoder)().encode(key))
        : undefined;
      if (pdf) {
        const saved = await this.store.latest(pdf.identity);
        if (
          saved?.protocol === PROTOCOL &&
          saved.questions &&
          saved.status !== "complete" &&
          (saved.status === "running" ||
            !saved.account ||
            saved.account === account)
        ) {
          run = job.run = saved;
          // A paused active batch is queried, never submitted a second time.
          if (run.status !== "running") {
            run.cancelRequested = false;
            for (const q of QUESTION_IDS) {
              if (run.questions![q]?.status === "failed")
                run.questions![q]!.status = "pending";
            }
          }
          run.status = "running";
          delete run.ended;
        }
      }
      if (!key || !account) throw new ReadingError("请先保存 Kimi API Key。");
      if (run.account && run.account !== account)
        throw new ReadingError("请使用提交此任务时的 API Key 继续查询。");
      run.account = account;
      client = this.client(key);
      await this.save(job);
      let text = await this.store.getText(run.hash);
      if (!text) {
        if (!pdf)
          throw new ReadingError("本地论文解析记录缺失，请重新选择原 PDF。");
        const bytes = await this.read(pdf.path);
        if ((await sha256(bytes)) !== run.hash)
          throw new ReadingError("PDF 已发生变化，请重新选择附件后生成。");
        check();
        if (!run.cancelRequested) {
          run.message = "正在上传并解析论文…";
          this.notify();
          extractionFile = await client.upload(bytes);
          await this.store.addRemote({
            id: extractionFile,
            account,
            runID: run.id,
          });
          check();
          if (!run.cancelRequested) {
            text = decodeExtraction(
              await client.extract(extractionFile, job.controller.signal),
            );
            await this.store.putText(run.hash, text);
          }
          await this.deleteFile(client, extractionFile, run);
          extractionFile = undefined;
        }
      } else if (pdf) {
        // Check that the attachment still matches the selected content hash.
        if ((await sha256(await this.read(pdf.path))) !== run.hash)
          throw new ReadingError("PDF 已发生变化，请重新选择附件后生成。");
      }
      while (true) {
        check();
        let batch = run.batches!.at(-1);
        if (!batch || batch.results) {
          if (run.cancelRequested) break;
          const pending = QUESTION_IDS.filter(
            (q) => run.questions![q]?.status === "pending",
          );
          if (!pending.length) break;
          const round = run.batches!.length + 1;
          batch = {
            requests: pending.map((question) => ({
              customID: run.id + "-" + question + "-" + round,
              question,
            })),
          };
          run.batches!.push(batch);
          await this.save(job);
        }
        if (!batch.inputFile) {
          if (run.cancelRequested) break;
          run.message = "正在提交 " + batch.requests.length + " 个独立问题…";
          this.notify();
          batch.inputFile = await client.uploadBatch(
            batch.requests.map(({ customID, question }) =>
              batchRequest(
                customID,
                text!,
                question,
                run.questions![question]!.parts,
              ),
            ),
          );
          // Persist before submission so a lost create response is recoverable.
          await this.save(job);
        }
        await this.store.addRemote({
          id: batch.inputFile,
          account,
          runID: run.id,
        });
        check();
        if (!batch.id) {
          if (batch.submitting) {
            const found = await client.findBatch(
              batch.inputFile,
              job.controller.signal,
            );
            if (!found)
              throw new ReadingError(
                "批次提交状态暂未确认，请稍后继续查询；未重复提交。",
              );
            batch.id = found.id;
            batch.status = found.status;
            await this.save(job);
          } else if (run.cancelRequested) {
            batch.status = "cancelled";
            batch.results = [];
            await this.deleteFile(client, batch.inputFile, run);
            break;
          } else {
            batch.submitting = true;
            await this.save(job);
            try {
              const created = await client.createBatch(batch.inputFile);
              batch.id = created.id;
              batch.status = created.status;
            } catch (error) {
              // A definite rejection can be retried; an uncertain response
              // must first be recovered from the account's batch list.
              if (
                error instanceof ReadingError &&
                error.status &&
                error.status >= 400 &&
                error.status < 500 &&
                error.status !== 408
              ) {
                batch.submitting = false;
                batch.status = "failed";
                batch.results = [];
                for (const { question } of batch.requests) {
                  run.questions![question]!.status = "failed";
                  run.questions![question]!.error = safeError(error);
                }
                await this.save(job);
                await this.deleteFile(client, batch.inputFile, run);
              }
              throw error;
            }
            await this.save(job);
          }
        }
        check();
        let remote: RemoteBatch;
        if (
          run.cancelRequested &&
          !TERMINAL.has(batch.status!) &&
          batch.status !== "cancelling"
        ) {
          remote = await client.cancelBatch(batch.id!);
        } else {
          remote = await client.getBatch(batch.id!, job.controller.signal);
        }
        batch.status = remote.status;
        batch.outputFile = remote.output_file_id ?? batch.outputFile;
        batch.errorFile = remote.error_file_id ?? batch.errorFile;
        const count = remote.request_counts;
        run.message = run.cancelRequested
          ? "正在取消批次…"
          : "Kimi 批次" +
            (remote.status === "validating" ? "校验中" : "处理中") +
            (count
              ? "，已处理 " +
                (count.completed + count.failed) +
                "/" +
                count.total +
                " 个请求"
              : "") +
            "。可关闭 Zotero，重启后继续查询。";
        await this.save(job);
        if (!TERMINAL.has(remote.status)) {
          await this.wait(job);
          continue;
        }
        const results = [];
        for (const id of new Set(
          [batch.outputFile, batch.errorFile].filter((id): id is string =>
            Boolean(id),
          ),
        )) {
          await this.store.addRemote({ id, account, runID: run.id });
          results.push(
            ...parseBatchResults(
              await client.extract(id, job.controller.signal),
            ),
          );
        }
        if (
          new Set(results.map((r) => r.customID)).size !== results.length ||
          results.some(
            (result) =>
              !batch.requests.some(
                (request) => request.customID === result.customID,
              ),
          )
        )
          throw new ReadingError(
            "批次结果中出现重复问题标识，未覆盖已有答案。",
          );
        batch.results = results;
        for (const request of batch.requests) {
          const progress = run.questions![request.question]!;
          const result = results.find((r) => r.customID === request.customID);
          const completion = result?.completion;
          if (!completion) {
            progress.status = "failed";
            progress.error = result?.error ?? "该题没有返回结果，可重试补全。";
            continue;
          }
          const previous = progress.parts.at(-1);
          if (
            completion.finish === "length" &&
            ((!completion.content && !completion.reasoning) ||
              (previous?.content === completion.content &&
                previous?.reasoning === completion.reasoning))
          ) {
            progress.status = "failed";
            progress.error = "续写未返回新增内容，可重试此题。";
            continue;
          }
          if (completion.done && completion.content.trim()) {
            progress.parts.push(completion);
            progress.status = "complete";
            delete progress.error;
            run.answers![request.question] = {
              answer: progress.parts
                .map((part) => part.content)
                .filter(Boolean)
                .join("\n\n"),
              sources: [],
            };
          } else if (completion.finish === "length") {
            progress.parts.push(completion);
            progress.status = "pending";
            delete progress.error;
          } else {
            progress.status = "failed";
            progress.error = "该题未正常结束，可重试补全。";
          }
        }
        this.updateUsage(run);
        // Store answers before deleting either results file.
        await this.save(job);
        for (const id of new Set(
          [batch.inputFile, batch.outputFile, batch.errorFile].filter(
            (id): id is string => Boolean(id),
          ),
        ))
          await this.deleteFile(client, id, run);
        if (run.cancelRequested) break;
      }
      const completed = QUESTION_IDS.filter(
        (q) => run.questions![q]?.status === "complete",
      ).length;
      run.status =
        completed === 6
          ? "complete"
          : run.cancelRequested
            ? "cancelled"
            : completed
              ? "partial"
              : "failed";
      run.message =
        completed === 6
          ? "六问解读已完整保存到本机。"
          : "已保存 " +
            completed +
            "/6 问。" +
            (run.cancelRequested ? "批次已取消。" : "可重试补全未完成的问题。");
      run.ended = Date.now();
      this.updateUsage(run);
    } catch (error) {
      const submitted =
        run.batches?.some((b) => !b.results && (b.id || b.inputFile)) ||
        (job.controller.signal.aborted &&
          run.batches?.some((b) => b.results) &&
          !run.cancelRequested &&
          QUESTION_IDS.some((q) => run.questions?.[q]?.status === "pending"));
      run.status = submitted
        ? "running"
        : run.cancelRequested
          ? "cancelled"
          : "failed";
      run.message =
        job.controller.signal.aborted && submitted
          ? "批次仍在云端执行，下次打开 Zotero 后继续查询。"
          : safeError(error) + (submitted ? " 批次已保留，可继续查询。" : "");
      if (!submitted) run.ended = Date.now();
    } finally {
      if (extractionFile && client)
        await this.deleteFile(client, extractionFile, run);
      try {
        await this.save(job);
      } catch {
        run.message = "本机保存失败，请保留此页并检查数据目录。";
        this.notify();
      }
    }
    return run;
  }

  private updateUsage(run: ReadingRun) {
    const results = run.batches?.flatMap((batch) => batch.results ?? []) ?? [];
    run.usageIncomplete =
      results.some((result) => !result.completion?.usage) ||
      run.batches!.some(
        (batch) =>
          batch.results && batch.results.length < batch.requests.length,
      );
    run.completion = {
      content: JSON.stringify(run.answers),
      done: run.status === "complete",
      finish: run.status === "complete" ? "stop" : undefined,
      usage: totalUsage(results),
    };
  }
}

export const readingService = new ReadingService();
