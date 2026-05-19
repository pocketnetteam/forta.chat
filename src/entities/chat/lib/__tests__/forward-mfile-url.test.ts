/**
 * Regression test for WEE-28:
 *   "forward: MissingUrlError + Failed to load image при пересылке файла/фото".
 *
 * Pipeline ломается так:
 *   1. SyncEngine.processFileSend отправляет m.file event с
 *      body = JSON.stringify({ name, type, size })   ← БЕЗ url
 *      + content.url = mxc://... (top-level)
 *      + content.secrets = {...} (top-level)
 *   2. Matrix client (matrix-client.ts:404) парсит body как JSON
 *      и кладёт в content.pbody.
 *      Получается: pbody = { name, type, size } — БЕЗ url.
 *   3. parseFileInfo для m.file идёт в branch `pbody`:
 *      url = pbody.url ?? encryptedUrl ?? ""
 *      → "" (пустая строка)  → fileInfo.url = ""
 *   4. useFileDownload → `!fileInfo.url` → throws `MissingUrlError`.
 *
 * Этот тест воспроизводит шаг 2-3: симулируем content, который получает
 * recipient (или sender через /sync), и проверяем что parseFileInfo
 * extracted url из *любого* доступного источника — pbody, top-level
 * content.url, либо canonical Matrix content.file.url.
 *
 * До фикса: тест падает (url === "" / secrets undefined).
 * После фикса: parseFileInfo фолбэчится на content.url + content.secrets.
 */
import { describe, it, expect } from "vitest";
import { parseFileInfo } from "../chat-helpers";

describe("parseFileInfo — m.file with SyncEngine-shaped content (WEE-28 regression)", () => {
  it("falls back to top-level content.url when pbody has no url field", () => {
    // SyncEngine puts only name/type/size into body — url lives at content.url.
    // matrix-client.ts JSON.parses body into pbody, so pbody has no url.
    const content = {
      msgtype: "m.file",
      body: JSON.stringify({ name: "doc.pdf", type: "application/pdf", size: 12345 }),
      pbody: { name: "doc.pdf", type: "application/pdf", size: 12345 },
      url: "mxc://server/Abc123",
    };

    const info = parseFileInfo(content, "m.file");

    expect(info).toBeDefined();
    expect(info!.name).toBe("doc.pdf");
    expect(info!.url).toBe("mxc://server/Abc123");
    expect(info!.url).not.toBe("");
  });

  it("falls back to top-level content.secrets when pbody has no secrets field", () => {
    const content = {
      msgtype: "m.file",
      body: JSON.stringify({ name: "doc.pdf", type: "application/pdf", size: 12345 }),
      pbody: { name: "doc.pdf", type: "application/pdf", size: 12345 },
      url: "mxc://server/Abc123",
      secrets: { block: 10, keys: "base64keys==", v: 2 },
    };

    const info = parseFileInfo(content, "m.file");

    expect(info).toBeDefined();
    expect(info!.secrets).toEqual({ block: 10, keys: "base64keys==", v: 2 });
  });

  it("falls back to top-level content.secrets when pbody.secrets is missing (forwarded PDF)", () => {
    // Reproduces the exact shape sent by SyncEngine.processFileSend for forwards
    // (см. sync-engine.ts: content.secrets устанавливается, когда eventInfo НЕ передан).
    const content = {
      msgtype: "m.file",
      body: JSON.stringify({
        name: "kupibilet_order.pdf",
        type: "application/pdf",
        size: 98765,
      }),
      pbody: {
        name: "kupibilet_order.pdf",
        type: "application/pdf",
        size: 98765,
      },
      url: "mxc://matrix.pocketnet.app/Forwarded",
      secrets: { block: 16, keys: "encryptionkey", v: 2 },
      forwarded_from: { sender_id: "@alice:server" },
    };

    const info = parseFileInfo(content, "m.file");

    expect(info).toBeDefined();
    expect(info!.url).toBe("mxc://matrix.pocketnet.app/Forwarded");
    expect(info!.secrets).toEqual({ block: 16, keys: "encryptionkey", v: 2 });
    expect(info!.name).toBe("kupibilet_order.pdf");
    expect(info!.type).toBe("application/pdf");
  });

  it("prefers pbody.url over content.url (back-compat with legacy bastyon-chat)", () => {
    // Old bastyon-chat embeds url inside body JSON. We must NOT regress this
    // path — pbody.url remains the primary source.
    const content = {
      msgtype: "m.file",
      body: JSON.stringify({
        name: "legacy.txt",
        type: "text/plain",
        size: 100,
        url: "mxc://server/LegacyUrl",
      }),
      pbody: {
        name: "legacy.txt",
        type: "text/plain",
        size: 100,
        url: "mxc://server/LegacyUrl",
      },
      url: "mxc://server/ShouldBeIgnored",
    };

    const info = parseFileInfo(content, "m.file");
    expect(info!.url).toBe("mxc://server/LegacyUrl");
  });

  it("prefers pbody.secrets over content.secrets (back-compat)", () => {
    const content = {
      msgtype: "m.file",
      pbody: {
        name: "x",
        type: "y",
        size: 0,
        url: "mxc://u",
        secrets: { block: 1, keys: "legacy", v: 1 },
      },
      secrets: { block: 99, keys: "ignored", v: 9 },
    };

    const info = parseFileInfo(content, "m.file");
    expect(info!.secrets).toEqual({ block: 1, keys: "legacy", v: 1 });
  });

  it("uses canonical Matrix content.file.url before top-level content.url (Element-forwarded files)", () => {
    // Canonical Matrix encrypted attachment (Element/Cinny/FluffyChat): mxc
    // url lives at content.file.url. matrix-client still synthesises pbody
    // from body, so we land in the pbody branch — encryptedUrl must beat
    // top-level content.url which may not even exist for canonical clients.
    const content = {
      msgtype: "m.file",
      body: JSON.stringify({ name: "from-element.pdf", type: "application/pdf", size: 1000 }),
      pbody: { name: "from-element.pdf", type: "application/pdf", size: 1000 },
      file: { url: "mxc://element/canonical", iv: "iv", key: { k: "k" }, hashes: {} },
    };

    const info = parseFileInfo(content, "m.file");
    expect(info!.url).toBe("mxc://element/canonical");
  });

  it("treats non-string content.url as absent (defensive narrowing)", () => {
    // A malformed event with url=null should not surface "null" as a URL —
    // the typeof guard must fall through to the empty-string sentinel.
    const content = {
      msgtype: "m.file",
      pbody: { name: "x", type: "application/octet-stream", size: 0 },
      url: null,
    } as unknown as Record<string, unknown>;

    const info = parseFileInfo(content, "m.file");
    expect(info!.url).toBe("");
  });
});
