import { assert } from "chai";
import { normalizeKimiHTML } from "../src/modules/kimiParser";

describe("KIMI content parser", function () {
  it("removes the current faq-a response wrapper", function () {
    assert.equal(
      normalizeKimiHTML('<div class="faq-a">\n# Reading\n</div>'),
      "# Reading",
    );
  });

  it("accepts reordered attributes and multiple wrapper classes", function () {
    assert.equal(
      normalizeKimiHTML(
        '<div data-state="done" class="answer faq-a highlighted">\nContent\n</div>',
      ),
      "Content",
    );
  });

  it("does not remove unrelated standalone closing div tags", function () {
    const content = '<div class="note">\nContent\n</div>';
    assert.equal(normalizeKimiHTML(content), content);
  });

  it("does not unwrap an incomplete faq-a response", function () {
    const content = '<div class="faq-a">\nPartial stream';
    assert.equal(normalizeKimiHTML(content), content);
  });
});
