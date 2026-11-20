// Token launch radar — rebuild (Node 22, standard library only).
//
// Reads the sealed DefiLlama snapshot, ranks every still-tokenless protocol by
// the value its launch would plausibly carry, and writes the board, the
// dashboard data and the judge's dossier.
//
// The valuation is calibrated on the snapshot itself, never on a hand-picked
// constant: for each category, the peer multiple is the MEDIAN market-cap /
// TVL ratio of the protocols in that category that already trade (at least
// three peers, else the median across every trading protocol). A protocol's
// implied value is its TVL times its category's peer multiple, moved by its
// own 7-day TVL momentum and by how long it has been tracked. Nothing about
// a protocol's name is ever special-cased.
//
//   implied = tvl x peerMultiple x momentum x seasoning
//   peerMultiple = median(mcap/tvl of trading peers in the category), clamped [0.02, 2]
//   momentum     = 1 + clamp(change_7d, -50, +100) / 100 x 0.35
//   seasoning    = 0.7 + min(age_days, 730) / 730 x 0.3   (age unknown: 365 days)
//
// The board covers the snapshot's whole watchlist, plus the strongest
// tokenless protocols below the watchlist floor, by TVL. Trading protocols
// are never ranked: they are shown apart, at the market's own values.
//
//   node main.ts --input <snapshot.json|directory> --output <dir>
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
// In the grader, /input holds the sealed snapshot and /output is the target.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

// The scorer's dossier caps: the text cap shapes the bytes, the rest refuse.
const DOSSIER_TEXT_MAX = 65_536;
const SHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASH_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

// Model constants (stated on the dashboard, and only here).
const GROWTH_FLOOR = -50;
const GROWTH_CAP = 100;
const GROWTH_WEIGHT = 0.35;
const SEASON_FLOOR = 0.7;
const SEASON_RANGE = 0.3;
const SEASON_DAYS = 730;
const UNKNOWN_AGE_DAYS = 365;
const MULTIPLE_FLOOR = 0.02;
const MULTIPLE_CAP = 2;
const MIN_PEERS = 3;
const EARLY_LIMIT = 120;
const LIVE_LIMIT = 24;
const MODEL_VERSION = 'radar-comps-1';

const DAY_MS = 86_400_000;

interface Proto {
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

interface Snap {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

interface FarmPlanStep {
  action: string;
  cost: string;
  time: string;
}

interface Row {
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
    peer_multiple: number;
    peer_count: number;
    growth_pct: number;
    momentum: number;
    seasoning: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

interface LiveEntry {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number;
}

interface RadarPayload {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model_note: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: Row[];
  live: LiveEntry[];
}

function fail(message: string): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(1);
}

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1] as string;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

function loadSnapshot(text: string): Snap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('snapshot.json is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) fail('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') fail('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || o.floor_usd <= 0) fail('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) fail('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) fail('snapshot.json has no watchlist');
  const protocols: Proto[] = (o.protocols as unknown[]).map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      fail(`protocol ${i} lacks a slug, a name or a TVL`);
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
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

function tokenless(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

function rankable(p: Proto): boolean {
  return tokenless(p) && p.category !== 'CEX' && !VERSION_TAIL.test(p.name);
}

// Peer multiples, calibrated on the snapshot's own trading protocols.
function peerMultiples(protocols: Proto[]): { byCategory: Map<string, { multiple: number; count: number }>; global: number } {
  const buckets = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0 || p.category === 'CEX') continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    const list = buckets.get(p.category as string) ?? [];
    list.push(ratio);
    buckets.set(p.category as string, list);
  }
  const global = all.length > 0 ? clamp(median(all), MULTIPLE_FLOOR, MULTIPLE_CAP) : 0.25;
  const byCategory = new Map<string, { multiple: number; count: number }>();
  for (const [cat, ratios] of buckets) {
    const multiple = ratios.length >= MIN_PEERS ? clamp(median(ratios), MULTIPLE_FLOOR, MULTIPLE_CAP) : global;
    byCategory.set(cat, { multiple, count: ratios.length });
  }
  return { byCategory, global };
}

function scoreOne(p: Proto, asOf: string, peers: { byCategory: Map<string, { multiple: number; count: number }>; global: number }): {
  implied: number;
  multiple: number;
  peerCount: number;
  growthPct: number;
  momentum: number;
  seasoning: number;
  age: number | null;
} {
  const peer = p.category !== null ? peers.byCategory.get(p.category) : undefined;
  const multiple = peer !== undefined ? peer.multiple : peers.global;
  const peerCount = peer !== undefined ? peer.count : 0;
  const growthPct = clamp(numOr(p.change_7d, 0), GROWTH_FLOOR, GROWTH_CAP);
  const momentum = 1 + (growthPct / 100) * GROWTH_WEIGHT;
  const age = ageInDays(asOf, p.listed_at);
  const ageForSeason = age ?? UNKNOWN_AGE_DAYS;
  const seasoning = SEASON_FLOOR + (Math.min(Math.max(ageForSeason, 0), SEASON_DAYS) / SEASON_DAYS) * SEASON_RANGE;
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * momentum * seasoning));
  return { implied, multiple, peerCount, growthPct, momentum, seasoning, age };
}

function money(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

function mainChain(p: Proto): string {
  return p.chains.length > 0 ? (p.chains[0] as string) : 'its main chain';
}

function stakeSize(p: Proto): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

function holdDays(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function categoryMove(p: Proto, size: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp')) return `Lend $${size} of USDC on ${p.name} (${chain}) and leave the loan open.`;
  if (c.includes('dex')) return `Add $${size} of liquidity to the busiest pool on ${p.name} (${chain}).`;
  if (c.includes('bridge')) return `Move $${size} of USDC across ${p.name} to ${chain} and put the funds to work there.`;
  if (c.includes('stak') || c.includes('restak')) return `Stake $${size} through ${p.name} on ${chain} and keep the receipt token.`;
  if (c.includes('perp') || c.includes('deriv')) return `Post $${size} of USDC as margin on ${p.name} and open a single small hedged position.`;
  if (c.includes('yield') || c.includes('farm') || c.includes('vault') || c.includes('allocator') || c.includes('curator')) {
    return `Deposit $${size} into the flagship vault on ${p.name} (${chain}) and hold the shares.`;
  }
  if (c.includes('rwa') || c.includes('stable')) return `Mint $${size} of the yield-bearing asset on ${p.name} (${chain}) and hold it.`;
  if (c.includes('prediction')) return `Back one outcome with $${size} on ${p.name} and let it ride.`;
  return `Put $${size} of USDC to work in ${p.name}'s core product on ${chain}.`;
}

function farmPlan(p: Proto, age: number | null): FarmPlanStep[] {
  const size = stakeSize(p);
  const hold = holdDays(age);
  const chain = mainChain(p);
  return [
    { action: `Set up a wallet used only for this farm, and keep its recovery phrase offline.`, cost: 'under $3 of gas', time: '5 minutes' },
    { action: categoryMove(p, size, chain), cost: `$${size} of capital plus a few dollars of gas`, time: '15 minutes to set up' },
    { action: `Do one real action on the protocol every week: a deposit, a swap, a vote, or a borrow.`, cost: 'about $2 of gas a week', time: '10 minutes a week' },
    { action: `Keep the position open for at least ${hold} days so more than one snapshot catches it.`, cost: `the $${size} stays locked in the position`, time: `${hold} days` },
    { action: `When a token is announced, claim only through the protocol's own site and log every transaction.`, cost: 'nothing to check; never pay to claim', time: '10 minutes' },
  ];
}

function planText(steps: FarmPlanStep[]): string[] {
  return steps.map((s) => {
    let line = `${s.action} Cost: ${s.cost}. Time: ${s.time}.`;
    if (line.length > 600) line = `${line.slice(0, 596)}...`;
    if (line.length < 20) line = `${line} Keep the record and check the protocol's own page.`;
    return line;
  });
}

function buildRows(snap: Snap): { rows: Row[]; earlyCount: number; live: LiveEntry[] } {
  const peers = peerMultiples(snap.protocols);
  const bySlug = new Map(snap.protocols.map((p) => [p.slug, p]));
  const picked = new Map<string, Proto>();
  for (const slug of snap.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) picked.set(slug, p);
  }
  const early = snap.protocols
    .filter((p) => !picked.has(p.slug) && rankable(p) && p.tvl_usd < snap.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_LIMIT);
  for (const p of early) picked.set(p.slug, p);

  const scored = [...picked.values()].map((p) => ({ p, s: scoreOne(p, snap.as_of, peers) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const rows: Row[] = scored.map((entry, i) => ({
    rank: i + 1,
    slug: entry.p.slug,
    name: entry.p.name,
    category: entry.p.category,
    chains: entry.p.chains,
    tvl_usd: entry.p.tvl_usd,
    change_7d: entry.p.change_7d,
    mcap_usd: entry.p.mcap_usd,
    listed_at: entry.p.listed_at,
    gecko_id: entry.p.gecko_id,
    symbol: entry.p.symbol,
    token_status: 'pre-token',
    age_days: entry.s.age,
    implied_value_usd: entry.s.implied,
    model: {
      peer_multiple: round4(entry.s.multiple),
      peer_count: entry.s.peerCount,
      growth_pct: entry.s.growthPct,
      momentum: round4(entry.s.momentum),
      seasoning: round4(entry.s.seasoning),
      age_days: entry.s.age,
    },
    farm_steps: planText(farmPlan(entry.p, entry.s.age)),
  }));

  const live: LiveEntry[] = snap.protocols
    .filter((p) => !tokenless(p) && p.category !== 'CEX' && p.mcap_usd !== null)
    .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_LIMIT)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: round4(clamp((p.mcap_usd as number) / Math.max(1, p.tvl_usd), MULTIPLE_FLOOR, MULTIPLE_CAP)),
    }));

  return { rows, earlyCount: early.length, live };
}

function checkBoard(rows: Row[], snap: Snap): string | null {
  const slugs = new Set(rows.map((r) => r.slug));
  const missing = snap.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  for (let i = 0; i < rows.length; i++) if (rows[i]!.rank !== i + 1) return `rank ${i + 1} is ${rows[i]!.rank}`;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.implied_value_usd > rows[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (rows.length >= 2 && rows[0]!.implied_value_usd === rows[rows.length - 1]!.implied_value_usd) {
    return `all ${rows.length} rows share the same implied value`;
  }
  for (const r of rows) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const inputArg = flag('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory>`);
}
const out = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snap = loadSnapshot(readFileSync(inputFile, 'utf8'));
const { rows, earlyCount, live } = buildRows(snap);
const problem = checkBoard(rows, snap);
if (problem !== null) fail(`the board fails its own gate: ${problem}`);

const payload: RadarPayload = {
  as_of: snap.as_of,
  source: snap.source,
  floor_usd: snap.floor_usd,
  model_version: MODEL_VERSION,
  model_note:
    'Implied value = TVL x category peer multiple (median mcap/TVL of trading protocols in the category, min 3 peers else the global median, clamped 0.02-2) x momentum (1 + clamped 7d change x 0.35) x seasoning (0.7 + age/730 x 0.3, age unknown 365d).',
  watchlist_size: snap.watchlist.length,
  board_size: rows.length,
  early_size: earlyCount,
  live_size: live.length,
  rows,
  live,
};

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows })}\n`);
writeFileSync(join(out, 'data.js'), `window.RADAR=${JSON.stringify(payload)};\n`);

const dashFiles = copyDir(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyDir(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) fail(`screenshots/ holds ${shots.length} images: hand in 3, the board, a detail view and a filtered view`);
for (const name of shots) if (!SHOT_NAME.test(name)) fail(`screenshots/${name}: bad name`);

writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: DOSSIER_TEXT_MAX, screenshots: SHOT_CAPS, dashboard: DASH_CAPS }),
);

process.stdout.write(
  `token radar: ${snap.protocols.length} protocols, ${snap.watchlist.length} on the watchlist, ${rows.length} rows (${earlyCount} early), top implied ${money(rows[0]!.implied_value_usd)} (${rows[0]!.slug})\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dashFiles.length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
