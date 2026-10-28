import { assert } from "chai";
import { config } from "../../package.json";
import { saveCachePatch } from "../../src/modules/cache";
import { identifyPDF } from "../../src/modules/localReading/service";
import { readingStore } from "../../src/modules/localReading/store";
import { MODEL, PROTOCOL } from "../../src/modules/localReading/protocol";
import { buildLocalSearchQuery } from "../../src/modules/localRelRanking";

type ItemDetails = HTMLElement & {
  item: Zotero.Item;
  render(): Promise<void>;
  scrollToPane(paneID: string, behavior?: string): Promise<unknown>;
};

const fulltextTerm = "coolpaperfulltextfixture";
const sourceText = "Compatibility fixture: a biomedical knowledge graph.";
const readingAnswer = "兼容测试解读：正文与来源已从本地记录恢复。";

describe("native Zotero item panes", function () {
  this.timeout(30_000);
  let win: ReturnType<typeof Zotero.getMainWindow>;
  const items: Zotero.Item[] = [];
  const pdfs: Zotero.Item[] = [];
  const identities: string[] = [];
  let hash: string;
  let path: string;
  let details: ItemDetails;

  before(async function () {
    win = Zotero.getMainWindow();
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    path = `${Zotero.DataDirectory.dir}/pane-compatibility-fixture.pdf`;
    await Zotero.File.putContentsAsync(path, fixturePDF());

    for (const [index, title] of [
      "PharmKG: a dedicated biomedical knowledge graph",
      "PharmKG biomedical knowledge graph applications",
      "Unrelated mineral physics experiment",
    ].entries()) {
      const item = new Zotero.Item("journalArticle");
      item.setField("title", title);
      item.setField("url", `https://arxiv.org/abs/2302.0501${index + 7}`);
      if (index < 2) item.addTag("PharmKG");
      await item.saveTx();
      items.push(item);

      const key = `2302.0501${index + 7}`;
      const now = Date.now();
      await saveCachePatch(
        { branch: "arxiv", key },
        {
          metadata: {
            branch: "arxiv",
            key,
            title,
            keywords: "biomedical,knowledge,graph",
            paperURL: `https://papers.cool/arxiv/${key}`,
          },
          kimiHTML: "<p>Cached papers.cool compatibility reading.</p>",
          related: { url: "https://papers.cool/arxiv/search", papers: [] },
          metadataFetchedAt: now,
          kimiFetchedAt: now,
          relatedFetchedAt: now,
        },
      );

      if (index === 2) continue;
      const pdf = await Zotero.Attachments.importFromFile({
        file: path,
        parentItemID: item.id,
        contentType: "application/pdf",
      });
      pdfs.push(pdf);
      const identity = await identifyPDF(pdf);
      identities.push(identity.identity);
      hash = identity.hash;
      await readingStore.putText(hash, sourceText);
      const answers = Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [
          `q${i + 1}`,
          { answer: readingAnswer, sources: ["s1"] },
        ]),
      ) as NonNullable<
        Awaited<ReturnType<typeof readingStore.latest>>
      >["answers"];
      await readingStore.save({
        id: `pane-test-${pdf.key}`,
        identity: identity.identity,
        hash,
        model: MODEL,
        protocol: PROTOCOL,
        started: now,
        status: "complete",
        completion: {
          content: JSON.stringify(answers),
          done: true,
          finish: "stop",
        },
        answers,
      });
    }
    await win.ZoteroPane.selectItem(items[0].id);
    details = await waitFor(() =>
      win.document.querySelector<ItemDetails>("#zotero-item-pane item-details"),
    );
    await waitFor(() => details.item?.id === items[0].id);
  });

  after(async function () {
    for (const pdf of pdfs) {
      const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
      if (reader?.itemID === pdf.id) win.Zotero_Tabs.close(reader.tabID);
    }
    for (const identity of identities) {
      await Zotero.DB.queryAsync(
        "DELETE FROM pcp_reading_runs WHERE identity = ?",
        [identity],
        { debug: false },
      );
    }
    if (hash) {
      await Zotero.DB.queryAsync(
        "DELETE FROM pcp_reading_text WHERE hash = ?",
        [hash],
        { debug: false },
      );
    }
    for (const [index, item] of items.entries()) {
      await item.eraseTx();
      await Zotero.DB.queryAsync(
        "DELETE FROM paperscool_cache WHERE cache_key = ?",
        [`arxiv:2302.0501${index + 7}`],
      );
    }
    if (path) await Zotero.File.removeIfExists(path);
  });

  async function showPane(suffix: string, ready: string) {
    const data = Zotero.ItemPaneManager.customSectionData;
    const option = data.options.find(
      (section) =>
        section.pluginID === config.addonID && section.paneID.endsWith(suffix),
    );
    assert.exists(option, `${suffix} was not registered`);
    const container = details.closest(
      "item-pane, context-pane",
    ) as HTMLElement & {
      collapsed: boolean;
    };
    if (container.collapsed) container.collapsed = false;
    const pane = await waitFor(
      () =>
        Array.from(
          details.querySelectorAll<HTMLElement>("item-pane-custom-section"),
        ).find((node) => node.dataset.pane === option!.paneID),
      () => `${suffix} was not inserted into item ${details.item?.id}`,
    );
    assert.isFalse(pane.hidden, `${suffix} is hidden`);
    await details.scrollToPane(option!.paneID, "instant");
    await waitFor(
      () => pane.querySelector(ready),
      () =>
        `${suffix} did not render ${ready}: ${pane.querySelector('[data-type="body"]')?.outerHTML.slice(0, 2000)}`,
    );
    return pane;
  }

  it("renders cached papers.cool KIMI and REL in the native library sidebar", async function () {
    const pane = await showPane("paperscool", ".pcp-status[data-tone='ok']");
    assert.include(pane.textContent, String(items[0].getField("title")));
    assert.include(
      pane.textContent,
      "Cached papers.cool compatibility reading",
    );
    assert.exists(pane.querySelector(".pcp-related"));
  });

  it("finds related library items and refreshes Local REL", async function () {
    const pane = await showPane("local-rel", ".pcp-local-result");
    const titles = () =>
      Array.from(pane.querySelectorAll(".pcp-local-result-title")).map(
        (node) => node.textContent,
      );
    assert.include(titles(), String(items[1].getField("title")));
    assert.notInclude(titles(), String(items[0].getField("title")));
    assert.notInclude(titles(), String(items[2].getField("title")));
    pane.querySelector<HTMLButtonElement>(".pcp-local-refresh")!.click();
    await waitFor(() =>
      pane.querySelector(".pcp-local-status[data-tone='ok']"),
    );
    assert.include(titles(), String(items[1].getField("title")));
  });

  it("finds a PDF-only term through the native full-text search used by Local REL", async function () {
    await Zotero.FullText.indexItems(
      pdfs.map((pdf) => pdf.id),
      { complete: true },
    );
    const search = new Zotero.Search({ libraryID: items[0].libraryID });
    search.addCondition(
      "quicksearch-everything",
      "contains",
      buildLocalSearchQuery(fulltextTerm),
    );
    const hits = await search.search();
    for (const pdf of pdfs) assert.include(hits, pdf.id);
    assert.notInclude(hits, items[2].id);
  });

  it("restores all six local-reading answers and opens their source", async function () {
    const pane = await showPane("local-reading", ".pcp-reading-answer");
    assert.lengthOf(pane.querySelectorAll(".pcp-reading-answer"), 6);
    assert.include(pane.textContent, readingAnswer);
    const attachment = pane.querySelector<HTMLSelectElement>("select")!;
    assert.equal(attachment.value, String(pdfs[0].id));
    pane.querySelector<HTMLButtonElement>(".pcp-reading-refs button")!.click();
    assert.include(pane.textContent, sourceText);
  });

  it("preserves local-reading answers when Zotero refreshes the same item", async function () {
    const pane = await showPane("local-reading", ".pcp-reading-answer");
    const report = pane.querySelector(".pcp-reading-report");
    await details.render();
    assert.strictEqual(pane.querySelector(".pcp-reading-report"), report);
    assert.lengthOf(pane.querySelectorAll(".pcp-reading-answer"), 6);
    assert.include(pane.textContent, readingAnswer);
  });

  it("opens a Local REL result in the PDF reader and renders all three reader panes", async function () {
    const pane = await showPane("local-rel", ".pcp-local-result");
    const row = pane.querySelector<HTMLElement>(".pcp-local-result")!;
    row.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
    await waitFor(() => {
      const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
      return reader?.itemID === pdfs[1].id;
    });
    details = await waitFor(() =>
      Array.from(
        win.document.querySelectorAll<ItemDetails>(
          "#zotero-context-pane-inner item-details",
        ),
      ).find((node) => node.item?.id === items[1].id),
    );
    await showPane("paperscool", ".pcp-status[data-tone='ok']");
    await showPane("local-rel", ".pcp-local-result");
    const readingPane = await showPane("local-reading", ".pcp-reading-answer");
    assert.equal(
      readingPane.querySelector<HTMLSelectElement>("select")!.value,
      String(pdfs[1].id),
    );
    assert.lengthOf(readingPane.querySelectorAll(".pcp-reading-answer"), 6);
  });
});

async function waitFor<T>(
  read: () => T | null | undefined | false,
  diagnostic = () => "Native item pane did not reach the expected state",
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const value = read();
    if (value) return value;
    await Zotero.Promise.delay(50);
  }
  assert.fail(diagnostic());
}

function fixturePDF() {
  const content = `BT /F1 12 Tf 36 760 Td (${fulltextTerm}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return `${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
