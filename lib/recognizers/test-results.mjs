// v3.1 Stage 4 (the sensing layer) — test-result recognition. Extracts pass/fail/skip counts from
// raw tool OUTPUT text (a Bash tool_result's stdout, typically), not just "a test command ran" —
// per the owner's sensing-layer directive: recognize what's INSIDE tool outputs, not just their
// names. Config-driven in spirit (each framework is one regex-family entry in FRAMEWORKS below,
// addable without touching the matching logic) though not yet wired to Settings-editable patterns
// — that wiring is a follow-up once the recognizer set is proven correct against real output.
//
// Every regex here matches the STANDARD summary line each framework's own docs/CLI describe (not
// reverse-engineered from a single observed sample) — node:test's shape is additionally verified
// against this exact project's own real output (captured live throughout the v3.1 build, this
// session: "# tests 88\n# pass 88\n# fail 0\n...").
//
// Regexes are DELIBERATELY tolerant of ANSI color codes (a real thing every one of these tools
// emits in a real terminal) — stripped before matching, not required to be absent.

/** Strips ANSI escape codes (color, cursor movement) — every one of these tools emits them by
 * default in a real terminal/CI run; a recognizer that only worked on already-stripped text would
 * fail on real captured output. */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

const FRAMEWORKS = [
  {
    // node:test's TAP-style summary — this project's OWN test runner, verified against real
    // output from this exact codebase's `npm test` throughout the v3.1 build.
    name: "node:test",
    re: /# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/,
    extract: (m) => ({ total: Number(m[1]), passed: Number(m[2]), failed: Number(m[3]), skipped: null }),
  },
  {
    // Vitest's default reporter summary block.
    name: "vitest",
    re: /Tests\s+(\d+) passed(?:\s*\|\s*(\d+) failed)?(?:\s*\|\s*(\d+) skipped)?\s*\((\d+)\)/,
    extract: (m) => ({ passed: Number(m[1]), failed: Number(m[2] || 0), skipped: Number(m[3] || 0), total: Number(m[4]) }),
  },
  {
    // Jest's default reporter summary line: "Tests:       2 failed, 1 skipped, 145 passed, 148 total"
    name: "jest",
    re: /Tests:\s+((?:\d+ \w+,\s*)*\d+ \w+,?\s*\d+ total)/,
    extract: (m) => {
      const seg = m[1];
      const grab = (word) => {
        const mm = seg.match(new RegExp(`(\\d+) ${word}`));
        return mm ? Number(mm[1]) : 0;
      };
      return { passed: grab("passed"), failed: grab("failed"), skipped: grab("skipped"), total: grab("total") };
    },
  },
  {
    // Playwright's default summary line: "15 passed (12.3s)" or "2 failed\n...\n13 passed (18.5s)"
    name: "playwright",
    re: /(?:(\d+) failed[\s\S]*?)?(\d+) passed(?:,\s*(\d+) skipped)?\s*\([\d.]+m?s\)/,
    extract: (m) => ({ failed: Number(m[1] || 0), passed: Number(m[2]), skipped: Number(m[3] || 0), total: Number(m[1] || 0) + Number(m[2]) + Number(m[3] || 0) }),
  },
  {
    // pytest's terminal summary line: "===== 2 failed, 45 passed, 3 skipped in 12.34s ====="
    name: "pytest",
    re: /=+\s*((?:\d+ \w+,?\s*)+)in [\d.]+s\s*=+/,
    extract: (m) => {
      const seg = m[1];
      const grab = (word) => {
        const mm = seg.match(new RegExp(`(\\d+) ${word}`));
        return mm ? Number(mm[1]) : 0;
      };
      const passed = grab("passed");
      const failed = grab("failed");
      const skipped = grab("skipped");
      return { passed, failed, skipped, total: passed + failed + skipped };
    },
  },
];

/** Tries every known framework's summary-line pattern against `text` (typically a Bash tool
 * result's stdout). Returns `{ framework, passed, failed, skipped, total }` for the FIRST match,
 * or `null` if nothing recognized — never throws, degrades to "not recognized" like every other
 * parser in this codebase. Order matters only in the (rare) case two patterns could both match the
 * same text; frameworks are listed in a fixed, deliberate order (this project's own test runner
 * first, since it's the one guaranteed to appear in this dashboard's own dogfooding). */
export function recognizeTestResult(text) {
  const clean = stripAnsi(text);
  for (const fw of FRAMEWORKS) {
    const m = clean.match(fw.re);
    if (m) {
      const counts = fw.extract(m);
      return { framework: fw.name, ...counts };
    }
  }
  return null;
}

export { FRAMEWORKS };
