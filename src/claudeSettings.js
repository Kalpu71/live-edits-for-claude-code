// @ts-check
// Adds and removes this extension's http hooks in Claude Code's user settings
// (~/.claude/settings.json), leaving everything else in the file untouched.
// No VS Code APIs, so it also runs from the uninstall script and in unit tests.
const fs = require("fs");
const os = require("os");
const path = require("path");

const SETTINGS_FILE = path.join(os.homedir(), ".claude", "settings.json");
const MATCHER = "Edit|Write|MultiEdit";
const MARK = "/live-edits/";
// How long Claude Code waits for one animation. Long, because edits are typed at
// reading speed by default; the animator keeps each edit well inside it.
const HOOK_TIMEOUT_S = 900;
/** Claude Code hook event -> bridge phase */
const EVENTS = { PreToolUse: "pre", PostToolUse: "post", PostToolUseFailure: "fail" };

function isOurs(group) {
  return (group.hooks || []).some(
    (h) => h && h.type === "http" && typeof h.url === "string" && h.url.includes(MARK)
  );
}

/** Settings with every hook group this extension added removed. */
function withoutHooks(settings) {
  const s = JSON.parse(JSON.stringify(settings || {}));
  if (!s.hooks || typeof s.hooks !== "object") return s;
  for (const ev of Object.keys(EVENTS)) {
    if (!Array.isArray(s.hooks[ev])) continue;
    s.hooks[ev] = s.hooks[ev].filter((g) => !isOurs(g));
    if (s.hooks[ev].length === 0) delete s.hooks[ev];
  }
  if (Object.keys(s.hooks).length === 0) delete s.hooks;
  return s;
}

/**
 * Settings with this extension's hooks pointing at the bridge on `port`.
 * @param {{ port: number, token: string }} bridge
 */
function withHooks(settings, bridge) {
  const s = withoutHooks(settings);
  s.hooks = s.hooks || {};
  for (const [ev, phase] of Object.entries(EVENTS)) {
    s.hooks[ev] = s.hooks[ev] || [];
    s.hooks[ev].push({
      matcher: MATCHER,
      hooks: [
        {
          type: "http",
          url: `http://127.0.0.1:${bridge.port}${MARK}${phase}`,
          headers: { "X-Live-Edits-Token": bridge.token },
          timeout: HOOK_TIMEOUT_S,
        },
      ],
    });
  }
  return s;
}

/** The port our installed hooks point at, or null when they aren't installed. */
function installedPort(settings) {
  for (const ev of Object.keys(EVENTS)) {
    for (const g of (settings && settings.hooks && settings.hooks[ev]) || []) {
      if (!isOurs(g)) continue;
      const m = /:(\d+)\//.exec(g.hooks.find((h) => h.url && h.url.includes(MARK)).url);
      return m ? Number(m[1]) : null;
    }
  }
  return null;
}

/** Parsed settings; {} when the file doesn't exist. Throws on invalid JSON. */
function readSettings(file = SETTINGS_FILE) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  return raw.trim() ? JSON.parse(raw) : {};
}

/** Writes settings atomically, keeping the previous version as settings.json.live-edits.bak. */
function writeSettings(settings, file = SETTINGS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".live-edits.bak");
  const tmp = file + ".live-edits.tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

module.exports = {
  SETTINGS_FILE,
  MATCHER,
  withHooks,
  withoutHooks,
  installedPort,
  readSettings,
  writeSettings,
};
