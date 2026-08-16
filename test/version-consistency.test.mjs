// Structural guard against version drift ([[no-drift]] + [[structural-prevention]] Law 1: one source
// of truth, and make the second copy IMPOSSIBLE to desync rather than remembering to sync it).
//
// Why this exists: at v3.3.2 the VERSION file said 3.3.1 while every code comment, the README
// section and the whole commit history described v3.3.2 — and package.json said "3.0.0-final",
// stale since v3.0. Three copies of one fact, hand-maintained, all disagreeing. Nothing caught it
// because nothing was looking. Now something is.
//
// VERSION is the source of truth (it is the file this repo's release docs and close-outs key off).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");

test("package.json version matches the VERSION file (VERSION is the source of truth)", () => {
  const version = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.match(version, /^\d+\.\d+\.\d+$/, "VERSION must be a plain semver line");
  assert.equal(
    pkg.version,
    version,
    `package.json says ${pkg.version} but VERSION says ${version} — update package.json, or VERSION if this IS a new release`
  );
});

test("a close-out document exists for the current VERSION", () => {
  // The repo's release convention: every version ships its evidence document. A version bump with
  // no close-out is a release nobody can audit later.
  const version = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
  const files = fs.readdirSync(ROOT).filter((f) => f.startsWith("CLOSE-OUT"));
  const expected = `CLOSE-OUT-v${version}.md`;
  assert.equal(
    files.includes(expected),
    true,
    `VERSION is ${version} but ${expected} does not exist (found: ${files.join(", ")})`
  );
});
