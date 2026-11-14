import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { AIController } from '../public/ai.js';
import { DECKS, loadDeck } from '../public/cards.js';
import { Game } from '../public/engine.js';
import { experimentControllerOptions } from './gary-policy-experiments.mjs';

export function seededRandom(seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  random.state = () => state;
  return random;
}

export const actionKey = (a) => JSON.stringify([a.kind, a.tkind, a.pkind, a.stadium, a.index, a.card?.id,
  a.card2?.id, a.target?.id, a.evo?.id, a.etype, a.vstar]);

function identifyProfile(profile) {
  if (profile.policy) return profile;
  const experiment = profile.version === 'v4' || (profile.version === 'v3' && profile.features !== undefined);
  return { ...profile, policy: experiment ? 'experiment' : 'built-in' };
}

export function replayProfiles(game, runProfiles) {
  const configured = game.challengerSeat === 1 ? runProfiles?.toReversed() : runProfiles;
  return game.versions.map((version, seat) => {
    const recorded = game.profiles?.[seat];
    if (recorded?.policy) return recorded;
    // Older game records copied the live V3 feature list into the experiment field.
    // The run summary kept the original inputs, including an absent feature list.
    const original = configured?.[seat];
    if (original?.version === version && (!recorded || original.label === recorded.label)) return identifyProfile(original);
    return identifyProfile(recorded ?? { version, features: version === 'v3' ? [] : undefined });
  });
}

export function arenaController({ version, features, milliseconds, policy }, onDecision) {
  // A fixed probe budget makes offline replays independent of machine load.
  return new AIController({ ...experimentControllerOptions(version, policy === 'built-in' ? undefined : features), onDecision,
    policyLimits: { milliseconds: milliseconds ?? Infinity } });
}

function publicTurn(game, p) {
  const mon = (m) => m && [m.id, m.card.id, m.hpLeft, m.energy.map((c) => c.id), m.conditions()];
  return { turn: game.turn, seat: p.idx, sides: game.players.map((q) => ({
    active: mon(q.active), bench: q.bench.map(mon), deck: q.deck.length, hand: q.hand.length, prizes: q.prizes.length,
  })), actions: [], prompts: [], events: [] };
}

function checkpointKind(game, p, action, options) {
  const foe = game.opp(p);
  if (action.kind === 'end') {
    if (options.some((a) => a.kind === 'attack')) return 'pass-with-attack';
    if (game.turn <= 5 && !p.bench.length && options.length > 1) return 'opening-alone';
  }
  if ((action.kind === 'power' || action.kind === 'trainer' || action.kind === 'stadium') && p.deck.length <= 7) return 'thin-deck';
  if (action.kind === 'bench' && foe.prizes.length <= (action.card.prizes || 1) && p.bench.length) return 'bench-prize';
  if (action.kind === 'retreat' && game.retreatCost(p, p.active) > 0) return 'paid-retreat';
  if (action.kind === 'energy' && game.turn <= 11 && options.some((a) => a.kind === 'energy' && a.target !== action.target)) return 'energy-target';
  if (action.kind === 'attack') {
    if (options.some((a) => a.kind === 'attack' && a !== action)) {
      return foe.prizes.length <= (p.active.card.prizes || 1) && p.prizes.length <= 4 ? 'last-exchange' : 'attack-choice';
    }
    if (game.turn <= 9 && options.some((a) => ['bench', 'evolve', 'trainer', 'power', 'energy'].includes(a.kind))) return 'setup-before-attack';
  }
  return null;
}

const searchTrainers = new Set(['nestBall', 'buddyPoffin', 'ultraBall', 'greatBall', 'pokePad', 'drayton', 'arven', 'jacq',
  'pokemonFanClub', 'pokemonTrader', 'computerSearch', 'professorsResearch', 'iono', 'marnie', 'professorOak']);
const setupKinds = new Set(['bench', 'evolve', 'trainer', 'power', 'energy', 'stadium']);
function extraCheckpoints(game, p, action, options) {
  const tags = [];
  if (game.turn <= 11 && options.some((a) => a !== action && a.kind === 'trainer' && searchTrainers.has(a.tkind)) &&
      (action.kind === 'attack' || action.kind === 'end' || action.kind === 'energy' || searchTrainers.has(action.tkind))) {
    tags.push('search-setup');
  }
  if (action.target && game.opp(p).bench.includes(action.target) &&
      options.some((a) => a !== action && a.tkind === action.tkind && a.target && a.target !== action.target)) {
    tags.push('opponent-target');
  }
  if (action.kind === 'attack' && options.some((a) => setupKinds.has(a.kind))) tags.push('turn-sequence');
  return tags;
}

export async function play(job, profiles, trace = false, expanded = false, timings) {
  const random = seededRandom(job.seed);
  const replay = [], candidates = [new Map(), new Map()], pending = [null, null];
  const stats = [0, 1].map(() => ({ firstAttack: null, noAttackTurns: 0, paidRetreatCards: 0, paidReturns: 0,
    drawToEmpty: 0, attackTurns: 0, followUpOpportunities: 0, followUpAttacks: 0, followUpPrizeAttacks: 0, decisions: {} }));
  const lastPrizeAttack = [null, null];
  const bots = profiles.map((profile, seat) => arenaController(profile, (_, result) => {
    if (result.reason) stats[seat].decisions[result.reason] = (stats[seat].decisions[result.reason] || 0) + 1;
  }));
  let capped = false, turn = null;
  const game = new Game({
    decks: job.decks, controllers: bots, random,
    hooks: trace ? { onLog(e) { if (turn) turn.events.push([e.key, e.pl, e.params]); } } : {},
  });
  for (const [seat, bot] of bots.entries()) {
    const chooseAction = bot.chooseAction.bind(bot);
    bot.chooseAction = async (g, p, options) => {
      const memory = expanded && trace ? bots.map((controller) => ({
        plan: controller.v3Policy.plans.get(g),
        prizes: controller.hardPolicy.prizes.get(g),
      })) : null;
      const started = timings && performance.now();
      const action = await chooseAction(g, p, options);
      if (timings) {
        const bin = Math.ceil((performance.now() - started) * 10);
        const counts = timings[profiles[seat].label];
        counts.set(bin, (counts.get(bin) || 0) + 1);
      }
      if (trace && turn) {
        const tag = checkpointKind(g, p, action, options);
        const tags = expanded ? extraCheckpoints(g, p, action, options) : [];
        if (tag && (tag !== 'paid-retreat' || !candidates[seat].has(tag))) tags.push(tag);
        if (tags.length) {
          pending[seat] = { tags, turn: g.turn, rng: random.state(), chosen: actionKey(action),
            options: options.map((a) => ({ key: actionKey(a), text: a.detail })), snapshot: structuredClone(g.serialize()),
            ...(memory ? { memory: memory.map(({ plan, prizes }) => ({ plan, prizes: prizes ? [...prizes] : undefined })) } : {}),
          };
        }
      }
      return action;
    };
    if (trace) {
      const choose = bot.choose.bind(bot);
      bot.choose = async (g, p, prompt) => {
        const answer = await choose(g, p, prompt);
        const option = prompt.options.find((o) => o.id === answer);
        if (turn) turn.prompts.push([turn.actions.length - 1, p.idx, prompt.kind, prompt.text,
          option?.mon?.id ?? option?.card?.id ?? answer]);
        return answer;
      };
    }
  }
  const startTurn = game.startTurn.bind(game);
  let activeHistory = new Map(), retreatPaid = 0;
  game.startTurn = async (p) => {
    if (game.turn >= 220) {
      capped = true;
      return game.setWinner('draw', 'reason.both');
    }
    if (turn && trace) replay.push(turn);
    const events = [];
    if (trace) turn = { events };
    await startTurn(p);
    if (!game.winner && lastPrizeAttack[p.idx] === game.turn - 2) stats[p.idx].followUpOpportunities++;
    turn = publicTurn(game, p);
    turn.events = events;
    activeHistory = new Map([[p.active?.id, 0]]);
    retreatPaid = 0;
  };
  const perform = game.perform.bind(game);
  game.perform = async (p, action) => {
    const before = p.active, beforeEnergy = before?.energy.length || 0;
    const deck = p.deck.length, record = stats[p.idx], snapshot = pending[p.idx];
    const prizes = p.prizes.length;
    pending[p.idx] = null;
    const choice = action.kind === 'attack' ? game.attacksOf(before)[action.index].name : action.tkind || action.pkind || action.stadium;
    if (trace && turn) turn.actions.push([action.kind, choice, action.card?.id, action.target?.id, action.evo?.id]);
    const ended = await perform(p, action);
    if (action.kind === 'attack') {
      record.firstAttack ??= game.turn;
      record.attackTurns++;
      const tookPrize = p.prizes.length < prizes;
      if (lastPrizeAttack[p.idx] === game.turn - 2) {
        record.followUpAttacks++;
        if (tookPrize) record.followUpPrizeAttacks++;
      }
      lastPrizeAttack[p.idx] = tookPrize ? game.turn : null;
    }
    if (ended && action.kind !== 'attack') record.noAttackTurns++;
    if (snapshot) {
      const { tags, ...checkpoint } = snapshot;
      for (const tag of tags) {
        if (tag !== 'thin-deck' || (p.deck.length <= 1 && p.deck.length < deck)) candidates[p.idx].set(tag, { tag, ...checkpoint });
      }
    }
    if (deck && !p.deck.length && ['trainer', 'power', 'stadium'].includes(action.kind)) record.drawToEmpty++;
    if (before && p.active && before !== p.active && !ended) {
      const paid = action.kind === 'retreat' ? beforeEnergy - before.energy.length : 0;
      retreatPaid += paid;
      record.paidRetreatCards += paid;
      if (retreatPaid > (activeHistory.get(p.active.id) ?? Infinity)) record.paidReturns++;
      activeHistory.set(p.active.id, retreatPaid);
    }
    return ended;
  };
  await game.run();
  if (trace && turn) replay.push(turn);
  const winner = game.winner === 'draw' ? null : game.winner.idx;
  const loser = winner === null ? null : 1 - winner;
  return { ...job, versions: profiles.map(({ version }) => version), profiles: profiles.map(identifyProfile), winner, first: game.first.idx, turns: game.turn, reason: game.winReason?.key, capped, stats,
    prizes: game.players.map((p) => p.prizes.length),
    ...(trace ? { replay, checkpoints: loser === null ? [] : [...candidates[loser].values()] } : {}) };
}

async function runShard({ jobs, profiles, out, index, trace, expanded, timing }) {
  await Promise.all([...new Set(jobs.flatMap((job) => job.decks))].map(loadDeck));
  const path = join(out, `games-${index}.jsonl.gz`);
  const gzip = createGzip({ level: 3 });
  const output = createWriteStream(path + '.tmp');
  const timings = timing && Object.fromEntries(profiles.map(({ label }) => [label, new Map()]));
  gzip.pipe(output);
  for (const [i, job] of jobs.entries()) {
    const result = await play(job, job.challengerSeat === 1 ? profiles.toReversed() : profiles, trace, expanded, timings);
    if (!gzip.write(JSON.stringify(result) + '\n')) await once(gzip, 'drain');
    const { replay, checkpoints, ...summary } = result;
    parentPort.postMessage({ summary, checkpoints: checkpoints?.map((entry) => entry.tag) || [] });
    if ((i + 1) % 100 === 0) parentPort.postMessage({ progress: i + 1 });
  }
  const finished = once(output, 'finish');
  gzip.end();
  await finished;
  await rename(path + '.tmp', path);
  if (timings) parentPort.postMessage({ timings });
}

function actionLatency(counts) {
  const bins = [...counts.entries()].sort(([a], [b]) => a - b);
  const count = bins.reduce((sum, [, n]) => sum + n, 0);
  const at = (quantile) => {
    let left = Math.ceil(count * quantile);
    for (const [bin, n] of bins) {
      left -= n;
      if (left <= 0) return bin / 10;
    }
    return null;
  };
  return { count, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1) };
}

async function main() {
  const [mode = 'selfplay', ...args] = process.argv.slice(2);
  const get = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
  const workers = Number(get('workers', '4')), seeds = Number(get('seeds', '1')), offset = Number(get('offset', mode === 'selfplay' ? '0' : '40'));
  let out = resolve(get('out', `.cache/gary-arena/${mode}`));
  const formats = get('format', 'classic,modern').split(',');
  const selected = get('decks', '').split(',').filter(Boolean);
  const expanded = get('checkpoints', '') === 'expanded';
  const timing = args.includes('--timing');
  const milliseconds = get('milliseconds', undefined);
  if (!['selfplay', 'evaluate'].includes(mode) || !Number.isInteger(workers) || workers < 1 ||
      !Number.isInteger(seeds) || seeds < 1 || !Number.isInteger(offset) || offset < 0 ||
      (milliseconds !== undefined && (!Number.isFinite(Number(milliseconds)) || Number(milliseconds) <= 0)) ||
      formats.some((format) => !['classic', 'modern'].includes(format)) || selected.some((key) => !DECKS[key])) {
    throw new Error('Use selfplay or evaluate with --workers=N --seeds=N --offset=N --milliseconds=N --format=classic,modern --decks=key,key --out=path');
  }
  const baseline = get('version', 'v2'), challenger = get('challenger', 'v3');
  if (![baseline, challenger].every((version) => /^v[1-4]$/.test(version))) throw new Error('Use --version=v1|v2|v3|v4 and --challenger=v1|v2|v3|v4.');
  const features = (name) => get(name, undefined)?.split(',').filter(Boolean);
  const limits = milliseconds === undefined ? {} : { milliseconds: Number(milliseconds) };
  const defender = { version: baseline, features: features('features'), label: baseline, ...limits };
  const candidate = { version: challenger, features: features('challenger-features'), label: challenger === baseline ? 'candidate' : challenger, ...limits };
  const profiles = (mode === 'selfplay' ? [defender, defender] : [candidate, defender]).map(identifyProfile);
  const jobs = [];
  for (const [f, format] of formats.entries()) {
    const decks = Object.keys(DECKS).filter((key) => DECKS[key].format === format && (!selected.length || selected.includes(key)));
    for (const [i, left] of decks.entries()) for (let j = i; j < decks.length; j++) for (let k = 0; k < seeds; k++) {
      const seed = (18790127 + f * 31521421 + i * 103009 + j * 70001 + (k + offset) * 13649) >>> 0;
      if (mode === 'evaluate') {
        for (const challengerSeat of [0, 1]) jobs.push({ format, decks: [left, decks[j]], seed, challengerSeat });
      } else {
        jobs.push({ format, decks: [left, decks[j]], seed });
        jobs.push({ format, decks: [decks[j], left], seed: i === j ? seed + 1 : seed });
      }
    }
  }
  if (!jobs.length) throw new Error('No games for the requested deck and format selection.');
  // Interleave deck matchups and formats so intermediate progress covers the full field.
  const mix = seededRandom(361);
  for (let i = jobs.length - 1; i > 0; i--) {
    const j = Math.floor(mix() * (i + 1));
    [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
  }
  await mkdir(dirname(out), { recursive: true });
  try {
    await mkdir(out);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    out = await mkdtemp(out + '-');
  }
  const result = { versions: profiles.map(({ version }) => version), profiles, seeds, offset, games: 0, planned: jobs.length, capped: 0, formats: {}, decks: {}, reasons: {},
    checkpoints: {}, decisions: {}, movement: {}, attackMetrics: {} };
  const count = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };
  const timings = timing && Object.fromEntries(profiles.map(({ label }) => [label, new Map()]));
  const started = Date.now();
  console.log(`${mode}: ${jobs.length} games across ${workers} workers → ${out}`);
  await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, (_, index) => new Promise((done, fail) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { jobs: jobs.filter((_, i) => i % workers === index), profiles, out, index, trace: mode === 'selfplay', expanded, timing },
    });
    worker.on('message', ({ summary: s, checkpoints, timings: shardTimings }) => {
      if (shardTimings) {
        for (const [label, bins] of Object.entries(shardTimings)) {
          for (const [bin, count] of bins) timings[label].set(bin, (timings[label].get(bin) || 0) + count);
        }
      }
      if (!s) return;
      result.games++;
      result.capped += Number(s.capped);
      const format = result.formats[s.format] ??= { games: 0, firstWins: 0, challengerWins: 0, draws: 0 };
      format.games++;
      if (s.winner === null) format.draws++;
      if (s.winner === s.first) format.firstWins++;
      if (mode === 'evaluate' && s.winner === s.challengerSeat) format.challengerWins++;
      count(result.reasons, s.reason);
      for (const tag of checkpoints) count(result.checkpoints, tag);
      for (const [seat, key] of s.decks.entries()) {
        const version = s.profiles[seat].label, stats = s.stats[seat];
        const decisions = result.decisions[version] ??= {};
        for (const [reason, n] of Object.entries(stats.decisions)) decisions[reason] = (decisions[reason] || 0) + n;
        const movement = result.movement[version] ??= { paidRetreatCards: 0, paidReturns: 0 };
        movement.paidRetreatCards += stats.paidRetreatCards;
        movement.paidReturns += stats.paidReturns;
        const metrics = (result.attackMetrics[s.format] ??= {})[version] ??= { games: 0, firstOpportunityAttacks: 0,
          followUpOpportunities: 0, followUpAttacks: 0, followUpPrizeAttacks: 0 };
        metrics.games++;
        metrics.firstOpportunityAttacks += Number(stats.firstAttack === (seat === s.first ? 3 : 2));
        metrics.followUpOpportunities += stats.followUpOpportunities;
        metrics.followUpAttacks += stats.followUpAttacks;
        metrics.followUpPrizeAttacks += stats.followUpPrizeAttacks;
        const d = result.decks[key] ??= { games: 0, wins: 0, losses: 0, draws: 0, firstAttacks: 0, noAttackTurns: 0 };
        if (mode === 'evaluate' && seat !== s.challengerSeat) continue;
        d.games++;
        count(d, s.winner === null ? 'draws' : s.winner === seat ? 'wins' : 'losses');
        d.firstAttacks += Number(s.stats[seat].firstAttack !== null);
        d.noAttackTurns += s.stats[seat].noAttackTurns;
      }
      if (result.games % 500 === 0) console.log(`${result.games}/${jobs.length} games, ${((Date.now() - started) / 1000).toFixed(1)}s`);
    });
    worker.on('error', fail);
    worker.on('exit', (code) => code === 0 ? done() : fail(new Error(`Shard ${index} exited with status ${code}`)));
  })));
  result.seconds = (Date.now() - started) / 1000;
  if (timings) result.actionLatency = Object.fromEntries(Object.entries(timings).map(([label, bins]) => [label, actionLatency(bins)]));
  await writeFile(join(out, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ games: result.games, seconds: result.seconds, formats: result.formats, reasons: result.reasons, checkpoints: result.checkpoints }));
}

if (!isMainThread) await runShard(workerData);
else if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
