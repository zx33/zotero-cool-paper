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

  it("shrinks the Zotero details column before the sidenav", function () {
    const win = Zotero.getMainWindow();
    const doc = win.document;
    const pane = htmlElement(doc, "div");
    pane.style.cssText = [
      "position: absolute",
      "visibility: hidden",
      "display: flex",
      "width: 260px",
      "inset: 0 auto auto 0",
    ].join(";");

    const main = htmlElement(doc, "div", "zotero-view-item-main");
    const intrinsicWidthSource = htmlElement(doc, "div");
    intrinsicWidthSource.style.cssText =
      "width: 420px; height: 1px; flex: 0 0 auto";
    const itemView = htmlElement(doc, "div", "zotero-view-item");
    const customSection = htmlElement(doc, "div");
    const collapsibleSection = htmlElement(doc, "div");
    const body = htmlElement(doc, "div", "body pcp-body");
    const root = htmlElement(doc, "div", "pcp-root");
    const kimi = htmlElement(doc, "div", "pcp-kimi");
    kimi.textContent =
      "This ordinary content must wrap before the Zotero item-pane sidenav. ".repeat(
        10,
      );
    root.append(kimi);
    body.append(root);
    collapsibleSection.append(body);
    customSection.append(collapsibleSection);
    itemView.append(customSection);
    main.append(intrinsicWidthSource, itemView);

    const sidenav = htmlElement(doc, "div");
    sidenav.style.cssText = "flex: 0 0 37px; width: 37px";
    pane.append(main, sidenav);
    doc.documentElement.append(pane);

    try {
      const mainRect = main.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      const sidenavRect = sidenav.getBoundingClientRect();
      assert.closeTo(
        mainRect.right,
        sidenavRect.left,
        0.5,
        "the details column overlapped the sidenav",
      );
      assert.isAtMost(
        bodyRect.right,
        sidenavRect.left + 0.5,
        "the plugin body extended behind the sidenav",
      );
      assert.equal(win.getComputedStyle(main).minWidth, "0px");
      assert.equal(win.getComputedStyle(itemView).minWidth, "0px");
    } finally {
      pane.remove();
    }
  });

  it("constrains the reader context-pane deck before its sidenav", function () {
    const win = Zotero.getMainWindow();
    const doc = win.document;
    const contextPaneHost = htmlElement(doc, "div");
    contextPaneHost.id = "zotero-context-pane";
    contextPaneHost.style.cssText = [
      "position: absolute",
      "visibility: hidden",
      "display: flex",
      "width: 357px",
      "inset: 0 auto auto 0",
    ].join(";");

    const flexibleHost = htmlElement(doc, "vbox");
    flexibleHost.style.cssText = [
      "display: flex",
      "flex: 1 1 auto",
      "flex-direction: column",
      "align-items: flex-start",
      "min-width: 0",
    ].join(";");
    const contextPane = htmlElement(doc, "context-pane");
    contextPane.id = "zotero-context-pane-inner";
    const panesDeck = htmlElement(doc, "deck");
    panesDeck.id = "zotero-context-pane-deck";
    const itemDeck = htmlElement(doc, "deck");
    itemDeck.id = "zotero-context-pane-item-deck";
    const itemDetails = htmlElement(doc, "item-details");
    itemDetails.className = "zotero-item-pane-content";
    const container = htmlElement(doc, "div", "zotero-view-item-container");
    const main = htmlElement(doc, "div", "zotero-view-item-main");
    const itemView = htmlElement(doc, "div", "zotero-view-item");
    const customSection = htmlElement(doc, "div");
    const body = htmlElement(doc, "div", "body pcp-body");
    const root = htmlElement(doc, "div", "pcp-root");
    const kimi = htmlElement(doc, "div", "pcp-kimi");
    kimi.textContent =
      "Reader context content must wrap before Zotero's context sidenav. ".repeat(
        10,
      );
    const intrinsicWidthSource = htmlElement(doc, "div");
    intrinsicWidthSource.style.cssText =
      "width: 466px; height: 1px; flex: 0 0 auto";

    root.append(kimi);
    body.append(root);
    customSection.append(body);
    itemView.append(customSection);
    main.append(intrinsicWidthSource, itemView);
    container.append(main);
    itemDetails.append(container);
    itemDeck.append(itemDetails);
    panesDeck.append(itemDeck);
    contextPane.append(panesDeck);
    flexibleHost.append(contextPane);

    const sidenav = htmlElement(doc, "div");
    sidenav.id = "zotero-context-pane-sidenav";
    sidenav.style.cssText = "flex: 0 0 37px; width: 37px";
    contextPaneHost.append(flexibleHost, sidenav);
    doc.documentElement.append(contextPaneHost);

    try {
      const flexibleHostRect = flexibleHost.getBoundingClientRect();
      const contextPaneRect = contextPane.getBoundingClientRect();
      const mainRect = main.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      const sidenavRect = sidenav.getBoundingClientRect();
      assert.closeTo(
        flexibleHostRect.right,
        sidenavRect.left,
        0.5,
        "the reader content host overlapped the sidenav",
      );
      for (const [name, rect] of [
        ["context pane", contextPaneRect],
        ["panes deck", panesDeck.getBoundingClientRect()],
        ["item deck", itemDeck.getBoundingClientRect()],
        ["item details", itemDetails.getBoundingClientRect()],
        ["details container", container.getBoundingClientRect()],
        ["details column", mainRect],
        ["plugin body", bodyRect],
      ] as const) {
        assert.isAtMost(
          rect.right,
          sidenavRect.left + 0.5,
          `${name} extended behind the reader sidenav`,
        );
      }
      assert.closeTo(
        contextPaneRect.width,
        320,
        0.5,
        "the reader context pane did not use the available width",
      );
      assert.equal(win.getComputedStyle(flexibleHost).width, "320px");
      assert.equal(win.getComputedStyle(contextPane).width, "320px");
    } finally {
      contextPaneHost.remove();
    }
  });
});

function htmlElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K];
function htmlElement(
  doc: Document,
  tag: string,
  className?: string,
): HTMLElement;
function htmlElement(doc: Document, tag: string, className?: string) {
  const element = doc.createElementNS(HTML_NS, tag) as HTMLElement;
  if (className) {
    element.className = className;
  }
  return element;
}
