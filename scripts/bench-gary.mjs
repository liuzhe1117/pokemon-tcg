// Paired games. Swap the controllers on a fixed deck order and RNG seed.
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AIController } from '../public/ai.js';
import { DECKS, loadDeck } from '../public/cards.js';
import { Game, canPay } from '../public/engine.js';
import { experimentControllerOptions } from './gary-policy-experiments.mjs';

const args = process.argv.slice(2);
const previousPath = args.find((arg) => arg.startsWith('--previous='))?.slice('--previous='.length);
const seedOffset = Number(args.find((arg) => arg.startsWith('--offset='))?.slice('--offset='.length) ?? 0);
const against = args.find((arg) => arg.startsWith('--against='))?.slice('--against='.length);
const profile = args.find((arg) => arg.startsWith('--profile='))?.slice('--profile='.length).split(',').filter(Boolean);
const baselineProfile = args.find((arg) => arg.startsWith('--baseline-profile='))?.slice('--baseline-profile='.length).split(',').filter(Boolean);
const compareV3 = args.includes('--v3');
const [seedCount = '8', ...requestedDecks] = args.filter((arg) => arg !== '--v3' &&
  !arg.startsWith('--previous=') && !arg.startsWith('--against=') && !arg.startsWith('--profile=') &&
  !arg.startsWith('--baseline-profile=') && !arg.startsWith('--offset='));
const seeds = Number(seedCount);
const decks = requestedDecks.length ? requestedDecks :
  ['sv-miraidon', 'svl-charizard', 'svl-gardevoir', 'svl-dragapult', 'mel-lucario', 'me-gengar'];
if ((compareV3 && previousPath) || (profile && !compareV3) || (against && (!compareV3 || !['v1', 'v2', 'v3'].includes(against))) ||
    (baselineProfile && against !== 'v3') ||
    !Number.isInteger(seeds) || seeds < 1 || !Number.isInteger(seedOffset) || seedOffset < 0 || decks.some((key) => !DECKS[key]) ||
    new Set(decks.map((key) => DECKS[key].format ?? 'classic')).size !== 1) {
  throw new Error('Usage: node scripts/bench-gary.mjs [seeds] [deck keys...] [--v3 | --previous=path/to/public] [--offset=N] [--against=v1|v2|v3] [--profile=name,...] [--baseline-profile=name,...]');
}
await Promise.all(decks.map(loadDeck));
let PreviousController;
if (previousPath) {
  const from = (file) => import(pathToFileURL(resolve(previousPath, file)).href);
  const [{ AIController: Previous }, { loadDeck: loadPrevious }] = await Promise.all([from('ai.js'), from('cards.js')]);
  await Promise.all(decks.map(loadPrevious));
  PreviousController = Previous;
}
const subjectMode = compareV3 ? against === 'v3' ? 'candidate' : 'v3' : previousPath ? 'current' : 'hard';
const opponentMode = compareV3 ? against ?? 'v2' : PreviousController ? 'previous' : 'cpu';

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const times = { [subjectMode]: { action: [], prompt: [] }, [opponentMode]: { action: [], prompt: [] } };
const reasons = {};
const byDeck = new Map(decks.map((key) => [key, { wins: 0, losses: 0, draws: 0 }]));
const byMatchup = new Map();
const byTurnOrder = { first: { wins: 0, losses: 0, draws: 0 }, second: { wins: 0, losses: 0, draws: 0 } };
const outcomes = { wins: 0, losses: 0, draws: 0 };
const winsByReason = {};
let capped = 0;
let lethalTurns = 0, convertedLethals = 0;
const movement = { switches: 0, retreatEnergyCards: 0, returnTurns: 0, paidReturnTurns: 0, energyOnReturnTurns: 0 };
const energy = { activeAttachments: 0, benchAttachments: 0, activeAlreadyReady: 0 };

function bot(mode, record, provenTurns) {
  let reason;
  const Controller = mode === 'previous' ? PreviousController : AIController;
  const controller = new Controller({
    hard: () => mode !== 'cpu',
    ...(previousPath ? { version: () => 'v3' } : {}),
    ...(compareV3 ? experimentControllerOptions(mode === 'candidate' ? 'v3' : mode,
      mode === subjectMode ? profile : baselineProfile) : {}),
    onDecision: (_, answer) => { reason = answer.reason; },
  });
  for (const [name, type] of [['chooseAction', 'action'], ['choose', 'prompt']]) {
    const choose = controller[name].bind(controller);
    controller[name] = async (...args) => {
      reason = null;
      const start = performance.now();
      const result = await choose(...args);
      if (record) times[mode][type].push(performance.now() - start);
      if (record && mode === subjectMode && reason) {
        reasons[reason] = (reasons[reason] || 0) + 1;
        if (reason === 'lethal') provenTurns.add(args[0].turn);
      }
      return result;
    };
  }
  return controller;
}

async function play(pair, seed, hardSeat, record) {
  const provenTurns = new Set();
  const controllers = [0, 1].map((seat) => bot(seat === hardSeat ? subjectMode : opponentMode, record, provenTurns));
  const game = new Game({ decks: pair, controllers, random: rng(seed) });
  const turns = new Map();
  const perform = game.perform.bind(game);
  game.perform = async (player, action) => {
    if (!record || player.idx !== hardSeat || action.kind === 'attack' || action.kind === 'end') return perform(player, action);
    const active = player.active;
    if (action.kind === 'energy') {
      if (action.target === active) {
        energy.activeAttachments++;
        const attacks = game.attacksOf(active), before = active.payTypes;
        const after = [...before, ...[action.card, action.card2].filter(Boolean).flatMap((c) => Array(c.provides || 1).fill(c.energyType))];
        if (attacks.some((a) => canPay(before, a.cost)) && !attacks.some((a) => !canPay(before, a.cost) && canPay(after, a.cost))) {
          energy.activeAlreadyReady++;
        }
      } else energy.benchAttachments++;
    }
    const before = action.kind === 'retreat' ? active.energy.length : 0;
    const ended = await perform(player, action);
    if (!active || !player.active || active === player.active) return ended;
    const paid = action.kind === 'retreat' ? before - active.energy.length : 0;
    const turn = turns.get(game.turn) ?? { visited: new Map([[active.id, 0]]), energy: 0, returned: false, paidReturn: false };
    turn.energy += paid;
    if (turn.visited.has(player.active.id)) {
      turn.returned = true;
      turn.paidReturn ||= turn.energy > turn.visited.get(player.active.id);
    }
    turn.visited.set(player.active.id, turn.energy);
    turns.set(game.turn, turn);
    movement.switches++;
    movement.retreatEnergyCards += paid;
    return ended;
  };
  const startTurn = game.startTurn.bind(game);
  game.startTurn = async (player) => {
    if (game.turn >= 300) {
      if (record) capped++;
      game.setWinner('draw', 'reason.both');
    } else await startTurn(player);
  };
  await game.run();
  if (!record) return;
  for (const turn of turns.values()) {
    if (turn.returned) movement.returnTurns++;
    if (turn.paidReturn) {
      movement.paidReturnTurns++;
      movement.energyOnReturnTurns += turn.energy;
    }
  }
  const outcome = game.winner === game.players[hardSeat] ? 'wins' : game.winner === 'draw' ? 'draws' : 'losses';
  const reason = game.winReason?.key;
  const finishingTurn = reason === 'reason.deckout' ? game.turn - 1 : game.turn;
  lethalTurns += provenTurns.size;
  if (outcome === 'wins' && provenTurns.has(finishingTurn)) convertedLethals++;
  outcomes[outcome]++;
  byDeck.get(pair[hardSeat])[outcome]++;
  byTurnOrder[game.first.idx === hardSeat ? 'first' : 'second'][outcome]++;
  const matchup = pair[hardSeat] + ' vs ' + pair[1 - hardSeat];
  if (!byMatchup.has(matchup)) byMatchup.set(matchup, { wins: 0, losses: 0, draws: 0 });
  byMatchup.get(matchup)[outcome]++;
  if (reason) {
    const counts = winsByReason[reason] ??= { wins: 0, losses: 0, draws: 0 };
    counts[outcome]++;
  }
}

function latency(values) {
  values.sort((a, b) => a - b);
  const percentile = (p) => values[Math.ceil(values.length * p) - 1]?.toFixed(3);
  return { count: values.length, p50Ms: Number(percentile(0.5)), p95Ms: Number(percentile(0.95)), maxMs: Number(percentile(1)) };
}

for (let i = 0; i < 8; i++) await play([decks[i % decks.length], decks[(i + 1) % decks.length]], 101 + i, i % 2, false);
const start = performance.now();
for (let left = 0; left < decks.length; left++) {
  for (let right = left; right < decks.length; right++) {
    for (let seed = 0; seed < seeds; seed++) {
      const pair = [decks[left], decks[right]];
      const runSeed = 20261112 + left * 103009 + right * 70001 + (seed + seedOffset) * 1337;
      await play(pair, runSeed, 0, true);
      await play(pair, runSeed, 1, true);
    }
  }
}
const total = outcomes.wins + outcomes.losses + outcomes.draws;
console.log(JSON.stringify({
  opponent: opponentMode, games: total, seedsPerMatchup: seeds, seedOffset, ...outcomes, winRate: outcomes.wins / total, capped,
  durationSeconds: (performance.now() - start) / 1000, byDeck: Object.fromEntries(byDeck), winsByReason,
  byTurnOrder, byMatchup: Object.fromEntries(byMatchup),
  lethalTurns, convertedLethals, movement, energy, hardDecisions: reasons,
  latency: Object.fromEntries(Object.entries(times).map(([mode, buckets]) =>
    [mode, Object.fromEntries(Object.entries(buckets).map(([type, values]) => [type, latency(values)]))])),
}, null, 2));
