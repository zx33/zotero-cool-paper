import { marked, type Token } from "marked";
import { config } from "../../../package.json";
import { getAPIKey, removeAPIKey, saveAPIKey } from "./credentials";
import {
  cost,
  makeSources,
  MODEL,
  PRICE_DATE,
  PROTOCOL,
  QUESTIONS,
  QUESTION_IDS,
  type Question,
} from "./protocol";
import { ReadingError, safeError } from "./runtime";
import {
  identifyPDF,
  readingService,
  type PDFIdentity,
  type ReadingService,
} from "./service";
import type { ReadingRun } from "./store";

export const READING_PANE_ID = "zoterocoolpaper-local-reading";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const cleanups = new Map<HTMLElement, () => void>();
const paneItems = new WeakMap<HTMLElement, number | undefined>();
let registeredPane: string | false = false;

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function parent(item?: Zotero.Item | null): Zotero.Item | undefined {
  if (item?.isRegularItem()) return item;
  if (item?.isPDFAttachment())
    return item.parentID ? Zotero.Items.get(item.parentID) : item;
}

export function registerLocalReadingItemPane(): void {
  const icon = `chrome://${config.addonRef}/content/icons/local-reading-icon.svg`;
  registeredPane = Zotero.ItemPaneManager.registerSection({
    paneID: READING_PANE_ID,
    pluginID: config.addonID,
    header: {
      icon,
      l10nID: `${config.addonRef}-local-reading-section-head-text`,
    },
    sidenav: {
      icon,
      l10nID: `${config.addonRef}-local-reading-section-sidenav-tooltip`,
    },
    onItemChange: ({ item, setEnabled, body }) => {
      // Zotero also calls this hook when refreshing the same item, without
      // scheduling another async render. Keep its mounted content in that case.
      if (paneItems.get(body) !== item?.id) {
        cleanups.get(body)?.();
        cleanups.delete(body);
        body.replaceChildren();
        paneItems.set(body, item?.id);
      }
      setEnabled(Boolean(parent(item)));
      return true;
    },
    onRender: () => {},
    onAsyncRender: async ({ body, item, tabType }) => {
      const target = parent(item);
      if (!target) return;
      const attachments = target.isPDFAttachment()
        ? [target]
        : target
            .getAttachments()
            .map((id) => Zotero.Items.get(id))
            .filter((a) => a.isPDFAttachment());
      let preferred = item?.isPDFAttachment() ? item.id : undefined;
      if (tabType === "reader") {
        const win = body.ownerDocument!.defaultView as unknown as {
          Zotero_Tabs?: { selectedID: string };
        };
        const reader = win.Zotero_Tabs
          ? Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID)
          : undefined;
        if (reader) preferred = reader.itemID;
      }
      await mountReadingPane(body, attachments, preferred);
    },
    onDestroy: ({ body }) => {
      cleanups.get(body)?.();
      cleanups.delete(body);
      paneItems.delete(body);
    },
  });
}

export function unregisterLocalReadingItemPane(): void {
  for (const cleanup of cleanups.values()) cleanup();
  cleanups.clear();
  readingService.shutdown();
  if (registeredPane) Zotero.ItemPaneManager.unregisterSection(registeredPane);
  registeredPane = false;
}

export async function mountReadingPane(
  body: HTMLElement,
  attachments: Zotero.Item[],
  preferred?: number,
  service: ReadingService = readingService,
  identify: typeof identifyPDF = identifyPDF,
): Promise<void> {
  cleanups.get(body)?.();
  let alive = true;
  let selection = 0;
  let paintVersion = 0;
  let pdf: PDFIdentity | undefined;
  let good: ReadingRun | undefined;
  let finished: ReadingRun | undefined;
  let sources = new Map<string, string>();
  const doc = body.ownerDocument!;
  body.classList.add("pcp-body");
  const root = element(doc, "div", undefined, "pcp-reading");
  body.replaceChildren(root);
  root.append(element(doc, "p", "Kimi K2.6 · 六问解读", "pcp-reading-title"));
  root.append(
    element(
      doc,
      "p",
      "六个问题分别阅读论文全文，由 Kimi 批量生成。提交后可关闭 Zotero，稍后回来查看。",
      "pcp-reading-hint",
    ),
  );
  const label = element(doc, "label", "PDF 附件");
  const select = element(doc, "select");
  select.setAttribute("aria-label", "PDF 附件");
  for (const attachment of attachments) {
    const option = element(
      doc,
      "option",
      String(attachment.getField("title") || "PDF 附件"),
    );
    option.value = String(attachment.id);
    select.append(option);
  }
  if (preferred && attachments.some((a) => a.id === preferred))
    select.value = String(preferred);
  label.append(select);
  root.append(label);
  const actions = element(doc, "div", undefined, "pcp-reading-actions");
  const generate = element(doc, "button", "生成六问");
  generate.dataset.action = "generate";
  const cancel = element(doc, "button", "取消");
  cancel.hidden = true;
  cancel.dataset.action = "cancel";
  const open = element(doc, "button", "打开 PDF");
  actions.append(generate, cancel, open);
  root.append(actions);
  const status = element(doc, "p", "正在读取本地记录…", "pcp-reading-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  root.append(status);
  const attempt = element(doc, "div", undefined, "pcp-reading-attempt");
  root.append(attempt);
  const report = element(doc, "div", undefined, "pcp-reading-report");
  root.append(report);
  const sourceView = element(doc, "details", undefined, "pcp-reading-source");
  sourceView.append(element(doc, "summary", "论文解析正文"));
  const sourceText = element(doc, "pre", "解析完成后可在这里查看全文。");
  sourceText.tabIndex = 0;
  sourceView.append(sourceText);
  root.append(sourceView);
  const settings = createSettings(doc, status, service);
  root.append(settings);
  root.append(
    element(
      doc,
      "p",
      "解读保存在本机；可展开论文解析正文或打开 PDF 对照阅读。",
      "pcp-reading-hint",
    ),
  );
  const unsubscribe = service.subscribe(() => {
    void paint().catch(() => {
      if (alive) status.textContent = "本地记录读取失败。";
    });
  });
  cleanups.set(body, () => {
    alive = false;
    selection++;
    paintVersion++;
    unsubscribe();
  });

  function renderReport(run?: ReadingRun) {
    report.replaceChildren();
    if (!run?.answers) return;
    const date = new Date(run.started).toLocaleString();
    report.append(
      element(
        doc,
        "p",
        `${date} · ${run.model}${run.protocol !== PROTOCOL ? " · 旧版协议，可按需重新生成" : ""}`,
        "pcp-reading-hint",
      ),
    );
    for (const [index, title] of QUESTIONS.entries()) {
      const answer = run.answers[`q${index + 1}` as Question];
      const section = element(
        doc,
        "details",
        undefined,
        "pcp-reading-question",
      );
      section.open = true;
      section.append(element(doc, "summary", `${index + 1}. ${title}`));
      const content = element(doc, "div", undefined, "pcp-reading-answer");
      if (answer) renderMarkdown(content, answer.answer);
      else {
        content.textContent =
          run.questions?.[`q${index + 1}` as Question]?.error ??
          "此题尚未完成。";
        content.className = "pcp-reading-hint";
      }
      section.append(content);
      const refs = element(doc, "div", undefined, "pcp-reading-refs");
      refs.append(element(doc, "span", "依据 "));
      for (const id of answer?.sources ?? []) {
        const link = element(doc, "button", id);
        link.title = "查看文件解析原文段落";
        link.addEventListener("click", () => {
          sourceText.textContent = `[${id}]\n${sources.get(id) ?? "来源暂不可用"}`;
          sourceView.open = true;
          sourceView.scrollIntoView({ block: "nearest" });
          sourceText.focus();
        });
        refs.append(link);
      }
      if (answer?.sources.length) section.append(refs);
      const parts = run.questions?.[`q${index + 1}` as Question]?.parts;
      if (!answer && parts?.some((part) => part.content)) {
        const draft = element(doc, "details");
        draft.append(element(doc, "summary", "查看已生成部分"));
        const draftContent = element(doc, "div");
        renderMarkdown(
          draftContent,
          parts.map((part) => part.content).join("\n\n"),
        );
        draft.append(draftContent);
        section.append(draft);
      }
      report.append(section);
    }
    if (run.checks?.warnings.length)
      report.append(
        element(
          doc,
          "p",
          run.checks.warnings.join("\n"),
          "pcp-reading-warning",
        ),
      );
    report.append(element(doc, "p", usageText(run), "pcp-reading-hint"));
  }

  async function paint() {
    const version = ++paintVersion;
    if (!pdf) {
      generate.disabled = true;
      open.disabled = !attachments.length;
      return;
    }
    const current = pdf;
    const [saved, latest] = await Promise.all([
      service.store.latest(current.identity, true),
      service.store.latest(current.identity),
    ]);
    if (!alive || version !== paintVersion || current !== pdf) return;
    const active = service.job(current.identity);
    const last = active?.run ?? latest ?? finished;
    good = saved;
    const resumable =
      last?.protocol === PROTOCOL &&
      last.questions &&
      last.status !== "complete";
    generate.textContent =
      last?.status === "running" && !active
        ? "继续查询"
        : resumable
          ? "补全六问"
          : good
            ? "重新生成六问"
            : "生成六问";
    generate.disabled = Boolean(active);
    cancel.hidden = !active && last?.status !== "running";
    cancel.disabled = Boolean(last?.cancelRequested);
    select.disabled = false;
    open.disabled = false;
    status.textContent = last?.message ?? "尚未生成。点击按钮开始六问解读。";
    const shown =
      last?.answers && Object.keys(last.answers).length ? last : good;
    if (shown && last && shown.id !== last.id)
      status.textContent += " 下方保留上一版完整解读。";
    attempt.replaceChildren();
    if (last?.cleanupPending)
      attempt.append(
        element(
          doc,
          "p",
          "有已结束任务的云端文件待清理，可在设置中重试。",
          "pcp-reading-warning",
        ),
      );
    if (
      last &&
      last.id !== shown?.id &&
      (last.status !== "running" || last.completion.usage)
    )
      attempt.append(
        element(doc, "p", "本次任务：" + usageText(last), "pcp-reading-hint"),
      );
    const reportKey = shown
      ? shown.id +
        ":" +
        QUESTION_IDS.map((q) =>
          [
            shown.answers?.[q]?.answer.length,
            shown.questions?.[q]?.status,
            shown.questions?.[q]?.parts.length,
          ].join("/"),
        ).join(",")
      : "";
    // Preserve expanded sections while only the batch status is changing.
    if (report.dataset.run !== reportKey) {
      renderReport(shown);
      report.dataset.run = reportKey;
    }
  }

  async function choose() {
    const revision = ++selection;
    pdf = undefined;
    good = undefined;
    finished = undefined;
    report.replaceChildren();
    delete report.dataset.run;
    sourceText.textContent = "解析完成后可在这里查看全文。";
    sourceView.open = false;
    attempt.replaceChildren();
    generate.disabled = true;
    cancel.hidden = true;
    status.textContent = "正在检查本地 PDF…";
    const attachment = attachments.find((a) => a.id === Number(select.value));
    if (!attachment) {
      status.textContent = "请先为此条目添加本地 PDF 附件。";
      select.disabled = true;
      open.disabled = true;
      return;
    }
    try {
      const selected = await identify(attachment);
      const text = await service.store.getText(selected.hash);
      if (!alive || revision !== selection) return;
      pdf = selected;
      sourceText.textContent = text ?? "解析完成后可在这里查看全文。";
      sources = new Map(makeSources(text ?? "").map((s) => [s.id, s.text]));
      await paint();
    } catch (error) {
      if (alive && revision === selection)
        status.textContent = safeError(error);
    }
  }

  select.addEventListener("change", () => {
    void choose();
  });
  open.addEventListener("click", () => {
    const id = Number(select.value);
    if (attachments.some((a) => a.id === id))
      void Zotero.Reader.open(id).catch(() => {
        if (alive) status.textContent = "PDF 打开失败，请检查附件是否已下载。";
      });
  });
  cancel.addEventListener("click", () => {
    if (pdf)
      void service.cancel(pdf.identity).catch((error) => {
        if (alive) status.textContent = safeError(error);
      });
  });
  generate.addEventListener("click", async () => {
    if (!pdf) return;
    const current = pdf;
    generate.disabled = true;
    try {
      const result = await service.start(current);
      if (!alive || current !== pdf) return;
      finished = result;
      const text = await service.store.getText(current.hash);
      if (!alive || current !== pdf) return;
      sources = new Map(makeSources(text ?? "").map((s) => [s.id, s.text]));
      sourceText.textContent = text ?? "解析完成后可在这里查看全文。";
      await paint();
    } catch (error) {
      if (alive && current === pdf) {
        status.textContent = safeError(error);
        generate.disabled = false;
      }
    }
  });
  await choose();
}

export function usageText(run: ReadingRun): string {
  const u = run.completion.usage;
  if (!u) return "用量尚未返回，费用待确认。";
  const batch = Boolean(run.batches);
  return (
    (run.usageIncomplete ? "已报告部分：" : "") +
    "输入 " +
    u.input.toLocaleString() +
    " / 输出 " +
    u.output.toLocaleString() +
    " tokens · 缓存 " +
    (u.cached === undefined ? "未报告" : u.cached.toLocaleString()) +
    " · " +
    (batch ? "Batch " : "") +
    "估算 ¥" +
    cost(u, batch).toFixed(3) +
    (run.usageIncomplete ? "，总费用尚不完整" : "")
  );
}

function createSettings(
  doc: Document,
  status: HTMLElement,
  service: ReadingService,
): HTMLDetailsElement {
  const details = element(doc, "details", undefined, "pcp-reading-settings");
  details.append(element(doc, "summary", "API Key 与费用说明"));
  const keyLabel = element(doc, "label", "Kimi API Key");
  const key = element(doc, "input");
  key.type = "password";
  key.autocomplete = "off";
  key.spellcheck = false;
  key.placeholder = "输入新 Key；留空保留现有 Key";
  keyLabel.append(key);
  details.append(keyLabel);
  const keyState = element(doc, "p", "", "pcp-reading-hint");
  const refresh = () => {
    try {
      keyState.textContent = getAPIKey()
        ? "已保存于 Zotero 密码管理器"
        : "尚未保存 API Key";
    } catch {
      keyState.textContent = "密码管理器尚未解锁";
    }
  };
  refresh();
  details.append(keyState);
  const buttons = element(doc, "div", undefined, "pcp-reading-actions");
  const save = element(doc, "button", "保存设置");
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      if (key.value.trim()) await saveAPIKey(key.value);
      key.value = "";
      refresh();
      status.textContent = "设置已保存。";
      await service.resumeAll();
    } catch {
      status.textContent = "设置未保存，请检查 Key 格式或密码管理器。";
    } finally {
      save.disabled = false;
    }
  });
  const forget = element(doc, "button", "移除 Key");
  forget.addEventListener("click", () => {
    try {
      removeAPIKey();
      key.value = "";
      refresh();
      status.textContent = "已移除此插件保存的 Key。";
    } catch {
      status.textContent = "Key 移除失败，请检查密码管理器。";
    }
  });
  const cleanup = element(doc, "button", "重试云端清理");
  cleanup.addEventListener("click", async () => {
    cleanup.disabled = true;
    try {
      const count = await service.cleanup();
      status.textContent = count
        ? `仍有 ${count} 个文件未确认删除，可稍后重试。`
        : "当前 Key 下已记录的待清理文件已处理。";
    } catch (error) {
      status.textContent = safeError(error);
    } finally {
      cleanup.disabled = false;
    }
  });
  buttons.append(save, forget, cleanup);
  details.append(buttons);
  details.append(
    element(
      doc,
      "p",
      `模型 ${MODEL}，开启思考，六问独立生成。按 ${PRICE_DATE} 单价快照及 Batch 六折估算：输入 / 缓存 / 输出分别 ¥3.9 / 0.66 / 16.2 每百万 tokens。显示实际返回的用量，不设消费上限。`,
      "pcp-reading-hint",
    ),
  );
  return details;
}

/** Build a small Markdown subset with native nodes. Raw HTML, URLs and images never load. */
export function renderMarkdown(target: HTMLElement, markdown: string): void {
  const doc = target.ownerDocument!;
  function render(tokens: Token[], into: HTMLElement) {
    for (const token of tokens) {
      if (token.type === "space") continue;
      if (token.type === "list") {
        const list = element(doc, token.ordered ? "ol" : "ul");
        for (const item of token.items) {
          const li = element(doc, "li");
          render(item.tokens, li);
          list.append(li);
        }
        into.append(list);
        continue;
      }
      if (token.type === "table") {
        const table = element(doc, "table");
        const head = element(doc, "thead");
        const heading = element(doc, "tr");
        for (const cell of token.header) {
          const th = element(doc, "th");
          render(cell.tokens, th);
          heading.append(th);
        }
        head.append(heading);
        table.append(head);
        const rows = element(doc, "tbody");
        for (const row of token.rows) {
          const tr = element(doc, "tr");
          for (const cell of row) {
            const td = element(doc, "td");
            render(cell.tokens, td);
            tr.append(td);
          }
          rows.append(tr);
        }
        table.append(rows);
        into.append(table);
        continue;
      }
      if (token.type === "br") {
        into.append(element(doc, "br"));
        continue;
      }
      const tags: Record<string, keyof HTMLElementTagNameMap> = {
        paragraph: "p",
        heading: "p",
        strong: "strong",
        em: "em",
        codespan: "code",
        code: "pre",
        blockquote: "blockquote",
        del: "s",
      };
      const node = tags[token.type] ? element(doc, tags[token.type]) : into;
      if ("tokens" in token && token.tokens) render(token.tokens, node);
      else
        node.append(
          doc.createTextNode("text" in token ? String(token.text) : token.raw),
        );
      if (node !== into) into.append(node);
    }
  }
  render(marked.lexer(markdown), target);
}
