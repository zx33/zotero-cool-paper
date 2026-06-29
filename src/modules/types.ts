export type PapersCoolBranch = "arxiv" | "venue";

export interface PaperReference {
  branch: PapersCoolBranch;
  key: string;
  source: "papers.cool-url" | "arxiv" | "openreview" | "title-search";
}

export interface PaperMetadata {
  branch: PapersCoolBranch;
  key: string;
  title?: string;
  authors?: string;
  summary?: string;
  subject?: string;
  published?: string;
  keywords?: string;
  paperURL: string;
  pdfURL?: string;
  kimiStars?: number;
  pdfStars?: number;
}

export interface RelatedPaper {
  branch: PapersCoolBranch;
  key: string;
  title: string;
  authors?: string;
  summary?: string;
  subject?: string;
  published?: string;
  keywords?: string;
  paperURL: string;
  pdfURL?: string;
  kimiStars?: number;
  pdfStars?: number;
}

export interface RelatedResult {
  url: string;
  papers: RelatedPaper[];
}

export interface ResolvedPaper {
  reference: PaperReference;
  metadata: PaperMetadata;
}

export interface CacheEntry {
  cacheKey: string;
  branch: PapersCoolBranch;
  key: string;
  metadata?: PaperMetadata;
  kimiHTML?: string;
  related?: RelatedResult;
  metadataFetchedAt?: number;
  kimiFetchedAt?: number;
  relatedFetchedAt?: number;
  updatedAt?: number;
}
