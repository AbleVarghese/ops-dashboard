// Regression test for a REAL bug found via live Playwright browser verification (v3.3): with
// dashToken configured, GET / succeeded (the browser's ?token= query param is on the page
// navigation itself, checked by authorized()) but the browser's own follow-up requests for
// <link href="/styles.css"> and <script src="/app.js"> carry NO token (a browser never propagates
// the original navigation's query string onto a sub-resource request found in the parsed HTML) —
// both got a real 401, and the dashboard rendered completely unstyled with app.js never executing.
// This spawns a REAL server.mjs process (same technique verify/collector-hub.mjs uses) against a
// real HTTP client — never a mock of the auth logic — because that's exactly what hid this bug the
// first time (the logic "looks right" in isolation; only a live request from an unauthenticated
// client reproduces it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG_DIR = path.join(import.meta.dirname, "..");

function makeIsolatedServerDir(dashToken) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opsdash-static-auth-test-"));
  for (const name of ["server.mjs", "lib", "public", "package.json", "VERSION"]) {
    fs.cpSync(path.join(PKG_DIR, name), path.join(dir, name), { recursive: true });
  }
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ port: 0, bind: "127.0.0.1", dashToken, collectorToken: null, projects: [], projectRepoMap: {}, controlContractEnabled: true }, null, 2)
  );
  return dir;
}

async function pollHealthz(port, deadlineMs = 5000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test("static assets (app.js, styles.css) are reachable WITHOUT a token even when dashToken is configured", async () => {
  const PORT = 39217; // fixed, unlikely-collision port for a synchronous isolated test run
  const dir = makeIsolatedServerDir("secret-token-123");
  // Port 0 in config.json is just a placeholder for readability above — rewrite it to the real
  // fixed port now that we know it, so the config on disk matches what we actually connect to.
  const cfgPath = path.join(dir, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  cfg.port = PORT;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const proc = spawn("node", ["server.mjs"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  try {
    const up = await pollHealthz(PORT);
    assert.equal(up, true, `server did not come up in time; log:\n${log}`);

    const [appJs, css, indexNoToken, indexWithToken] = await Promise.all([
      fetch(`http://127.0.0.1:${PORT}/app.js`),
      fetch(`http://127.0.0.1:${PORT}/styles.css`),
      fetch(`http://127.0.0.1:${PORT}/`), // no token — must still 401 (index itself IS gated)
      fetch(`http://127.0.0.1:${PORT}/?token=secret-token-123`),
    ]);

    assert.equal(appJs.status, 200, "app.js must be reachable with no token");
    assert.match(appJs.headers.get("content-type"), /javascript/);
    assert.equal(css.status, 200, "styles.css must be reachable with no token");
    assert.match(css.headers.get("content-type"), /css/);
    // Index itself (and every data route) STAYS gated — only the two static shell assets are
    // exempt; this proves the fix didn't accidentally widen the auth exemption further.
    assert.equal(indexNoToken.status, 401, "index.html must still require the token");
    assert.equal(indexWithToken.status, 200, "index.html with the correct token still works");

    const apiState = await fetch(`http://127.0.0.1:${PORT}/api/state`);
    assert.equal(apiState.status, 401, "/api/state must still require the token — the fix must not leak data routes");
  } finally {
    proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
