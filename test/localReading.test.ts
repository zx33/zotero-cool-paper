import { assert } from "chai";
import {
  KimiClient,
  type ReadingClient,
  type RemoteBatch,
} from "../src/modules/localReading/client";
import {
  getAPIKey,
  saveAPIKey,
  removeAPIKey,
} from "../src/modules/localReading/credentials";
import {
  batchRequest,
  cost,
  decodeExtraction,
  makeSources,
  messagesFor,
  parseBatchResults,
  QUESTION_IDS,
  QUESTIONS,
  PROTOCOL,
  totalUsage,
  type BatchRequest,
  type Completion,
  type Question,
} from "../src/modules/localReading/protocol";
import {
  mountReadingPane,
  READING_PANE_ID,
  renderMarkdown,
  usageText,
} from "../src/modules/localReading/pane";
import {
  ReadingError,
  runtime,
  sha256,
} from "../src/modules/localReading/runtime";
import {
  ReadingService,
  type PDFIdentity,
} from "../src/modules/localReading/service";
import {
  readingStore,
  type ReadingRun,
  type ReadingStore,
  type RemoteFile,
} from "../src/modules/localReading/store";

const paragraph = "本文比较两种方法，报告有限的实验结果。";
const answerJSON = () =>
  JSON.stringify(
    Object.fromEntries(
      QUESTION_IDS.map((q, i) => [
        q,
        { answer: "第" + (i + 1) + "问：" + paragraph, sources: [] },
      ]),
    ),
  );
const completion = (): Completion => ({
  content: answerJSON(),
  done: true,
  finish: "stop",
  usage: { input: 10000, output: 900, cached: 512 },
});

class MemoryStore implements ReadingStore {
  texts = new Map<string, string>();
  runs = new Map<string, ReadingRun>();
  files = new Map<string, RemoteFile>();
  async getText(hash: string) {
    return this.texts.get(hash);
  }
  async putText(hash: string, text: string) {
    this.texts.set(hash, text);
  }
  async save(run: ReadingRun) {
    this.runs.set(run.id, JSON.parse(JSON.stringify(run)));
  }
  async latest(identity: string, completeOnly = false) {
    return [...this.runs.values()]
      .reverse()
      .find(
        (run) =>
          run.identity === identity &&
          (!completeOnly || run.status === "complete"),
      );
  }
  async active() {
    return [...this.runs.values()].filter((run) => run.status === "running");
  }
  async pending(account: string) {
    return [...this.files.values()].filter(
      (f) =>
        f.account === account &&
        (!f.runID || this.runs.get(f.runID)?.status !== "running"),
    );
  }
  async addRemote(file: RemoteFile) {
    this.files.set(file.id, file);
  }
  async removeRemote(id: string) {
    this.files.delete(id);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function responseRow(request: BatchRequest, content?: string, finish = "stop") {
  const index = QUESTIONS.indexOf(
    request.body.messages[2].content as (typeof QUESTIONS)[number],
  );
  return {
    custom_id: request.custom_id,
    response: {
      status_code: 200,
      body: {
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: content ?? "第" + (index + 1) + "问：" + paragraph,
            },
            finish_reason: finish,
          },
        ],
        usage: {
          prompt_tokens: 10000,
          completion_tokens: 900,
          cached_tokens: 512,
        },
      },
    },
    error: null,
  };
}

async function fixture() {
  const store = new MemoryStore();
  const bytes = new (runtime().TextEncoder)().encode("%PDF-1.7 synthetic test");
  const hash = await sha256(bytes);
  const pdf: PDFIdentity = {
    identity: "1:TEST:" + hash,
    hash,
    attachmentID: 1,
    path: "fixture.pdf",
  };
  const calls: string[] = [];
  const submissions: BatchRequest[][] = [];
  const inputs = new Map<string, BatchRequest[]>();
  const remote = new Map<string, RemoteBatch>();
  const files = new Map<string, string>();
  const client: ReadingClient = {
    async upload() {
      calls.push("upload");
      return "test-file";
    },
    async extract(id) {
      calls.push("extract:" + id);
      if (id === "test-file") return JSON.stringify({ content: paragraph });
      return files.get(id)!;
    },
    async remove(id) {
      calls.push("delete:" + id);
    },
    async uploadBatch(requests) {
      calls.push("uploadBatch");
      submissions.push(requests);
      const id = "input-" + submissions.length;
      inputs.set(id, requests);
      return id;
    },
    async createBatch(inputFile) {
      calls.push("createBatch");
      const id = "batch-" + remote.size;
      const batch: RemoteBatch = {
        id,
        status: "validating",
        input_file_id: inputFile,
      };
      remote.set(id, batch);
      return { ...batch };
    },
    async getBatch(id) {
      calls.push("getBatch");
      const batch = remote.get(id)!;
      const output = "output-" + id;
      files.set(
        output,
        inputs
          .get(batch.input_file_id!)!
          .map((r) => JSON.stringify(responseRow(r)))
          .reverse()
          .join("\n"),
      );
      batch.status = "completed";
      batch.output_file_id = output;
      return { ...batch };
    },
    async findBatch(inputFile) {
      calls.push("findBatch");
      return [...remote.values()].find((b) => b.input_file_id === inputFile);
    },
    async cancelBatch(id) {
      calls.push("cancelBatch");
      const batch = remote.get(id)!;
      batch.status = "cancelled";
      return { ...batch };
    },
  };
  const service = new ReadingService(
    store,
    () => "test-key-not-a-secret",
    () => client,
    async () => bytes,
    0,
  );
  return {
    service,
    store,
    pdf,
    client,
    calls,
    submissions,
    inputs,
    remote,
    files,
    bytes,
  };
}

describe("Kimi local reading", function () {
  it("registers an independent native item-pane section", function () {
    const data = (
      Zotero.ItemPaneManager as unknown as { customSectionData: unknown }
    ).customSectionData;
    assert.include(JSON.stringify(data), READING_PANE_ID);
  });

  describe("local reading protocol and transport", function () {
    it("keeps the full extraction and selects exactly one of the six questions", function () {
      assert.equal(
        decodeExtraction(JSON.stringify({ content: paragraph })),
        paragraph,
      );
      assert.equal(decodeExtraction(paragraph), paragraph);
      assert.throws(() => decodeExtraction('{"error":"bad"}'));
      const text = "First\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n附录末尾";
      assert.lengthOf(makeSources(text), 3);
      for (const [index, q] of QUESTION_IDS.entries()) {
        const request = batchRequest("paper-" + q, text, q);
        assert.lengthOf(request.body.messages, 3);
        assert.equal(request.body.messages[1].content, text);
        assert.equal(request.body.messages[2].content, QUESTIONS[index]);
        assert.deepEqual(request.body.thinking, { type: "enabled" });
        assert.equal(request.body.model, "kimi-k2.6");
        assert.notProperty(request.body, "response_format");
        assert.notProperty(request.body, "temperature");
        assert.notInclude(request.body.messages[0].content, "字符");
      }
    });

    it("accepts Kimi's live Batch status code zero only with a successful completion body", function () {
      const raw = responseRow(batchRequest("live-q1", paragraph, "q1"));
      const body = raw.response.body as typeof raw.response.body & {
        object?: string;
        error?: unknown;
      };
      raw.response.status_code = 0;
      body.object = "chat.completion";
      const parsed = parseBatchResults(JSON.stringify(raw))[0];
      assert.isTrue(parsed.completion?.done);
      assert.equal(parsed.completion?.usage?.input, 10000);
      body.error = { message: "server failure" };
      assert.isUndefined(parseBatchResults(JSON.stringify(raw))[0].completion);
      delete body.error;
      delete body.object;
      assert.isUndefined(parseBatchResults(JSON.stringify(raw))[0].completion);
    });

    it("reads long Markdown responses and missing-usage results without shortening them", function () {
      const long = "完整的方法解释与实验条件。".repeat(3000);
      const request = batchRequest("long-q3", paragraph, "q3");
      const raw = responseRow(request, long);
      const results = parseBatchResults(JSON.stringify(raw));
      assert.equal(results[0].completion?.content, long);
      assert.isTrue(results[0].completion?.done);
      assert.deepEqual(results[0].completion?.usage, {
        input: 10000,
        output: 900,
        cached: 512,
      });
      assert.throws(
        () =>
          parseBatchResults(JSON.stringify(raw) + "\n" + JSON.stringify(raw)),
        "重复",
      );
      assert.throws(
        () => parseBatchResults("private-malformed-output"),
        "格式无效",
      );
      const missing = JSON.parse(JSON.stringify(raw));
      delete missing.response.body.usage;
      assert.isUndefined(
        totalUsage(parseBatchResults(JSON.stringify(missing))),
      );
    });

    it("preserves thinking and the current question when continuing a truncated answer", function () {
      const request = batchRequest("q4-more", paragraph, "q4", [
        {
          content: "已生成部分",
          reasoning: "此前思考",
          finish: "length",
          done: false,
        },
      ]);
      assert.deepEqual(request.body.thinking, { type: "enabled", keep: "all" });
      assert.equal(request.body.messages[2].content, QUESTIONS[3]);
      assert.equal(request.body.messages[3].content, "已生成部分");
      assert.equal(request.body.messages[3].reasoning_content, "此前思考");
      const raw = responseRow(request, "", "length");
      Object.assign(raw.response.body.choices[0].message, {
        content: null,
        reasoning_content: "仍在思考",
      });
      assert.equal(
        parseBatchResults(JSON.stringify(raw))[0].completion?.reasoning,
        "仍在思考",
      );
    });

    it("shows Batch pricing from actual usage and keeps unknown usage unknown", function () {
      assert.closeTo(
        cost({ input: 10000, output: 1000, cached: 512 }),
        0.0892352,
        1e-8,
      );
      assert.closeTo(
        cost({ input: 10000, output: 1000, cached: 512 }, true),
        0.05354112,
        1e-8,
      );
      assert.isAbove(
        cost({ input: 10000, output: 1000 }, true),
        cost({ input: 10000, output: 1000, cached: 512 }, true),
      );
      const u = totalUsage([
        { customID: "a", completion: completion() },
        {
          customID: "b",
          completion: { ...completion(), usage: { input: 200, output: 30 } },
        },
      ]);
      assert.equal(u?.input, 10200);
      assert.isUndefined(u?.cached);
    });

    it("uses native file and Batch APIs with independent JSONL requests", async function () {
      const win = runtime();
      const requests: { url: string; init: RequestInit }[] = [];
      const client = new KimiClient("dummy-private-value", (async (
        url,
        init,
      ) => {
        requests.push({ url: String(url), init: init! });
        if (String(url).endsWith("/files")) {
          const form = init!.body as FormData;
          const file = form.get("file") as File;
          if (form.get("purpose") === "file-extract")
            assert.equal(file.name, "paper.pdf");
          else {
            assert.equal(form.get("purpose"), "batch");
            assert.equal(file.name, "questions.jsonl");
            const lines = (await file.text())
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            assert.lengthOf(lines, 6);
            assert.lengthOf(new Set(lines.map((line) => line.custom_id)), 6);
            assert.deepEqual(
              lines.map((line) => line.body.messages[2].content),
              [...QUESTIONS],
            );
          }
          return new win.Response('{"id":"file-123"}');
        }
        if (init!.method === "POST" && String(url).endsWith("/batches")) {
          assert.deepEqual(JSON.parse(String(init!.body)), {
            input_file_id: "file-123",
            endpoint: "/v1/chat/completions",
            completion_window: "24h",
          });
          return new win.Response('{"id":"batch-123","status":"validating"}');
        }
        if (String(url).endsWith("/cancel"))
          return new win.Response('{"id":"batch-123","status":"cancelling"}');
        if (String(url).includes("?limit="))
          return new win.Response(
            '{"data":[{"id":"batch-123","status":"completed","input_file_id":"file-123"}],"has_more":false}',
          );
        return new win.Response(
          '{"id":"batch-123","status":"completed","output_file_id":"output-123"}',
        );
      }) as typeof fetch);
      await client.upload(new win.TextEncoder().encode("%PDF-1.7"));
      await client.uploadBatch(
        QUESTION_IDS.map((q) => batchRequest(q, paragraph, q)),
      );
      const batch = await client.createBatch("file-123");
      assert.equal(batch.id, "batch-123");
      assert.equal(
        (await client.getBatch(batch.id, new win.AbortController().signal))
          .output_file_id,
        "output-123",
      );
      assert.equal(
        (await client.findBatch("file-123", new win.AbortController().signal))
          ?.id,
        batch.id,
      );
      assert.equal((await client.cancelBatch(batch.id)).status, "cancelling");
      for (const request of requests) {
        assert.isTrue(request.url.startsWith("https://api.moonshot.cn/v1/"));
        assert.equal(request.init.redirect, "error");
        assert.equal(request.init.credentials, "omit");
      }
    });

    it("does not expose provider error bodies or allow arbitrary endpoints", async function () {
      const fail = new KimiClient(
        "dummy-private-value",
        (async () =>
          new (runtime().Response)("dummy-private-value provider echo", {
            status: 401,
          })) as typeof fetch,
      );
      try {
        await fail.getBatch(
          "batch-1",
          new (runtime().AbortController)().signal,
        );
        assert.fail("Expected HTTP failure");
      } catch (error) {
        assert.include(String(error), "401");
        assert.equal((error as ReadingError).status, 401);
        assert.notInclude(String(error), "dummy-private-value");
      }
      try {
        await fail.getBatch(
          "../private",
          new (runtime().AbortController)().signal,
        );
        assert.fail("Expected invalid path");
      } catch (error) {
        assert.include(String(error), "请求地址无效");
      }
    });
  });

  describe("local reading jobs and durable storage", function () {
    this.timeout(15000);

    it("submits six questions once, maps unordered results, and reuses document extraction", async function () {
      const f = await fixture();
      assert.isEmpty(f.calls);
      const first = f.service.start(f.pdf);
      assert.strictEqual(f.service.start(f.pdf), first);
      const run = await first;
      assert.equal(run.status, "complete");
      assert.lengthOf(f.submissions, 1);
      assert.lengthOf(f.submissions[0], 6);
      assert.equal(run.completion.content, answerJSON());
      assert.equal(run.completion.usage?.input, 60000);
      assert.equal(f.store.files.size, 0);
      assert.notInclude(
        JSON.stringify([...f.store.runs.values()]),
        "test-key-not-a-secret",
      );
      f.calls.length = 0;
      assert.equal((await f.service.start(f.pdf)).status, "complete");
      assert.notInclude(f.calls, "upload");
      assert.notInclude(f.calls, "extract:test-file");
      assert.lengthOf(f.submissions, 2);
    });

    it("completes expensive and long answers without a spending or character cap", async function () {
      const f = await fixture();
      const get = f.client.getBatch;
      const long = "保留方法细节、公式和实验条件。".repeat(1000);
      f.client.getBatch = async (id, signal) => {
        const batch = await get(id, signal);
        const rows = f.files
          .get(batch.output_file_id!)!
          .split("\n")
          .map((line) => JSON.parse(line));
        for (const row of rows) {
          row.response.body.choices[0].message.content = long;
          row.response.body.usage.prompt_tokens = 1000000;
        }
        f.files.set(
          batch.output_file_id!,
          rows.map((row) => JSON.stringify(row)).join("\n"),
        );
        return batch;
      };
      const run = await f.service.start(f.pdf);
      assert.equal(run.status, "complete");
      for (const q of QUESTION_IDS)
        assert.equal(run.answers?.[q]?.answer, long);
      assert.isAbove(cost(run.completion.usage!, true), 20);
    });

    it("preserves successful questions and retries only the failed question", async function () {
      const f = await fixture();
      const get = f.client.getBatch;
      f.client.getBatch = async (id, signal) => {
        const batch = await get(id, signal);
        const requests = f.inputs.get(batch.input_file_id!)!;
        f.files.set(
          batch.output_file_id!,
          requests
            .map((r) =>
              JSON.stringify(
                r.body.messages[2].content === QUESTIONS[3]
                  ? {
                      custom_id: r.custom_id,
                      response: { status_code: 500 },
                      error: { message: "private echo" },
                    }
                  : responseRow(r),
              ),
            )
            .join("\n"),
        );
        return batch;
      };
      const partial = await f.service.start(f.pdf);
      assert.equal(partial.status, "partial");
      assert.lengthOf(Object.keys(partial.answers!), 5);
      assert.isTrue(partial.usageIncomplete);
      assert.notInclude(JSON.stringify(partial), "private echo");
      f.client.getBatch = get;
      const completed = await f.service.start(f.pdf);
      assert.equal(completed.id, partial.id);
      assert.equal(completed.status, "complete");
      assert.lengthOf(f.submissions[1], 1);
      assert.equal(f.submissions[1][0].body.messages[2].content, QUESTIONS[3]);
      assert.equal(completed.completion.usage?.input, 60000);
    });

    it("continues only a length-ended question and preserves both parts and their usage", async function () {
      const f = await fixture();
      const get = f.client.getBatch;
      f.client.getBatch = async (id, signal) => {
        const batch = await get(id, signal);
        const requests = f.inputs.get(batch.input_file_id!)!;
        f.files.set(
          batch.output_file_id!,
          requests
            .map((r) =>
              JSON.stringify(
                r.body.messages[2].content === QUESTIONS[2]
                  ? responseRow(
                      r,
                      r.body.messages.length === 3 ? "方法前半" : "方法后半",
                      r.body.messages.length === 3 ? "length" : "stop",
                    )
                  : responseRow(r),
              ),
            )
            .join("\n"),
        );
        return batch;
      };
      const run = await f.service.start(f.pdf);
      assert.equal(run.status, "complete");
      assert.equal(run.answers?.q3?.answer, "方法前半\n\n方法后半");
      assert.lengthOf(f.submissions, 2);
      assert.lengthOf(f.submissions[1], 1);
      assert.equal(f.submissions[1][0].body.messages[3].content, "方法前半");
      assert.equal(run.completion.usage?.input, 70000);
    });

    it("stops a no-progress continuation while retaining the incomplete answer", async function () {
      const f = await fixture();
      const get = f.client.getBatch;
      f.client.getBatch = async (id, signal) => {
        const batch = await get(id, signal);
        const requests = f.inputs.get(batch.input_file_id!)!;
        f.files.set(
          batch.output_file_id!,
          requests
            .map((r) => JSON.stringify(responseRow(r, "相同片段", "length")))
            .join("\n"),
        );
        return batch;
      };
      const run = await f.service.start(f.pdf);
      assert.equal(run.status, "failed");
      assert.lengthOf(f.submissions, 2);
      assert.equal(run.questions?.q1?.parts[0].content, "相同片段");
      assert.include(run.questions?.q1?.error ?? "", "新增内容");
      assert.equal(run.completion.usage?.input, 120000);
    });

    it("retries a rejected submission instead of looking for a nonexistent batch", async function () {
      const f = await fixture();
      const create = f.client.createBatch;
      f.client.createBatch = async () => {
        throw new ReadingError("API Key 无效", 401);
      };
      const rejected = await f.service.start(f.pdf);
      assert.equal(rejected.status, "failed");
      assert.isFalse(rejected.batches?.[0].submitting);
      assert.include(f.calls, "delete:input-1");
      f.client.createBatch = create;
      const completed = await f.service.start(f.pdf);
      assert.equal(completed.status, "complete");
      assert.notInclude(f.calls, "findBatch");
      assert.equal(f.calls.filter((call) => call === "upload").length, 1);
    });

    it("allows a new key to start after a terminal failure", async function () {
      const f = await fixture();
      const create = f.client.createBatch;
      f.client.createBatch = async () => {
        throw new ReadingError("API Key 无效", 401);
      };
      const rejected = await f.service.start(f.pdf);
      f.client.createBatch = create;
      const service = new ReadingService(
        f.store,
        () => "replacement-key",
        () => f.client,
        async () => f.bytes,
        0,
      );
      const completed = await service.start(f.pdf);
      assert.equal(completed.status, "complete");
      assert.notEqual(completed.id, rejected.id);
      assert.notEqual(completed.account, rejected.account);
      assert.equal(f.calls.filter((call) => call === "upload").length, 1);
      service.shutdown();
    });

    it("does not mark a local upload failure as a submitted cloud batch", async function () {
      const f = await fixture();
      const upload = f.client.uploadBatch;
      f.client.uploadBatch = async () => {
        throw new ReadingError("请求文件超过 100 MB");
      };
      const failed = await f.service.start(f.pdf);
      assert.equal(failed.status, "failed");
      assert.notInclude(f.calls, "createBatch");
      f.client.uploadBatch = upload;
      const completed = await f.service.start(f.pdf);
      assert.equal(completed.status, "complete");
      assert.notInclude(f.calls, "findBatch");
    });

    it("recovers an accepted submission after its response is lost without creating another batch", async function () {
      const f = await fixture();
      const create = f.client.createBatch;
      f.client.createBatch = async (input) => {
        await create(input);
        throw new ReadingError("Network interrupted");
      };
      const paused = await f.service.start(f.pdf);
      assert.equal(paused.status, "running");
      assert.isTrue(paused.batches?.[0].submitting);
      const recovered = await f.service.start(f.pdf);
      assert.equal(recovered.status, "complete");
      assert.equal(f.calls.filter((call) => call === "createBatch").length, 1);
      assert.include(f.calls, "findBatch");
      assert.lengthOf(f.submissions, 1);
    });

    it("resumes a persisted batch after shutdown without cancelling or resubmitting it", async function () {
      const f = await fixture();
      const entered = deferred<void>();
      const get = f.client.getBatch;
      f.client.getBatch = async (_id, signal) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error("detached")),
            { once: true },
          ),
        );
        throw new Error("unreachable");
      };
      const pending = f.service.start(f.pdf);
      await entered.promise;
      const active = f.service.job(f.pdf.identity)!.run;
      assert.lengthOf(await f.store.pending(active.account!), 0);
      f.service.shutdown();
      const paused = await pending;
      assert.equal(paused.status, "running");
      assert.notInclude(f.calls, "cancelBatch");
      f.client.getBatch = get;
      const resumed = new ReadingService(
        f.store,
        () => "test-key-not-a-secret",
        () => f.client,
        async () => f.bytes,
        0,
      );
      await resumed.resumeAll();
      await waitUntil(() => !resumed.busy());
      assert.equal((await f.store.latest(f.pdf.identity))?.status, "complete");
      assert.lengthOf(f.submissions, 1);
      assert.equal(f.calls.filter((c) => c === "createBatch").length, 1);
      resumed.shutdown();
    });

    it("cancels the remote batch and keeps the previous completed report", async function () {
      const f = await fixture();
      const original = await f.service.start(f.pdf);
      const entered = deferred<void>();
      const release = deferred<void>();
      f.client.getBatch = async (id) => {
        entered.resolve();
        await release.promise;
        return { ...f.remote.get(id)!, status: "in_progress" };
      };
      const pending = f.service.start(f.pdf);
      await entered.promise;
      await f.service.cancel(f.pdf.identity);
      release.resolve();
      const cancelled = await pending;
      assert.equal(cancelled.status, "cancelled");
      assert.include(f.calls, "cancelBatch");
      assert.equal(
        (await f.store.latest(f.pdf.identity, true))?.id,
        original.id,
      );
    });

    it("waits for an upload ID, deletes it after cancellation, and never submits questions", async function () {
      const f = await fixture();
      const entered = deferred<void>();
      const upload = deferred<string>();
      f.client.upload = async () => {
        entered.resolve();
        return upload.promise;
      };
      const pending = f.service.start(f.pdf);
      await entered.promise;
      await f.service.cancel(f.pdf.identity);
      upload.resolve("cancelled-file");
      assert.equal((await pending).status, "cancelled");
      assert.deepEqual(f.calls, ["delete:cancelled-file"]);
      assert.equal(f.store.files.size, 0);
    });

    it("keeps results for rereading after a malformed download instead of resubmitting questions", async function () {
      const f = await fixture();
      const extract = f.client.extract;
      f.client.extract = async (id, signal) =>
        id.startsWith("output-") ? "invalid" : extract(id, signal);
      const paused = await f.service.start(f.pdf);
      assert.equal(paused.status, "running");
      assert.isFalse(f.calls.some((c) => c.startsWith("delete:output")));
      f.client.extract = extract;
      assert.equal((await f.service.start(f.pdf)).status, "complete");
      assert.lengthOf(f.submissions, 1);
    });

    it("records failed cleanup and retries deletion without new model requests", async function () {
      const f = await fixture();
      f.client.remove = async () => {
        throw new Error("offline");
      };
      const run = await f.service.start(f.pdf);
      assert.equal(run.status, "complete");
      assert.isTrue(run.cleanupPending);
      assert.equal(f.store.files.size, 3);
      f.client.remove = async (id) => {
        f.calls.push("delete:" + id);
      };
      f.calls.length = 0;
      assert.equal(await f.service.cleanup(), 0);
      assert.lengthOf(f.calls, 3);
      assert.isTrue(f.calls.every((c) => c.startsWith("delete:")));
      assert.equal(f.store.files.size, 0);
    });

    it("stops before upload when the selected PDF has changed", async function () {
      const f = await fixture();
      const run = await f.service.start({ ...f.pdf, hash: "changed" });
      assert.equal(run.status, "failed");
      assert.include(run.message!, "PDF 已发生变化");
      assert.isEmpty(f.calls);
    });

    it("keeps active Batch input files out of native cleanup queries", async function () {
      const f = await fixture();
      const run = await f.service.start(f.pdf);
      run.id = "active-" + Zotero.Utilities.randomString(10);
      run.identity = run.id;
      run.status = "running";
      const file = {
        id: run.id + "-file",
        account: run.account!,
        runID: run.id,
      };
      try {
        await readingStore.save(run);
        await readingStore.addRemote(file);
        assert.notInclude(
          (await readingStore.pending(run.account!)).map((f) => f.id),
          file.id,
        );
        assert.include(
          (await readingStore.active()).map((r) => r.id),
          run.id,
        );
        run.status = "complete";
        await readingStore.save(run);
        assert.include(
          (await readingStore.pending(run.account!)).map((f) => f.id),
          file.id,
        );
      } finally {
        await readingStore.removeRemote(file.id);
        await Zotero.DB.queryAsync(
          "DELETE FROM pcp_reading_runs WHERE id = ?",
          [run.id],
          { debug: false },
        );
      }
    });

    it("stores reports and extraction in Zotero SQLite without affecting the previous success", async function () {
      const f = await fixture();
      const run = await f.service.start(f.pdf);
      run.identity = `test-${Zotero.Utilities.randomString(12)}`;
      await readingStore.save(run);
      await readingStore.putText(run.identity, paragraph);
      try {
        assert.equal(
          (await readingStore.latest(run.identity, true))?.completion.content,
          answerJSON(),
        );
        assert.equal(await readingStore.getText(run.identity), paragraph);
        const failed = {
          ...run,
          id: `${run.id}-failed`,
          status: "failed" as const,
          started: run.started + 1,
        };
        await readingStore.save(failed);
        assert.equal(
          (await readingStore.latest(run.identity))?.status,
          "failed",
        );
        assert.equal(
          (await readingStore.latest(run.identity, true))?.id,
          run.id,
        );
      } finally {
        await Zotero.DB.queryAsync(
          "DELETE FROM pcp_reading_runs WHERE identity = ?",
          [run.identity],
        );
        await Zotero.DB.queryAsync(
          "DELETE FROM pcp_reading_text WHERE hash = ?",
          [run.identity],
        );
      }
    });

    it("writes cleanup records after a Batch version added the run_id column", async function () {
      assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
      await readingStore.getText("schema-compatibility-fixture");
      const columns = (await Zotero.DB.queryAsync(
        "PRAGMA table_info(pcp_reading_remote)",
      )) as { name: string }[];
      if (!columns.some((column) => column.name === "run_id"))
        await Zotero.DB.queryAsync(
          "ALTER TABLE pcp_reading_remote ADD COLUMN run_id TEXT",
        );
      const id = `schema-test-${Zotero.Utilities.randomString(12)}`;
      try {
        await readingStore.addRemote({ id, account: id });
        assert.include(
          (await readingStore.pending(id)).map((file) => file.id),
          id,
        );
      } finally {
        await readingStore.removeRemote(id);
      }
    });

    it("round-trips credentials through the isolated profile login manager", async function () {
      assert.include(
        Zotero.DataDirectory.dir,
        ".scaffold/test/data",
        "Credential tests require the isolated test profile",
      );
      try {
        await saveAPIKey("fixture-not-a-real-api-key");
        assert.equal(getAPIKey(), "fixture-not-a-real-api-key");
        await saveAPIKey("fixture-replaced-key");
        assert.equal(getAPIKey(), "fixture-replaced-key");
      } finally {
        removeAPIKey();
      }
      assert.equal(getAPIKey(), "");
    });

    it("keeps reading content and remote identifiers out of native debug logs", async function () {
      const f = await fixture();
      const run = await f.service.start(f.pdf);
      const sentinel = `private-reading-${Zotero.Utilities.randomString(12)}`;
      run.identity = sentinel;
      run.completion.content = sentinel;
      const logs: string[] = [];
      const debug = Zotero.debug;
      const enabled = Zotero.Debug.enabled;
      Zotero.debug = (message) => logs.push(String(message));
      Zotero.Debug.enabled = true;
      try {
        // Positive control: the native logger really is including bound values.
        await Zotero.DB.queryAsync("SELECT ? AS value", ["logging-control"]);
        assert.isTrue(logs.some((line) => line.includes("logging-control")));
        logs.length = 0;
        await readingStore.putText(sentinel, sentinel);
        await readingStore.save(run);
        await readingStore.addRemote({ id: sentinel, account: sentinel });
        assert.equal(await readingStore.getText(sentinel), sentinel);
        assert.equal(
          (await readingStore.latest(sentinel))?.completion.content,
          sentinel,
        );
        const pending = await readingStore.pending(sentinel);
        assert.lengthOf(pending, 1);
        assert.equal(pending[0].id, sentinel);
        assert.equal(pending[0].account, sentinel);
        await readingStore.removeRemote(sentinel);
        assert.isFalse(logs.some((line) => line.includes(sentinel)));
      } finally {
        Zotero.debug = debug;
        Zotero.Debug.enabled = enabled;
        const options = { noCache: true, debug: false };
        await Zotero.DB.queryAsync(
          "DELETE FROM pcp_reading_runs WHERE identity = ?",
          [sentinel],
          options,
        );
        await Zotero.DB.queryAsync(
          "DELETE FROM pcp_reading_text WHERE hash = ?",
          [sentinel],
          options,
        );
        await readingStore.removeRemote(sentinel);
      }
    });

    it("does not expose bound paper text when SQLite rejects a write", async function () {
      await readingStore.getText("privacy-test-initialize");
      await Zotero.DB.queryAsync(
        "CREATE TEMP TRIGGER pcp_reading_test_failure BEFORE INSERT ON pcp_reading_text BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END",
      );
      try {
        let caught: unknown;
        try {
          await readingStore.putText(
            "private-fixture-hash",
            "private-paper-text",
          );
        } catch (error) {
          caught = error;
        }
        assert.instanceOf(caught, ReadingError);
        assert.include(String(caught), "本地解读数据库读写失败");
        assert.notInclude(String(caught), "private-paper-text");
        assert.notInclude(String(caught), "private-fixture-hash");
        assert.notInclude(String(caught), "PARAMS");
      } finally {
        await Zotero.DB.queryAsync("DROP TRIGGER pcp_reading_test_failure");
      }
    });

    it("does not echo a damaged private report in a JSON parsing error", async function () {
      const identity = `damaged-${Zotero.Utilities.randomString(12)}`;
      const options = { noCache: true, debug: false };
      await readingStore.getText(identity);
      await Zotero.DB.queryAsync(
        "INSERT INTO pcp_reading_runs VALUES (?, ?, ?, ?, ?)",
        [identity, identity, "complete", Date.now(), "private-broken-report"],
        options,
      );
      try {
        let caught: unknown;
        try {
          await readingStore.latest(identity);
        } catch (error) {
          caught = error;
        }
        assert.instanceOf(caught, ReadingError);
        assert.include(String(caught), "本地解读记录损坏");
        assert.notInclude(String(caught), "private-broken-report");
      } finally {
        await Zotero.DB.queryAsync(
          "DELETE FROM pcp_reading_runs WHERE identity = ?",
          [identity],
          options,
        );
      }
    });
  });

  describe("local reading pane", function () {
    this.timeout(15000);

    it("shows complete cached Markdown and has no spending-limit setting", async function () {
      const f = await fixture();
      const doc = Zotero.getMainWindow().document;
      const body = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div",
      ) as HTMLElement;
      body.style.cssText = "position:absolute;visibility:hidden;width:220px;";
      doc.documentElement.append(body);
      const item = {
        id: 1,
        getField: () => "Test paper.pdf",
      } as unknown as Zotero.Item;
      try {
        await mountReadingPane(body, [item], 1, f.service, async () => f.pdf);
        assert.isEmpty(f.calls);
        assert.notExists(body.querySelector('input[type="number"]'));
        const button = body.querySelector(
          '[data-action="generate"]',
        ) as HTMLButtonElement;
        button.click();
        await waitUntil(
          () =>
            !f.service.busy() &&
            body.querySelectorAll(".pcp-reading-answer").length === 6,
        );
        assert.equal(button.textContent, "重新生成六问");
        assert.lengthOf(body.querySelectorAll(".pcp-reading-question"), 6);
        assert.include(
          body.querySelector(".pcp-reading-source pre")!.textContent!,
          paragraph,
        );
        assert.include(body.textContent!, "Batch 估算");
        for (const selector of [
          ".pcp-reading",
          "select",
          ".pcp-reading-question",
          ".pcp-reading-source",
        ])
          assert.isAtMost(
            body.querySelector(selector)!.getBoundingClientRect().width,
            220.5,
          );
        f.calls.length = 0;
        await mountReadingPane(body, [item], 1, f.service, async () => f.pdf);
        assert.isEmpty(f.calls);
        assert.lengthOf(body.querySelectorAll(".pcp-reading-answer"), 6);
      } finally {
        await mountReadingPane(body, [], undefined, f.service);
        body.remove();
        f.service.shutdown();
      }
    });

    it("does not display an old paper's batch result in the newly selected pane", async function () {
      const f = await fixture();
      const entered = deferred<void>();
      const finish = deferred<void>();
      const get = f.client.getBatch;
      f.client.getBatch = async (id, signal) => {
        entered.resolve();
        await finish.promise;
        return get(id, signal);
      };
      const doc = Zotero.getMainWindow().document;
      const body = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div",
      ) as HTMLElement;
      const item = { id: 1, getField: () => "A.pdf" } as unknown as Zotero.Item;
      try {
        await mountReadingPane(body, [item], 1, f.service, async () => f.pdf);
        (
          body.querySelector('[data-action="generate"]') as HTMLButtonElement
        ).click();
        await entered.promise;
        const other = {
          ...f.pdf,
          identity: "different-paper",
          attachmentID: 2,
        };
        const second = {
          id: 2,
          getField: () => "B.pdf",
        } as unknown as Zotero.Item;
        await mountReadingPane(body, [second], 2, f.service, async () => other);
        finish.resolve();
        await waitUntil(() => !f.service.busy());
        await Zotero.Promise.delay(30);
        assert.lengthOf(body.querySelectorAll(".pcp-reading-answer"), 0);
        assert.isDefined(await f.store.latest(f.pdf.identity, true));
        assert.isUndefined(await f.store.latest(other.identity, true));
      } finally {
        finish.resolve();
        await mountReadingPane(body, [], undefined, f.service);
        f.service.shutdown();
      }
    });

    it("renders Markdown tables and long content without loading HTML or remote resources", function () {
      const doc = Zotero.getMainWindow().document;
      const target = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div",
      ) as HTMLElement;
      renderMarkdown(
        target,
        "**bold** [click](javascript:alert(1)) ![remote](https://example.invalid/x.png)\n\n" +
          "| Method | Result |\n|---|---|\n| A | **2.5** |\n\n" +
          '<script>alert(1)</script><img src="https://example.invalid/y.png" onerror="alert(1)">',
      );
      assert.lengthOf(
        target.querySelectorAll("script,img,iframe,a,style,link,object"),
        0,
      );
      assert.equal(target.querySelector("strong")?.textContent, "bold");
      assert.equal(target.querySelector("tbody td strong")?.textContent, "2.5");
      assert.lengthOf(target.querySelectorAll("th"), 2);
    });

    it("keeps old cached reports readable and distinguishes incomplete usage", async function () {
      const f = await fixture();
      const run = await f.service.start(f.pdf);
      run.protocol = "six-questions-v2.1-text";
      delete run.batches;
      assert.notInclude(usageText(run), "Batch");
      run.usageIncomplete = true;
      assert.include(usageText(run), "总费用尚不完整");
      delete run.completion.usage;
      assert.include(usageText(run), "费用待确认");
    });
  });
});

async function waitUntil(check: () => boolean) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5000) assert.fail("Timed out waiting for UI");
    await Zotero.Promise.delay(20);
  }
}
