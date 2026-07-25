// v3.2 container-hardening — lib/watch-compat.mjs's fs.watch-vs-poll mode selection and the
// polling fallback's actual change-detection behavior (not just that it doesn't throw).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchCompat, watchMode } from "../lib/watch-compat.mjs";

test("watchMode: OPS_DASH_WATCH_MODE=poll forces poll mode regardless of container detection", () => {
  const prev = process.env.OPS_DASH_WATCH_MODE;
  process.env.OPS_DASH_WATCH_MODE = "poll";
  try {
    assert.equal(watchMode(), "poll");
  } finally {
    if (prev === undefined) delete process.env.OPS_DASH_WATCH_MODE;
    else process.env.OPS_DASH_WATCH_MODE = prev;
  }
});

test("watchMode: OPS_DASH_WATCH_MODE=native forces native mode", () => {
  const prev = process.env.OPS_DASH_WATCH_MODE;
  process.env.OPS_DASH_WATCH_MODE = "native";
  try {
    assert.equal(watchMode(), "native");
  } finally {
    if (prev === undefined) delete process.env.OPS_DASH_WATCH_MODE;
    else process.env.OPS_DASH_WATCH_MODE = prev;
  }
});

test("watchCompat (poll mode, forced): fires a callback when a watched file's content/mtime changes", async () => {
  const prev = process.env.OPS_DASH_WATCH_MODE;
  const prevPoll = process.env.OPS_DASH_WATCH_POLL_MS;
  process.env.OPS_DASH_WATCH_MODE = "poll";
  process.env.OPS_DASH_WATCH_POLL_MS = "50"; // fast poll for a snappy test
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opsdash-watchcompat-"));
  const file = path.join(dir, "watched.txt");
  fs.writeFileSync(file, "v1");
  try {
    await new Promise((resolve, reject) => {
      const watcher = watchCompat(file, () => {
        watcher.close();
        resolve();
      });
      setTimeout(() => fs.writeFileSync(file, "v2-" + Date.now()), 60);
      setTimeout(() => reject(new Error("poll watcher never fired")), 2000);
    });
  } finally {
    if (prev === undefined) delete process.env.OPS_DASH_WATCH_MODE;
    else process.env.OPS_DASH_WATCH_MODE = prev;
    if (prevPoll === undefined) delete process.env.OPS_DASH_WATCH_POLL_MS;
    else process.env.OPS_DASH_WATCH_POLL_MS = prevPoll;
  }
});

test("watchCompat (poll mode, forced): fires when a NEW file appears in a watched directory", async () => {
  const prev = process.env.OPS_DASH_WATCH_MODE;
  const prevPoll = process.env.OPS_DASH_WATCH_POLL_MS;
  process.env.OPS_DASH_WATCH_MODE = "poll";
  process.env.OPS_DASH_WATCH_POLL_MS = "50";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opsdash-watchcompat-dir-"));
  try {
    await new Promise((resolve, reject) => {
      const watcher = watchCompat(dir, (eventType, filename) => {
        if (filename === "new.txt") {
          watcher.close();
          resolve();
        }
      });
      setTimeout(() => fs.writeFileSync(path.join(dir, "new.txt"), "hi"), 60);
      setTimeout(() => reject(new Error("poll watcher never saw the new file")), 2000);
    });
  } finally {
    if (prev === undefined) delete process.env.OPS_DASH_WATCH_MODE;
    else process.env.OPS_DASH_WATCH_MODE = prev;
    if (prevPoll === undefined) delete process.env.OPS_DASH_WATCH_POLL_MS;
    else process.env.OPS_DASH_WATCH_POLL_MS = prevPoll;
  }
});

test("watchCompat (native mode, forced): returns a handle with close()/on() (fs.watch passthrough)", () => {
  const prev = process.env.OPS_DASH_WATCH_MODE;
  process.env.OPS_DASH_WATCH_MODE = "native";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opsdash-watchcompat-native-"));
  try {
    const watcher = watchCompat(dir, () => {});
    assert.equal(typeof watcher.close, "function");
    watcher.close();
  } finally {
    if (prev === undefined) delete process.env.OPS_DASH_WATCH_MODE;
    else process.env.OPS_DASH_WATCH_MODE = prev;
  }
});
