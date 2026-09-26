import { assert } from "chai";
import { config, version } from "../package.json";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("loads exactly one versioned item-pane stylesheet", function () {
    const doc = Zotero.getMainWindow().document;
    const prefix = `chrome://${config.addonRef}/content/zoteroPane.css`;
    const styles = doc.querySelectorAll(`link[href^="${prefix}"]`);
    assert.lengthOf(styles, 1);
    assert.equal(styles[0].id, `${config.addonRef}-stylesheet`);
    assert.include(
      (styles[0] as HTMLLinkElement).href,
      `version=${encodeURIComponent(version)}`,
    );
  });
});
