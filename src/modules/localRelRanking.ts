const MAX_KEYWORDS = 12;
const MAX_TAG_KEYWORDS = 4;
const MAX_CORE_PHRASES = 3;
const MIN_RELEVANCE_SCORE = 8;

const STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "against",
  "also",
  "among",
  "an",
  "and",
  "are",
  "as",
  "at",
  "based",
  "before",
  "between",
  "both",
  "but",
  "by",
  "could",
  "dedicated",
  "during",
  "each",
  "for",
  "from",
  "have",
  "in",
  "into",
  "is",
  "its",
  "more",
  "most",
  "not",
  "of",
  "on",
  "or",
  "other",
  "our",
  "paper",
  "show",
  "such",
  "than",
  "that",
  "the",
  "their",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "toward",
  "using",
  "various",
  "was",
  "were",
  "which",
  "while",
  "with",
  "within",
  "without",
  "would",
]);

const BROAD_SINGLE_TERMS = new Set([
  "analysis",
  "approach",
  "benchmark",
  "data",
  "framework",
  "graph",
  "knowledge",
  "learning",
  "method",
  "mining",
  "model",
  "network",
  "neural",
  "prediction",
  "result",
  "study",
  "system",
]);

const WORKFLOW_TAGS = new Set([
  "done",
  "favorite",
  "favourite",
  "important",
  "needs review",
  "needs-review",
  "read later",
  "read-later",
  "reviewed",
  "starred",
  "to do",
  "to read",
  "to-do",
  "to-read",
  "todo",
  "unread",
  "完成",
  "已读",
  "待办",
  "待读",
  "待读论文",
  "收藏",
  "稍后阅读",
  "重要",
]);

export type LocalRelKeywordTier = "core" | "domain" | "supporting";
export type LocalRelMatchField = "title" | "tag" | "abstract" | "fulltext";

export interface KeywordTextIndex {
  title: string;
  abstract: string;
  tags: string[];
}

export interface LocalRelKeyword {
  id: string;
  label: string;
  aliases: string[];
  tier: LocalRelKeywordTier;
  kind: "entity" | "phrase" | "term";
}

export interface WeightedLocalRelKeyword {
  keyword: LocalRelKeyword;
  idf: number;
}

export interface LocalRelMatch {
  keyword: LocalRelKeyword;
  field: LocalRelMatchField;
  weight: number;
  exactMetadataMatch: boolean;
}

export interface LocalRelCandidateScore {
  score: number;
  matches: LocalRelMatch[];
  qualifies: boolean;
}

export function extractLocalKeywords(index: KeywordTextIndex) {
  const keywords: LocalRelKeyword[] = [];
  const seenTerms = new Set<string>();
  const corePhraseComponents = new Set<string>();
  const sourceTokens = tokenize(
    [index.title, index.abstract, ...index.tags].join(" "),
  );

  const addKeyword = (
    label: string,
    tier: LocalRelKeywordTier,
    kind: LocalRelKeyword["kind"],
    aliases: string[] = [],
  ) => {
    const normalized = normalizeKeywordText(label);
    if (!normalized || seenTerms.has(normalized)) {
      return false;
    }
    const normalizedAliases = aliases
      .map((alias) => alias.trim())
      .filter((alias) => {
        const key = normalizeKeywordText(alias);
        return key && key !== normalized && !seenTerms.has(key);
      });
    keywords.push({
      id: normalized,
      label: label.trim(),
      aliases: normalizedAliases,
      tier,
      kind,
    });
    seenTerms.add(normalized);
    normalizedAliases.forEach((alias) =>
      seenTerms.add(normalizeKeywordText(alias)),
    );
    return true;
  };

  let acceptedTagCount = 0;
  for (const tag of index.tags) {
    if (WORKFLOW_TAGS.has(normalizeKeywordText(tag))) {
      continue;
    }
    const tagTokens = contentTokens(tag);
    if (
      !tagTokens.length ||
      (tagTokens.length === 1 && !isStandaloneToken(tagTokens[0]))
    ) {
      continue;
    }
    const kind = tagTokens.length > 1 ? "phrase" : "term";
    if (addKeyword(tag, kind === "phrase" ? "core" : "domain", kind)) {
      acceptedTagCount += 1;
      if (acceptedTagCount >= MAX_TAG_KEYWORDS) {
        break;
      }
    }
  }

  const titleTokens = tokenize(index.title);
  for (const token of titleTokens.filter((entry) => isEntityToken(entry.raw))) {
    if (keywords.length >= MAX_KEYWORDS) {
      return keywords;
    }
    addKeyword(token.raw, "core", "entity");
  }

  const remainingCorePhraseSlots = Math.max(
    0,
    MAX_CORE_PHRASES -
      keywords.filter(
        (keyword) => keyword.tier === "core" && keyword.kind === "phrase",
      ).length,
  );
  const phraseCandidates: Array<{
    label: string;
    aliases: string[];
    components: string[];
    score: number;
    position: number;
  }> = [];
  for (let index = 0; index < titleTokens.length - 1; index += 1) {
    const first = titleTokens[index];
    const second = titleTokens[index + 1];
    if (!isPhraseToken(first) || !isPhraseToken(second)) {
      continue;
    }
    const label = `${first.raw} ${second.raw}`;
    const acronym = phraseAcronym(label);
    const aliases =
      acronym && sourceTokens.some((token) => token.raw === acronym)
        ? [acronym]
        : [];
    const components = [first.normalized, second.normalized];
    phraseCandidates.push({
      label,
      aliases,
      components,
      score:
        (aliases.length ? 10 : 0) +
        components.filter((term) => !BROAD_SINGLE_TERMS.has(term)).length * 3,
      position: index,
    });
  }
  for (const candidate of phraseCandidates
    .sort((a, b) => b.score - a.score || a.position - b.position)
    .slice(0, remainingCorePhraseSlots)) {
    if (addKeyword(candidate.label, "core", "phrase", candidate.aliases)) {
      candidate.components.forEach((term) => corePhraseComponents.add(term));
    }
  }

  for (const token of titleTokens) {
    if (keywords.length >= MAX_KEYWORDS) {
      return keywords;
    }
    if (!isStandaloneToken(token)) {
      continue;
    }
    if (
      corePhraseComponents.has(token.normalized) &&
      BROAD_SINGLE_TERMS.has(token.normalized)
    ) {
      continue;
    }
    addKeyword(
      token.raw,
      BROAD_SINGLE_TERMS.has(token.normalized) ? "supporting" : "domain",
      "term",
    );
  }

  for (const token of tokenize(index.abstract).filter((entry) =>
    isEntityToken(entry.raw),
  )) {
    if (keywords.length >= MAX_KEYWORDS) {
      return keywords;
    }
    addKeyword(token.raw, "domain", "entity");
  }

  const frequency = new Map<string, { token: TextToken; count: number }>();
  for (const token of contentTokens(index.abstract)) {
    const entry = frequency.get(token.normalized);
    frequency.set(token.normalized, {
      token: entry?.token ?? token,
      count: (entry?.count ?? 0) + 1,
    });
  }
  for (const { token, count } of [...frequency.values()].sort(
    (a, b) => b.count - a.count,
  )) {
    if (keywords.length >= MAX_KEYWORDS) {
      break;
    }
    if (
      corePhraseComponents.has(token.normalized) &&
      BROAD_SINGLE_TERMS.has(token.normalized)
    ) {
      continue;
    }
    addKeyword(
      token.raw,
      count > 1 && !BROAD_SINGLE_TERMS.has(token.normalized)
        ? "domain"
        : "supporting",
      "term",
    );
  }

  return keywords;
}

export function scoreKeywordMatches(
  index: KeywordTextIndex,
  searchedKeywords: WeightedLocalRelKeyword[],
): LocalRelCandidateScore {
  const matches = searchedKeywords.map(({ keyword, idf }) => {
    const field = keywordMatchField(index, keyword);
    const exactMetadataMatch = field !== "fulltext";
    return {
      keyword,
      field,
      exactMetadataMatch,
      weight: tierWeight(keyword.tier) * fieldWeight(field) * Math.max(1, idf),
    };
  });

  const exactCore = matches.filter(
    (match) => match.keyword.tier === "core" && match.exactMetadataMatch,
  );
  const exactDomain = matches.filter(
    (match) => match.keyword.tier === "domain" && match.exactMetadataMatch,
  );
  const hasStrongDomainField = exactDomain.some(
    (match) => match.field === "title" || match.field === "tag",
  );
  const coverageBonus = exactCore.length && exactDomain.length ? 2 : 0;
  const score =
    matches.reduce((total, match) => total + match.weight, 0) + coverageBonus;
  const topicGate =
    exactCore.length > 0 || (exactDomain.length >= 2 && hasStrongDomainField);

  return {
    score: Math.round(score * 100) / 100,
    matches,
    qualifies: topicGate && score >= MIN_RELEVANCE_SCORE,
  };
}

export function localKeywordIDF(
  documentFrequency: number,
  documentCount: number,
) {
  if (documentFrequency <= 0 || documentCount <= 0) {
    return 1;
  }
  return Math.min(
    3,
    1 + Math.log((documentCount + 1) / (documentFrequency + 1)),
  );
}

export function keywordSearchTerms(keyword: LocalRelKeyword) {
  return [keyword.label, ...keyword.aliases];
}

export function buildLocalSearchQuery(term: string) {
  const cleaned = term.replace(/"/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.includes(" ") ? `"${cleaned}"` : cleaned;
}

export function normalizeKeywordText(value: string) {
  return tokenize(value)
    .map((token) => token.normalized)
    .join(" ");
}

function keywordMatchField(
  index: KeywordTextIndex,
  keyword: LocalRelKeyword,
): LocalRelMatchField {
  const terms = keywordSearchTerms(keyword);
  if (terms.some((term) => containsKeyword(index.title, term))) {
    return "title";
  }
  if (
    index.tags.some((tag) => terms.some((term) => containsKeyword(tag, term)))
  ) {
    return "tag";
  }
  if (terms.some((term) => containsKeyword(index.abstract, term))) {
    return "abstract";
  }
  return "fulltext";
}

function containsKeyword(value: string, keyword: string) {
  const haystack = ` ${normalizeKeywordText(value)} `;
  const needle = normalizeKeywordText(keyword);
  return Boolean(needle && haystack.includes(` ${needle} `));
}

function tierWeight(tier: LocalRelKeywordTier) {
  return { core: 5, domain: 2, supporting: 0.75 }[tier];
}

function fieldWeight(field: LocalRelMatchField) {
  return { title: 3, tag: 2.5, abstract: 1.6, fulltext: 0.35 }[field];
}

function phraseAcronym(value: string) {
  const tokens = contentTokens(value);
  if (tokens.length < 2 || tokens.length > 4) {
    return "";
  }
  return tokens.map((token) => token.raw[0]?.toUpperCase() ?? "").join("");
}

function tokenize(value: string): TextToken[] {
  return (
    value.normalize("NFKC").match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? []
  ).map((raw) => ({ raw, normalized: normalizeToken(raw) }));
}

function contentTokens(value: string) {
  return tokenize(value).filter(isPhraseToken);
}

function isPhraseToken(token: TextToken) {
  return (
    !STOPWORDS.has(token.normalized) &&
    !/^\d+$/.test(token.normalized) &&
    (token.normalized.length >= 2 || isEntityToken(token.raw))
  );
}

function isStandaloneToken(token: TextToken) {
  return (
    isPhraseToken(token) &&
    token.normalized !== "data" &&
    (token.normalized.length >= 3 || isEntityToken(token.raw))
  );
}

function isEntityToken(value: string) {
  if (/^[A-Z][A-Z\d-]{1,9}$/.test(value)) {
    return true;
  }
  return /[a-z]/.test(value) && /[A-Z]/.test(value.slice(1));
}

function normalizeToken(value: string) {
  let normalized = value.normalize("NFKC").toLocaleLowerCase();
  if (/^[\p{L}\p{N}]+ies$/u.test(normalized) && normalized.length > 4) {
    normalized = `${normalized.slice(0, -3)}y`;
  } else if (
    /^[\p{L}\p{N}]+s$/u.test(normalized) &&
    normalized.length > 4 &&
    !/(?:ss|us|is)$/u.test(normalized)
  ) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

interface TextToken {
  raw: string;
  normalized: string;
}
