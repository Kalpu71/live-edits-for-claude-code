const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { otherInstallExists } = require("../src/uninstall");

function fakeHome(layout) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "live-edits-home-"));
  for (const [dir, names, obsolete] of layout) {
    const root = path.join(home, dir, "extensions");
    fs.mkdirSync(root, { recursive: true });
    for (const n of names) fs.mkdirSync(path.join(root, n));
    if (obsolete) fs.writeFileSync(path.join(root, ".obsolete"), JSON.stringify(obsolete));
  }
  return home;
}

test("the copy being uninstalled doesn't count as another install", () => {
  const home = fakeHome([[".cursor", ["kalpu71.live-edits-for-claude-code-0.1.1", "someone.other-ext-1.0.0"]]]);
  const self = path.join(home, ".cursor", "extensions", "kalpu71.live-edits-for-claude-code-0.1.1");
  assert.strictEqual(otherInstallExists(home, self), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a copy in another editor keeps the hooks", () => {
  const home = fakeHome([
    [".cursor", ["kalpu71.live-edits-for-claude-code-0.1.1"]],
    [".vscode", ["kalpu71.live-edits-for-claude-code-0.1.1"]],
  ]);
  const self = path.join(home, ".vscode", "extensions", "kalpu71.live-edits-for-claude-code-0.1.1");
  assert.strictEqual(otherInstallExists(home, self), true);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a different build in the same editor keeps the hooks, removed folders don't", () => {
  const swapped = fakeHome([
    [".cursor", ["local.live-edits-for-claude-code-0.1.0", "kalpu71.live-edits-for-claude-code-0.1.1"], { "local.live-edits-for-claude-code-0.1.0": true }],
  ]);
  const local = path.join(swapped, ".cursor", "extensions", "local.live-edits-for-claude-code-0.1.0");
  assert.strictEqual(otherInstallExists(swapped, local), true);
  fs.rmSync(swapped, { recursive: true, force: true });

  const leftovers = fakeHome([
    [".cursor", ["kalpu71.live-edits-for-claude-code-0.1.0", "kalpu71.live-edits-for-claude-code-0.1.1"], { "kalpu71.live-edits-for-claude-code-0.1.0": true }],
  ]);
  const current = path.join(leftovers, ".cursor", "extensions", "kalpu71.live-edits-for-claude-code-0.1.1");
  assert.strictEqual(otherInstallExists(leftovers, current), false);
  fs.rmSync(leftovers, { recursive: true, force: true });
});
