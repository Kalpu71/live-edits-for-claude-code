// @ts-check
// Runs (as plain Node) when the extension is uninstalled: removes its hooks from
// Claude Code's settings and deletes the bridge's port/token file, so nothing is
// left pointing at a server that no longer exists. Skipped while another editor
// (or another build) still has the extension installed, since the hooks and the
// bridge file are shared by all of them.
const fs = require("fs");
const os = require("os");
const path = require("path");
const claude = require("./claudeSettings");
const { CONFIG_FILE } = require("./bridge");

const EDITOR_DIRS = [".vscode", ".vscode-insiders", ".vscode-oss", ".cursor", ".windsurf", ".vscodium", ".trae"];
const FOLDER = /\.live-edits-for-claude-code-\d/;

/**
 * Whether a copy of this extension other than `selfDir` is installed in any editor.
 * Folders an editor has marked for removal (listed in its extensions/.obsolete) don't count.
 */
function otherInstallExists(home = os.homedir(), selfDir = path.resolve(__dirname, "..")) {
  for (const dir of EDITOR_DIRS) {
    const root = path.join(home, dir, "extensions");
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    let obsolete = {};
    try {
      obsolete = JSON.parse(fs.readFileSync(path.join(root, ".obsolete"), "utf8"));
    } catch {}
    for (const name of names) {
      if (!FOLDER.test(name) || obsolete[name]) continue;
      if (path.resolve(root, name).toLowerCase() !== selfDir.toLowerCase()) return true;
    }
  }
  return false;
}

function cleanUp() {
  if (otherInstallExists()) return;
  try {
    const settings = claude.readSettings();
    if (claude.installedPort(settings) !== null) claude.writeSettings(claude.withoutHooks(settings));
  } catch (e) {
    console.error(`live-edits: could not clean ${claude.SETTINGS_FILE}: ${e}`);
  }
  fs.rmSync(path.dirname(CONFIG_FILE), { recursive: true, force: true });
}

if (require.main === module) cleanUp();

module.exports = { otherInstallExists };
