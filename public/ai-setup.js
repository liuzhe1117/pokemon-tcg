// Screen visible board changes cheaply. The tactical probe must execute each
// shortlisted action and the resulting attack before it can choose the line.
import { readyDamage } from './ai-combat.js';
import { deckCatalog, unseenCardCounts } from './ai-plan.js';
import { Mon, keptEffects } from './engine.js';

const ownBench = ['plusOwnBench', 'plusAllBench', 'timesAllBench', 'timesOwnInPlay', 'timesTagInPlay',
  'bonusIfEqualBench', 'needsBenchName', 'bonusIfBenchName', 'plusBenchNamed', 'plusBenchEvolved',
  'bonusIfBenchStage2Type', 'timesNamedInPlay', 'bonusIfFewerInPlay', 'bonusIfOwnBenchDamaged'];
const opposingBench = ['plusOppBench', 'plusAllBench', 'timesAllBench', 'bonusIfEqualBench', 'bonusIfFewerInPlay'];
const boardEnergy = ['timesAllEnergy', 'timesOwnEnergyAll', 'plusTypeEnergyAll', 'timesAttachedNameAll', 'timesBothActiveEnergy'];

function project(game, p, action) {
  const foe = game.opp(p);
  const view = Object.create(game);
  const owner = { ...p, bench: [...p.bench] };
  const opponent = { ...foe, bench: [...foe.bench] };
  view.players = game.players.map((side) => side === p ? owner : opponent);
  view.current = owner;
  view.first = view.players[game.first?.idx];
  const card = action.card;
  if (action.kind === 'bench' || action.tkind === 'echoingHorn') {
    const side = action.kind === 'bench' ? owner : opponent;
    const basic = side === owner ? card : foe.discard.find((c) => c.kind === 'pokemon' && c.stage === 0);
    if (!basic || side.bench.length >= 5) return null;
    side.bench.push(new Mon(basic, game.turn, view, -100 - side.bench.length));
  } else {
    const mon = action.target;
    const active = mon.id === p.active.id;
    const index = owner.bench.findIndex((m) => m.id === mon.id);
    if (!active && index < 0) return null;
    const current = active ? owner.active : owner.bench[index];
    const changed = Object.assign(Object.create(current), { game: view });
    if (action.kind === 'energy') changed.energy = [...current.energy, card, ...[action.card2].filter(Boolean)];
    else if (action.kind === 'evolve' || action.tkind === 'rareCandy') {
      changed.stack = [...current.stack, action.evo ?? card];
      changed.status = {};
      changed.effects = game.modern ? { ...keptEffects(current.effects), evolvedNow: { expires: game.turn } } : {};
    } else {
      changed.effects = game.modern ? { ...changed.effects, movedActive: { expires: game.turn } } : changed.effects;
      owner.bench[index] = Object.assign(Object.create(owner.active), {
        game: view, status: {}, effects: keptEffects(owner.active.effects),
      });
      owner.active = changed;
      return view;
    }
    if (active) owner.active = changed;
    else owner.bench[index] = changed;
  }
  return view;
}

const handCards = (a) => [a.card, a.card2, a.evo].filter(Boolean);
const dependsOn = (attacks, effects) => attacks.some(({ fx }) => effects.some((key) => fx[key]));
const evolves = (a) => a.kind === 'evolve' || a.tkind === 'rareCandy';

export function knockoutSetups(game, p, actions, hasBudget) {
  if (game.turn === 1 || !p.active || !game.opp(p).active ||
      !actions.some((a) => a.kind === 'bench' || a.tkind === 'echoingHorn' || evolves(a))) return [];
  const defender = game.opp(p).active;
  const attacks = game.attacksOf(p.active);
  const switchers = actions.filter((a) => a.tkind === 'switch' && a.target ||
    a.kind === 'retreat' && game.retreatCost(p, p.active) === 0);
  const changingAttacks = [...attacks, ...switchers.flatMap((a) => game.attacksOf(a.target))];
  const addsOwn = dependsOn(changingAttacks, ownBench);
  const addsOpposing = dependsOn(changingAttacks, opposingBench);
  const candidates = actions.filter((a) => addsOwn && (a.kind === 'bench' || evolves(a) && a.target !== p.active) ||
    addsOpposing && a.tkind === 'echoingHorn' || evolves(a) && a.target === p.active &&
      dependsOn((a.evo ?? a.card).attacks, [...ownBench, ...opposingBench]));
  if (!candidates.length || readyDamage(game, p.active, defender, undefined, { certain: true, attacks }) >= defender.hpLeft) return [];
  const energyTargets = new Set([p.active, ...switchers.map((a) => a.target)]);
  const scalesWithEnergy = dependsOn(changingAttacks, boardEnergy);
  const complements = [...candidates, ...switchers, ...actions.filter((a) =>
    a.kind === 'energy' && (energyTargets.has(a.target) || scalesWithEnergy))];
  const damage = (view) => {
    const owner = view.players[p.idx];
    return readyDamage(view, owner.active, defender, undefined, { owner, certain: true });
  };
  const variants = [];
  const singles = new Set();
  for (const action of candidates) {
    if (!hasBudget()) return variants;
    const view = project(game, p, action);
    if (!view) continue;
    if (damage(view) >= defender.hpLeft) {
      singles.add(action);
      variants.push([action]);
      if (variants.length === 3) return variants;
    }
  }
  for (const action of candidates) {
    if (singles.has(action)) continue;
    const view = project(game, p, action);
    if (!view) continue;
    for (const next of complements) {
      if (!hasBudget()) return variants;
      if (next === action || singles.has(next) || handCards(next).some((card) => handCards(action).includes(card))) continue;
      // These two orders have identical projected occupancy and use the same cards.
      if (action.kind === 'bench' && next.kind === 'bench' && candidates.indexOf(next) < candidates.indexOf(action)) continue;
      const after = project(view, view.current, next);
      if (after && damage(after) >= defender.hpLeft) {
        variants.push([action, next]);
        if (variants.length === 3) return variants;
      }
    }
  }
  return variants;
}

export function setupCards(steps) {
  return steps.filter(({ action }) => action.kind !== 'attack').flatMap(({ action }) => handCards(action));
}

export function redundantPokemonSearch(game, p, action, knownPrizes) {
  if (action.tkind !== 'ultraBall' || p.bench.length < 5 || !knownPrizes || !p.deck.length) return false;
  const { list } = deckCatalog(p);
  const counts = unseenCardCounts(game, p, list);
  if (list.reduce((n, [card]) => n + Math.max(0, (counts.get(card.id) || 0) - (knownPrizes.get(card.id) || 0)), 0) !== p.deck.length) return false;
  return !list.some(([card]) => card.kind === 'pokemon' && card.stage > 0 &&
    (counts.get(card.id) || 0) > (knownPrizes.get(card.id) || 0));
}
