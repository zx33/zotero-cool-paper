import { getLocaleID } from "../utils/locale";
import {
  extractLocalKeywords,
  keywordSearchTerms,
  localKeywordIDF,
  scoreKeywordMatches,
  type KeywordTextIndex,
  type LocalRelKeyword,
  type LocalRelMatch,
  type LocalRelMatchField,
} from "./localRelRanking";

const PANE_ID = "zoterocoolpaper-local-rel";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const MAX_RESULTS = 20;

export interface LocalRelResult {
  item: Zotero.Item;
  score: number;
  matches: LocalRelMatch[];
}

export function registerLocalRelItemPane() {
  unregisterLocalRelItemPane();
  const icon = `chrome://${addon.data.config.addonRef}/content/icons/local-rel-icon.svg`;

  Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID: addon.data.config.addonID,
    header: {
      l10nID: getLocaleID("local-rel-section-head-text"),
      icon,
    },
    sidenav: {
      l10nID: getLocaleID("local-rel-section-sidenav-tooltip"),
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
      await renderLocalRel(body, item, setSectionSummary);
    },
  });
}

export function unregisterLocalRelItemPane() {
  Zotero.ItemPaneManager.unregisterSection(PANE_ID);
}

async function renderLocalRel(
  body: HTMLElement,
  sourceItem: Zotero.Item,
  setSectionSummary?: (summary: string) => void,
) {
  const token = Zotero.Utilities.randomString(8);
  body.dataset.pcpLocalRenderToken = token;
  ensureShell(body, true);
  const state = getShellState(body);
  const isStale = () => body.dataset.pcpLocalRenderToken !== token;
  const setStatus = (
    message: string,
    tone: "idle" | "ok" | "warn" = "idle",
  ) => {
    state.status.textContent = message;
    state.status.dataset.tone = tone;
    setSectionSummary?.(message);
  };

  state.refreshButton.addEventListener("click", () => {
    void renderLocalRel(body, sourceItem, setSectionSummary);
  });

  try {
    setStatus("正在从 Zotero 条目提取本地关键词...");
    const keywords = extractLocalKeywords(itemTextIndex(sourceItem));
    renderKeywords(state, keywords);
    if (!keywords.length) {
      renderEmpty(state, "当前条目没有足够的标签、标题或摘要用于检索。");
      setStatus("当前条目没有可用关键词", "warn");
      return;
    }

    setStatus(`正在当前资料库中检索 ${keywords.length} 个关键词...`);
    const results = await searchLocalLibrary(sourceItem, keywords);
    if (isStale()) {
      return;
    }

    renderResults(state, results, setStatus);
    const message = results.length
      ? `找到 ${results.length} 篇本地相关论文`
      : "当前资料库中没有匹配论文";
    setStatus(message, results.length ? "ok" : "warn");
  } catch (error) {
    ztoolkit.log("Local REL item pane render failed", error);
    if (!isStale()) {
      renderEmpty(state, `Local REL 加载失败：${errorMessage(error)}`);
      setStatus("Local REL 加载失败", "warn");
    }
  }
}

async function searchLocalLibrary(
  sourceItem: Zotero.Item,
  keywords: LocalRelKeyword[],
): Promise<LocalRelResult[]> {
  const hitsByItemID = new Map<number, Map<string, LocalRelKeyword>>();
  const itemIDsByKeyword = new Map<string, Set<number>>();

  const searches = await Promise.all(
    keywords.flatMap((keyword) =>
      keywordSearchTerms(keyword).map(async (term) => {
        try {
          const search = new Zotero.Search({ libraryID: sourceItem.libraryID });
          search.addCondition("quicksearch-everything", "contains", term);
          return { keyword, term, ids: await search.search() };
        } catch (error) {
          ztoolkit.log(`Local REL search failed for keyword: ${term}`, error);
          return { keyword, term, ids: [] as number[] };
        }
      }),
    ),
  );

  for (const { keyword, ids } of searches) {
    for (const id of ids) {
      const item = regularParentItem(Zotero.Items.get(id));
      if (
        !item ||
        item.id === sourceItem.id ||
        item.libraryID !== sourceItem.libraryID ||
        item.deleted
      ) {
        continue;
      }
      const keywordItemIDs =
        itemIDsByKeyword.get(keyword.id) ?? new Set<number>();
      keywordItemIDs.add(item.id);
      itemIDsByKeyword.set(keyword.id, keywordItemIDs);

      const hits =
        hitsByItemID.get(item.id) ?? new Map<string, LocalRelKeyword>();
      hits.set(keyword.id, keyword);
      hitsByItemID.set(item.id, hits);
    }
  }

  const maximumDocumentFrequency = Math.max(
    1,
    ...[...itemIDsByKeyword.values()].map((itemIDs) => itemIDs.size),
  );
  const results: LocalRelResult[] = [];
  for (const [itemID, searchedKeywords] of hitsByItemID) {
    const item = Zotero.Items.get(itemID);
    if (!item?.isRegularItem?.()) {
      continue;
    }
    const weightedKeywords = [...searchedKeywords.values()].map((keyword) => ({
      keyword,
      idf: localKeywordIDF(
        itemIDsByKeyword.get(keyword.id)?.size ?? 0,
        maximumDocumentFrequency,
      ),
    }));
    const ranked = scoreKeywordMatches(itemTextIndex(item), weightedKeywords);
    if (ranked.qualifies) {
      results.push({ item, score: ranked.score, matches: ranked.matches });
    }
  }

  return results
    .sort(
      (a, b) =>
        b.score - a.score ||
        exactMatchCount(b) - exactMatchCount(a) ||
        itemYear(b.item) - itemYear(a.item) ||
        getField(a.item, "title").localeCompare(getField(b.item, "title")),
    )
    .slice(0, MAX_RESULTS);
}

function regularParentItem(item: Zotero.Item | false | undefined) {
  if (!item) {
    return undefined;
  }
  if (item.isRegularItem?.()) {
    return item;
  }
  if (item.isAttachment?.() && item.parentItemID) {
    const parent = Zotero.Items.get(item.parentItemID);
    return parent?.isRegularItem?.() ? parent : undefined;
  }
  return undefined;
}

function itemTextIndex(item: Zotero.Item): KeywordTextIndex {
  let tags: string[] = [];
  try {
    tags = item
      .getTags()
      .map((entry) => (typeof entry.tag === "string" ? entry.tag : ""))
      .filter(Boolean);
  } catch (error) {
    ztoolkit.log("Local REL failed to read item tags", error);
  }
  return {
    title: getField(item, "title"),
    abstract: getField(item, "abstractNote"),
    tags,
  };
}

function ensureShell(body: HTMLElement, reset = false) {
  if (!reset && body.querySelector(".pcp-local-root")) {
    return;
  }
  body.classList.add("pcp-body", "pcp-local-body");
  body.replaceChildren();

  const doc = ownerDocumentOf(body);
  const root = createHTML(doc, "div", "pcp-local-root");
  const toolbar = createHTML(doc, "div", "pcp-toolbar pcp-local-toolbar");
  toolbar.append(createButton(doc, "刷新", "pcp-local-refresh"));

  const hint = createHTML(doc, "div", "pcp-local-hint");
  hint.textContent =
    "仅使用当前 Zotero 文献库。双击结果可打开本地 PDF；没有 PDF 时会定位到条目。";
  const status = createHTML(doc, "div", "pcp-status pcp-local-status");
  status.dataset.tone = "idle";
  status.textContent = "等待加载...";
  const keywords = createHTML(doc, "div", "pcp-local-keywords");
  const results = createHTML(doc, "div", "pcp-local-results");

  root.append(toolbar, hint, status, keywords, results);
  body.append(root);
}

function getShellState(body: HTMLElement): LocalRelShellState {
  return {
    refreshButton: mustQuery<HTMLButtonElement>(body, ".pcp-local-refresh"),
    status: mustQuery<HTMLElement>(body, ".pcp-local-status"),
    keywords: mustQuery<HTMLElement>(body, ".pcp-local-keywords"),
    results: mustQuery<HTMLElement>(body, ".pcp-local-results"),
  };
}

function renderKeywords(
  state: LocalRelShellState,
  keywords: LocalRelKeyword[],
) {
  state.keywords.replaceChildren();
  if (!keywords.length) {
    return;
  }
  const doc = ownerDocumentOf(state.keywords);
  const label = createHTML(doc, "span", "pcp-local-keyword-label");
  label.textContent = "本地检索关键词";
  state.keywords.append(label);
  for (const keyword of keywords) {
    const chip = createHTML(doc, "span", "pcp-local-keyword");
    chip.dataset.tier = keyword.tier;
    chip.textContent = keyword.aliases.length
      ? `${keyword.label} (${keyword.aliases.join("/")})`
      : keyword.label;
    chip.title = keywordTierLabel(keyword.tier);
    state.keywords.append(chip);
  }
}

function renderResults(
  state: LocalRelShellState,
  results: LocalRelResult[],
  setStatus: (message: string, tone?: "idle" | "ok" | "warn") => void,
) {
  state.results.replaceChildren();
  if (!results.length) {
    renderEmpty(state, "没有找到达到主题相关性门槛的本地论文。");
    return;
  }

  const doc = ownerDocumentOf(state.results);
  for (const result of results) {
    const row = createResultRow(doc, result);
    const open = async () => {
      row.dataset.opening = "true";
      try {
        const openedReader = await openLocalItem(result.item);
        setStatus(
          openedReader
            ? "已打开本地 PDF"
            : "该条目没有本地 PDF，已在 Zotero 中定位",
          openedReader ? "ok" : "warn",
        );
      } catch (error) {
        ztoolkit.log("Local REL failed to open item", error);
        setStatus(`打开失败：${errorMessage(error)}`, "warn");
      } finally {
        delete row.dataset.opening;
      }
    };
    row.addEventListener("dblclick", (event) => {
      event.preventDefault();
      void open();
    });
    row.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") {
        event.preventDefault();
        void open();
      }
    });
    row.addEventListener("click", () => {
      let selected = state.results.querySelector(
        ".pcp-local-result[data-selected]",
      );
      while (selected) {
        selected.removeAttribute("data-selected");
        selected = state.results.querySelector(
          ".pcp-local-result[data-selected]",
        );
      }
      row.dataset.selected = "true";
    });
    state.results.append(row);
  }
}

function createResultRow(doc: Document, result: LocalRelResult) {
  const row = createHTML(doc, "div", "pcp-local-result");
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.setAttribute("aria-label", `打开 ${getField(result.item, "title")}`);

  const title = createHTML(doc, "div", "pcp-local-result-title");
  title.textContent = getField(result.item, "title") || "未命名条目";
  const meta = createHTML(doc, "div", "pcp-local-result-meta");
  meta.textContent = itemMeta(result.item);
  const matches = createHTML(doc, "div", "pcp-local-result-matches");
  matches.textContent = result.matches
    .filter((match) => match.exactMetadataMatch)
    .slice(0, 8)
    .map((match) => `${match.keyword.label} · ${matchFieldLabel(match.field)}`)
    .join(" / ");
  row.append(title);
  if (meta.textContent) {
    row.append(meta);
  }
  row.append(matches);
  return row;
}

async function openLocalItem(item: Zotero.Item) {
  const reader = (
    Zotero as typeof Zotero & {
      Reader?: { open: (itemID: number) => Promise<unknown> };
    }
  ).Reader;

  if (reader?.open) {
    for (const attachmentID of item.getAttachments()) {
      const attachment = Zotero.Items.get(attachmentID) as
        | (Zotero.Item & {
            attachmentContentType?: string;
            fileExists?: () => Promise<boolean>;
            isPDFAttachment?: () => boolean;
          })
        | false;
      if (!attachment) {
        continue;
      }
      const isPDF =
        attachment.isPDFAttachment?.() ||
        attachment.attachmentContentType === "application/pdf";
      if (!isPDF) {
        continue;
      }
      const exists = attachment.fileExists
        ? await attachment.fileExists()
        : true;
      if (exists) {
        await reader.open(attachment.id);
        return true;
      }
    }
  }

  const win = Zotero.getMainWindow();
  await win.ZoteroPane.selectItem(item.id);
  win.Zotero_Tabs.select("zotero-pane");
  win.focus();
  return false;
}

function renderEmpty(state: LocalRelShellState, message: string) {
  state.results.replaceChildren();
  const empty = createHTML(
    ownerDocumentOf(state.results),
    "div",
    "pcp-local-empty",
  );
  empty.textContent = message;
  state.results.append(empty);
}

function itemMeta(item: Zotero.Item) {
  const creators = (() => {
    try {
      return item
        .getCreators()
        .slice(0, 3)
        .map((creator) => creator.lastName || creator.firstName)
        .filter(Boolean)
        .join(", ");
    } catch {
      return "";
    }
  })();
  return [
    creators,
    String(itemYear(item) || ""),
    getField(item, "publicationTitle"),
  ]
    .filter(Boolean)
    .join(" · ");
}

function itemYear(item: Zotero.Item) {
  const match = getField(item, "date").match(/\b(?:18|19|20|21)\d{2}\b/);
  return match ? Number(match[0]) : 0;
}

function exactMatchCount(result: LocalRelResult) {
  return result.matches.filter((match) => match.exactMetadataMatch).length;
}

function matchFieldLabel(field: LocalRelMatchField) {
  return {
    title: "标题",
    tag: "标签",
    abstract: "摘要",
    fulltext: "全文/其他字段",
  }[field];
}

function keywordTierLabel(tier: LocalRelKeyword["tier"]) {
  return {
    core: "核心短语或实体",
    domain: "领域关键词",
    supporting: "辅助关键词",
  }[tier];
}

function getField(item: Zotero.Item, field: string) {
  try {
    return String(item.getField(field as never) || "");
  } catch {
    return "";
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

function createButton(doc: Document, label: string, className: string) {
  const button = createHTML(doc, "button", className);
  button.type = "button";
  button.textContent = label;
  return button;
}

function mustQuery<T extends Element>(root: ParentNode, selector: string) {
  const node = root.querySelector(selector);
  if (!node) {
    throw new Error(`Missing Local REL pane node: ${selector}`);
  }
  return node as T;
}

function ownerDocumentOf(element: HTMLElement) {
  const doc = element.ownerDocument;
  if (!doc) {
    throw new Error("Missing ownerDocument for Local REL pane element");
  }
  return doc;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "未知错误";
}

interface LocalRelShellState {
  refreshButton: HTMLButtonElement;
  status: HTMLElement;
  keywords: HTMLElement;
  results: HTMLElement;
}
