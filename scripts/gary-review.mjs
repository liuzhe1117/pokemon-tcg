import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { constants, createGunzip } from 'node:zlib';
import { loadDeck } from '../public/cards.js';
import { Game } from '../public/engine.js';
import { actionKey, arenaController, replayProfiles, seededRandom } from './gary-arena.mjs';

const [directory = '.cache/gary-arena/v2-all-pairs', sampleCount = '32', ...options] = process.argv.slice(2);
const root = resolve(directory);
const sampleSize = Number(sampleCount);
if (!Number.isInteger(sampleSize) || sampleSize < 0) throw new Error('The sample size must be a non-negative integer.');
const breadth = Number(options.find((arg) => arg.startsWith('--breadth='))?.slice(10) ?? 1);
if (!Number.isInteger(breadth) || breadth < 1) throw new Error('The replay breadth must be a positive integer.');
const screenFile = options.find((arg) => arg.startsWith('--screen='))?.slice(9);
const profiles = screenFile ? JSON.parse(await readFile(screenFile, 'utf8')) : [];
const reportName = options.find((arg) => arg.startsWith('--report='))?.slice(9);
if (reportName && !/^[a-z0-9-]+$/.test(reportName)) throw new Error('Use a lowercase report name.');
const partial = options.includes('--partial');
const focus = new Set((options.find((arg) => arg.startsWith('--focus='))?.slice(8) ?? '').split(',').filter(Boolean));
const challenger = options.find((arg) => arg.startsWith('--challenger='))?.split('=')[1] ?? (options.includes('--v3') ? 'v3' : null);
if (challenger && !/^v[1-4]$/.test(challenger)) throw new Error('Use --challenger=v1|v2|v3|v4.');
const files = (await readdir(root)).filter((file) => file.endsWith('.jsonl.gz') || (partial && file.endsWith('.jsonl.gz.tmp'))).sort();
if (!files.length) throw new Error('No arena replay shards found.');
const runProfiles = await readFile(join(root, 'summary.json'), 'utf8').then((data) => JSON.parse(data).profiles, (error) => {
  if (error.code !== 'ENOENT') throw error;
});
const losses = {}, samples = new Map();
let games = 0, draws = 0;
const count = (record, key) => { record[key] = (record[key] || 0) + 1; };
const random = seededRandom(15519);

for (const file of files) {
  const input = createReadStream(join(root, file)).pipe(createGunzip(partial ? { finishFlush: constants.Z_SYNC_FLUSH } : {}));
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    let game;
    try { game = JSON.parse(line); }
    catch (error) { if (file.endsWith('.tmp')) continue; throw error; }
    games++;
    if (game.winner === null) { draws++; continue; }
    const seat = 1 - game.winner;
    const result = losses[game.format] ??= { games: 0, endings: {}, signals: {}, decks: {} };
    result.games++;
    count(result.endings, game.reason);
    count(result.decks, game.decks[seat]);
    const me = game.stats[seat], foe = game.stats[1 - seat];
    if (me.firstAttack === null || (foe.firstAttack !== null && me.firstAttack - foe.firstAttack >= 3)) count(result.signals, 'lost-opening-tempo');
    if (me.firstAttack === null) count(result.signals, 'never-attacked');
    if (me.paidReturns) count(result.signals, 'paid-return');
    if (me.drawToEmpty && game.reason === 'reason.deckout') count(result.signals, 'optional-draw-to-empty');
    if (!game.checkpoints) throw new Error('The replay must come from a selfplay run with checkpoints.');
    const recorded = replayProfiles(game, runProfiles);
    for (const cp of game.checkpoints) {
      count(result.signals, cp.tag);
      if (focus.size && !focus.has(cp.tag)) continue;
      // A near-empty draw matters here when the recorded game actually ended by deck-out.
      if (cp.tag === 'thin-deck' && game.reason !== 'reason.deckout') continue;
      const key = `${game.format}/${cp.tag}`;
      if (!samples.has(key)) samples.set(key, { seen: 0, positions: [] });
      const group = samples.get(key);
      group.seen++;
      const index = group.positions.length < sampleSize ? group.positions.length : Math.floor(random() * group.seen);
      if (index < sampleSize) group.positions[index] = { seed: game.seed, decks: game.decks, seat, profiles: recorded, cp };
    }
  }
}

function alternative(actions, original, tag) {
  if (tag === 'pass-with-attack') return actions.filter((a) => a.kind === 'attack');
  if (tag === 'opening-alone') return actions.filter((a) => a.kind !== 'end');
  if (tag === 'paid-retreat') return actions.filter((a) => a.kind !== 'retreat');
  if (tag === 'last-exchange' || tag === 'attack-choice') return actions.filter((a) => a.kind === 'attack' && a !== original);
  if (tag === 'energy-target') return actions.filter((a) => a.kind === 'energy' && a.target !== original.target);
  if (tag === 'setup-before-attack' || tag === 'turn-sequence') {
    return actions.filter((a) => ['bench', 'evolve', 'trainer', 'power', 'energy', 'stadium'].includes(a.kind));
  }
  if (tag === 'opponent-target') return actions.filter((a) => a !== original && a.tkind === original.tkind && a.target !== original.target);
  return actions.filter((a) => a !== original);
}

function restorePosition(cp, bots) {
  const game = Game.restore(structuredClone(cp.snapshot), { controllers: bots, hooks: {} });
  game.random = seededRandom(cp.rng);
  for (const [i, memory] of (cp.memory ?? []).entries()) {
    if (!bots[i]) continue;
    if (memory.plan) bots[i].v3Policy.plans.set(game, memory.plan);
    if (memory.prizes) bots[i].hardPolicy.prizes.set(game, new Map(memory.prizes));
  }
  return game;
}

async function firstChoice(position, profile = position.profiles[position.seat]) {
  const { cp, seat } = position;
  const bot = arenaController(profile);
  const bots = seat === 0 ? [bot, null] : [null, bot];
  const game = restorePosition(cp, bots);
  const player = game.players[seat];
  return actionKey(await bot.chooseAction(game, player, game.legalActions(player)));
}

async function resume(position, change, challengerVersion, excluded = new Set(), challengerFeatures) {
  const { cp, seat, profiles } = position;
  await Promise.all(position.decks.map(loadDeck));
  const bots = profiles.map((profile, i) => arenaController(i === seat && challengerVersion
    ? { version: challengerVersion, features: challengerFeatures, milliseconds: profile.milliseconds } : profile));
  const game = restorePosition(cp, bots);
  let first = true, picked;
  const bot = bots[seat], choose = bot.chooseAction.bind(bot);
  bot.chooseAction = async (g, p, actions) => {
    const original = actions.find((a) => actionKey(a) === cp.chosen);
    if (first) {
      first = false;
      if (!original) return choose(g, p, actions);
      const options = change ? alternative(actions, original, cp.tag).filter((a) => !excluded.has(actionKey(a))) : [original];
      if (change && !options.length) {
        await choose(g, p, actions);
        return original;
      }
      if (!change && !challengerVersion) await choose(g, p, actions);
      const a = change || challengerVersion ? await choose(g, p, change ? options : actions) : original;
      picked = actionKey(a);
      return a;
    }
    if (change && g.turn === cp.turn && original && ['thin-deck', 'bench-prize', 'paid-retreat'].includes(cp.tag)) {
      const candidates = alternative(actions, original, cp.tag);
      if (candidates.length) return choose(g, p, candidates);
    }
    return choose(g, p, actions);
  };
  const start = game.startTurn.bind(game);
  game.startTurn = async (p) => game.turn < 220 ? start(p) : game.setWinner('draw', 'reason.both');
  await game.run({ resume: true });
  return { winner: game.winner === 'draw' ? null : game.winner.idx, reason: game.winReason?.key, picked };
}

const counterfactual = {};
const screening = Object.fromEntries(profiles.map(({ id }) => [id, {
  compared: 0, changed: 0, matchedWins: 0, branchMatches: 0, draws: 0, phases: {},
}]));
for (const [key, group] of samples) {
  const result = { seen: group.seen, compared: 0, reproducedLosses: 0, alternativeWins: 0, alternativeDraws: 0,
    branches: 0, byAction: {}, worsened: 0, examples: [] };
  const comparison = challenger && { replayed: 0, changedOpeningAction: 0, wins: 0, draws: 0, examples: [] };
  if (comparison) result[challenger] = comparison;
  for (const position of group.positions) {
    const { seat, cp } = position;
    const control = await resume(position, false);
    if (!control.picked) continue;
    const excluded = new Set([control.picked]), variants = [];
    for (let branch = 0; branch < breadth; branch++) {
      const variant = await resume(position, true, undefined, excluded);
      if (!variant.picked || excluded.has(variant.picked)) break;
      excluded.add(variant.picked);
      variants.push(variant);
    }
    if (!variants.length) continue;
    result.compared++;
    if (control.winner === 1 - seat) {
      result.reproducedLosses++;
      if (profiles.length) {
        const baseline = position.profiles[seat];
        const restoredChoice = await firstChoice(position);
        const winning = new Set(variants.filter((variant) => variant.winner === seat).map((variant) => variant.picked));
        for (const profile of restoredChoice === cp.chosen ? profiles : []) {
          const summary = screening[profile.id];
          const phase = summary.phases[cp.tag] ??= { compared: 0, changed: 0, matchedWins: 0 };
          summary.compared++;
          phase.compared++;
          const action = await firstChoice(position, { ...baseline, policy: 'experiment', features: profile.features });
          if (action === restoredChoice) continue;
          summary.changed++;
          phase.changed++;
          if (winning.has(action)) summary.branchMatches++;
          const candidate = await resume(position, false, baseline.version, undefined, profile.features);
          if (candidate.winner === seat) {
            summary.matchedWins++;
            phase.matchedWins++;
          }
          if (candidate.winner === null) summary.draws++;
        }
      }
      for (const variant of variants) {
        result.branches++;
        const [kind, trainer, power, stadium] = JSON.parse(variant.picked);
        const action = [kind, trainer || power || stadium].filter(Boolean).join(':');
        const stats = result.byAction[action] ??= { branches: 0, wins: 0, draws: 0 };
        stats.branches++;
        if (variant.winner === seat) stats.wins++;
        if (variant.winner === null) stats.draws++;
      }
      if (comparison) {
        const candidate = await resume(position, false, challenger);
        comparison.replayed++;
        if (candidate.picked && candidate.picked !== control.picked) comparison.changedOpeningAction++;
        if (candidate.winner === seat) {
          comparison.wins++;
          if (candidate.picked && candidate.picked !== control.picked && comparison.examples.length < 2) {
            comparison.examples.push({ decks: position.decks, seed: position.seed, seat, turn: cp.turn,
              original: cp.options.find((a) => a.key === control.picked)?.text,
              alternative: cp.options.find((a) => a.key === candidate.picked)?.text });
          }
        }
        if (candidate.winner === null) comparison.draws++;
      }
      const best = variants.find((variant) => variant.winner === seat) ?? variants.find((variant) => variant.winner === null);
      if (best?.winner === seat) result.alternativeWins++;
      if (best?.winner === null) result.alternativeDraws++;
      if (best && result.examples.length < 3) result.examples.push({
        decks: position.decks, seed: position.seed, seat, turn: cp.turn,
        original: cp.options.find((a) => a.key === control.picked)?.text,
        alternative: cp.options.find((a) => a.key === best.picked)?.text,
        ending: [control.reason, best.reason],
      });
    } else if (control.winner === seat && variants.some((variant) => variant.winner === 1 - seat)) result.worsened++;
  }
  counterfactual[key] = result;
  console.log(key, JSON.stringify({ compared: result.compared, reproduced: result.reproducedLosses,
    wins: result.alternativeWins, draws: result.alternativeDraws, worsened: result.worsened }));
}
const report = { games, draws, breadth, losses, counterfactual, screening };
const suffix = [challenger, partial ? 'partial' : null, breadth > 1 ? 'breadth-' + breadth : null, reportName]
  .filter(Boolean).map((part) => '-' + part).join('');
await writeFile(join(root, `review${suffix}.json`), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ games, draws, byFormat: Object.fromEntries(Object.entries(losses)
  .map(([format, { games, endings, signals }]) => [format, { games, endings, signals }])) }));
