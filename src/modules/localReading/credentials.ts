const ORIGIN = "chrome://zoterocoolpaper";
const REALM = "Moonshot Kimi API";

function manager() {
  return (
    Zotero.getMainWindow() as unknown as {
      Services: { logins: nsILoginManager };
    }
  ).Services.logins;
}

export function getAPIKey(): string {
  return manager().findLogins(ORIGIN, "", REALM)[0]?.password ?? "";
}

export async function saveAPIKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed || /\s/.test(trimmed)) throw new Error("Invalid credential");
  const LoginInfo = Components.Constructor(
    "@mozilla.org/login-manager/loginInfo;1",
    "nsILoginInfo",
    "init",
  );
  const info = new LoginInfo(ORIGIN, null, REALM, "API Key", trimmed, "", "");
  const existing = manager().findLogins(ORIGIN, "", REALM);
  if (existing.length) manager().modifyLogin(existing[0], info);
  else await manager().addLoginAsync(info);
  for (const duplicate of existing.slice(1)) manager().removeLogin(duplicate);
}

export function removeAPIKey(): void {
  for (const login of manager().findLogins(ORIGIN, "", REALM))
    manager().removeLogin(login);
}
