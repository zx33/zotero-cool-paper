import { getString, initLocale } from "./utils/locale";
import { version as addonVersion } from "../package.json";
import { initPapersCoolCache } from "./modules/cache";
import { initReadingStore } from "./modules/localReading/store";
import {
  registerLocalReadingItemPane,
  unregisterLocalReadingItemPane,
} from "./modules/localReading/pane";
import {
  registerPapersCoolItemPane,
  unregisterPapersCoolItemPane,
} from "./modules/itemPane";
import {
  registerLocalRelItemPane,
  unregisterLocalRelItemPane,
} from "./modules/localRel";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  await initPapersCoolCache();
  await initReadingStore();
  registerPapersCoolItemPane();
  registerLocalRelItemPane();
  registerLocalReadingItemPane();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

function onMainWindowLoad(win: _ZoteroTypes.MainWindow): void {
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  registerStyleSheet(win);
  ztoolkit.log(getString("startup-finish"));
}

function onMainWindowUnload(win: Window): void {
  unregisterStyleSheet(win);
}

function onShutdown(): void {
  unregisterLocalReadingItemPane();
  for (const win of Zotero.getMainWindows()) {
    unregisterStyleSheet(win);
  }
  unregisterLocalRelItemPane();
  unregisterPapersCoolItemPane();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

function registerStyleSheet(win: _ZoteroTypes.MainWindow) {
  const doc = win.document;
  unregisterStyleSheet(win);
  const styles = ztoolkit.UI.createElement(doc, "link", {
    properties: {
      id: `${addon.data.config.addonRef}-stylesheet`,
      type: "text/css",
      rel: "stylesheet",
      href: `${styleSheetURL()}?version=${encodeURIComponent(addonVersion)}`,
    },
  });
  doc.documentElement?.appendChild(styles);
}

function unregisterStyleSheet(win: Window) {
  const prefix = styleSheetURL();
  win.document
    .querySelectorAll(`link[href^="${prefix}"]`)
    .forEach((link: Element) => link.remove());
}

function styleSheetURL() {
  return `chrome://${addon.data.config.addonRef}/content/zoteroPane.css`;
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
