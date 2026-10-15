// @ts-check
// Live Edits for Claude Code: wires the hook bridge to the animator and offers the
// commands, status bar toggle and first-run prompt that install the hooks into
// Claude Code's settings.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { Bridge, loadBridgeConfig, saveBridgeConfig, findFreePort, CONFIG_FILE } = require("./bridge");
const { Animator } = require("./animator");
const claude = require("./claudeSettings");

const DONT_ASK_KEY = "liveEdits.dontAskToEnable";

/** @param {vscode.ExtensionContext} ctx */
async function activate(ctx) {
  const output = vscode.window.createOutputChannel("Live Edits for Claude Code");
  const log = (msg) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
  const animator = new Animator();
  let focusedAt = vscode.window.state.focused ? Date.now() : 0;
  const describe = () => ({
    folders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
    focusedAt,
  });

  let config = loadBridgeConfig();
  /** @type {Bridge} */
  let bridge;
  const startBridge = async () => {
    bridge = new Bridge({
      port: config.port,
      token: config.token,
      handle: (phase, input) => animator.handle(phase, input),
      describe,
      log,
    });
    await bridge.start();
  };
  await startBridge();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const installed = () => {
    try {
      return claude.installedPort(claude.readSettings()) === config.port;
    } catch {
      return false;
    }
  };
  const refreshStatus = () => {
    const on = vscode.workspace.getConfiguration("liveEdits").get("enabled", true);
    if (animator.busyWith) {
      status.text = `$(keyboard) Typing ${animator.busyWith}… $(debug-step-over)`;
      status.tooltip = "Click to finish this edit instantly. The next edit plays normally.";
      status.command = "liveEdits.skip";
    } else if (!installed()) {
      status.text = "$(keyboard) Live Edits: set up";
      status.tooltip = "Click to let Claude Code's edits be typed out live in this editor";
      status.command = "liveEdits.enable";
    } else if (bridge.portConflict) {
      status.text = "$(warning) Live Edits";
      status.tooltip = `Another program is using port ${config.port}. Click to pick a new port.`;
      status.command = "liveEdits.enable";
    } else {
      status.text = on ? "$(keyboard) Live Edits" : "$(debug-pause) Live Edits";
      status.tooltip = on
        ? "Claude Code's edits are typed out live. Click to pause."
        : "Paused: Claude Code's edits apply instantly. Click to resume.";
      status.command = "liveEdits.toggle";
    }
    status.show();
  };

  const enable = async () => {
    try {
      if (bridge.portConflict) {
        config = saveBridgeConfig({ ...config, port: await findFreePort() });
        await bridge.stop();
        await startBridge();
      }
      claude.writeSettings(claude.withHooks(claude.readSettings(), config));
      await vscode.workspace.getConfiguration("liveEdits").update("enabled", true, vscode.ConfigurationTarget.Global);
      log(`hooks installed in ${claude.SETTINGS_FILE} (port ${config.port})`);
      vscode.window.showInformationMessage(
        "Live Edits is on. Claude Code's next edits will be typed out here (start a new Claude chat if one is already running)."
      );
    } catch (e) {
      vscode.window.showErrorMessage(`Live Edits couldn't update ${claude.SETTINGS_FILE}: ${e.message}`);
    }
    refreshStatus();
  };

  const remove = async () => {
    try {
      claude.writeSettings(claude.withoutHooks(claude.readSettings()));
      log("hooks removed");
      vscode.window.showInformationMessage("Live Edits removed from Claude Code. Edits now apply instantly.");
    } catch (e) {
      vscode.window.showErrorMessage(`Live Edits couldn't update ${claude.SETTINGS_FILE}: ${e.message}`);
    }
    refreshStatus();
  };

  const toggle = async () => {
    const c = vscode.workspace.getConfiguration("liveEdits");
    await c.update("enabled", !c.get("enabled", true), vscode.ConfigurationTarget.Global);
  };

  // Another window may change the port or token (e.g. after a port conflict).
  const configWatcher = () => {
    const latest = loadBridgeConfig();
    if (latest.port === config.port && latest.token === config.token) return;
    config = latest;
    bridge.stop().then(startBridge).then(refreshStatus, (e) => log(`restart failed: ${e}`));
  };
  fs.watchFile(CONFIG_FILE, { interval: 3000 }, configWatcher);
  // Settings edits and port conflicts both show up within a few seconds.
  const statusTimer = setInterval(refreshStatus, 5000);

  ctx.subscriptions.push(
    output,
    status,
    { dispose: () => animator.dispose() },
    { dispose: () => void bridge.stop() },
    { dispose: () => fs.unwatchFile(CONFIG_FILE, configWatcher) },
    { dispose: () => clearInterval(statusTimer) },
    vscode.commands.registerCommand("liveEdits.enable", enable),
    vscode.commands.registerCommand("liveEdits.disable", remove),
    vscode.commands.registerCommand("liveEdits.toggle", toggle),
    vscode.commands.registerCommand("liveEdits.skip", () => animator.skip()),
    vscode.commands.registerCommand("liveEdits.showLog", () => output.show()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("liveEdits")) refreshStatus();
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        focusedAt = Date.now();
        if (!bridge.isHub()) void bridge.register();
      }
    })
  );
  animator.onBusy = refreshStatus;
  refreshStatus();

  // First run: offer to install the hooks, but only where Claude Code is around.
  const claudeAround =
    !!vscode.extensions.getExtension("anthropic.claude-code") || fs.existsSync(path.dirname(claude.SETTINGS_FILE));
  if (claudeAround && !installed() && !ctx.globalState.get(DONT_ASK_KEY)) {
    const choice = await vscode.window.showInformationMessage(
      "Live Edits can type out Claude Code's edits in your editor, letter by letter. Turn it on? " +
        "This adds three hooks to ~/.claude/settings.json (a backup is kept).",
      "Turn on",
      "Not now",
      "Don't ask again"
    );
    if (choice === "Turn on") await enable();
    else if (choice === "Don't ask again") await ctx.globalState.update(DONT_ASK_KEY, true);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
