import type {
  PaperMetadata,
  PaperReference,
  PapersCoolBranch,
  RelatedPaper,
  RelatedResult,
  ResolvedPaper,
} from "./types";

const BASE_URL = "https://papers.cool";

export async function fetchPaperMetadata(
  reference: PaperReference,
): Promise<PaperMetadata> {
  const html = await requestText("GET", buildPaperURL(reference));
  const doc = parseHTML(html);
  const metadata = parseMetadataDocument(doc, reference);
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
  const doc = parseHTML(html);
  const papers = parsePaperList(doc, metadata.branch).filter(
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

  const results = await Promise.allSettled(
    (["arxiv", "venue"] as const).map(async (branch) => {
      const url = buildSearchURL(branch, cleanTitle);
      const html = await requestText("GET", url);
      return parsePaperList(parseHTML(html), branch);
    }),
  );

  const candidates = results
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .map((metadata) => ({
      metadata,
      score: titleScore(cleanTitle, metadata.title),
    }))
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best || best.score < 0.68) {
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

function parseMetadataDocument(
  doc: Document,
  reference: PaperReference,
): PaperMetadata {
  const paper = doc.querySelector(".paper") as HTMLElement | null;
  const key = paper?.id || reference.key;
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
    keywords: paper?.getAttribute("keywords") || base?.keywords,
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
  return Array.from(doc.querySelectorAll(".paper"))
    .map((paper) => parsePaperElement(paper as HTMLElement, branch))
    .filter(Boolean) as RelatedPaper[];
}

function parsePaperElement(
  paper: HTMLElement | null,
  branch: PapersCoolBranch,
): RelatedPaper | null {
  if (!paper?.id) {
    return null;
  }

  const titleLink = paper.querySelector(
    ".title-link",
  ) as HTMLAnchorElement | null;
  const pdfLink = paper.querySelector(".title-pdf") as HTMLElement | null;
  const title = cleanWhitespace(titleLink?.textContent);
  if (!title) {
    return null;
  }

  return {
    branch,
    key: paper.id,
    title,
    authors: cleanLabel(
      cleanWhitespace(paper.querySelector(".authors")?.textContent),
    ),
    summary: cleanWhitespace(paper.querySelector(".summary")?.textContent),
    subject: cleanLabel(
      cleanWhitespace(paper.querySelector(".subjects")?.textContent),
    ),
    published: cleanLabel(
      cleanWhitespace(paper.querySelector(".date")?.textContent),
    ),
    keywords: paper.getAttribute("keywords") || undefined,
    paperURL:
      absoluteURL(titleLink?.getAttribute("href")) ||
      buildPaperURL({
        branch,
        key: paper.id,
      }),
    pdfURL: pdfLink?.getAttribute("data") || undefined,
    kimiStars: numberFromText(
      paper.querySelector(".title-kimi sup")?.textContent,
    ),
    pdfStars: numberFromText(
      paper.querySelector(".title-pdf sup")?.textContent,
    ),
  };
}

function titleScore(target: string, candidate: string) {
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
