// @ts-check
// Local HTTP bridge between Claude Code's http hooks and the editor windows.
//
// Claude Code posts every hook to one fixed port (written into ~/.claude/settings.json).
// The first editor window to bind that port is the hub; every window, the hub
// included, also listens on a private ephemeral port. Other windows register with the
// hub every couple of seconds, and the hub forwards each hook to the window whose
// workspace contains the Claude session's cwd (else the most recently focused one).
// When the hub window closes, the next window to notice binds the port and takes over.
//
// Every request must carry the shared token, so other local programs and web pages
// can't drive the editor. No VS Code APIs here, so it is unit-tested with plain Node.
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PREFIX = "/live-edits";
const TOKEN_HEADER = "x-live-edits-token";
const PHASES = ["pre", "post", "fail"];
const HEARTBEAT_MS = 2000;
const STALE_MS = 7000;
// Just over the hook timeout Claude Code is given (claudeSettings.js), so a forwarded
// animation is never cut off before Claude Code itself gives up.
const FORWARD_TIMEOUT_MS = 905_000;
const DEFAULT_PORT = 47821;

const CONFIG_FILE = path.join(os.homedir(), ".claude", "live-edits", "bridge.json");

/**
 * Port and token shared by all windows and by the hooks in Claude's settings.
 * Created on first use.
 * @returns {{ port: number, token: string }}
 */
function loadBridgeConfig(file = CONFIG_FILE) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Number.isInteger(cfg.port) && typeof cfg.token === "string" && cfg.token.length >= 32) return cfg;
  } catch {}
  return saveBridgeConfig({ port: DEFAULT_PORT, token: crypto.randomBytes(24).toString("hex") }, file);
}

/** @param {{ port: number, token: string }} cfg */
function saveBridgeConfig(cfg, file = CONFIG_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return cfg;
}

/** A port nothing is listening on right now. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
    });
  });
}

/** @param {http.Server} server @returns {Promise<number>} */
function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (/** @type {Error} */ e) => reject(e);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}

/** @param {http.IncomingMessage} req @returns {Promise<string>} */
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** @returns {Promise<{ status: number, body: string }>} */
function postJson(port, urlPath, token, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method: "POST",
        headers: { "content-type": "application/json", [TOKEN_HEADER]: token },
        timeout: timeoutMs,
        agent: false, // a reused socket to a closed hub fails with a reset instead of a clean refusal
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

function samePath(a, b) {
  return process.platform === "linux" ? a === b : a.toLowerCase() === b.toLowerCase();
}

/** Length of the longest workspace folder containing `cwd`, or -1. */
function matchLength(folders, cwd) {
  let best = -1;
  for (const f of folders || []) {
    const folder = path.resolve(f);
    const dir = path.resolve(cwd);
    if (samePath(dir, folder) || samePath(dir.slice(0, folder.length + 1), folder + path.sep))
      best = Math.max(best, folder.length);
  }
  return best;
}

/**
 * @typedef {{ folders: string[], focusedAt: number }} WindowInfo
 * @typedef {{ id: string, port: number, seenAt: number } & WindowInfo} Peer
 */

class Bridge {
  /**
   * @param {{
   *   port: number,
   *   token: string,
   *   handle: (phase: string, input: any) => Promise<void>,
   *   describe: () => WindowInfo,
   *   log?: (msg: string) => void,
   * }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.id = crypto.randomUUID();
    /** @type {Map<string, Peer>} */
    this.peers = new Map();
    /** @type {http.Server | null} */
    this.hubServer = null;
    /** @type {http.Server | null} */
    this.privateServer = null;
    this.privatePort = 0;
    /** Set when the hub port answers but isn't one of us (another program owns it). */
    this.portConflict = false;
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
  }

  log(msg) {
    if (this.opts.log) this.opts.log(msg);
  }

  isHub() {
    return this.hubServer !== null;
  }

  async start() {
    this.privateServer = http.createServer((req, res) => this.serve(req, res, false));
    this.privatePort = await listen(this.privateServer, 0);
    await this.tryBecomeHub();
    if (!this.isHub()) await this.register();
    this.timer = setInterval(() => this.tick(), HEARTBEAT_MS);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await Promise.all(
      [this.hubServer, this.privateServer].map(
        (s) =>
          s &&
          new Promise((r) => {
            s.close(() => r(undefined));
            s.closeAllConnections();
          })
      )
    );
    this.hubServer = null;
    this.privateServer = null;
  }

  async tryBecomeHub() {
    const srv = http.createServer((req, res) => this.serve(req, res, true));
    try {
      await listen(srv, this.opts.port);
      this.hubServer = srv;
      this.portConflict = false;
      this.log(`hub on port ${this.opts.port}`);
      return true;
    } catch (e) {
      if (/** @type {any} */ (e).code !== "EADDRINUSE") this.log(`hub bind failed: ${e}`);
      return false;
    }
  }

  /** Tell the hub this window exists; the hub keeps it while heartbeats arrive. */
  async register() {
    const body = JSON.stringify({ id: this.id, port: this.privatePort, ...this.opts.describe() });
    try {
      const res = await postJson(this.opts.port, `${PREFIX}/register`, this.opts.token, body, 1500);
      this.portConflict = res.status !== 200;
      return true;
    } catch {
      // The hub is unreachable (its window closed): take over. If it is in fact
      // still there, binding just fails and we try again on the next heartbeat.
      await this.tryBecomeHub();
      return false;
    }
  }

  async tick() {
    if (this.isHub()) {
      const cutoff = Date.now() - STALE_MS;
      for (const [id, p] of this.peers) if (p.seenAt < cutoff) this.peers.delete(id);
    } else await this.register();
  }

  /** The window that should show an edit made from `cwd`: "self" or a peer. */
  route(cwd) {
    const self = { id: this.id, port: this.privatePort, seenAt: Date.now(), ...this.opts.describe() };
    const cutoff = Date.now() - STALE_MS;
    const all = [self, ...[...this.peers.values()].filter((p) => p.seenAt >= cutoff)];
    const byMatch = all
      .map((w) => ({ w, len: cwd ? matchLength(w.folders, cwd) : -1 }))
      .sort((a, b) => b.len - a.len || b.w.focusedAt - a.w.focusedAt);
    return byMatch[0].w;
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {boolean} isHubServer
   */
  async serve(req, res, isHubServer) {
    const reply = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const given = Buffer.from(String(req.headers[TOKEN_HEADER] || ""));
    const want = Buffer.from(this.opts.token);
    if (req.method !== "POST" || given.length !== want.length || !crypto.timingSafeEqual(given, want))
      return reply(403, { error: "forbidden" });

    const url = (req.url || "").split("?")[0];
    let body;
    try {
      body = await readBody(req);
    } catch {
      return reply(413, { error: "too large" });
    }

    if (url === `${PREFIX}/ping`) return reply(200, { app: "live-edits", hub: this.isHub() });

    if (isHubServer && url === `${PREFIX}/register`) {
      try {
        const p = JSON.parse(body);
        if (p.id !== this.id) this.peers.set(p.id, { ...p, seenAt: Date.now() });
      } catch {}
      return reply(200, {});
    }

    // Hook from Claude Code (hub port) or a hook forwarded by the hub (private port).
    const phase = isHubServer
      ? url.startsWith(`${PREFIX}/`) && url.slice(PREFIX.length + 1)
      : url.startsWith(`${PREFIX}/run/`) && url.slice(PREFIX.length + 5);
    if (!phase || !PHASES.includes(phase)) return reply(404, { error: "not found" });

    let input = {};
    try {
      input = JSON.parse(body);
    } catch {}

    // Claude Code only waits on this reply; errors never block the edit.
    try {
      const target = isHubServer ? this.route(input.cwd) : null;
      if (!target || target.id === this.id) await this.opts.handle(phase, input);
      else {
        try {
          await postJson(target.port, `${PREFIX}/run/${phase}`, this.opts.token, body, FORWARD_TIMEOUT_MS);
        } catch (e) {
          this.peers.delete(target.id);
          this.log(`forward to window ${target.id} failed: ${e}`);
        }
      }
    } catch (e) {
      this.log(`handling ${phase} failed: ${e}`);
    }
    reply(200, {});
  }
}

module.exports = {
  Bridge,
  loadBridgeConfig,
  saveBridgeConfig,
  findFreePort,
  matchLength,
  DEFAULT_PORT,
  CONFIG_FILE,
  TOKEN_HEADER,
};
