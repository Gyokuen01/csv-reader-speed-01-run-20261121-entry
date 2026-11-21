# Fast broken-CSV reader — csv-reader-speed-01-run-20261121

[![make.fun bounty](https://make.fun/badge.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's own csv-reader 1.0.0. `solve.js` exports
`run(input)` returning exactly csv-reader 1.0.0's `{columns, rows, errors}`
for every `{text, header}`; `main.ts` is the house driver (unchanged), run
by the harness as `node /bot/main.ts`.

## Approach

Two tiers, both plain JavaScript in one ES module (no dependencies, no
WebAssembly, no native addon):

- **Fast path (most records).** A record is usually a single line. One
  native regex scan finds the next `"` or CR; a line holding neither is one
  slice + `split(',')`. A line with a quote is parsed quote-aware straight
  on the text with `indexOf` jumps — no per-line copy, no per-character
  loop. Doubled quotes (`""` → `"`) are detected by the closing-quote scan
  itself, so the common quoted field costs no extra scan.
- **Slow path (rare records).** A quoted field spanning lines, a stray CR,
  junk after a closing quote, or a quote that never closes falls back to a
  general parser that reproduces csv-reader 1.0.0's broken-row policy
  exactly (`stray_cr`, `unterminated_quote`, `quote_junk`, `short_row`,
  `long_row`, header/width handling, line counting), using `indexOf`/`slice`
  jumps instead of walking character by character.

## Local verification (practice set, dev only — not the final result)

- Practice set: **6/6 cases identical** to csv-reader 1.0.0's expected
  answers (byte-identical `answers.json` vs the house baseline's output).
- Differential fuzzing vs the reference: **0 mismatches** in 100,000 random
  broken-CSV inputs, 30,000 more in an earlier round, plus 24 full-size
  cases drawn with the kit's own generator, and a hand-written edge-case
  suite (empty text, BOM only, lone CRs, CRLF, unterminated quotes,
  `"""`, junk after closing quotes, blank lines, header with no rows).
- Local CPU time (practice set, `run()` only, trimmed mean over 15
  interleaved rounds, same machine): this entry ~125–165 ms per set vs
  ~740 ms for csv-reader 1.0.0 — about 4.5–5.9x on `run()` alone. Total
  main.ts time includes the fixed JSON parse/stringify the driver pays for
  every entry. Final ranking runs on a fresh set drawn after entries close,
  so practice numbers are a gate only, not a result.

## Files

- `solve.js` — the reader (`run(input)`).
- `main.ts` — the house driver, unchanged.
- `package.json` — `{"type": "module"}`.
