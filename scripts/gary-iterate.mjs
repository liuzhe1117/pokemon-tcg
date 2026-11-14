import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.cache/gary-arena/v3-iteration');
const workers = process.argv[3] ?? '5';
const firstReview = resolve('.cache/gary-arena/v3-all-pairs/review-v4.json');
const firstHoldout = resolve('.cache/gary-arena/v4-holdout/summary.json');
const decks = ['sv-melmetal', 'swv-lycanroc', 'c30-umbreon', 'swl-inteleon', 'svl-gardevoir', 'svd-miraidon',
  'sm-hydro-fury', 'swv-noivern', 'swv-victini', 'sm-bright-tide', 'svl-charizard', 'svd-koraidon',
  'me-gengar', 'mel-lucario', 'svd-zapdos', 'swl-zacian', 'koga', 'grass-chopper', 'overgrowth', 'sabrina',
  'trouble', 'psych-out', 'misty', 'lt-surge', 'ash', 'brock'];
const candidates = [
  ['draw-before-retreat', 'paid-retreat', 'Draw before paying for a retreat without a knockout.'],
  ['reserve-deck', 'thin-deck', 'Protect the last draw from optional abilities and Trainers.'],
  ['charge-before-retreat', 'paid-retreat', 'Attach to the Active when it enables a knockout that retreat does not.'],
  ['switch-instead-of-retreat', 'paid-retreat', 'Use a Switch card for the same destination instead of discarding Energy.'],
  ['search-before-attack', 'setup-before-attack', 'Find a missing piece of the deck plan before a low-impact attack.'],
  ['cleaner-attack', 'attack-choice', 'Keep Energy and avoid recoil or lockout when another attack has comparable guaranteed damage.'],
  ['backup-before-attack', 'setup-before-attack', 'Establish a backup early before a non-knockout attack.'],
  ['stay-with-safe-attack', 'paid-retreat', 'Keep a healthy Active that attacks almost as well as the paid pivot.'],
  ['preserve-bench-slots', 'bench-prize', 'Save late Bench slots for useful Pokémon and avoid unnecessary Prize liabilities.'],
];

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const exists = async (file) => access(file).then(() => true, () => false);
async function run(script, args) {
  const processRun = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
  const [code, signal] = await once(processRun, 'exit');
  if (code !== 0) throw new Error(`${script} exited with ${signal || code}`);
}
function results(report) {
  const totals = { wins: 0, losses: 0, draws: 0, games: report.games };
  for (const format of Object.values(report.formats)) {
    totals.wins += format.challengerWins;
    totals.draws += format.draws;
    totals.losses += format.games - format.challengerWins - format.draws;
  }
  return totals;
}
function evidence(report, tag) {
  return Object.entries(report.counterfactual).filter(([key]) => key.endsWith('/' + tag)).map(([key, value]) => ({
    format: key.split('/')[0], samples: value.reproducedLosses, alternativeWins: value.alternativeWins, examples: value.examples,
  }));
}

await mkdir(root, { recursive: true });
const statusFile = join(root, 'progress.json');
const status = await exists(statusFile) ? await json(statusFile) : { incumbent: [], rounds: [], final: {} };
async function save() {
  await writeFile(statusFile + '.tmp', JSON.stringify(status, null, 2) + '\n');
  await rename(statusFile + '.tmp', statusFile);
}
async function arena(mode, path, args) {
  if (await exists(join(path, 'summary.json'))) return json(join(path, 'summary.json'));
  // A retry gets a fresh shard directory if a previous process stopped mid-write.
  const actualPath = await exists(path) ? path + '-retry-' + Date.now() : path;
  await run('scripts/gary-arena.mjs', [mode, '--workers=' + workers, '--out=' + actualPath, ...args]);
  if (actualPath !== path) {
    const previous = path + '-interrupted-' + Date.now();
    await rename(path, previous);
    await rename(actualPath, path);
  }
  return json(join(path, 'summary.json'));
}
const sameDecks = '--decks=' + decks.join(',');
const profile = (features) => '--features=' + features.join(',');
const challenger = (features) => '--challenger-features=' + features.join(',');
const ahead = (record) => record.wins > record.losses;

if (!status.rounds.length) {
  const proposed = ['draw-before-attack', 'redirect-energy'];
  let review, holdout;
  if (await exists(firstReview) && await exists(firstHoldout)) {
    review = await json(firstReview);
    holdout = await json(firstHoldout);
  } else {
    const directory = join(root, 'round-01'), self = join(directory, 'selfplay');
    await arena('selfplay', self, ['--version=v3', profile([]), '--offset=80']);
    const reviewPath = join(self, 'review.json');
    if (!await exists(reviewPath)) await run('scripts/gary-review.mjs', [self, '40', '--focus=energy-target,setup-before-attack']);
    review = await json(reviewPath);
    holdout = await arena('evaluate', join(directory, 'primary'),
      ['--version=v3', '--challenger=v3', profile([]), challenger(proposed), '--offset=140']);
  }
  const comparison = results(holdout);
  const promote = ahead(comparison);
  if (promote) status.incumbent = proposed;
  status.rounds.push({ round: 1, proposed, selfplay: review.games,
    evidence: [...evidence(review, 'energy-target'), ...evidence(review, 'setup-before-attack')], comparison,
    promoted: promote, reason: promote ? 'More wins than losses across the full paired holdout.' : 'The full paired holdout did not improve.',
    incumbent: status.incumbent });
  await save();
}

for (const [index, [feature, tag, hypothesis]] of candidates.entries()) {
  const round = index + 2;
  if (status.rounds.length >= round) continue;
  console.log(`Round ${round} → ${feature}; incumbent: ${status.incumbent.join(',') || 'original V3'}`);
  const directory = join(root, 'round-' + String(round).padStart(2, '0'));
  const self = join(directory, 'selfplay'), reviewPath = join(self, 'review.json');
  const offset = 500 + 100 * round;
  const selfplay = await arena('selfplay', self, ['--version=v3', profile(status.incumbent), sameDecks, '--offset=' + offset]);
  if (!await exists(reviewPath)) await run('scripts/gary-review.mjs', [self, '16', '--focus=' + tag]);
  const review = await json(reviewPath);
  const next = [...status.incumbent, feature];
  const args = ['--version=v3', '--challenger=v3', profile(status.incumbent), challenger(next), sameDecks, '--seeds=2'];
  const primary = results(await arena('evaluate', join(directory, 'primary'), [...args, '--offset=' + (offset + 20)]));
  const confirmation = ahead(primary)
    ? results(await arena('evaluate', join(directory, 'confirmation'), [...args, '--offset=' + (offset + 40)])) : null;
  const promoted = confirmation !== null && ahead(confirmation);
  if (promoted) status.incumbent = next;
  const reason = promoted ? 'Won both independent paired batches.' : confirmation
    ? 'The positive first batch did not replicate.' : primary.wins === primary.losses
      ? 'The first paired batch tied.' : 'Lost the first paired batch.';
  status.rounds.push({ round, proposed: [feature], hypothesis, selfplay: selfplay.games, evidence: evidence(review, tag),
    primary, confirmation, promoted, reason, incumbent: status.incumbent });
  await save();
  console.log(JSON.stringify({ round, feature, primary, confirmation, promoted, reason }));
}

for (const version of ['v2', 'v1']) {
  if (status.final[version]) continue;
  const report = await arena('evaluate', join(root, 'final-vs-' + version),
    ['--version=' + version, '--challenger=v3', challenger(status.incumbent), '--offset=1900']);
  status.final[version] = { ...results(report), formats: report.formats, decisions: report.decisions, movement: report.movement };
  await save();
}
console.log(JSON.stringify({ completed: status.rounds.length, incumbent: status.incumbent, final: status.final }));
