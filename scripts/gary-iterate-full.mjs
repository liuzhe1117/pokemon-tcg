import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { garyV3Profile } from '../public/ai-v3-current.js';
import { DECKS } from '../public/cards.js';

const root = resolve(process.argv[2] ?? '.cache/gary-arena/v3-full-iteration');
const workers = Number(process.argv[3] ?? 8);
if (!Number.isInteger(workers) || workers < 1) throw new Error('Pass a positive worker count.');
const until = process.argv.find((arg) => arg.startsWith('--until='))?.slice(8);
const deadline = until ? Date.parse(until) : null;
if (until && !Number.isFinite(deadline)) throw new Error('Pass --until with an ISO date and timezone.');
const continuing = process.argv.find((arg) => arg.startsWith('--continue='))?.slice(11);
const baseRules = ['draw-before-attack', 'redirect-energy'];
const options = [
  ['attack-effects'], ['attack-sustain'], ['stage-development'], ['matchup-development'], ['energy-readiness'],
  ['board-readiness'], ['reply-risk'], ['reserve-protection'], ['resource-cost'], ['prize-pressure'],
  ['search-diversity'], ['tactical-confidence'], ['patient-tactics'],
  ['attack-effects', 'reply-risk'], ['energy-readiness', 'matchup-development'],
  ['stage-development', 'reserve-protection'], ['prize-pressure', 'search-diversity'],
  ['board-readiness', 'resource-cost'], ['reply-risk', 'patient-tactics'],
  ['search-diversity', 'tactical-confidence'],
  ['acceleration-order'], ['knockout-order'], ['acceleration-order', 'knockout-order'],
];
const focus = [
  ['energy-target', 'pass-with-attack'],
  ['attack-choice', 'last-exchange'],
  ['setup-before-attack', 'opening-alone', 'search-setup'],
  ['paid-retreat', 'bench-prize'],
  ['thin-deck', 'opponent-target', 'turn-sequence'],
];
const mutuallyExclusive = [['attack-effects', 'attack-sustain'], ['tactical-confidence', 'patient-tactics']];
const counts = Object.values(DECKS).reduce((sum, deck) => {
  sum[deck.format] = (sum[deck.format] || 0) + 1;
  return sum;
}, {});
const expected = Object.values(counts).reduce((sum, count) => sum + count * (count + 1), 0);
const profileArg = (features) => '--features=' + features.join(',');
const candidateArg = (features) => '--challenger-features=' + features.join(',');
const key = (features) => [...features].sort().join(',');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const exists = async (file) => access(file).then(() => true, () => false);
const statusFile = join(root, 'progress.json');

await mkdir(root, { recursive: true });
const status = await exists(statusFile) ? await json(statusFile) : {
  initial: garyV3Profile, incumbent: garyV3Profile, rounds: [], final: {},
};
if (status.deadline !== undefined && status.deadline !== deadline) throw new Error('Resume with the same cutoff and output path.');
status.deadline = deadline;
if (continuing && !status.checkpoint) {
  if (!deadline || status.rounds.length) throw new Error('Use a fresh output path and --until to continue another run.');
  const source = resolve(continuing);
  let earlier;
  do {
    earlier = await exists(join(source, 'progress.json')) ? await json(join(source, 'progress.json')) : null;
    if ((earlier?.rounds.length ?? 0) < 10) {
      if (Date.now() >= deadline) throw new Error('The source rounds did not finish before the cutoff.');
      await setTimeout(2500);
    }
  } while ((earlier?.rounds.length ?? 0) < 10);
  for (const { round } of earlier.rounds) {
    const directory = 'round-' + String(round).padStart(2, '0');
    if (!await exists(join(root, directory))) await symlink(join(source, directory), join(root, directory));
  }
  Object.assign(status, {
    initial: earlier.initial, incumbent: earlier.incumbent, rounds: earlier.rounds,
    checkpoint: { profile: earlier.incumbent, round: earlier.rounds.length, source },
  });
}
async function save() {
  await writeFile(statusFile + '.tmp', JSON.stringify(status, null, 2) + '\n');
  await rename(statusFile + '.tmp', statusFile);
}

async function run(script, args, output = 'inherit') {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', output, 'inherit'] });
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) throw new Error(`${script} exited with ${signal || code}`);
}

async function arena(mode, directory, args, count = workers) {
  const summary = join(directory, 'summary.json');
  if (!await exists(summary)) {
    if (await exists(directory)) await rename(directory, directory + '-interrupted-' + Date.now());
    await run('scripts/gary-arena.mjs', [mode, '--out=' + directory, '--workers=' + count, ...args]);
  }
  const result = await json(summary);
  if (result.games !== expected) throw new Error(`Unexpected result from ${directory}`);
  return result;
}

function results(report) {
  const totals = { wins: 0, losses: 0, draws: 0, games: report.games, capped: report.capped, formats: report.formats,
    movement: report.movement, seconds: report.seconds };
  for (const format of Object.values(report.formats)) {
    totals.wins += format.challengerWins;
    totals.draws += format.draws;
    totals.losses += format.games - format.challengerWins - format.draws;
  }
  return totals;
}

const nameOf = (feature) => feature.split('@')[0];
function profilesFor(status, round) {
  const completed = new Set([key(status.initial), ...status.rounds.map(({ proposed }) => key(proposed))]);
  const profiles = new Map();
  const include = (features) => {
    const id = key(features);
    if (id === key(status.incumbent) || completed.has(id)) return;
    const added = features.filter((feature) => !status.incumbent.includes(feature));
    const removed = status.incumbent.filter((feature) => !features.includes(feature));
    profiles.set(id, { id, features, changes: [...added, ...removed.map((feature) => '-' + feature)] });
  };
  for (const additions of options) {
    const excluded = new Set([...additions, ...mutuallyExclusive.filter((family) => family.some((name) => additions.includes(name))).flat()]);
    include([...new Set([...status.incumbent.filter((entry) => !excluded.has(nameOf(entry))), ...additions])]);
  }
  if (deadline !== null) {
    const tunable = [...new Set(options.flat())].filter((name) => name !== 'search-diversity');
    const strengths = [0.55, 1.35, 0.8, 1.65, 0.35, 1.15, 1.85];
    const active = status.incumbent.filter((feature) => !baseRules.includes(feature));
    for (const feature of active) {
      include(status.incumbent.filter((entry) => entry !== feature));
    }
    for (const [index, name] of tunable.entries()) {
      const choice = tunable[(index + round) % tunable.length];
      const weight = strengths[(round + index) % strengths.length];
      const family = mutuallyExclusive.find((entries) => entries.includes(choice)) ?? [choice];
      const reduced = status.incumbent.filter((entry) => !family.includes(nameOf(entry)));
      include([...reduced, choice + '@' + weight]);
      if (name !== choice) include([...reduced, choice + '@' + strengths[(round + index + 2) % strengths.length]]);
    }
  }
  if (profiles.size < 10) {
    for (const feature of status.incumbent.filter((name) => !baseRules.includes(name)).toReversed()) {
      const reduced = status.incumbent.filter((name) => name !== feature);
      include(reduced);
      for (const additions of options) {
        const next = [...new Set([...reduced, ...additions])];
        if (!mutuallyExclusive.some((family) => family.every((name) => next.some((entry) => nameOf(entry) === name))) &&
            new Set(next.map(nameOf)).size === next.length) include(next);
        if (profiles.size >= 16) break;
      }
      if (profiles.size >= 16) break;
    }
  }
  if (!profiles.size) throw new Error('No untested strategy profiles remain.');
  const available = [...profiles.values()];
  if (deadline === null || available.length <= 20) return available;
  const first = (round * 7) % available.length;
  return available.slice(first).concat(available.slice(0, first)).slice(0, 20);
}

function aggregate(reports, profiles) {
  const evidence = {};
  for (const report of reports) for (const [phase, data] of Object.entries(report.counterfactual)) {
    evidence[phase] = { seen: data.seen, positions: data.reproducedLosses, branches: data.branches,
      wins: data.alternativeWins, draws: data.alternativeDraws, examples: data.examples };
  }
  const ranked = profiles.map((profile) => {
    const total = { compared: 0, changed: 0, matchedWins: 0, phases: {} };
    for (const report of reports) {
      const row = report.screening[profile.id];
      for (const field of ['compared', 'changed', 'matchedWins']) total[field] += row[field];
      Object.assign(total.phases, row.phases);
    }
    const changedPhases = Object.values(total.phases).filter((p) => p.changed > 0).length;
    const score = total.matchedWins * 5 + changedPhases + Math.log1p(total.changed);
    return { ...profile, ...total, changedPhases, score };
  }).sort((a, b) => b.score - a.score);
  return { ranked, evidence };
}

for (let round = status.rounds.length + 1; deadline !== null || round <= 10; round++) {
  const directory = join(root, 'round-' + String(round).padStart(2, '0'));
  const offset = deadline === null ? 10000 + (round - 1) * 250 : 20000 + (round - 1) * 250;
  const self = join(directory, 'selfplay');
  const startedAt = status.active?.round === round && await exists(self) ? status.active.startedAt : null;
  if (deadline !== null && !startedAt && Date.now() >= deadline) break;
  status.active = { round, phase: 'selfplay', profile: status.incumbent, startedAt: startedAt ?? new Date().toISOString() };
  await save();
  if (deadline !== null && !startedAt && Date.now() >= deadline) break;
  console.log(`Round ${round}, selfplay with ${status.incumbent.join(', ')}`);
  const corpus = await arena('selfplay', self, ['--version=v3', profileArg(status.incumbent), '--offset=' + offset, '--checkpoints=expanded']);
  status.active.phase = 'review';
  await save();
  const reviewPath = join(directory, 'selection.json');
  if (!await exists(reviewPath)) {
    const profiles = profilesFor(status, round);
    const screenFile = join(directory, 'profiles.json');
    await writeFile(screenFile, JSON.stringify(profiles) + '\n');
    const reports = await Promise.all(focus.map(async (phases, index) => {
      const name = 'part-' + index, path = join(self, 'review-breadth-3-' + name + '.json');
      if (!await exists(path)) await run('scripts/gary-review.mjs', [self, '12', '--breadth=3',
        '--focus=' + phases.join(','), '--screen=' + screenFile, '--report=' + name]);
      return json(path);
    }));
    await writeFile(reviewPath + '.tmp', JSON.stringify(aggregate(reports, profiles), null, 2) + '\n');
    await rename(reviewPath + '.tmp', reviewPath);
  }
  const { ranked, evidence } = await json(reviewPath);
  const chosen = ranked[0];
  status.active = { ...status.active, phase: 'evaluate', candidate: chosen.changes, screen: chosen };
  await save();
  console.log(`Round ${round}, selected ${chosen.changes.join(', ')} with ${chosen.changed}/${chosen.compared} changed actions across ${chosen.changedPhases} phases`);
  const result = results(await arena('evaluate', join(directory, 'evaluate'),
    ['--version=v3', profileArg(status.incumbent), '--challenger=v3', candidateArg(chosen.features), '--offset=' + (offset + 80)]));
  const promoted = result.wins > result.losses;
  const before = status.incumbent;
  if (promoted) status.incumbent = chosen.features;
  status.rounds.push({ round, selfplay: corpus.games, proposed: chosen.features, changes: chosen.changes,
    screen: chosen, evidence, comparison: result, promoted, before, incumbent: status.incumbent,
    startedAt: status.active.startedAt, finishedAt: new Date().toISOString() });
  await save();
  console.log(JSON.stringify({ round, proposed: chosen.changes, wins: result.wins, losses: result.losses, draws: result.draws, promoted }));
}

status.active = { phase: 'final', profile: status.incumbent };
await save();
const references = ['v1', 'v2', 'original-v3'];
if (status.checkpoint) references.push('checkpoint-v3');
await Promise.all(references.map(async (opponent) => {
  if (status.final[opponent]) return;
  const version = opponent.endsWith('-v3') ? 'v3' : opponent;
  const args = ['--version=' + version, '--challenger=v3', candidateArg(status.incumbent), '--offset=' + (deadline === null ? 15000 : 50000)];
  if (version === 'v3') args.push(profileArg(opponent === 'checkpoint-v3' ? status.checkpoint.profile : status.initial));
  const result = results(await arena('evaluate', join(root, 'final-vs-' + opponent), args, Math.max(1, Math.floor(workers / references.length))));
  status.final[opponent] = result;
}));
await save();
if (deadline !== null) {
  status.active.phase = 'benchmark';
  await save();
  status.sixDeck = status.sixDeck ?? {};
  for (const opponent of ['v1', 'v2']) {
    if (status.sixDeck[opponent]) continue;
    const path = join(root, 'six-modern-vs-' + opponent + '.json');
    const output = await open(path + '.tmp', 'w');
    try {
      await run('scripts/bench-gary.mjs', ['24', '--v3', '--profile=' + status.incumbent.join(','), '--against=' + opponent], output.fd);
    } finally {
      await output.close();
    }
    await rename(path + '.tmp', path);
    const report = await json(path);
    status.sixDeck[opponent] = { wins: report.wins, losses: report.losses, draws: report.draws, games: report.games, latency: report.latency };
    await save();
  }
}
status.active = { phase: 'completed' };
await save();
console.log(JSON.stringify({ completed: status.rounds.length, incumbent: status.incumbent, final: status.final }));
