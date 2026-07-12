import { marked } from "marked";
import { getLocaleID } from "../utils/locale";
import { getCache, saveCachePatch } from "./cache";
import { getItemTitle, identifyPaperFromItem } from "./identifier";
import {
  buildPaperURL,
  fetchKimiReading,
  fetchPaperMetadata,
  fetchRelatedPapers,
  resolvePaperByTitle,
} from "./papersCoolClient";
import type {
  CacheEntry,
  PaperMetadata,
  PaperReference,
  RelatedPaper,
  RelatedResult,
} from "./types";

const PANE_ID = "paperscool";
const HTML_NS = "http://www.w3.org/1999/xhtml";

export function registerPapersCoolItemPane() {
  unregisterPapersCoolItemPane();
  const icon = `chrome://${addon.data.config.addonRef}/content/icons/item-pane-icon.png`;

  Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID: addon.data.config.addonID,
    header: {
      l10nID: getLocaleID("item-section-head-text"),
      icon,
    },
    sidenav: {
      l10nID: getLocaleID("item-section-sidenav-tooltip"),
      icon,
    },
    onItemChange: ({ item, setEnabled }) => {
      setEnabled(Boolean(item?.isRegularItem?.()));
      return true;
    },
    onRender: ({ body }) => {
      ensureShell(body);
    },
    onAsyncRender: async ({ body, item, setSectionSummary }) => {
      if (!item) {
        return;
      }
      await renderItem(body, item, false, setSectionSummary);
    },
  });
}

export function unregisterPapersCoolItemPane() {
  Zotero.ItemPaneManager.unregisterSection(PANE_ID);
}

async function renderItem(
  body: HTMLElement,
  item: Zotero.Item,
  forceRefresh: boolean,
  setSectionSummary?: (summary: string) => void,
) {
  const token = Zotero.Utilities.randomString(8);
  body.dataset.pcpRenderToken = token;
  ensureShell(body, true);

  const state = getShellState(body);
  const isStale = () => body.dataset.pcpRenderToken !== token;
  const setStatus = (
    message: string,
    tone: "idle" | "ok" | "warn" = "idle",
  ) => {
    state.status.textContent = message;
    state.status.dataset.tone = tone;
    setSectionSummary?.(message);
  };

  state.refreshButton.addEventListener("click", () => {
    void renderItem(body, item, true, setSectionSummary);
  });

  try {
    setStatus("识别论文来源...");
    const resolved = await resolveReference(item, setStatus);
    if (isStale()) {
      return;
    }

    if (!resolved) {
      renderUnsupported(state);
      setStatus(
        "未找到 papers.cool 支持的 arXiv/OpenReview/venue 论文",
        "warn",
      );
      return;
    }

    const { reference } = resolved;
    let metadata = resolved.metadata;
    let cache = forceRefresh ? undefined : await getCache(reference);

    if (!metadata && cache?.metadata) {
      metadata = cache.metadata;
    }

    if (!metadata || forceRefresh || !metadata.keywords) {
      setStatus("读取 papers.cool 论文信息...");
      metadata = await fetchPaperMetadata(reference);
      await saveCachePatch(reference, {
        metadata,
        metadataFetchedAt: Date.now(),
      });
      cache = await getCache(reference);
    }

    if (isStale()) {
      return;
    }

    renderMetadata(state, reference, metadata);
    renderCachedContent(state, cache);
    setStatus(
      forceRefresh ? "正在刷新 KIMI 与 REL..." : "正在加载 KIMI 与 REL...",
    );

    const kimiPromise = loadKimi(
      reference,
      state,
      cache,
      forceRefresh,
      isStale,
    );
    const relatedPromise = loadRelated(
      reference,
      metadata,
      state,
      cache,
      forceRefresh,
      isStale,
    );
    const [kimiResult, relatedResult] = await Promise.all([
      kimiPromise,
      relatedPromise,
    ]);

    if (isStale()) {
      return;
    }

    setStatus(
      contentStatusMessage(kimiResult.ok, relatedResult.ok),
      kimiResult.ok && relatedResult.ok ? "ok" : "warn",
    );
  } catch (error) {
    ztoolkit.log("papers.cool item pane render failed", error);
    if (!isStale()) {
      renderError(state.kimiContainer, error);
      setStatus("papers.cool 加载失败", "warn");
    }
  }
}

async function resolveReference(
  item: Zotero.Item,
  setStatus: (message: string) => void,
) {
  const directReference = identifyPaperFromItem(item);
  if (directReference) {
    return { reference: directReference, metadata: undefined };
  }

  const title = getItemTitle(item);
  if (!title) {
    return null;
  }

  setStatus("未找到直接 ID，正在用标题搜索 papers.cool...");
  return resolvePaperByTitle(title);
}

async function loadKimi(
  reference: PaperReference,
  state: ShellState,
  cache: CacheEntry | undefined,
  forceRefresh: boolean,
  isStale: () => boolean,
): Promise<ContentLoadResult> {
  if (cache?.kimiHTML && !forceRefresh) {
    return { ok: true };
  }

  state.kimiContainer.textContent = "KIMI 解读加载中...";
  let lastRenderAt = 0;
  let kimiHTML: string;
  try {
    kimiHTML = await fetchKimiReading(reference, (partial) => {
      const now = Date.now();
      if (isStale() || !partial || now - lastRenderAt < 900) {
        return;
      }
      lastRenderAt = now;
      try {
        renderKimiContent(state.kimiContainer, partial, true);
      } catch (error) {
        ztoolkit.log("papers.cool KIMI streaming render failed", error);
      }
    });

    if (isStale()) {
      return { ok: true };
    }

    renderKimiContent(state.kimiContainer, kimiHTML);
  } catch (error) {
    ztoolkit.log("papers.cool KIMI load failed", error);
    if (!isStale()) {
      renderError(state.kimiContainer, error, "KIMI 加载失败");
    }
    return { ok: false };
  }

  try {
    await saveCachePatch(reference, {
      kimiHTML,
      kimiFetchedAt: Date.now(),
    });
  } catch (error) {
    ztoolkit.log("papers.cool KIMI cache save failed", error);
  }
  return { ok: true };
}

async function loadRelated(
  reference: PaperReference,
  metadata: PaperMetadata,
  state: ShellState,
  cache: CacheEntry | undefined,
  forceRefresh: boolean,
  isStale: () => boolean,
): Promise<ContentLoadResult> {
  if (cache?.related && !forceRefresh) {
    return { ok: true };
  }

  state.relatedContainer.textContent = "REL 相关论文加载中...";
  state.openRelatedButton.disabled = true;
  delete state.openRelatedButton.dataset.url;
  updateRelatedSummary(state, "加载中");
  let related: RelatedResult;
  try {
    related = await fetchRelatedPapers(metadata);
    if (isStale()) {
      return { ok: true };
    }

    renderRelated(state, related);
    state.openRelatedButton.disabled = false;
    state.openRelatedButton.dataset.url = related.url;
  } catch (error) {
    ztoolkit.log("papers.cool REL load failed", error);
    if (!isStale()) {
      renderError(state.relatedContainer, error, "REL 加载失败");
      updateRelatedSummary(state, "失败");
    }
    return { ok: false };
  }

  try {
    await saveCachePatch(reference, {
      related,
      relatedFetchedAt: Date.now(),
    });
  } catch (error) {
    ztoolkit.log("papers.cool REL cache save failed", error);
  }
  return { ok: true };
}

function ensureShell(body: HTMLElement, reset = false) {
  if (!reset && body.querySelector(".pcp-root")) {
    return;
  }

  body.classList.add("pcp-body");
  body.replaceChildren();

  const doc = ownerDocumentOf(body);
  const root = createHTML(doc, "div", "pcp-root");

  const toolbar = createHTML(doc, "div", "pcp-toolbar");
  const refresh = createButton(doc, "刷新", "pcp-refresh");
  const openPaper = createButton(doc, "打开论文页", "pcp-open-paper", true);
  const openRelated = createButton(doc, "打开 REL", "pcp-open-related", true);
  toolbar.append(refresh, openPaper, openRelated);

  const status = createHTML(doc, "div", "pcp-status");
  status.dataset.tone = "idle";
  status.textContent = "等待加载...";

  const meta = createHTML(doc, "div", "pcp-meta");

  const relatedSection = createHTML(
    doc,
    "details",
    "pcp-section pcp-related-details",
  );
  const relatedSummary = createHTML(doc, "summary", "pcp-related-summary-line");
  relatedSummary.textContent = "REL 相关论文";
  relatedSection.append(relatedSummary, createHTML(doc, "div", "pcp-related"));

  const kimiSection = createHTML(doc, "section", "pcp-section");
  kimiSection.append(
    createHeading(doc, "KIMI 解读"),
    createHTML(doc, "div", "pcp-kimi"),
  );

  root.append(toolbar, status, meta, relatedSection, kimiSection);
  body.append(root);
}

function getShellState(body: HTMLElement): ShellState {
  const state = {
    status: mustQuery<HTMLElement>(body, ".pcp-status"),
    meta: mustQuery<HTMLElement>(body, ".pcp-meta"),
    refreshButton: mustQuery<HTMLButtonElement>(body, ".pcp-refresh"),
    openPaperButton: mustQuery<HTMLButtonElement>(body, ".pcp-open-paper"),
    openRelatedButton: mustQuery<HTMLButtonElement>(body, ".pcp-open-related"),
    relatedSummary: mustQuery<HTMLElement>(body, ".pcp-related-summary-line"),
    kimiContainer: mustQuery<HTMLElement>(body, ".pcp-kimi"),
    relatedContainer: mustQuery<HTMLElement>(body, ".pcp-related"),
  };

  state.openPaperButton.addEventListener("click", () => {
    launchURL(state.openPaperButton.dataset.url);
  });
  state.openRelatedButton.addEventListener("click", () => {
    launchURL(state.openRelatedButton.dataset.url);
  });
  updateRelatedSummary(state);

  return state;
}

function renderMetadata(
  state: ShellState,
  reference: PaperReference,
  metadata: PaperMetadata,
) {
  state.openPaperButton.disabled = false;
  state.openPaperButton.dataset.url =
    metadata.paperURL || buildPaperURL(reference);

  state.meta.replaceChildren();
  const doc = ownerDocumentOf(state.meta);
  const title = doc.createElement("div");
  title.className = "pcp-title";
  title.textContent = metadata.title || reference.key;
  state.meta.append(title);

  const details = [
    `${reference.branch}: ${reference.key}`,
    metadata.kimiStars === undefined ? "" : `KIMI ${metadata.kimiStars}`,
    metadata.pdfStars === undefined ? "" : `PDF ${metadata.pdfStars}`,
    metadata.published || "",
  ].filter(Boolean);
  const detail = doc.createElement("div");
  detail.className = "pcp-detail";
  detail.textContent = details.join(" | ");
  state.meta.append(detail);

  if (metadata.keywords) {
    const keywords = doc.createElement("div");
    keywords.className = "pcp-keywords";
    keywords.textContent = `REL keywords: ${metadata.keywords}`;
    state.meta.append(keywords);
  }
}

function createHTML<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
) {
  const element = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (className) {
    element.className = className;
  }
  return element;
}

function createButton(
  doc: Document,
  label: string,
  className: string,
  disabled = false,
) {
  const button = createHTML(doc, "button", className);
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  return button;
}

function createHeading(doc: Document, label: string) {
  const heading = createHTML(doc, "h3");
  heading.textContent = label;
  return heading;
}

function renderCachedContent(state: ShellState, cache?: CacheEntry) {
  if (cache?.kimiHTML) {
    renderKimiContent(state.kimiContainer, cache.kimiHTML);
  }
  if (cache?.related) {
    renderRelated(state, cache.related);
    state.openRelatedButton.disabled = false;
    state.openRelatedButton.dataset.url = cache.related.url;
  }
}

function renderKimiHTML(
  container: HTMLElement,
  rawHTML: string,
  streaming = false,
) {
  const normalized = normalizeKimiHTML(rawHTML);
  const rendered = marked.parse(normalized, {
    async: false,
    gfm: true,
  }) as string;
  const doc = ownerDocumentOf(container);
  container.replaceChildren(createSanitizedFragment(rendered, doc));
  rewriteLinks(container);
  if (streaming) {
    const marker = doc.createElement("p");
    marker.className = "pcp-loading";
    marker.textContent = "生成中...";
    container.append(marker);
  }
}

function renderKimiContent(
  container: HTMLElement,
  rawHTML: string,
  streaming = false,
) {
  try {
    renderKimiHTML(container, rawHTML, streaming);
  } catch (error) {
    ztoolkit.log("papers.cool KIMI rich render failed", error);
    renderKimiTextFallback(container, rawHTML, streaming);
  }
}

function renderKimiTextFallback(
  container: HTMLElement,
  rawHTML: string,
  streaming = false,
) {
  container.replaceChildren();
  const doc = ownerDocumentOf(container);
  const pre = doc.createElement("pre");
  pre.className = "pcp-kimi-fallback";
  pre.textContent = rawHTML;
  container.append(pre);
  if (streaming) {
    const marker = doc.createElement("p");
    marker.className = "pcp-loading";
    marker.textContent = "生成中...";
    container.append(marker);
  }
}

function renderRelated(state: ShellState, related: RelatedResult) {
  const container = state.relatedContainer;
  container.replaceChildren();
  const doc = ownerDocumentOf(container);
  updateRelatedSummary(state, related.papers.length);
  if (!related.papers.length) {
    container.textContent = "暂无 REL 结果。";
    return;
  }

  const list = doc.createElement("ol");
  list.className = "pcp-related-list";
  for (const paper of related.papers.slice(0, 10)) {
    list.append(createRelatedItem(doc, paper));
  }
  container.append(list);
}

function updateRelatedSummary(
  state: ShellState,
  summary: string | number = state.relatedSummary.dataset.summary || "",
) {
  state.relatedSummary.dataset.summary = String(summary);
  const suffix = summary === "" ? "" : ` (${summary})`;
  state.relatedSummary.textContent = `REL 相关论文${suffix}`;
}

function createRelatedItem(doc: Document, paper: RelatedPaper) {
  const item = doc.createElement("li");
  const link = doc.createElement("a");
  link.className = "pcp-related-title";
  link.href = paper.paperURL;
  link.textContent = paper.title;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    launchURL(paper.paperURL);
  });
  item.append(link);

  const meta = doc.createElement("div");
  meta.className = "pcp-related-meta";
  meta.textContent = [
    paper.published,
    paper.subject,
    paper.kimiStars === undefined ? "" : `KIMI ${paper.kimiStars}`,
  ]
    .filter(Boolean)
    .join(" | ");
  item.append(meta);

  if (paper.summary) {
    const summary = doc.createElement("p");
    summary.className = "pcp-related-summary";
    summary.textContent = paper.summary;
    item.append(summary);
  }

  return item;
}

function renderUnsupported(state: ShellState) {
  state.meta.textContent =
    "这个条目没有可识别的 arXiv ID、papers.cool 链接或 OpenReview ID；也没有用标题在 papers.cool 搜到高置信匹配。";
  state.kimiContainer.textContent = "";
  state.relatedContainer.textContent = "";
}

function renderError(container: HTMLElement, error: unknown, prefix?: string) {
  const message = errorMessage(error);
  container.textContent = prefix ? `${prefix}: ${message}` : message;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const message = typeof record.message === "string" ? record.message : "";
    if (name || message) {
      return [name, message].filter(Boolean).join(": ");
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return "Unknown papers.cool error";
}

function contentStatusMessage(kimiOK: boolean, relatedOK: boolean) {
  if (kimiOK && relatedOK) {
    return "papers.cool 已加载";
  }
  if (kimiOK) {
    return "KIMI 已加载，REL 加载失败";
  }
  if (relatedOK) {
    return "REL 已加载，KIMI 加载失败";
  }
  return "KIMI 与 REL 加载失败";
}

function normalizeKimiHTML(text: string) {
  const urlRegex =
    /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#/%?=~_|!:,.;]*[-A-Z0-9+&@#/%=~_|])/gi;
  return text
    .replace(/^<div\s+class=["']faq-a["']\s*>\s*$/gim, "")
    .replace(/^<\/div>\s*$/gim, "")
    .replace(urlRegex, " $1 ")
    .replace(/---\n/g, "")
    .replace(/(-|\n)&gt;/g, "$1>")
    .replace(/&lt;(\/{0,1}[a-z]{2,4})&gt;/g, "<$1>");
}

function createSanitizedFragment(html: string, targetDoc: Document) {
  const parsedDoc = new DOMParser().parseFromString(
    `<main>${html}</main>`,
    "text/html",
  );
  const root = parsedDoc.querySelector("main");
  const fragment = targetDoc.createDocumentFragment();
  if (!root) {
    return fragment;
  }
  parsedDoc
    .querySelectorAll("script, style, iframe, object, embed, link, meta, form")
    .forEach((node: Element) => node.remove());
  parsedDoc.querySelectorAll("*").forEach((node: Element) => {
    for (const attr of Array.from(node.attributes) as Attr[]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (
        name.startsWith("on") ||
        name === "srcdoc" ||
        ((name === "href" || name === "src") && value.startsWith("javascript:"))
      ) {
        node.removeAttribute(attr.name);
      }
    }
  });
  for (const child of Array.from(root.childNodes)) {
    if (child) {
      fragment.append(targetDoc.importNode(child, true));
    }
  }
  return fragment;
}

function rewriteLinks(container: HTMLElement) {
  container.querySelectorAll("a[href]").forEach((anchor: Element) => {
    const link = anchor as HTMLAnchorElement;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      launchURL(link.href);
    });
  });
}

function launchURL(url?: string) {
  if (!url) {
    return;
  }
  if (typeof Zotero.launchURL === "function") {
    Zotero.launchURL(url);
    return;
  }
  ztoolkit.getGlobal("open")(url, "_blank");
}

function mustQuery<T extends Element>(root: ParentNode, selector: string) {
  const node = root.querySelector(selector);
  if (!node) {
    throw new Error(`Missing papers.cool pane node: ${selector}`);
  }
  return node as T;
}

function ownerDocumentOf(element: HTMLElement) {
  const doc = element.ownerDocument;
  if (!doc) {
    throw new Error("Missing ownerDocument for papers.cool pane element");
  }
  return doc;
}

interface ShellState {
  status: HTMLElement;
  meta: HTMLElement;
  refreshButton: HTMLButtonElement;
  openPaperButton: HTMLButtonElement;
  openRelatedButton: HTMLButtonElement;
  relatedSummary: HTMLElement;
  kimiContainer: HTMLElement;
  relatedContainer: HTMLElement;
}

interface ContentLoadResult {
  ok: boolean;
}
