const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const claude = require("../src/claudeSettings");

const bridge = { port: 47821, token: "t".repeat(48) };
const userSettings = {
  model: "opus",
  permissions: { allow: ["Bash(git *)"] },
  hooks: {
    PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "prettier --write" }] }],
    Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
  },
};

test("withHooks adds pre/post/fail http hooks and keeps the user's own", () => {
  const s = claude.withHooks(userSettings, bridge);
  assert.strictEqual(s.model, "opus");
  assert.deepStrictEqual(s.permissions, userSettings.permissions);
  assert.deepStrictEqual(s.hooks.Stop, userSettings.hooks.Stop);
  assert.strictEqual(s.hooks.PostToolUse.length, 2);
  assert.strictEqual(s.hooks.PostToolUse[0].hooks[0].command, "prettier --write");
  const ours = s.hooks.PreToolUse[0].hooks[0];
  assert.strictEqual(ours.type, "http");
  assert.strictEqual(ours.url, "http://127.0.0.1:47821/live-edits/pre");
  assert.strictEqual(ours.headers["X-Live-Edits-Token"], bridge.token);
  assert.strictEqual(ours.timeout, 900, "long enough for reading-speed typing");
  assert.strictEqual(s.hooks.PostToolUseFailure[0].hooks[0].url, "http://127.0.0.1:47821/live-edits/fail");
  assert.strictEqual(claude.installedPort(s), 47821);
  assert.deepStrictEqual(userSettings.hooks.PreToolUse, undefined, "input not mutated");
});

test("withHooks twice doesn't duplicate, and a new port replaces the old", () => {
  const twice = claude.withHooks(claude.withHooks(userSettings, bridge), { ...bridge, port: 50000 });
  assert.strictEqual(twice.hooks.PreToolUse.length, 1);
  assert.strictEqual(twice.hooks.PostToolUse.length, 2);
  assert.strictEqual(claude.installedPort(twice), 50000);
});

test("withoutHooks restores the original settings exactly", () => {
  assert.deepStrictEqual(claude.withoutHooks(claude.withHooks(userSettings, bridge)), userSettings);
  assert.deepStrictEqual(claude.withoutHooks(claude.withHooks({}, bridge)), {});
  assert.strictEqual(claude.installedPort(userSettings), null);
});

test("read/write keep a backup, handle a missing file and reject broken JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-edits-"));
  const file = path.join(dir, "settings.json");
  assert.deepStrictEqual(claude.readSettings(file), {});
  claude.writeSettings({ a: 1 }, file);
  claude.writeSettings({ a: 2 }, file);
  assert.deepStrictEqual(claude.readSettings(file), { a: 2 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file + ".live-edits.bak", "utf8")), { a: 1 });
  fs.writeFileSync(file, "﻿{\"bom\": true}");
  assert.deepStrictEqual(claude.readSettings(file), { bom: true });
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => claude.readSettings(file));
  fs.rmSync(dir, { recursive: true, force: true });
});
