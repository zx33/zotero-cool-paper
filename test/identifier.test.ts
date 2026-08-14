import { assert } from "chai";
import { identifyPaperFromItem } from "../src/modules/identifier";

describe("paper identifier", function () {
  it("does not mistake an IEEE DOI suffix for an arXiv ID", function () {
    assert.isNull(
      identifyPaperFromItem(
        itemWithFields({ DOI: "10.1109/TPAMI.2023.12345" }),
      ),
    );
  });

  it("does not trust an arXiv-shaped IEEE DOI suffix", function () {
    assert.isNull(
      identifyPaperFromItem(
        itemWithFields({ DOI: "10.1109/TPAMI.2310.12345" }),
      ),
    );
  });

  it("does not extract a bare arXiv-shaped substring from a title", function () {
    assert.isNull(
      identifyPaperFromItem(
        itemWithFields({ title: "Benchmark results for model 2310.12345" }),
      ),
    );
  });

  it("does not combine an arXiv marker with a different field", function () {
    assert.isNull(
      identifyPaperFromItem(
        itemWithFields({ title: "Study arXiv:", DOI: "2310.12345" }),
      ),
    );
  });

  it("ignores a malformed papers.cool URL and continues identification", function () {
    assert.deepEqual(
      identifyPaperFromItem(
        itemWithFields({
          url: "https://papers.cool/arxiv/%ZZ",
          extra: "arXiv: 2301.12345",
        }),
      ),
      arxivReference("2301.12345"),
    );
  });

  it("decodes a valid encoded papers.cool paper key", function () {
    assert.deepEqual(
      identifyPaperFromItem(
        itemWithFields({
          url: "https://papers.cool/arxiv/hep-th%2F9901001",
        }),
      ),
      {
        branch: "arxiv",
        key: "hep-th/9901001",
        source: "papers.cool-url",
      },
    );
  });

  it("recognizes an arXiv DOI", function () {
    assert.deepEqual(
      identifyPaperFromItem(
        itemWithFields({ DOI: "10.48550/arXiv.2301.12345" }),
      ),
      arxivReference("2301.12345"),
    );
  });

  it("recognizes a versioned arXiv URL", function () {
    assert.deepEqual(
      identifyPaperFromItem(
        itemWithFields({ url: "https://arxiv.org/abs/2301.12345v2" }),
      ),
      arxivReference("2301.12345"),
    );
  });

  it("recognizes an explicit arXiv ID in Extra", function () {
    assert.deepEqual(
      identifyPaperFromItem(itemWithFields({ extra: "arXiv: 2301.12345" })),
      arxivReference("2301.12345"),
    );
  });

  it("recognizes a bare arXiv ID in Archive Location", function () {
    assert.deepEqual(
      identifyPaperFromItem(
        itemWithFields({ archiveLocation: "2301.12345v2" }),
      ),
      arxivReference("2301.12345"),
    );
  });

  it("recognizes a bare arXiv ID on its own Extra line", function () {
    assert.deepEqual(
      identifyPaperFromItem(
        itemWithFields({ extra: "Citation Key: example\n2301.12345" }),
      ),
      arxivReference("2301.12345"),
    );
  });

  it("rejects a modern arXiv ID with an invalid month", function () {
    assert.isNull(
      identifyPaperFromItem(itemWithFields({ archiveLocation: "2023.12345" })),
    );
  });
});

function itemWithFields(fields: Record<string, string>) {
  return {
    getField(field: string) {
      return fields[field] ?? "";
    },
    getAttachments() {
      return [];
    },
  } as unknown as Zotero.Item;
}

function arxivReference(key: string) {
  return { branch: "arxiv", key, source: "arxiv" };
}
