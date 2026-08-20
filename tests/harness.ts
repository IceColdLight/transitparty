/**
 * A deliberately tiny test harness: no dependencies, no config, no watch mode.
 *
 * These tests exist because this prototype's worst bugs are not crashes. A
 * city generates fine and has no race worth running in it. A planner returns a
 * route that walks across a river. A timetable produces vehicles that bunch,
 * so half the map is unreachable for two minutes at a stretch. None of that
 * throws — it just quietly makes the game worse — so every check here states a
 * property in plain English and prints the number behind it, because the
 * measurement is usually the interesting part.
 */
let failures = 0;
let checks = 0;

export function describe(name: string) {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

/** Assert a property, and always show the number behind it. */
export function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (!ok) failures++;
  const mark = ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark} ${label}${detail ? `   \x1b[2m— ${detail}\x1b[0m` : ''}`);
}

/** Two numbers agree to within a tolerance. */
export function near(label: string, got: number, want: number, tol: number) {
  check(label, Math.abs(got - want) <= tol, `${got.toFixed(3)} vs ${want} (±${tol})`);
}

/** Purely informational — a measurement worth seeing in the log. */
export function note(text: string) {
  console.log(`  \x1b[2m${text}\x1b[0m`);
}

export function report(): never {
  const ok = failures === 0;
  console.log(
    `\n${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} — ${checks - failures}/${checks} checks`,
  );
  process.exit(ok ? 0 : 1);
}

export const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
export const pct = (n: number, d: number) => `${((n / d) * 100).toFixed(1)}%`;
