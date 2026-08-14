import type {
  PaperMetadata,
  PaperReference,
  PapersCoolBranch,
  RelatedPaper,
  RelatedResult,
  ResolvedPaper,
} from "./types";

const BASE_URL = "https://papers.cool";
export const TITLE_MATCH_THRESHOLD = 0.68;
const PAPER_DOM = {
  list: [".papers", "[data-paper-list]"],
  paper: [".paper", "[data-paper-id]"],
  titleLink: [
    ".title-link",
    "[data-role='paper-title']",
    "h2 a[href]",
    "h3 a[href]",
  ],
  pdfLink: [".title-pdf", "[data-role='paper-pdf']"],
  authors: [".authors", "[data-role='paper-authors']"],
  summary: [".summary", "[data-role='paper-summary']"],
  subjects: [".subjects", "[data-role='paper-subjects']"],
  date: [".date", "[data-role='paper-date']"],
  kimiStars: [".title-kimi sup", "[data-role='kimi-stars']"],
  pdfStars: [".title-pdf sup", "[data-role='pdf-stars']"],
  empty: [".no-results", ".empty-results", "[data-empty-results]"],
} as const;

export async function fetchPaperMetadata(
  reference: PaperReference,
): Promise<PaperMetadata> {
  const html = await requestText("GET", buildPaperURL(reference));
  const metadata = parsePaperMetadataHTML(html, reference);
  if (!metadata.title) {
    throw new Error("papers.cool did not return a paper detail page");
  }
  return metadata;
}

export async function fetchKimiReading(
  reference: PaperReference,
  onProgress?: (partialHTML: string) => void,
) {
  const text = await requestText(
    "POST",
    buildKimiURL(reference),
    onProgress,
    240000,
  );
  if (!text.trim()) {
    throw new Error("papers.cool returned empty KIMI content");
  }
  return text;
}

export async function fetchRelatedPapers(
  metadata: PaperMetadata,
): Promise<RelatedResult> {
  if (!metadata.keywords) {
    throw new Error("papers.cool did not provide REL keywords for this paper");
  }

  const url = buildRelatedURL(metadata.branch, metadata.keywords);
  const html = await requestText("GET", url);
  const papers = parsePaperListHTML(html, metadata.branch).filter(
    (paper) => paper.key !== metadata.key,
  );
  return { url, papers };
}

export async function resolvePaperByTitle(
  title: string,
): Promise<ResolvedPaper | null> {
  const cleanTitle = title.trim();
  if (!cleanTitle) {
    return null;
  }

  const branches = ["arxiv", "venue"] as const;
  const results = await Promise.allSettled(
    branches.map(async (branch) => {
      const url = buildSearchURL(branch, cleanTitle);
      const html = await requestText("GET", url);
      return parsePaperListHTML(html, branch);
    }),
  );

  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [{ branch: branches[index], reason: result.reason }]
      : [],
  );
  if (failures.length === branches.length) {
    const details = failures
      .map(({ branch, reason }) => `${branch}: ${errorMessage(reason)}`)
      .join("; ");
    throw new Error(
      `papers.cool title search failed for every branch: ${details}`,
    );
  }

  const candidates = results
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .map((metadata) => ({
      metadata,
      score: titleScore(cleanTitle, metadata.title),
    }))
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best || best.score < TITLE_MATCH_THRESHOLD) {
    return null;
  }

  return {
    reference: {
      branch: best.metadata.branch,
      key: best.metadata.key,
      source: "title-search",
    },
    metadata: best.metadata,
  };
}

export function buildPaperURL(
  reference: Pick<PaperReference, "branch" | "key">,
) {
  return `${BASE_URL}/${reference.branch}/${encodePath(reference.key)}`;
}

export function buildKimiURL(
  reference: Pick<PaperReference, "branch" | "key">,
) {
  const url = new URL(`/${reference.branch}/kimi`, BASE_URL);
  url.searchParams.set("paper", reference.key);
  return url.href;
}

export function buildRelatedURL(branch: PapersCoolBranch, keywords: string) {
  const url = new URL(`/${branch}/search`, BASE_URL);
  url.searchParams.set("query", keywords);
  applySupportedSearchParams(url, branch, { timeSort: true });
  return url.href;
}

function buildSearchURL(branch: PapersCoolBranch, title: string) {
  const url = new URL(`/${branch}/search`, BASE_URL);
  url.searchParams.set("highlight", "1");
  url.searchParams.set("query", title);
  applySupportedSearchParams(url, branch, { timeSort: true });
  url.searchParams.set("show", "5");
  return url.href;
}

function applySupportedSearchParams(
  url: URL,
  branch: PapersCoolBranch,
  options: { timeSort?: boolean },
) {
  // papers.cool venue search currently returns HTTP 500 when sort=0 is present.
  if (options.timeSort && branch === "arxiv") {
    url.searchParams.set("sort", "0");
  }
}

function requestText(
  method: "GET" | "POST",
  url: string,
  onProgress?: (partialText: string) => void,
  timeout = 45000,
) {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.timeout = timeout;
    xhr.setRequestHeader("Accept", "text/html, text/markdown, text/plain, */*");
    xhr.onprogress = () => {
      if (onProgress && xhr.responseText) {
        onProgress(xhr.responseText);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText ?? "");
      } else {
        reject(new Error(`papers.cool request failed: ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("papers.cool network request failed"));
    xhr.ontimeout = () => reject(new Error("papers.cool request timed out"));
    xhr.send();
  });
}

function parseHTML(html: string) {
  return new DOMParser().parseFromString(html, "text/html");
}

export function parsePaperMetadataHTML(
  html: string,
  reference: PaperReference,
) {
  return parseMetadataDocument(parseHTML(html), reference);
}

export function parsePaperListHTML(html: string, branch: PapersCoolBranch) {
  return parsePaperList(parseHTML(html), branch);
}

function parseMetadataDocument(
  doc: Document,
  reference: PaperReference,
): PaperMetadata {
  const paper = firstPaperElement(doc);
  const key = paperKey(paper) || reference.key;
  const branch = reference.branch;
  const base = parsePaperElement(paper, branch);

  return {
    branch,
    key,
    title:
      textByID(doc, `title-${key}`) ||
      metaContent(doc, "citation_title") ||
      base?.title,
    authors:
      cleanLabel(textByID(doc, `authors-${key}`)) ||
      metaContent(doc, "citation_authors") ||
      base?.authors,
    summary:
      textByID(doc, `summary-${key}`) ||
      metaContent(doc, "citation_abstract") ||
      base?.summary,
    subject: cleanLabel(textByID(doc, `subjects-${key}`)) || base?.subject,
    published:
      cleanLabel(textByID(doc, `date-${key}`)) ||
      metaContent(doc, "citation_date") ||
      metaContent(doc, "citation_year") ||
      base?.published,
    keywords: paperKeywords(paper) || base?.keywords,
    paperURL:
      absoluteURL(
        (doc.getElementById(`title-${key}`) as HTMLAnchorElement | null)?.href,
      ) || buildPaperURL({ branch, key }),
    pdfURL:
      (doc.getElementById(`pdf-${key}`) as HTMLElement | null)?.getAttribute(
        "data",
      ) ||
      metaContent(doc, "citation_pdf_url") ||
      base?.pdfURL,
    kimiStars:
      numberByID(doc, `kimi-stars-${key}`) ?? base?.kimiStars ?? undefined,
    pdfStars:
      numberByID(doc, `pdf-stars-${key}`) ?? base?.pdfStars ?? undefined,
  };
}

function parsePaperList(doc: Document, branch: PapersCoolBranch) {
  const list = queryFirst<HTMLElement>(doc, PAPER_DOM.list);
  if (!list) {
    throw new Error("papers.cool search page is missing its paper list");
  }

  const paperElements = queryAll<HTMLElement>(list, PAPER_DOM.paper);
  if (!paperElements.length) {
    if (isKnownEmptyResult(doc, list)) {
      return [];
    }
    throw new Error("papers.cool paper list has an unrecognized structure");
  }

  const papers = paperElements
    .map((paper) => parsePaperElement(paper as HTMLElement, branch))
    .filter(Boolean) as RelatedPaper[];
  if (!papers.length) {
    throw new Error("papers.cool paper entries could not be parsed");
  }
  return papers;
}

function parsePaperElement(
  paper: HTMLElement | null,
  branch: PapersCoolBranch,
): RelatedPaper | null {
  const key = paperKey(paper);
  if (!paper || !key) {
    return null;
  }

  const titleLink = queryFirst<HTMLAnchorElement>(paper, PAPER_DOM.titleLink);
  const pdfLink = queryFirst<HTMLElement>(paper, PAPER_DOM.pdfLink);
  const title = cleanWhitespace(titleLink?.textContent);
  if (!title) {
    return null;
  }

  return {
    branch,
    key,
    title,
    authors: cleanLabel(
      cleanWhitespace(queryFirst(paper, PAPER_DOM.authors)?.textContent),
    ),
    summary: cleanWhitespace(queryFirst(paper, PAPER_DOM.summary)?.textContent),
    subject: cleanLabel(
      cleanWhitespace(queryFirst(paper, PAPER_DOM.subjects)?.textContent),
    ),
    published: cleanLabel(
      cleanWhitespace(queryFirst(paper, PAPER_DOM.date)?.textContent),
    ),
    keywords: paperKeywords(paper),
    paperURL:
      absoluteURL(titleLink?.getAttribute("href")) ||
      buildPaperURL({
        branch,
        key,
      }),
    pdfURL: elementURL(pdfLink),
    kimiStars: numberFromText(
      queryFirst(paper, PAPER_DOM.kimiStars)?.textContent,
    ),
    pdfStars: numberFromText(
      queryFirst(paper, PAPER_DOM.pdfStars)?.textContent,
    ),
  };
}

function firstPaperElement(doc: Document) {
  const list = queryFirst<HTMLElement>(doc, PAPER_DOM.list);
  return queryFirst<HTMLElement>(list ?? doc, PAPER_DOM.paper);
}

function paperKey(paper: HTMLElement | null) {
  return paper?.id || paper?.getAttribute("data-paper-id") || undefined;
}

function paperKeywords(paper: HTMLElement | null) {
  return (
    paper?.getAttribute("keywords") ||
    paper?.getAttribute("data-keywords") ||
    undefined
  );
}

function elementURL(element: HTMLElement | null) {
  return (
    element?.getAttribute("data") ||
    element?.getAttribute("data-url") ||
    absoluteURL(element?.getAttribute("href"))
  );
}

function isKnownEmptyResult(doc: Document, list: HTMLElement) {
  return Boolean(
    queryFirst(list, PAPER_DOM.empty) ||
    /\btotal\s*:\s*0\b/i.test(doc.body?.textContent ?? ""),
  );
}

function queryFirst<T extends Element>(
  root: ParentNode,
  selectors: readonly string[],
) {
  for (const selector of selectors) {
    const match = root.querySelector(selector) as T | null;
    if (match) {
      return match;
    }
  }
  return null;
}

function queryAll<T extends Element>(
  root: ParentNode,
  selectors: readonly string[],
) {
  return Array.from(root.querySelectorAll(selectors.join(", "))) as T[];
}

export function titleScore(target: string, candidate: string) {
  const a = normalizeTitle(target);
  const b = normalizeTitle(candidate);
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  if (a.includes(b) || b.includes(a)) {
    return 0.92;
  }

  const aWords = new Set(a.split(" ").filter((word) => word.length > 2));
  const bWords = new Set(b.split(" ").filter((word) => word.length > 2));
  const intersection = Array.from(aWords).filter((word) => bWords.has(word));
  const union = new Set([...aWords, ...bWords]);
  return union.size ? intersection.length / union.size : 0;
}

function normalizeTitle(title: string) {
  return title
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function textByID(doc: Document, id: string) {
  return cleanWhitespace(doc.getElementById(id)?.textContent);
}

function numberByID(doc: Document, id: string) {
  return numberFromText(doc.getElementById(id)?.textContent);
}

function numberFromText(value?: string | null) {
  const text = cleanWhitespace(value);
  if (!text) {
    return undefined;
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

function metaContent(doc: Document, name: string) {
  return cleanWhitespace(
    doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content"),
  );
}

function cleanLabel(value?: string) {
  return value
    ?.replace(/^(authors?|subjects?|publish|subject|author)\s*:\s*/i, "")
    .trim();
}

function cleanWhitespace(value?: string | null) {
  return value?.replace(/\s+/g, " ").trim() || undefined;
}

function absoluteURL(href?: string | null) {
  if (!href) {
    return undefined;
  }
  try {
    return new URL(href, BASE_URL).href;
  } catch {
    return undefined;
  }
}

function encodePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}
