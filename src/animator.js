// @ts-check
// Shows one Claude Code edit in the editor:
//   pre  - open the file beside the chat, highlight the lines about to change (red),
//          strike through the exact text that goes, backspace it, then type the
//          replacement into the unsaved buffer
//   post - the real edit is on disk now: revert the buffer to disk (same text, so no
//          visible jump), highlight the new lines (green), close the file, and return
//          to the chat after a short idle. New files are typed out here.
//   fail - the edit failed or was denied: put the buffer back, close the file
// The bridge replies to Claude Code only when a phase finishes, so the real edit
// happens after the animation.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { lineOf, predictFinalText, changedRegion, typingPlan, deletionPlan, play } = require("./typing");

const WATCHDOG_MS = 180_000;
const DOOM_MS = 700;
const RETURN_IDLE_MS = 1500;
// Claude Code waits at most 15 minutes for a hook (see claudeSettings.js). Even with
// speed-up off, one edit's typing and deleting stay well inside that, so the real
// edit never lands while the animation is still running.
const SAFE_TYPE_MS = 12 * 60_000;
const SAFE_DELETE_MS = 60_000;
const FAST_DELETE_MS = 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (/** @type {vscode.Uri} */ uri) =>
  process.platform === "linux" ? path.resolve(uri.fsPath) : path.resolve(uri.fsPath).toLowerCase();

function settings() {
  const c = vscode.workspace.getConfiguration("liveEdits");
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || lo));
  const speedUp = c.get("speedUpLongEdits", false);
  return {
    enabled: c.get("enabled", true),
    typeMs: 1000 / clamp(c.get("typingSpeed", 14), 2, 200),
    delMs: 1000 / clamp(c.get("deleteSpeed", 16), 2, 200),
    holdMs: clamp(c.get("pauseBefore", 1.8), 0, 10) * 1000,
    afterMs: clamp(c.get("pauseAfter", 2), 0, 10) * 1000,
    typeMaxMs: speedUp ? clamp(c.get("maxTypingSeconds", 45), 1, 600) * 1000 : SAFE_TYPE_MS,
    delMaxMs: speedUp ? FAST_DELETE_MS : SAFE_DELETE_MS,
    closeFiles: c.get("closeFilesAfterEdit", true),
    returnToChat: c.get("returnToChat", true),
  };
}

class Animator {
  constructor() {
    const line = (rgba) =>
      vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: `rgba(${rgba}, 0.22)`,
        overviewRulerColor: `rgba(${rgba}, 0.8)`,
        overviewRulerLane: vscode.OverviewRulerLane.Full,
      });
    this.oldDeco = line("255, 80, 80");
    this.newDeco = line("60, 200, 120");
    this.typingDeco = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(60, 200, 120, 0.28)",
    });
    this.deletingDeco = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(255, 80, 80, 0.35)",
      textDecoration: "line-through",
    });
    this.caretDeco = vscode.window.createTextEditorDecorationType({
      before: { contentText: "▏", color: new vscode.ThemeColor("editorCursor.foreground"), fontWeight: "bold" },
    });
    this.allDecos = [this.oldDeco, this.newDeco, this.typingDeco, this.deletingDeco, this.caretDeco];
    /** Files this extension opened (and so may close). */
    this.openedByUs = new Set();
    /** Files whose buffer differs from disk until reverted -> watchdog timer. */
    this.animated = new Map();
    /** Files Claude is about to create. */
    this.pendingNew = new Set();
    /** While a buffer is being animated: the file's real bytes on disk, restored if the user saves mid-animation. */
    this.diskBytes = new Map();
    this.returnTimer = undefined;
    /** @type {vscode.Tab | null} */
    this.chatTab = null;
    /** Set by skip(): finish the current edit at once. */
    this.rushing = false;
    /** Resolvers of pauses in progress, so skip() can cut them short. */
    this.wakers = new Set();
    /** Name of the file being animated, or null. */
    this.busyWith = null;
    /** Called when busyWith changes. */
    this.onBusy = () => {};
    this.saveListener = vscode.workspace.onDidSaveTextDocument((doc) => this.protectDisk(doc));
  }

  dispose() {
    clearTimeout(this.returnTimer);
    for (const t of this.animated.values()) clearTimeout(t);
    for (const d of this.allDecos) d.dispose();
    this.saveListener.dispose();
  }

  /** Entry point for the bridge. */
  async handle(phase, input) {
    const ti = (input && input.tool_input) || {};
    if (typeof ti.file_path !== "string") return;
    const uri = vscode.Uri.file(ti.file_path);
    const s = settings();
    this.rushing = false;
    this.setBusy(phase === "fail" ? null : path.basename(uri.fsPath));
    try {
      if (phase === "pre") {
        if (s.enabled) await this.pre(uri, input, s);
      } else if (phase === "post") {
        if (s.enabled) await this.post(uri, ti, s);
        else await this.revert(uri);
      } else if (phase === "fail") {
        await this.fail(uri, s);
      }
    } finally {
      this.setBusy(null);
    }
  }

  /** Finish the edit being shown right away: remaining keystrokes at once, pauses cut short. */
  skip() {
    if (!this.busyWith) return;
    this.rushing = true;
    for (const wake of [...this.wakers]) wake();
  }

  setBusy(name) {
    if (this.busyWith === name) return;
    this.busyWith = name;
    this.onBusy();
  }

  /** A pause that skip() can cut short. */
  wait(ms) {
    if (this.rushing || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.wakers.delete(wake);
        resolve(undefined);
      };
      const timer = setTimeout(wake, ms);
      this.wakers.add(wake);
    });
  }

  /**
   * The user saved a buffer while it held half-typed text: put the real content back
   * on disk and finish the animation, so a partial file never stays saved.
   * @param {vscode.TextDocument} doc
   */
  protectDisk(doc) {
    if (doc.uri.scheme !== "file") return;
    const bytes = this.diskBytes.get(keyOf(doc.uri));
    if (!bytes) return;
    fs.writeFileSync(doc.uri.fsPath, bytes);
    this.skip();
  }

  // --- phases ---------------------------------------------------------------

  async pre(uri, input, s) {
    clearTimeout(this.returnTimer);
    if (!this.chatTab) this.chatTab = this.findChatTab();
    if (!fs.existsSync(uri.fsPath)) {
      this.pendingNew.add(keyOf(uri));
      return;
    }
    const ti = input.tool_input;
    const edit = (ti.edits && ti.edits[0]) || ti;
    const bytes = fs.readFileSync(uri.fsPath);
    const text = bytes.toString("utf8").replace(/^﻿/, "");
    const editor = await this.show(uri);
    this.highlight(editor, this.oldDeco, this.rangeOf(editor.document, edit.old_string), lineOf(text, edit.old_string));
    await this.wait(s.holdMs);

    const fin = predictFinalText(text, input.tool_name, ti);
    const doc = editor.document;
    if (fin != null && fin !== text && this.canAnimate(doc) && doc.getText() === text) {
      this.diskBytes.set(keyOf(uri), bytes);
      await this.typeInto(uri, text, fin, s);
    }
  }

  async post(uri, ti, s) {
    clearTimeout(this.returnTimer);
    if (!this.chatTab) this.chatTab = this.findChatTab();
    const key = keyOf(uri);
    const edit = (ti.edits && ti.edits[0]) || ti;

    if (this.animated.has(key)) {
      await this.revert(uri);
    } else if (this.pendingNew.delete(key)) {
      // Brand-new file: empty the buffer before it is shown, then type it out.
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      if (text && this.canAnimate(doc)) {
        this.diskBytes.set(key, fs.readFileSync(uri.fsPath));
        await this.replaceOffsets(uri, 0, text.length, "");
        await this.show(uri);
        await this.typeInto(uri, "", text, s);
        await this.revert(uri);
      }
    }

    let editor = await this.show(uri);
    // The file changed on disk; wait for the editor to show the new text.
    const needle = edit.new_string;
    let range = this.rangeOf(editor.document, needle);
    for (let i = 0; !range && needle && i < 30; i++) {
      await sleep(100);
      editor = this.editorsFor(uri)[0] || editor;
      range = this.rangeOf(editor.document, needle);
    }
    this.highlight(editor, this.newDeco, range, lineOf(editor.document.getText(), needle));
    await this.wait(s.afterMs);
    await this.finish(uri, s);
  }

  async fail(uri, s) {
    this.pendingNew.delete(keyOf(uri));
    await this.revert(uri);
    await this.finish(uri, s);
  }

  /** Clear highlights, close the file if we opened it, and head back to the chat soon. */
  async finish(uri, s) {
    this.clearDecos();
    const key = keyOf(uri);
    if (s.closeFiles && this.openedByUs.has(key)) {
      const tab = this.tabFor(uri);
      if (tab && !tab.isDirty) await vscode.window.tabGroups.close(tab, true);
    }
    this.openedByUs.delete(key);
    clearTimeout(this.returnTimer);
    if (s.returnToChat) this.returnTimer = setTimeout(() => this.returnToChat(), RETURN_IDLE_MS);
  }

  // --- typing ---------------------------------------------------------------

  /** Turns the buffer text `cur` into `fin` on screen: backspace the changed part, then type the rest. */
  async typeInto(uri, cur, fin, s) {
    const { start, end: delEnd, insert } = changedRegion(cur, fin);
    const key = keyOf(uri);
    clearTimeout(this.animated.get(key));
    this.animated.set(key, undefined); // the buffer is about to differ from disk

    const removed = cur.slice(start, delEnd);
    if (removed.length > 0) {
      let end = delEnd;
      const paintDoomed = () => {
        const doc = this.docFor(uri);
        if (!doc) return;
        const range = new vscode.Range(doc.positionAt(start), doc.positionAt(end));
        for (const e of this.editorsFor(uri)) {
          e.setDecorations(this.oldDeco, []);
          e.setDecorations(this.typingDeco, []);
          e.setDecorations(this.deletingDeco, end > start ? [range] : []);
          e.setDecorations(this.caretDeco, [new vscode.Range(range.end, range.end)]);
          e.revealRange(new vscode.Range(range.end, range.end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
      };
      paintDoomed();
      await this.wait(DOOM_MS); // show exactly what will go before it goes
      await play(
        deletionPlan(removed, s.delMs),
        s.delMaxMs,
        async (batch) => {
          const size = batch.reduce((t, k) => t + k.size, 0);
          await this.replaceOffsets(uri, end - size, end, "");
          end -= size;
          paintDoomed();
        },
        (ms) => this.wait(ms),
        () => this.rushing
      );
      for (const e of this.editorsFor(uri)) e.setDecorations(this.deletingDeco, []);
      if (insert.length > 0) await this.wait(s.typeMs * 6); // a beat before typing the replacement
    } else {
      for (const e of this.editorsFor(uri)) e.setDecorations(this.oldDeco, []);
    }

    if (insert.length > 0) {
      let typed = 0;
      this.paintTyping(uri, start, start);
      await play(
        typingPlan(insert, s.typeMs),
        s.typeMaxMs,
        async (batch) => {
          const text = batch.map((k) => k.text).join("");
          await this.replaceOffsets(uri, start + typed, start + typed, text);
          typed += text.length;
          this.paintTyping(uri, start, start + typed);
        },
        (ms) => this.wait(ms),
        () => this.rushing
      );
    }
    for (const e of this.editorsFor(uri)) e.setDecorations(this.caretDeco, []);
    // If the real edit never arrives (denied, cancelled), put the file back.
    this.animated.set(key, setTimeout(() => this.revert(uri), WATCHDOG_MS));
  }

  paintTyping(uri, start, end) {
    const doc = this.docFor(uri);
    if (!doc) return;
    const range = new vscode.Range(doc.positionAt(start), doc.positionAt(end));
    const caret = new vscode.Range(range.end, range.end);
    for (const e of this.editorsFor(uri)) {
      e.setDecorations(this.typingDeco, end > start ? [range] : []);
      e.setDecorations(this.caretDeco, [caret]);
      e.revealRange(caret, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  async replaceOffsets(uri, start, end, text) {
    const doc = this.docFor(uri);
    if (!doc) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(start), doc.positionAt(end)), text);
    await vscode.workspace.applyEdit(edit);
  }

  /** Drop the unsaved animation and reload the file from disk. */
  async revert(uri) {
    const key = keyOf(uri);
    if (!this.animated.has(key)) return;
    clearTimeout(this.animated.get(key));
    this.animated.delete(key);
    this.diskBytes.delete(key);
    const doc = this.docFor(uri);
    if (!doc || !doc.isDirty) return;
    const column = (this.editorsFor(uri)[0] || {}).viewColumn;
    await vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus: false, preview: false });
    await vscode.commands.executeCommand("workbench.action.files.revert");
  }

  // --- editor helpers ---------------------------------------------------------

  /** Typing goes into the unsaved buffer, so never with auto-save on or over the user's own unsaved work. */
  canAnimate(doc) {
    const autoSave = vscode.workspace.getConfiguration("files", doc.uri).get("autoSave", "off");
    return autoSave === "off" && !doc.isDirty;
  }

  async show(uri) {
    const existing = this.editorsFor(uri)[0];
    if (existing) return existing;
    if (!this.tabFor(uri)) this.openedByUs.add(keyOf(uri));
    // Keep the chat visible: if it lives in an editor tab, open the file beside it.
    const active = vscode.window.tabGroups.activeTabGroup.activeTab;
    const chatIsActive = !!active && active.input instanceof vscode.TabInputWebview;
    if (chatIsActive) this.chatTab = active;
    const doc = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(doc, {
      viewColumn: chatIsActive ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
      preview: false,
      preserveFocus: true,
    });
  }

  highlight(editor, deco, range, fallbackLine) {
    this.clearDecos();
    if (range) {
      editor.setDecorations(deco, [range]);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } else {
      const line = Math.max(0, (fallbackLine || 1) - 1);
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
    }
  }

  clearDecos() {
    for (const e of vscode.window.visibleTextEditors) for (const d of this.allDecos) e.setDecorations(d, []);
  }

  rangeOf(doc, needle) {
    if (!needle) return null;
    const text = doc.getText();
    let idx = text.indexOf(needle);
    if (idx < 0 && text.includes("\r\n")) {
      needle = needle.replace(/\r?\n/g, "\r\n");
      idx = text.indexOf(needle);
    }
    if (idx < 0) return null;
    return new vscode.Range(doc.positionAt(idx), doc.positionAt(idx + needle.length));
  }

  docFor(uri) {
    const key = keyOf(uri);
    return vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && keyOf(d.uri) === key);
  }

  editorsFor(uri) {
    const key = keyOf(uri);
    return vscode.window.visibleTextEditors.filter((e) => e.document.uri.scheme === "file" && keyOf(e.document.uri) === key);
  }

  tabFor(uri) {
    const key = keyOf(uri);
    for (const g of vscode.window.tabGroups.all)
      for (const t of g.tabs)
        if (t.input instanceof vscode.TabInputText && keyOf(t.input.uri) === key) return t;
    return null;
  }

  findChatTab() {
    for (const g of vscode.window.tabGroups.all)
      for (const t of g.tabs)
        if (t.input instanceof vscode.TabInputWebview && /claude/i.test(t.input.viewType)) return t;
    return null;
  }

  async returnToChat() {
    const tab = this.findChatTab() || this.chatTab;
    this.chatTab = null;
    if (!tab) {
      // Chat is in the side bar; put the cursor back in its input.
      await vscode.commands.executeCommand("claude-vscode.focus").then(undefined, () => {});
      return;
    }
    if (tab.isActive && tab.group.isActive) return;
    const focusGroup = [
      "workbench.action.focusFirstEditorGroup",
      "workbench.action.focusSecondEditorGroup",
      "workbench.action.focusThirdEditorGroup",
      "workbench.action.focusFourthEditorGroup",
    ][(tab.group.viewColumn || 1) - 1];
    if (focusGroup) await vscode.commands.executeCommand(focusGroup);
    const index = tab.group.tabs.indexOf(tab);
    if (index >= 0) await vscode.commands.executeCommand("workbench.action.openEditorAtIndex", index);
  }
}

module.exports = { Animator };
