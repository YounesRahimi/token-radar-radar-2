// Token radar entry point: sealed snapshot in, ranked board plus static page out.
// This run scores every pre-token protocol with lib/model.ts, writes board.json
// and the dashboard dataset, copies the page and screenshots beside them, then
// seals the dossier the judge reads. The page itself is static and offline:
// dashboard/index.html, app.css and app.js render data.js with no framework
// and no network.
//
// Outside the grader, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../kit/input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: text shapes the dossier bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SHOT_CAPS = { max: 4, max_bytes: 524_288 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Value of `--name <value>` (or `--name=value`), else `fallback`. */
function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const joined = process.argv.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

const inputArg = flag('input', '/input');
const snapPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(snapPath)) {
  process.stderr.write(`token radar: no snapshot at ${snapPath}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const dest = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snap = parseSnapshot(readFileSync(snapPath, 'utf8'));
const { board, radar } = buildRadar(snap);
const bad = boardIssue(board, snap);
if (bad !== null) {
  process.stderr.write(`token radar: refusing a board the gate rejects: ${bad}\n`);
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(dest, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping dotfiles. */
function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const entry of readdirSync(from)) {
    if (entry.startsWith('.')) continue;
    const src = join(from, entry);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(to, entry));
    names.push(entry);
  }
  return names;
}

copyDir(join(here, 'dashboard'), join(dest, 'dashboard'));
const shots = copyDir(join(here, 'screenshots'), join(dest, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!SHOT_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier closes the run: the scorer rebuilds it byte for byte from this output.
writeFileSync(join(dest, 'dossier.json'), buildDossier(dest, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snap.protocols.length} protocols, ${snap.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(dest, 'board.json')}, ${join(dest, 'data.js')}, ${join(dest, 'dashboard')} (3 files), ${join(dest, 'screenshots')} (${shots.length} images) and ${join(dest, 'dossier.json')}\n`,
);
