// Minimal zero-dep HTTP(S) JSON POST client for collector.mjs -> hub's /ingest endpoint. Node
// built-ins only (http/https), no fetch polyfill needed (Node >=22 has global fetch, but this
// project's whole convention is explicit http/https per server.mjs's own style — kept consistent
// rather than mixing fetch in for just this one file).
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

/** POSTs `body` (JSON-serialized) to `hubUrl` + `pathname`, Bearer-authorized with `token`.
 * Resolves `{ status, body }` (body JSON-parsed if possible, else raw text) on any HTTP response
 * (including 4xx/5xx — those are NOT thrown, they're a normal "the hub said no" outcome the caller
 * decides how to handle). Rejects only on a genuine transport failure (DNS, connection refused,
 * timeout) — the caller's retry loop treats a rejection and a non-2xx status the same way (both
 * mean "didn't succeed, try again later"), but keeps them distinguishable in logs. */
export function postJson(hubUrl, pathname, token, body, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(pathname, hubUrl);
    } catch (err) {
      reject(new Error(`invalid hub URL "${hubUrl}": ${err.message}`));
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const transport = target.protocol === "https:" ? https : http;
    const req = transport.request(
      target,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": payload.length,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsed = data;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            // non-JSON response body (e.g. a proxy error page) — hand back raw text, don't throw
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`request to ${target} timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
