import type { PaperReference } from "./types";

const PAPERS_COOL_URL_RE =
  /papers\.cool\/(arxiv|venue)\/(?!search\b|kimi\b)([^?#\s]+)/i;
const ARXIV_RE =
  /(?:arxiv(?::[ \t]*|[ \t]+id(?:[ \t]*:[ \t]*|[ \t]+))|arxiv\.org\/(?:abs|pdf)\/|10\.48550\/arxiv\.)([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/gi;
const BARE_ARXIV_RE =
  /^\s*([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?\s*$/i;
const MODERN_ARXIV_ID_RE = /^\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}$/;
const LEGACY_ARXIV_ID_RE = /^[a-z-]+\/\d{7}$/i;
const OPENREVIEW_URL_RE =
  /openreview\.net\/(?:forum|pdf)\?id=([A-Za-z0-9_-]+)/i;
const OPENREVIEW_KEY_RE = /\b([A-Za-z0-9_-]{6,})@OpenReview\b/;

export function identifyPaperFromItem(
  item: Zotero.Item,
): PaperReference | null {
  const { text, bareArxivCandidates } = collectItemSignals(item);

  const papersCoolMatch = text.match(PAPERS_COOL_URL_RE);
  if (papersCoolMatch) {
    return {
      branch: papersCoolMatch[1].toLowerCase() as PaperReference["branch"],
      key: decodeURIComponent(papersCoolMatch[2]),
      source: "papers.cool-url",
    };
  }

  const arxivKey =
    findExplicitArxivKey(text) ?? findBareArxivKey(bareArxivCandidates);
  if (arxivKey) {
    return {
      branch: "arxiv",
      key: arxivKey,
      source: "arxiv",
    };
  }

  const openReviewMatch =
    text.match(OPENREVIEW_URL_RE) ?? text.match(OPENREVIEW_KEY_RE);
  if (openReviewMatch) {
    return {
      branch: "venue",
      key: `${openReviewMatch[1]}@OpenReview`,
      source: "openreview",
    };
  }

  return null;
}

export function getItemTitle(item: Zotero.Item) {
  return getField(item, "title");
}

function collectItemSignals(item: Zotero.Item) {
  const archive = getField(item, "archive");
  const archiveLocation = getField(item, "archiveLocation");
  const extra = getField(item, "extra");
  const values = [
    getField(item, "title"),
    getField(item, "url"),
    getField(item, "DOI"),
    extra,
    archive,
    archiveLocation,
    getField(item, "libraryCatalog"),
  ];
  const bareArxivCandidates = [
    archive,
    archiveLocation,
    ...extra.split(/\r?\n/),
  ];

  try {
    for (const attachmentID of item.getAttachments()) {
      const attachment = Zotero.Items.get(attachmentID);
      const attachmentTitle = getField(attachment, "title");
      values.push(attachmentTitle);
      values.push(getField(attachment, "url"));
      bareArxivCandidates.push(attachmentTitle);
    }
  } catch (error) {
    ztoolkit.log("Failed to inspect Zotero item attachments", error);
  }

  return {
    text: values.filter(Boolean).join("\n"),
    bareArxivCandidates: bareArxivCandidates.filter(Boolean),
  };
}

function findExplicitArxivKey(text: string) {
  for (const match of text.matchAll(ARXIV_RE)) {
    if (isValidArxivKey(match[1])) {
      return match[1];
    }
  }
  return undefined;
}

function findBareArxivKey(candidates: string[]) {
  for (const candidate of candidates) {
    const match = candidate.match(BARE_ARXIV_RE);
    if (match && isValidArxivKey(match[1])) {
      return match[1];
    }
  }
  return undefined;
}

function isValidArxivKey(key: string) {
  return MODERN_ARXIV_ID_RE.test(key) || LEGACY_ARXIV_ID_RE.test(key);
}

function getField(item: Zotero.Item, field: string) {
  try {
    return String(item.getField(field as never) || "");
  } catch {
    return "";
  }
}
