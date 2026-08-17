import { assert } from "chai";

const HTML_NS = "http://www.w3.org/1999/xhtml";

describe("item pane responsive layout", function () {
  it("keeps rich KIMI content within a narrow pane", function () {
    const win = Zotero.getMainWindow();
    const doc = win.document;
    const body = htmlElement(doc, "div", "pcp-body");
    body.style.cssText =
      "position: absolute; visibility: hidden; width: 220px; inset: 0 auto auto 0;";

    const root = htmlElement(doc, "div", "pcp-root");
    const section = htmlElement(doc, "section", "pcp-section");
    const kimi = htmlElement(doc, "div", "pcp-kimi");
    const paragraph = htmlElement(doc, "p");
    paragraph.textContent = "Dual-target-molecule-generation-".repeat(20);
    const image = htmlElement(doc, "img") as HTMLImageElement;
    image.width = 800;
    image.height = 400;
    const pre = htmlElement(doc, "pre");
    pre.textContent = "unbroken-code-token-".repeat(50);
    const table = htmlElement(doc, "table");
    table.innerHTML = `<tbody><tr><td>${"wide-table-cell-".repeat(50)}</td></tr></tbody>`;

    kimi.append(paragraph, image, pre, table);
    section.append(kimi);
    root.append(section);
    body.append(root);
    doc.documentElement.append(body);

    try {
      const bodyWidth = body.getBoundingClientRect().width;
      for (const element of [root, section, kimi, image, pre, table]) {
        assert.isAtMost(
          element.getBoundingClientRect().width,
          bodyWidth + 0.5,
          `${element.localName} overflowed the item pane`,
        );
      }
      assert.equal(win.getComputedStyle(root).minWidth, "0px");
      assert.equal(win.getComputedStyle(kimi).whiteSpace, "normal");
      assert.equal(win.getComputedStyle(table).overflowX, "auto");
    } finally {
      body.remove();
    }
  });
});

function htmlElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
) {
  const element = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (className) {
    element.className = className;
  }
  return element;
}
