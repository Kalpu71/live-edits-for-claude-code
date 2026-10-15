// @ts-check
// Runs (as plain Node) when the extension is uninstalled: removes its hooks from
// Claude Code's settings and deletes the bridge's port/token file, so nothing is
// left pointing at a server that no longer exists.
const fs = require("fs");
const path = require("path");
const claude = require("./claudeSettings");
const { CONFIG_FILE } = require("./bridge");

try {
  const settings = claude.readSettings();
  if (claude.installedPort(settings) !== null) claude.writeSettings(claude.withoutHooks(settings));
} catch (e) {
  console.error(`live-edits: could not clean ${claude.SETTINGS_FILE}: ${e}`);
}
fs.rmSync(path.dirname(CONFIG_FILE), { recursive: true, force: true });
