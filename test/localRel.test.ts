import { assert } from "chai";
import {
  extractLocalKeywords,
  scoreKeywordMatches,
} from "../src/modules/localRel";

describe("Local REL keyword ranking", function () {
  it("extracts keywords entirely from local Zotero metadata", function () {
    assert.deepEqual(
      extractLocalKeywords({
        title:
          "PharmKG: a dedicated knowledge graph benchmark for biomedical data mining",
        abstract:
          "Knowledge graphs support biomedical discovery and biomedical reasoning.",
        tags: ["drug repurposing", "knowledge graph"],
      }),
      [
        "drug repurposing",
        "knowledge graph",
        "PharmKG",
        "knowledge",
        "graph",
        "benchmark",
        "biomedical",
        "mining",
        "graphs",
        "support",
        "discovery",
        "reasoning",
      ],
    );
  });

  it("works without tags or any papers.cool identifier", function () {
    assert.includeMembers(
      extractLocalKeywords({
        title: "A foundation model for clinician-centered drug repurposing",
        abstract: "",
        tags: [],
      }),
      ["foundation", "model", "clinician-centered", "drug", "repurposing"],
    );
  });

  it("prioritizes title, tag, abstract, then full-text hits", function () {
    const ranked = scoreKeywordMatches(
      {
        title: "Graph neural networks for discovery",
        tags: ["drug repurposing"],
        abstract: "Knowledge graph reasoning",
      },
      ["graph neural networks", "drug repurposing", "reasoning", "clinical"],
    );

    assert.equal(ranked.score, 10);
    assert.deepEqual(
      ranked.matches.map((match) => match.field),
      ["title", "tag", "abstract", "fulltext"],
    );
  });
});
