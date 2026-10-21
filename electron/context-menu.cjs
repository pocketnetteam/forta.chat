/**
 * Right-click menu and F5 for the app window.
 *
 * Electron shows no context menu of its own, so a right click in the message
 * field offered no Paste (the usual way to paste on Linux), and F5 did nothing
 * (audit S8-04).
 */

/**
 * Menu items for a right click, from Electron's context-menu params.
 * @param {{ isEditable: boolean, selectionText: string, editFlags: Record<string, boolean> }} params
 * @returns {Array<{ role: string, enabled?: boolean } | { type: "separator" }>}
 */
function contextMenuTemplate(params) {
  const flags = params.editFlags || {};
  if (params.isEditable) {
    return [
      { role: "cut", enabled: !!flags.canCut },
      { role: "copy", enabled: !!flags.canCopy },
      { role: "paste", enabled: !!flags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: flags.canSelectAll !== false },
    ];
  }
  if (params.selectionText && params.selectionText.trim()) {
    return [{ role: "copy", enabled: flags.canCopy !== false }];
  }
  return [];
}

/**
 * Whether a key press should reload the window: plain F5.
 * @param {{ type: string, key: string, control?: boolean, meta?: boolean, alt?: boolean, shift?: boolean }} input
 * @returns {boolean}
 */
function isReloadKey(input) {
  return input.type === "keyDown" && input.key === "F5" && !input.control && !input.meta && !input.alt;
}

/**
 * @param {import("electron").BrowserWindow} win
 * @param {typeof import("electron").Menu} Menu
 */
function wireContextMenuAndReload(win, Menu) {
  win.webContents.on("context-menu", (_event, params) => {
    const template = contextMenuTemplate(params);
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (!isReloadKey(input)) return;
    event.preventDefault();
    win.webContents.reload();
  });
}

module.exports = { contextMenuTemplate, isReloadKey, wireContextMenuAndReload };
