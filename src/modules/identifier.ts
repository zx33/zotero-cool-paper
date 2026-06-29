import type { PaperReference } from "./types";

const PAPERS_COOL_URL_RE =
  /papers\.cool\/(arxiv|venue)\/(?!search\b|kimi\b)([^?#\s]+)/i;
const ARXIV_RE =
  /(?:arxiv:|arxiv\s+id[:\s]*|arxiv\.org\/(?:abs|pdf)\/|10\.48550\/arxiv\.)([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i;
const LOOSE_ARXIV_RE = /\b(\d{4}\.\d{4,5})(?:v\d+)?\b/;
const OPENREVIEW_URL_RE =
  /openreview\.net\/(?:forum|pdf)\?id=([A-Za-z0-9_-]+)/i;
const OPENREVIEW_KEY_RE = /\b([A-Za-z0-9_-]{6,})@OpenReview\b/;

export function identifyPaperFromItem(
  item: Zotero.Item,
): PaperReference | null {
  const text = collectItemText(item);

  const papersCoolMatch = text.match(PAPERS_COOL_URL_RE);
  if (papersCoolMatch) {
    return {
      branch: papersCoolMatch[1].toLowerCase() as PaperReference["branch"],
      key: decodeURIComponent(papersCoolMatch[2]),
      source: "papers.cool-url",
    };
  }

  const arxivMatch = text.match(ARXIV_RE) ?? text.match(LOOSE_ARXIV_RE);
  if (arxivMatch) {
    return {
      branch: "arxiv",
      key: arxivMatch[1],
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

function collectItemText(item: Zotero.Item) {
  const values = [
    getField(item, "title"),
    getField(item, "url"),
    getField(item, "DOI"),
    getField(item, "extra"),
    getField(item, "archive"),
    getField(item, "archiveLocation"),
    getField(item, "libraryCatalog"),
  ];

  try {
    for (const attachmentID of item.getAttachments()) {
      const attachment = Zotero.Items.get(attachmentID);
      values.push(getField(attachment, "title"));
      values.push(getField(attachment, "url"));
    }
  } catch (error) {
    ztoolkit.log("Failed to inspect Zotero item attachments", error);
  }

  return values.filter(Boolean).join("\n");
}

function getField(item: Zotero.Item, field: string) {
  try {
    return String(item.getField(field as never) || "");
  } catch {
    return "";
  }
}
