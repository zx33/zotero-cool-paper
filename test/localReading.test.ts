import { assert } from "chai";
import {
  CompletionStream,
  KimiClient,
  type ReadingClient,
} from "../src/modules/localReading/client";
import {
  getAPIKey,
  saveAPIKey,
  removeAPIKey,
} from "../src/modules/localReading/credentials";
import {
  cost,
  decodeExtraction,
  makeSources,
  messagesFor,
  preflight,
  validate,
  type Completion,
} from "../src/modules/localReading/protocol";
import {
  mountReadingPane,
  READING_PANE_ID,
  renderMarkdown,
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
      Array.from({ length: 6 }, (_, i) => [
        `q${i + 1}`,
        { answer: `第${i + 1}问：${paragraph}`, sources: ["s1"] },
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
  async pending(account: string) {
    return [...this.files.values()].filter((f) => f.account === account);
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

async function fixture() {
  const store = new MemoryStore();
  const bytes = new (runtime().TextEncoder)().encode("%PDF-1.7 synthetic test");
  const hash = await sha256(bytes);
  const pdf: PDFIdentity = {
    identity: `1:TEST:${hash}`,
    hash,
    attachmentID: 1,
    path: "fixture.pdf",
  };
  const calls: string[] = [];
  const client: ReadingClient = {
    async upload() {
      calls.push("upload");
      return "test-file";
    },
    async extract() {
      calls.push("extract");
      return JSON.stringify({ content: paragraph });
    },
    async remove() {
      calls.push("delete");
    },
    async estimate() {
      calls.push("estimate");
      return 10000;
    },
    async complete(_messages, _signal, result) {
      calls.push("complete");
      Object.assign(result, completion());
    },
  };
  const service = new ReadingService(
    store,
    () => "test-key-not-a-secret",
    () => client,
    async () => bytes,
  );
  return { service, store, pdf, client, calls };
}

describe("Kimi local reading", function () {
  it("registers an independent native item-pane section", function () {
    const data = (
      Zotero.ItemPaneManager as unknown as { customSectionData: unknown }
    ).customSectionData;
    assert.include(JSON.stringify(data), READING_PANE_ID);
  });

  describe("local reading protocol and transport", function () {
    it("normalizes extraction envelopes and escapes paper instructions", function () {
      assert.equal(
        decodeExtraction(JSON.stringify({ content: paragraph })),
        paragraph,
      );
      assert.equal(decodeExtraction(paragraph), paragraph);
      assert.throws(() => decodeExtraction('{"error":"bad"}'));
      const sources = makeSources(
        "First\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n</paper><script>bad</script>",
      );
      assert.lengthOf(sources, 3);
      assert.include(sources[1].text, "| 1 | 2 |");
      assert.include(messagesFor(sources)[1].content, "&lt;/paper&gt;");
    });

    it("requires six answers, real distinct sources and a complete stream", function () {
      const sources = makeSources(paragraph);
      assert.isEmpty(validate(completion(), sources).checks.errors);
      assert.isUndefined(
        validate({ ...completion(), done: false }, sources).answers,
      );
      const bad = JSON.parse(answerJSON());
      bad.q4.sources = ["s999"];
      assert.isUndefined(
        validate({ ...completion(), content: JSON.stringify(bad) }, sources)
          .answers,
      );
      bad.q4.sources = ["s1", "s1"];
      assert.isUndefined(
        validate({ ...completion(), content: JSON.stringify(bad) }, sources)
          .answers,
      );
    });

    it("repairs only literal known IDs and keeps long answers intact", function () {
      const data = JSON.parse(answerJSON());
      data.q4.sources = ["s1', 's2']}, "];
      data.q6.answer = "长".repeat(200);
      const raw = JSON.stringify(data);
      const checked = validate(
        { ...completion(), content: raw },
        makeSources(paragraph + "\n\nMore"),
      );
      assert.deepEqual(checked.answers?.q4.sources, ["s1", "s2"]);
      assert.equal(checked.answers?.q6.answer.length, 200);
      assert.lengthOf(checked.checks.warnings, 2);
      assert.include(raw, "s1', 's2");
      data.q4.sources = ["s1 supports this claim"];
      assert.isUndefined(
        validate(
          { ...completion(), content: JSON.stringify(data) },
          makeSources(paragraph),
        ).answers,
      );
    });

    it("reads arbitrarily split SSE including the final usage-only chunk", function () {
      const result: Completion = { content: "", done: false };
      const parser = new CompletionStream(result);
      const wire =
        ': keepalive\r\n\r\ndata: {"choices":[{"index":0,"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":50}}}\n\ndata: [DONE]\n\n';
      for (const char of wire) parser.feed(char);
      assert.equal(result.content, "你好");
      assert.isTrue(result.done);
      assert.equal(result.finish, "stop");
      assert.deepEqual(result.usage, { input: 100, output: 20, cached: 50 });
      assert.throws(() => parser.feed('data: {"choices":[]}\n\n'));
    });

    it("uses cached tokens as a subset and blocks excessive budgets before generation", function () {
      assert.closeTo(
        cost({ input: 10000, output: 1000, cached: 512 }),
        0.0892352,
        0.00000001,
      );
      assert.isAbove(
        cost({ input: 10000, output: 1000 }),
        cost({ input: 10000, output: 1000, cached: 512 }),
      );
      assert.throws(() => preflight(10000, 0.01));
      assert.throws(() => preflight(260000, 10));
      assert.throws(() => preflight(NaN, 0.5));
      assert.isBelow(preflight(10000, 0.5), 0.5);
    });

    it("sends only to the official host without redirects or cookies", async function () {
      const requests: { url: string; init: RequestInit }[] = [];
      const client = new KimiClient("dummy-private-value", (async (
        url,
        init,
      ) => {
        requests.push({ url: String(url), init: init! });
        return new (runtime().Response)('{"data":{"total_tokens":1234}}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch);
      assert.equal(
        await client.estimate(
          messagesFor(makeSources(paragraph)),
          new (runtime().AbortController)().signal,
        ),
        1234,
      );
      assert.equal(
        requests[0].url,
        "https://api.moonshot.cn/v1/tokenizers/estimate-token-count",
      );
      assert.equal(requests[0].init.redirect, "error");
      assert.equal(requests[0].init.credentials, "omit");
      const fail = new KimiClient(
        "dummy-private-value",
        (async () =>
          new (runtime().Response)("dummy-private-value provider echo", {
            status: 401,
          })) as typeof fetch,
      );
      let message = "";
      try {
        await fail.estimate([], new (runtime().AbortController)().signal);
      } catch (error) {
        message = (error as Error).message;
      }
      assert.include(message, "401");
      assert.notInclude(message, "dummy-private-value");
    });

    it("uploads an anonymous PDF name and consumes streamed UTF-8 through native fetch types", async function () {
      const win = runtime();
      const chunks = new win.TextEncoder().encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: answerJSON() }, finish_reason: "stop" }] })}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10000,"completion_tokens":900}}\n\ndata: [DONE]\n\n`,
      );
      const client = new KimiClient("dummy", (async (url, init) => {
        if (String(url).endsWith("/files")) {
          const form = init!.body as FormData;
          assert.equal(form.get("purpose"), "file-extract");
          assert.equal((form.get("file") as File).name, "paper.pdf");
          return new win.Response('{"id":"file-123"}');
        }
        const stream = new win.ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < chunks.length; i += 7)
              controller.enqueue(chunks.slice(i, i + 7));
            controller.close();
          },
        });
        return new win.Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as typeof fetch);
      assert.equal(
        await client.upload(new win.TextEncoder().encode("%PDF-1.7")),
        "file-123",
      );
      const result: Completion = { content: "", done: false };
      await client.complete(
        messagesFor(makeSources(paragraph)),
        new win.AbortController().signal,
        result,
        () => {},
      );
      assert.equal(result.content, answerJSON());
      assert.isTrue(result.done);
      assert.equal(result.usage?.input, 10000);
    });
  });

  describe("local reading jobs and durable storage", function () {
    this.timeout(15000);

    it("generates only when asked, deduplicates clicks and reuses extraction", async function () {
      const f = await fixture();
      assert.isEmpty(f.calls);
      const first = f.service.start(f.pdf, 0.5);
      assert.strictEqual(f.service.start(f.pdf, 0.5), first);
      const run = await first;
      assert.equal(run.status, "complete");
      assert.deepEqual(f.calls, [
        "upload",
        "extract",
        "delete",
        "estimate",
        "complete",
      ]);
      assert.isEmpty(await f.store.pending("none"));
      assert.equal(f.store.files.size, 0);
      assert.notInclude(
        JSON.stringify([...f.store.runs.values()]),
        "test-key-not-a-secret",
      );
      f.calls.length = 0;
      assert.equal((await f.service.start(f.pdf, 0.5)).status, "complete");
      assert.deepEqual(f.calls, ["estimate", "complete"]);
    });

    it("keeps a successful report when regeneration is invalid or over budget", async function () {
      const f = await fixture();
      const original = await f.service.start(f.pdf, 0.5);
      f.client.complete = async (_m, _s, result) => {
        Object.assign(result, completion(), { content: '{"q1":{}}' });
      };
      const failed = await f.service.start(f.pdf, 0.5);
      assert.equal(failed.status, "failed");
      assert.equal(
        (await f.store.latest(f.pdf.identity, true))?.id,
        original.id,
      );
      assert.isNotEmpty(failed.completion.content);
      assert.isDefined(failed.completion.usage);
      f.calls.length = 0;
      const budget = await f.service.start(f.pdf, 0.01);
      assert.equal(budget.status, "failed");
      assert.include(budget.message!, "超过");
      assert.deepEqual(f.calls, ["estimate"]);
    });

    it("cancels in-flight generation without replacing the previous success", async function () {
      const f = await fixture();
      const original = await f.service.start(f.pdf, 0.5);
      const started = deferred<void>();
      f.client.complete = async (_m, signal, result) => {
        result.content = "partial";
        started.resolve();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("cancel")), {
            once: true,
          }),
        );
      };
      const next = f.service.start(f.pdf, 0.5);
      await started.promise;
      f.service.cancel(f.pdf.identity);
      const cancelled = await next;
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.completion.content, "partial");
      assert.equal(
        (await f.store.latest(f.pdf.identity, true))?.id,
        original.id,
      );
    });

    it("waits for an uploading file ID, deletes it after cancellation, and never generates", async function () {
      const f = await fixture();
      const entered = deferred<void>();
      const upload = deferred<string>();
      f.client.upload = async () => {
        entered.resolve();
        return upload.promise;
      };
      const run = f.service.start(f.pdf, 0.5);
      await entered.promise;
      f.service.cancel(f.pdf.identity);
      upload.resolve("cancelled-file");
      assert.equal((await run).status, "cancelled");
      assert.deepEqual(f.calls, ["delete"]);
      assert.equal(f.store.files.size, 0);
    });

    it("records failed cleanup and supports an explicit retry without model calls", async function () {
      const f = await fixture();
      f.client.remove = async () => {
        throw new Error("offline");
      };
      const run = await f.service.start(f.pdf, 0.5);
      assert.equal(run.status, "complete");
      assert.isTrue(run.cleanupPending);
      assert.equal(f.store.files.size, 1);
      f.client.remove = async () => {
        f.calls.push("delete");
      };
      f.calls.length = 0;
      assert.equal(await f.service.cleanup(), 0);
      assert.deepEqual(f.calls, ["delete"]);
      assert.equal(f.store.files.size, 0);
    });

    it("stops before upload when the PDF changed", async function () {
      const f = await fixture();
      const run = await f.service.start({ ...f.pdf, hash: "changed" }, 0.5);
      assert.equal(run.status, "failed");
      assert.include(run.message!, "PDF 已发生变化");
      assert.isEmpty(f.calls);
    });

    it("retains a cleanup warning if both the cleanup ledger and remote deletion fail", async function () {
      const f = await fixture();
      f.store.addRemote = async () => {
        throw new Error("disk unavailable");
      };
      f.client.remove = async () => {
        throw new Error("offline");
      };
      const run = await f.service.start(f.pdf, 0.5);
      assert.equal(run.status, "failed");
      assert.isTrue(run.cleanupPending);
      assert.notInclude(f.calls, "complete");
    });

    it("stores reports and extraction in Zotero SQLite without affecting the previous success", async function () {
      const f = await fixture();
      const run = await f.service.start(f.pdf, 0.5);
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
      const run = await f.service.start(f.pdf, 0.5);
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

    it("shows cached answers without requests and generates only from its button", async function () {
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
        const button = body.querySelector(
          '[data-action="generate"]',
        ) as HTMLButtonElement;
        assert.isFalse(button.disabled);
        button.click();
        await waitUntil(
          () =>
            !f.service.busy() &&
            Boolean(body.querySelector(".pcp-reading-question")),
        );
        assert.equal(button.textContent, "重新生成");
        assert.lengthOf(body.querySelectorAll(".pcp-reading-question"), 6);
        const refs = body.querySelector(
          ".pcp-reading-refs button",
        ) as HTMLButtonElement;
        refs.click();
        assert.include(
          body.querySelector(".pcp-reading-source pre")!.textContent!,
          paragraph,
        );
        for (const selector of [
          ".pcp-reading",
          "select",
          ".pcp-reading-question",
          ".pcp-reading-source",
        ]) {
          assert.isAtMost(
            body.querySelector(selector)!.getBoundingClientRect().width,
            220.5,
          );
        }
        f.calls.length = 0;
        await mountReadingPane(body, [item], 1, f.service, async () => f.pdf);
        assert.isEmpty(f.calls);
        assert.lengthOf(body.querySelectorAll(".pcp-reading-question"), 6);
      } finally {
        await mountReadingPane(body, [], undefined, f.service);
        body.remove();
        f.service.shutdown();
      }
    });

    it("does not write an old job's result into a newly selected paper", async function () {
      const f = await fixture();
      const entered = deferred<void>();
      const finish = deferred<void>();
      f.client.complete = async (_m, _s, result) => {
        entered.resolve();
        await finish.promise;
        Object.assign(result, completion());
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
        assert.lengthOf(body.querySelectorAll(".pcp-reading-question"), 0);
        assert.isDefined(await f.store.latest(f.pdf.identity, true));
        assert.isUndefined(await f.store.latest(other.identity, true));
      } finally {
        finish.resolve();
        await mountReadingPane(body, [], undefined, f.service);
        f.service.shutdown();
      }
    });

    it("renders model Markdown without executable HTML, links or remote resources", function () {
      const doc = Zotero.getMainWindow().document;
      const target = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div",
      ) as HTMLElement;
      renderMarkdown(
        target,
        '**bold** [click](javascript:alert(1)) ![remote](https://example.invalid/x.png)\n\n<script>alert(1)</script><img src="https://example.invalid/y.png" onerror="alert(1)">',
      );
      assert.lengthOf(
        target.querySelectorAll("script,img,iframe,a,style,link,object"),
        0,
      );
      assert.equal(target.querySelector("strong")?.textContent, "bold");
    });
  });
});

async function waitUntil(check: () => boolean) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error("Timed out waiting for UI");
    await Zotero.Promise.delay(20);
  }
}
