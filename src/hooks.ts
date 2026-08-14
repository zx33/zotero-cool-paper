import { getString, initLocale } from "./utils/locale";
import { initPapersCoolCache } from "./modules/cache";
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
  registerPapersCoolItemPane();
  registerLocalRelItemPane();

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
  void win;
}

function onShutdown(): void {
  unregisterLocalRelItemPane();
  unregisterPapersCoolItemPane();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

function registerStyleSheet(win: _ZoteroTypes.MainWindow) {
  const doc = win.document;
  const styles = ztoolkit.UI.createElement(doc, "link", {
    properties: {
      type: "text/css",
      rel: "stylesheet",
      href: `chrome://${addon.data.config.addonRef}/content/zoteroPane.css`,
    },
  });
  doc.documentElement?.appendChild(styles);
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
