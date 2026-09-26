export function runtime() {
  return Zotero.getMainWindow() as unknown as Window & typeof globalThis;
}

export function io() {
  return (
    Zotero.getMainWindow() as unknown as {
      IOUtils: {
        read(path: string): Promise<Uint8Array>;
        stat(path: string): Promise<{ size: number }>;
      };
    }
  ).IOUtils;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await runtime().crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

export class ReadingError extends Error {}
export function safeError(error: unknown): string {
  // Never surface arbitrary HTTP, OS, or credential-manager exception strings.
  return error instanceof ReadingError
    ? error.message
    : "操作失败，请检查网络、PDF 是否可读或密码管理器是否已解锁。";
}
