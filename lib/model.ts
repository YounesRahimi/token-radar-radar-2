// Token radar scoring model: a sealed snapshot in, a ranked board out.
// Ranking order is fixed: full watchlist coverage first (the gate's row),
// the early radar second (discovery below the floor by TVL), then a sort by
// implied value with slug order breaking ties so reruns stay byte-identical.
// A protocol ranks only when it is pre-token: no market cap, no CoinGecko id
// and no symbol on its record. Anything already trading is set aside for the
// dashboard's live view and never competes for a rank.
//
// The board always covers the snapshot's full watchlist first, then fills up
// with the strongest pre-token protocols below the watchlist TVL floor (the
// early radar, capped). Nothing here names a protocol: one function scores
// every row from the snapshot's own figures.
//
// Implied value is TVL times a category base multiple, bent four ways:
//
//   size      sublinear TVL scaling against a reference size, so mega-TVLs
//             discount: (tvl / reference) ^ (exponent - 1)
//   momentum  the 7-day change, clamped, pushed through tanh so one hot week
//             saturates instead of doubling anything: 1 + tanh(g/50) * weight
//   age       log-age maturity that pays most of its range for surviving the
//             first year and then flattens: floor + log1p(age)/log1p(max) * span
//   spread    a small premium per chain the protocol names, capped.
//
// The base multiple is the category's own: the median market-cap-per-TVL of
// the snapshot's trading protocols in that category, pulled toward the
// global median when the category has few comps, then clamped. Unknown ages
// score as one year old. The dashboard page re-derives every number shown
// from the fields below, so the model constants travel with the data.

/** One protocol entry, exactly the ten fields the sealed snapshot carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Tunables the dashboard prints and the sandbox may override. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  tvl_exponent: number;
  tvl_reference_usd: number;
  category_floor: number;
  category_cap: number;
  category_prior_weight: number;
  chain_bonus: number;
  chain_max: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  tvl_exponent: 0.85,
  tvl_reference_usd: 50_000_000,
  category_floor: 0.05,
  category_cap: 1.5,
  category_prior_weight: 4,
  chain_bonus: 0.015,
  chain_max: 8,
};

/** Model label quoted by the dashboard and the rules. */
export const MODEL_VERSION = 'radar-2';

/** Early-radar rows taken from below the watchlist floor, by TVL. */
export const EARLY_ROWS = 160;

/** Live-token rows shown beside the board, by market cap. */
export const LIVE_ROWS = 24;

/** One farm-plan step before it is flattened to a string. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One ranked row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
    category_multiplier: number;
    tvl_scale: number;
    chain_multiplier: number;
  };
  farm_steps: string[];
}

/** The compact row the dashboard renders; the page rebuilds plans itself. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  base_multiple: number;
  category_multiplier: number;
  tvl_scale: number;
  chain_multiplier: number;
}

/** A protocol that already trades: the market prices it, not the model. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard page needs, shipped as data.js. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  category_multiples: Record<string, number>;
  rows: RadarRow[];
  live: LiveRow[];
}

/** The headline counts the CLI prints after a run. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** Thrown when the snapshot text is not the shape this model scores. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const MS_PER_DAY = 86_400_000;

/** `value` when it is a finite number, otherwise `fallback`. */
function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamp `v` into [`lo`, `hi`]. */
function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Round to four decimals for the breakdown the dashboard shows. */
function q4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Middle value of a sorted array (upper middle on ties); `fallback` if empty. */
function middle(sorted: number[], fallback: number): number {
  return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : fallback;
}

/** Whole days from `listedAt` to `asOf`, floored at zero; null if unparseable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / MS_PER_DAY));
}

/**
 * One category's base multiple from the snapshot's own trading comps: the
 * median market-cap-per-TVL inside the category, shrunk toward the global
 * median (the prior) when comps are scarce, then clamped into its band.
 */
export function categoryMultiple(category: string | null, live: SnapshotProtocol[], model: ModelConstants = MODEL): number {
  const key = category ?? 'Other';
  const inside: number[] = [];
  const everywhere: number[] = [];
  for (const p of live) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    everywhere.push(ratio);
    if ((p.category ?? 'Other') === key) inside.push(ratio);
  }
  everywhere.sort((a, b) => a - b);
  const globalMed = middle(everywhere, model.base_multiple);
  const prior = clampNum(globalMed, model.category_floor, model.category_cap);
  inside.sort((a, b) => a - b);
  const catMed = middle(inside, prior);
  const shrunk = (inside.length * catMed + model.category_prior_weight * prior) / (inside.length + model.category_prior_weight);
  return q4(clampNum(shrunk, model.category_floor, model.category_cap));
}

/** Every category's base multiple in one pass (`null` filed under `Other`). */
export function categoryBaseMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): Map<string, number> {
  const traded = snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX');
  const labels = new Set(snapshot.protocols.map((p) => p.category ?? 'Other'));
  const table = new Map<string, number>();
  for (const label of labels) table.set(label, categoryMultiple(label === 'Other' ? null : label, traded, model));
  return table;
}

/** One protocol's implied value and the multipliers behind it. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  baseMultiple: number = model.base_multiple,
): {
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
  baseMultiple: number;
  tvlScale: number;
  chainMult: number;
} {
  const age = ageDays(asOf, protocol.listed_at);
  // Clamped weekly change through tanh: strong weeks lift, but saturate.
  const growthPct = clampNum(numOr(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
  const growthMult = 1 + Math.tanh(growthPct / 50) * model.growth_weight;
  // Log-age: the first year of survival earns most of the maturity range.
  const scoredAge = clampNum(age ?? model.unknown_age_days, 0, model.maturity_days);
  const maturityMult = model.maturity_floor + (Math.log1p(scoredAge) / Math.log1p(model.maturity_days)) * model.maturity_range;
  // Sublinear size: each extra TVL dollar counts for a little less.
  const tvlScale = Math.pow(Math.max(protocol.tvl_usd, 1) / model.tvl_reference_usd, model.tvl_exponent - 1);
  // Reach: a small premium per chain, capped.
  const chainMult = 1 + Math.min(protocol.chains.length, model.chain_max) * model.chain_bonus;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * baseMultiple * tvlScale * growthMult * maturityMult * chainMult));
  return { implied, growthPct, growthMult, maturityMult, age, baseMultiple, tvlScale, chainMult };
}

/** A name ending in a release marker is another protocol's pool, not its own. */
const VERSIONED = /\s(v\d+(\.\d+)?|V\d+(\.\d+)?|\d+\.\d+)$/;

/** No token record of any kind. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Rankable means pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** Index protocols by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** Score the snapshot into ranked rows, strongest implied value first. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const picked = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every listed slug is scored, no exceptions.
  for (const slug of snapshot.watchlist) {
    const found = index.get(slug);
    if (found !== undefined) picked.set(slug, found);
  }
  // The early radar fills from below the floor, by TVL, never displacing a pick.
  const fresh = snapshot.protocols
    .filter((p) => !picked.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of fresh) picked.set(p.slug, p);

  const comps = categoryBaseMultiples(snapshot, model);
  const scored = [...picked.values()].map((p) => {
    const base = comps.get(p.category ?? 'Other') ?? model.base_multiple;
    const v = impliedValue(p, snapshot.as_of, model, base);
    return { p, v, base };
  });
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    model: {
      base_multiple: s.base,
      growth_pct: s.v.growthPct,
      growth_multiplier: q4(s.v.growthMult),
      maturity_multiplier: q4(s.v.maturityMult),
      age_days: s.v.age,
      category_multiplier: s.base,
      tvl_scale: q4(s.v.tvlScale),
      chain_multiplier: q4(s.v.chainMult),
    },
    farm_steps: farmSteps(s.p, s.v.age).map(stepText),
  }));
}

/** Flatten one step to a single gate-shaped string (20..600 chars). */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep checking the protocol's own announcements page.`;
  return s;
}

/** The protocol's first named chain, or a neutral fallback. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Position size for one farm, stepped from the protocol's own TVL. */
function stakeFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** Typical per-transaction gas from the chain record. */
function txFee(p: SnapshotProtocol): number {
  const joined = p.chains.join(' ').toLowerCase();
  if (joined.includes('ethereum')) return 6;
  if (joined.length === 0) return 2;
  return 1;
}

/** Qualifying hold window: younger protocols need longer histories. */
function holdWindow(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The one category-shaped action a farmer can follow; category picks the verb, the record picks the numbers. */
function fieldAction(p: SnapshotProtocol, stake: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${stake} of USDC on ${name} (${chain}) and leave the supply position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Add $${stake} of liquidity to ${name}'s main pool on ${chain} and keep it ranged.`;
  if (c.includes('bridge')) return `Move $${stake} of USDC through ${name} onto ${chain} and put the bridged funds to work in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${stake} through ${name} and hold on to the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Post $${stake} of USDC as margin on ${name} and carry one small hedged position.`;
  if (c.includes('prediction')) return `Back one outcome on ${name} with $${stake} and leave the ticket on.`;
  if (c.includes('curator') || c.includes('allocator')) return `Place $${stake} into a ${name} vault on ${chain} and hold the shares.`;
  if (c.includes('stable')) return `Mint or lock $${stake} of the stable asset via ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${stake} of the yield-bearing asset ${name} issues on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${stake} of cover from ${name} on ${chain} and keep the policy live.`;
  return `Put $${stake} of USDC to work in ${name} on ${chain} and keep the position open.`;
}

/**
 * Six farm steps derived from the protocol's own record: category picks the
 * action, TVL picks the stake, the chain record picks the gas, age picks the
 * hold. No hand-kept lists, no names read.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const stake = stakeFor(p);
  const fee = txFee(p);
  const hold = holdWindow(age);
  const weeks = Math.max(2, Math.round(hold / 7));
  const weekFee = fee * 2;
  const allIn = fee * (2 + weeks * 2);
  const core = fieldAction(p, stake, chain);
  return [
    {
      text: `Open a fresh wallet that holds only this farm's funds, with the recovery phrase stored offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: core,
      cost: `$${stake} of capital plus roughly $${fee} of gas on ${chain}`,
      time: '15 minutes to set up',
    },
    {
      text: `Do ${weeks} qualifying actions, roughly one a week: deposit, borrow, swap or vote, each on its own day.`,
      cost: `about $${weekFee} of gas weekly, $${fee * weeks * 2} across the window`,
      time: `10 minutes a week for ${weeks} weeks`,
    },
    {
      text: `Stay in the position for at least ${hold} days so it spans more than one activity snapshot.`,
      cost: `the $${stake} stays deployed; plan $${stake + allIn} all-in with gas`,
      time: `${hold} days`,
    },
    {
      text: `When rewards appear, open the protocol's own points page and claim only through the link it publishes.`,
      cost: 'checking costs nothing, and claiming never needs an upfront fee',
      time: '10 minutes',
    },
    {
      text: `Log the wallet, the dates and every transaction hash so the position can be repeated or unwound.`,
      cost: 'nothing beyond the log itself',
      time: '5 minutes',
    },
  ];
}

/** Trading protocols set aside for the dashboard's live view, by market cap. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** Shrink a board row to the compact shape data.js ships. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    base_multiple: row.model.base_multiple,
    category_multiplier: row.model.category_multiplier,
    tvl_scale: row.model.tvl_scale,
    chain_multiplier: row.model.chain_multiplier,
  };
}

/** Score the snapshot into the board plus everything the page renders. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const fresh = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const comps = categoryBaseMultiples(snapshot, model);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: fresh,
    live_size: live.length,
    category_multiples: Object.fromEntries(comps),
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** Parse snapshot text, refusing anything but the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** The first reason a board fails the gate, or null when it passes. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const have = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !have.has(s));
  if (missing.length > 0) return `board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} reads ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share implied value $${board[0]!.implied_value_usd}: not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} carries ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a ${s.length}-character farm step`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} values at ${r.implied_value_usd}`;
  }
  return null;
}

/** The dashboard dataset as one script tag body: no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
