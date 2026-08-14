import { assert } from "chai";
import {
  extractLocalKeywords,
  localKeywordIDF,
  normalizeKeywordText,
  scoreKeywordMatches,
  type LocalRelKeyword,
} from "../src/modules/localRelRanking";

const pharmKGSource = {
  title:
    "PharmKG: a dedicated knowledge graph benchmark for biomedical data mining",
  abstract:
    "Biomedical KG embedding supports biological discovery with KGE models.",
  tags: [],
};

describe("Local REL keyword ranking", function () {
  it("keeps entities and topic phrases instead of broad component words", function () {
    const keywords = extractLocalKeywords(pharmKGSource);
    const labels = keywords.map((keyword) => keyword.label);
    const knowledgeGraph = keywordByLabel(keywords, "knowledge graph");

    assert.include(labels, "PharmKG");
    assert.include(labels, "knowledge graph");
    assert.include(labels, "biomedical");
    assert.notInclude(labels, "knowledge");
    assert.notInclude(labels, "graph");
    assert.equal(knowledgeGraph.tier, "core");
    assert.deepEqual(knowledgeGraph.aliases, ["KG"]);
  });

  it("normalizes simple singular and plural phrase variants", function () {
    assert.equal(
      normalizeKeywordText("Knowledge graphs"),
      normalizeKeywordText("knowledge graph"),
    );
  });

  it("accepts a biomedical knowledge-graph paper", function () {
    const keywords = extractLocalKeywords(pharmKGSource);
    const ranked = scoreKeywordMatches(
      {
        title: "Knowledge graphs for drug repurposing",
        abstract:
          "A review of biomedical knowledge graph resources and methods.",
        tags: ["drug repurposing"],
      },
      weightedHits(keywords, ["knowledge graph", "biomedical"]),
    );

    assert.isTrue(ranked.qualifies);
    assert.isAbove(ranked.score, 8);
  });

  it("rejects graph knowledge distillation despite broad search hits", function () {
    const keywords = extractLocalKeywords(pharmKGSource);
    const ranked = scoreKeywordMatches(
      {
        title:
          "On representation knowledge distillation for graph neural networks",
        abstract: "A benchmark for graph representation learning.",
        tags: ["knowledge distillation"],
      },
      weightedHits(keywords, ["knowledge graph"]),
    );

    assert.isFalse(ranked.qualifies);
  });

  it("rejects graph architecture search without a core topic match", function () {
    const keywords = extractLocalKeywords(pharmKGSource);
    const ranked = scoreKeywordMatches(
      {
        title:
          "DARTS-GT: Differentiable architecture search for graph transformers",
        abstract: "A neural architecture benchmark.",
        tags: ["graph NAS"],
      },
      weightedHits(keywords, ["knowledge graph"]),
    );

    assert.isFalse(ranked.qualifies);
  });

  it("gives locally rarer keywords more weight", function () {
    assert.isAbove(localKeywordIDF(3, 100), localKeywordIDF(80, 100));
  });

  it("works without tags or any papers.cool identifier", function () {
    const labels = extractLocalKeywords({
      title: "A foundation model for clinician-centered drug repurposing",
      abstract: "",
      tags: [],
    }).map((keyword) => keyword.label);

    assert.include(labels, "drug repurposing");
    assert.include(labels, "clinician-centered drug");
  });
});

function keywordByLabel(keywords: LocalRelKeyword[], label: string) {
  const keyword = keywords.find(
    (candidate) => candidate.label.toLocaleLowerCase() === label,
  );
  assert.exists(keyword, `Missing keyword: ${label}`);
  return keyword as LocalRelKeyword;
}

function weightedHits(keywords: LocalRelKeyword[], labels: string[]) {
  return labels.map((label) => ({
    keyword: keywordByLabel(keywords, label),
    idf: 1,
  }));
}
