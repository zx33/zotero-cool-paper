import { assert } from "chai";
import {
  parsePaperListHTML,
  parsePaperMetadataHTML,
  TITLE_MATCH_THRESHOLD,
  titleScore,
} from "../src/modules/papersCoolClient";
import {
  currentPapersCoolHTML,
  emptyPapersCoolHTML,
  semanticFallbackHTML,
} from "./fixtures/papersCoolHTML";

describe("papers.cool HTML parser", function () {
  it("parses a snapshot of the current paper structure", function () {
    const papers = parsePaperListHTML(currentPapersCoolHTML, "arxiv");

    assert.lengthOf(papers, 1);
    assert.deepInclude(papers[0], {
      branch: "arxiv",
      key: "2302.05019",
      title: "A Comprehensive Survey on Automatic Knowledge Graph Construction",
      authors: "Lingfeng Zhong, Jia Wu",
      summary: "A survey of knowledge graph construction.",
      subject: "Information Retrieval",
      published: "2023-02-10",
      keywords: "knowledge,graph,survey,construction",
      paperURL: "https://papers.cool/arxiv/2302.05019",
      pdfURL: "https://arxiv.org/pdf/2302.05019",
      kimiStars: 9,
      pdfStars: 7,
    });
  });

  it("parses detail metadata from the current snapshot", function () {
    const metadata = parsePaperMetadataHTML(currentPapersCoolHTML, {
      branch: "arxiv",
      key: "2302.05019",
      source: "arxiv",
    });

    assert.equal(
      metadata.title,
      "A Comprehensive Survey on Automatic Knowledge Graph Construction",
    );
    assert.equal(metadata.authors, "Lingfeng Zhong, Jia Wu");
    assert.equal(metadata.pdfURL, "https://arxiv.org/pdf/2302.05019");
  });

  it("accepts a known empty result page", function () {
    assert.deepEqual(parsePaperListHTML(emptyPapersCoolHTML, "arxiv"), []);
  });

  it("supports semantic fallback attributes when CSS classes change", function () {
    const papers = parsePaperListHTML(semanticFallbackHTML, "venue");

    assert.lengthOf(papers, 1);
    assert.deepInclude(papers[0], {
      branch: "venue",
      key: "fallback-paper",
      title: "Fallback Paper",
      authors: "Ada Example",
      keywords: "fallback,parser",
      pdfURL: "https://example.com/fallback.pdf",
    });
  });

  it("reports an upstream structure change instead of returning no papers", function () {
    assert.throws(
      () =>
        parsePaperListHTML(
          "<html><body>Unexpected page</body></html>",
          "arxiv",
        ),
      "missing its paper list",
    );
  });

  it("normalizes punctuation and case for exact titles", function () {
    assert.equal(
      titleScore("Graph-Based Models: A Survey", "graph based models a survey"),
      1,
    );
  });

  it("accepts a candidate that contains the complete target title", function () {
    assert.isAtLeast(
      titleScore(
        "Knowledge Graph Construction",
        "Knowledge Graph Construction: A Survey",
      ),
      TITLE_MATCH_THRESHOLD,
    );
  });

  it("rejects titles with insufficient word overlap", function () {
    assert.isBelow(
      titleScore(
        "Knowledge Graph Construction",
        "Graph Neural Architecture Search",
      ),
      TITLE_MATCH_THRESHOLD,
    );
  });
});
