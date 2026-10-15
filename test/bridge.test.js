const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const path = require("path");
const { Bridge, matchLength, findFreePort } = require("../src/bridge");

const token = "k".repeat(48);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hook(port, phase, body, tok = token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: `/live-edits/${phase}`, method: "POST", headers: { "x-live-edits-token": tok } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function windowBridge(port, name, folders, focusedAt, calls) {
  return new Bridge({
    port,
    token,
    describe: () => ({ folders, focusedAt }),
    handle: async (phase, input) => {
      await sleep(50);
      calls.push(`${name}:${phase}:${input.tool_input.file_path}`);
    },
  });
}

const root = path.resolve("/projects");
const app = path.join(root, "app");
const api = path.join(root, "api");

test("matchLength picks the longest containing folder", () => {
  assert.strictEqual(matchLength([app], path.join(app, "src")), app.length);
  assert.strictEqual(matchLength([app], app), app.length);
  assert.strictEqual(matchLength([app], path.join(root, "app2")), -1);
  assert.strictEqual(matchLength([root, app], path.join(app, "x")), app.length);
});

test("hub routes each hook to the window holding the session's folder, and waits for it", async () => {
  const port = await findFreePort();
  const calls = [];
  const a = windowBridge(port, "A", [app], 1, calls);
  const b = windowBridge(port, "B", [api], 2, calls);
  await a.start();
  await b.start();
  try {
    assert.ok(a.isHub() && !b.isHub());
    await b.register();

    const res = await hook(port, "pre", { cwd: api, tool_input: { file_path: "api.ts" } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(calls, ["B:pre:api.ts"], "reply came after B finished");

    await hook(port, "post", { cwd: path.join(app, "src"), tool_input: { file_path: "app.ts" } });
    // No folder matches: most recently focused window (B) shows it.
    await hook(port, "fail", { cwd: path.resolve("/elsewhere"), tool_input: { file_path: "x.ts" } });
    assert.deepStrictEqual(calls, ["B:pre:api.ts", "A:post:app.ts", "B:fail:x.ts"]);
  } finally {
    await a.stop();
    await b.stop();
  }
});

test("requests without the token are refused", async () => {
  const port = await findFreePort();
  const calls = [];
  const a = windowBridge(port, "A", [app], 1, calls);
  await a.start();
  try {
    assert.strictEqual((await hook(port, "pre", { tool_input: { file_path: "f" } }, "wrong")).status, 403);
    assert.strictEqual((await hook(port, "pre", { tool_input: { file_path: "f" } }, "")).status, 403);
    assert.deepStrictEqual(calls, []);
  } finally {
    await a.stop();
  }
});

test("when the hub window closes, another window takes over the port", async () => {
  const port = await findFreePort();
  const calls = [];
  const a = windowBridge(port, "A", [app], 1, calls);
  const b = windowBridge(port, "B", [api], 2, calls);
  await a.start();
  await b.start();
  try {
    await a.stop();
    await b.register(); // what B's heartbeat does: finds the hub gone and binds the port
    assert.ok(b.isHub());
    await hook(port, "pre", { cwd: api, tool_input: { file_path: "api.ts" } });
    assert.deepStrictEqual(calls, ["B:pre:api.ts"]);
  } finally {
    await b.stop();
  }
});

test("a foreign program on the port is reported as a conflict", async () => {
  const port = await findFreePort();
  const foreign = http.createServer((req, res) => res.writeHead(404).end()).listen(port, "127.0.0.1");
  await new Promise((r) => foreign.once("listening", r));
  const a = windowBridge(port, "A", [app], 1, []);
  await a.start();
  try {
    assert.ok(!a.isHub());
    assert.ok(a.portConflict);
  } finally {
    await a.stop();
    foreign.close();
  }
});
