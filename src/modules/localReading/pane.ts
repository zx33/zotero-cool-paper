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
const BUDGET_PREF = `${config.prefsPrefix}.localReading.maxCost`;
const cleanups = new Map<HTMLElement, () => void>();
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
      cleanups.get(body)?.();
      cleanups.delete(body);
      body.replaceChildren();
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
      "点击生成后，所选 PDF 或已缓存的解析正文会发送至 Kimi 官方 API。打开此页不会调用模型。",
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
  const generate = element(doc, "button", "生成解读");
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
  sourceView.append(element(doc, "summary", "来源段落（非 PDF 页码）"));
  const sourceText = element(doc, "pre", "生成后可点击每题下方的来源编号。");
  sourceText.tabIndex = 0;
  sourceView.append(sourceText);
  root.append(sourceView);
  const settings = createSettings(doc, status, service);
  root.append(settings);
  root.append(
    element(
      doc,
      "p",
      "基于文件接口返回的文字；扫描页、图片及公式可能解析不全。本版不自动补图。解读是模型草稿，可点击来源核对。",
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
      renderMarkdown(content, answer.answer);
      section.append(content);
      const refs = element(doc, "div", undefined, "pcp-reading-refs");
      refs.append(element(doc, "span", "依据 "));
      for (const id of answer.sources) {
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
      section.append(refs);
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
    const last = active?.run ?? finished ?? latest;
    good = saved;
    generate.textContent = good ? "重新生成" : "生成解读";
    generate.disabled = Boolean(active) || service.busy();
    cancel.hidden = !active;
    cancel.disabled = active?.controller.signal.aborted ?? false;
    select.disabled = Boolean(active);
    open.disabled = false;
    status.textContent =
      active?.run.message ??
      last?.message ??
      "尚未生成。点击按钮开始六问解读。";
    if (service.busy() && !active)
      status.textContent = "另一篇论文正在生成；完成后可继续。";
    if (good && last && last.id !== good.id && last.status !== "running")
      status.textContent += " 下方显示上一版成功结果。";
    attempt.replaceChildren();
    if (last?.cleanupPending)
      attempt.append(
        element(
          doc,
          "p",
          "有云端文件尚未确认删除。请在设置中重试清理。",
          "pcp-reading-warning",
        ),
      );
    if (last && last.id !== good?.id && last.status !== "running") {
      attempt.append(
        element(
          doc,
          "p",
          `最近一次尝试：${usageText(last)}`,
          "pcp-reading-hint",
        ),
      );
      if (last.completion.content) {
        const draft = element(doc, "details");
        draft.append(
          element(doc, "summary", "查看未通过检查的原始草稿"),
          element(doc, "pre", last.completion.content),
        );
        attempt.append(draft);
      }
    }
    // Preserve expanded questions and source focus during progress updates.
    if (report.dataset.run !== (good?.id ?? "")) {
      renderReport(good);
      report.dataset.run = good?.id ?? "";
    }
  }

  async function choose() {
    const revision = ++selection;
    pdf = undefined;
    good = undefined;
    finished = undefined;
    report.replaceChildren();
    delete report.dataset.run;
    sourceText.textContent = "生成后可点击每题下方的来源编号。";
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
    if (pdf) service.cancel(pdf.identity);
  });
  generate.addEventListener("click", async () => {
    if (!pdf) return;
    const current = pdf;
    generate.disabled = true;
    try {
      const result = await service.start(current, getBudget());
      if (!alive || current !== pdf) return;
      finished = result;
      const text = await service.store.getText(current.hash);
      if (!alive || current !== pdf) return;
      sources = new Map(makeSources(text ?? "").map((s) => [s.id, s.text]));
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
  if (!u) return "未收到完整用量，费用未知（不代表免费）。";
  return `输入 ${u.input.toLocaleString()} / 输出 ${u.output.toLocaleString()} tokens · 缓存 ${u.cached === undefined ? "未报告" : u.cached.toLocaleString()} · 估算 ¥${cost(u).toFixed(3)}${u.cached === undefined ? "（未扣缓存优惠）" : ""}`;
}

function getBudget(): number {
  const value = Number(Zotero.Prefs.get(BUDGET_PREF, true));
  return Number.isFinite(value) && value > 0 ? value : 0.5;
}

function createSettings(
  doc: Document,
  status: HTMLElement,
  service: ReadingService,
): HTMLDetailsElement {
  const details = element(doc, "details", undefined, "pcp-reading-settings");
  details.append(element(doc, "summary", "API Key 与费用设置"));
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
  const budgetLabel = element(doc, "label", "单次生成预估上限（元）");
  const budget = element(doc, "input");
  budget.type = "number";
  budget.min = "0.01";
  budget.step = "0.01";
  budget.value = String(getBudget());
  budgetLabel.append(budget);
  details.append(budgetLabel);
  const buttons = element(doc, "div", undefined, "pcp-reading-actions");
  const save = element(doc, "button", "保存设置");
  save.addEventListener("click", async () => {
    const value = Number(budget.value);
    if (!Number.isFinite(value) || value <= 0) {
      status.textContent = "请输入有效的费用上限。";
      return;
    }
    save.disabled = true;
    try {
      if (key.value.trim()) await saveAPIKey(key.value);
      Zotero.Prefs.set(BUDGET_PREF, String(value), true);
      key.value = "";
      refresh();
      status.textContent = "设置已保存。";
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
      `模型 ${MODEL}，关闭思考，一次生成六问。${PRICE_DATE} 价格快照：输入 / 缓存 / 输出分别 ¥6.5 / 1.1 / 27 每百万 tokens。上限用于生成前估算，实际以供应商账单为准。`,
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
