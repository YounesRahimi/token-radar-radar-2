// Token radar runner: one sealed snapshot in, a ranked board plus a static page out.
// The pipeline scores every pre-token protocol with lib/model.ts, persists the
// ranked rows and the dashboard dataset, stages the dashboard page and the
// screenshots beside them, and seals the run with the dossier the judge reads.
// The page never phones home: dashboard/index.html, app.css and app.js render
// data.js with no framework and no network at all.
//
// Local equivalent of the grader's container:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../kit/input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own limits: the text budget shapes dossier bytes, the rest refuse outright. */
const MAX_TEXT_BYTES = 65_536;
const SHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const SHOT_FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read `--name <value>` or `--name=value`; when repeated, the last flag wins. Falls back when absent. */
function opt(name: string, fallback: string): string {
  let seen: string | undefined;
  let hungry = false;
  for (const token of process.argv) {
    if (hungry) { seen = token; hungry = false; continue; }
    if (token === `--${name}`) { hungry = true; continue; }
    if (token.startsWith(`--${name}=`)) seen = token.slice(name.length + 3);
  }
  if (hungry) seen = '';
  return seen === undefined || seen === '' ? fallback : seen;
}

const rawInput = opt('input', '/input');
const snapFile = rawInput.endsWith('.json') ? rawInput : join(rawInput, 'snapshot.json');
if (!existsSync(snapFile)) {
  process.stderr.write(`token radar: no snapshot at ${snapFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const target = opt('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snap = parseSnapshot(readFileSync(snapFile, 'utf8'));
const { board, radar } = buildRadar(snap);
const refuse = boardIssue(board, snap);
if (refuse !== null) {
  process.stderr.write(`token radar: refusing a board the gate rejects: ${refuse}\n`);
  process.exit(1);
}
// One refusal point: nothing below runs unless the board clears every gate row.

mkdirSync(target, { recursive: true });
// board.json first: the dossier hashes every sibling, so the ranked rows land before anything reads them.
writeFileSync(join(target, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
// data.js next: the shipped dashboard renders exactly this dataset, no fetch and no network.
writeFileSync(join(target, 'data.js'), dataScript(radar));

/** Stage one directory's regular files into `to`; dotfiles stay behind. Returns what landed. */
function stageDir(from: string, to: string): string[] {
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

stageDir(join(root, 'dashboard'), join(target, 'dashboard'));
const shots = stageDir(join(root, 'screenshots'), join(target, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!SHOT_FILE.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier closes the run: the scorer rebuilds it byte for byte from this output.
writeFileSync(join(target, 'dossier.json'), buildDossier(target, { text_max_bytes: MAX_TEXT_BYTES, screenshots: SHOT_LIMITS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snap.protocols.length} protocols, ${snap.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(target, 'board.json')}, ${join(target, 'data.js')}, ${join(target, 'dashboard')} (3 files), ${join(target, 'screenshots')} (${shots.length} images) and ${join(target, 'dossier.json')}\n`,
);
