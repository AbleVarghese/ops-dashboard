// v3.2 collector/hub split — lib/hub-client.mjs's postJson() against a real local HTTP server
// (not a mock — this is exactly the kind of "hits the real transport" test the correctness law
// prefers over asserting against a mocked http module).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { postJson } from "../lib/hub-client.mjs";

function withServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

test("postJson: sends the Authorization: Bearer header and the JSON body, gets the JSON response back", async () => {
  let seenAuth = null;
  let seenBody = null;
  const { url, close } = await withServer((req, res) => {
    seenAuth = req.headers.authorization;
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seenBody = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  try {
    const res = await postJson(url, "/ingest", "sekret", { type: "heartbeat", collectorId: "c1" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(seenAuth, "Bearer sekret");
    assert.deepEqual(seenBody, { type: "heartbeat", collectorId: "c1" });
  } finally {
    close();
  }
});

test("postJson: a non-2xx response resolves (not rejects) with the status — caller decides retry", async () => {
  const { url, close } = await withServer((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  });
  try {
    const res = await postJson(url, "/ingest", "wrong-token", { type: "heartbeat", collectorId: "c1" });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "unauthorized" });
  } finally {
    close();
  }
});

test("postJson: rejects on a genuine transport failure (connection refused)", async () => {
  await assert.rejects(() => postJson("http://127.0.0.1:1", "/ingest", "t", {}, { timeoutMs: 500 }));
});

test("postJson: omits the Authorization header when no token is given", async () => {
  let seenAuth = "unset";
  const { url, close } = await withServer((req, res) => {
    seenAuth = req.headers.authorization || null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  try {
    await postJson(url, "/ingest", null, { type: "heartbeat" });
    assert.equal(seenAuth, null);
  } finally {
    close();
  }
});
