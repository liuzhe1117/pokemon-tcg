// Gary's difficulty uses the value of the whole set of cards left after paying a cost.
import { canPay, isType, matchesAttackDiscard } from './engine.js';
import { deckCatalog, energyMissing } from './ai-plan.js';

const units = (card) => Array(card.provides || 1).fill(card.energyType);
export const attackEnergyTypes = (mon, cards) => mon.card.powerKind === 'energyBurn' && mon.payTypes.every((t) => t === 'Fire') &&
  !mon.status.asleep && !mon.status.confused && !mon.status.paralyzed && !mon.effects.noPower
  ? cards.flatMap(units).map(() => 'Fire') : cards.flatMap(units);

export function attackPotential(game, mon, cards = mon.energy) {
  const energy = attackEnergyTypes(mon, cards);
  return Math.max(0, ...game.attacksOf(mon).map((attack) => {
    const missing = energyMissing(energy, attack.cost);
    const strength = 12 + Math.min(attack.base, 240) / 7 + (attack.fx.spread ? 6 : 0);
    return strength * (missing === 0 ? 1 : 0.45 ** missing);
  }));
}

const drawSupport = new Set(['bill', 'professorOak', 'professorsResearch', 'nemona', 'lilliesDetermination', 'iono', 'marnie',
  'cynthia', 'hop', 'youngster', 'barry', 'judge', 'shauna', 'hau', 'arven', 'trAriana', 'roxanne']);
const setupSearch = new Set(['ultraBall', 'quickBall', 'nestBall', 'buddyPoffin', 'levelBall', 'greatBall', 'pokePad',
  'computerSearch', 'evolutionIncense', 'jacq', 'arven', 'hilda', 'energySearch', 'earthenVessel']);
const gusts = new Set(['gust', 'bossOrders', 'counterCatcher', 'primeCatcher', 'guzma', 'trGiovanni']);
const switches = new Set(['switch', 'switchCart', 'primeCatcher', 'guzma', 'birdKeeper']);
const discardEnergyPowers = new Set(['psychicEmbrace', 'infernalReign', 'starPortal', 'dynamotor', 'darkPatchPower',
  'blazingInferno', 'firestarter', 'magneticAbsorption', 'energyConcerto', 'darkSignalEnergy']);
const discardEnergyTrainers = new Set(['darkPatch', 'aquaPatch', 'metalSaucer', 'energyRetrieval', 'energyRetrievalM',
  'superRod', 'nightStretcher', 'melony', 'ordinaryRod', 'brocksGrit', 'superiorEnergyRetrieval']);

export function handEvaluator(game, p, plan) {
  const cards = deckCatalog(p).list.map(([card]) => card);
  const board = game.allMons(p);
  const foe = game.opp(p);
  const evos = new Map(cards.filter((card) => card.evolvesFrom).map((card) => [card.name, card.evolvesFrom]));
  const energyUsers = [...board.map((m) => m.card), ...cards.filter((c) => c.kind === 'pokemon')];
  const hasEnergyRecovery = [...board.map((mon) => mon.card), ...p.hand].some((c) =>
    discardEnergyPowers.has(c.powerKind) || discardEnergyTrainers.has(c.tkind));
  const recoverable = (card) => hasEnergyRecovery && card.kind === 'energy' && !card.special &&
    !p.discard.some((c) => c.kind === 'energy' && !c.special && c.energyType === card.energyType);
  const values = new Map();

  function cardValue(card) {
    if (values.has(card)) return values.get(card);
    let value;
    if (card.kind === 'energy') {
      const paysColor = (c) => c.attacks?.some((a) => a.cost.some((t) => t !== 'Colorless' && isType(card.energyType, t)));
      const onBoard = board.some((m) => paysColor(m.card));
      value = (onBoard ? 13 : energyUsers.some(paysColor) ? 10 : 7) + (card.special ? 5 : 0);
      if (!p.flags.energy && board.some((m) => game.attacksOf(m).some((a) =>
        !canPay(m.payTypes, a.cost) && canPay([...m.payTypes, ...units(card)], a.cost)))) value += 8;
    } else if (card.kind === 'pokemon') {
      if (card.stage === 0) {
        value = (p.bench.length >= 5 ? 5 : 10) + (card.powerKind ? 3 : 0) +
          (board.length <= 1 ? 8 : 0) + (cards.some((c) => c.evolvesFrom === card.name) ? 3 : 0);
      } else {
        const basic = evos.get(card.evolvesFrom);
        value = 5 + (board.some((m) => m.name === card.evolvesFrom) ? 15 :
          card.stage === 2 && board.some((m) => m.name === basic) ? 9 : 0);
        if (card.powerKind) value += 3;
      }
    } else {
      const kind = card.tkind;
      value = card.aceSpec ? 16 : 7;
      if (drawSupport.has(kind)) value += p.deck.length > 8 ? 8 : 0;
      if (setupSearch.has(kind)) value += p.deck.length > 3 && (board.length <= 2 || game.turn < 8) ? 9 : 4;
      if (kind === 'rareCandy') value += board.some((m) => m.card.stage === 0 &&
        cards.some((c) => c.stage === 2 && evos.get(c.evolvesFrom) === m.name)) ? 10 : 3;
      if (gusts.has(kind)) value += foe.bench.length ? 12 : 6;
      if (switches.has(kind)) value += board.some((m) => m !== p.active && attackPotential(game, m) > 15) ? 9 : 4;
      if (card.ttype === 'stadium' && game.stadium?.card.name === card.name) value -= 4;
      if (card.ttype === 'supporter' && p.flags.supporter) value -= 2;
    }
    value += plan?.keepPriority(card) ?? 0;
    values.set(card, value);
    return value;
  }

  return (hand, discarded = []) => {
    const counts = new Map();
    let value = 0;
    for (const card of hand) {
      const key = card.kind === 'energy' && !card.special ? card.energyType : card.name;
      const n = counts.get(key) || 0;
      const weights = card.kind === 'energy' ? [1, 0.65, 0.32] : [1, 0.38, 0.15];
      value += cardValue(card) * (weights[n] ?? 0.08);
      counts.set(key, n + 1);
    }
    const ready = new Set(board.map((m) => m.name));
    const candy = hand.some((c) => c.tkind === 'rareCandy');
    for (const card of hand) if (card.kind === 'pokemon' && card.stage === 0) ready.add(card.name);
    for (const card of new Set(hand.filter((c) => c.kind === 'pokemon' && c.stage > 0).map((c) => c.name))) {
      const parent = evos.get(card) || hand.find((c) => c.name === card).evolvesFrom;
      if (ready.has(parent) || (candy && ready.has(evos.get(parent)))) value += 8;
      if (hand.some((c) => c.name === parent)) value += 3;
    }
    if (hand.some((c) => c.kind === 'energy')) value += board.length ? 8 : 2;
    if (hand.some((c) => drawSupport.has(c.tkind)) && p.deck.length > 8) value += 6;
    return value + (plan?.reserveValue?.(hand) || 0) +
      new Set(discarded.filter(recoverable).map((c) => c.energyType)).size * 6;
  };
}

function attachedEvaluator(game, p, sources) {
  const holders = [...new Set(sources.values())];
  const before = new Map(holders.map((m) => [m, attackPotential(game, m)]));
  return (selected) => holders.reduce((score, mon) => {
    const lost = selected.filter((card) => sources.get(card) === mon);
    if (!lost.length) return score;
    const owner = game.ownerOf(mon);
    const sign = owner === p ? -1 : 1;
    const readyLoss = before.get(mon) - attackPotential(game, mon, mon.energy.filter((card) => !lost.includes(card)));
    const weight = owner.active === mon ? 1.15 : 0.8;
    return score + sign * (readyLoss * weight + lost.reduce((n, card) => n + (card.provides || 1) * 2 + (card.special ? 4 : 0), 0));
  }, 0);
}

// Enumerate full payments for ordinary one/two-card costs. Large optional payments use
// a bounded shortlist ranked by the same evaluator, with the engine enforcing legality.
function paymentScores(cost, evaluate, onComplete) {
  let { remaining } = cost;
  const need = cost.units ?? cost.count;
  const unitsFor = (card) => cost.units == null ? 1 : card.provides || 1;
  if (remaining.length > 32 || (need > 2 && remaining.length > 10)) {
    const limit = Math.max(need, need > 4 ? 8 : 10);
    remaining = [...remaining].map((card) => [card, evaluate([...cost.selected, card])])
      .sort((a, b) => b[1] - a[1]).slice(0, limit).map(([card]) => card);
  }
  const best = new Map();
  const capacity = [0];
  for (const card of remaining) capacity.push(capacity.at(-1) + unitsFor(card));
  function complete(start, left, picked) {
    if (left <= 0) {
      const score = evaluate([...cost.selected, ...picked]);
      onComplete?.(picked, score);
      for (const card of picked) best.set(card, Math.max(score, best.get(card) ?? -Infinity));
      return;
    }
    if (capacity.at(-1) - capacity[start] < left) return;
    for (let i = start; i < remaining.length; i++) {
      picked.push(remaining[i]);
      complete(i + 1, left - unitsFor(remaining[i]), picked);
      picked.pop();
    }
  }
  complete(0, need, []);
  return best;
}

export function preferredRetreatPayment(game, mon, cards, units) {
  if (!units) return [];
  let best = [], value = -Infinity;
  const evaluate = (paid) => attackPotential(game, mon, cards.filter((card) => !paid.includes(card))) -
    paid.reduce((loss, card) => loss + (card.provides || 1) * 2 + (card.special ? 4 : 0), 0);
  paymentScores({ remaining: cards, selected: [], units }, evaluate, (paid, score) => {
    if (score <= value) return;
    best = [...paid];
    value = score;
  });
  return best;
}

// Fixed attack discards pay by card, with typed cards taken before the fallback.
export function energyAfterAttackCost(game, p, mon, { type, n, strict }) {
  let remaining = mon.energy;
  const discard = (pool, count) => {
    if (!pool.length || !count) return 0;
    const sources = new Map(remaining.map((card) => [card, mon]));
    let paid, best = -Infinity;
    paymentScores({ remaining: pool, selected: [], count: Math.min(count, pool.length) },
      attachedEvaluator(game, p, sources), (cards, score) => {
        if (score > best) {
          paid = [...cards];
          best = score;
        }
      });
    remaining = remaining.filter((card) => !paid.includes(card));
    return paid.length;
  };
  if (!type) discard(remaining, n);
  else {
    const count = discard(remaining.filter((card) => matchesAttackDiscard(card, type, strict)), n);
    if (!strict) discard(remaining, n - count);
  }
  return remaining;
}

export function retreatResourceCost(game, p) {
  const mon = p.active;
  const units = game.retreatCost(p, mon);
  if (!units) return 0;
  const sources = new Map(mon.energy.map((card) => [card, mon]));
  const scores = paymentScores({ remaining: mon.energy, selected: [], units }, attachedEvaluator(game, p, sources));
  const best = Math.max(...scores.values());
  return 5 * units + (Number.isFinite(best) ? -best : 5 * units);
}

const handCosts = new Set(['prompt.q.discard1', 'prompt.q.discardK', 'prompt.q.discardEnergy', 'prompt.q.discardMore', 'prompt.q.sightseer']);
const genericSearch = new Set(['prompt.q.searchPokemon', 'prompt.q.searchAny', 'prompt.q.searchEnergy', 'prompt.q.searchSupporter',
  'prompt.q.searchTrainer', 'prompt.q.searchItem', 'prompt.q.fromDiscard', 'prompt.q.callFamily', 'prompt.q.rareCandy']);
const discardAmounts = new Set(['prompt.q.discardSelfHowMany', 'prompt.q.discardHandHowMany', 'prompt.q.discardHowMany', 'prompt.q.discardHowManyBench']);

export function rankHardPrompt(game, p, prompt, plan, setupRoutes) {
  const { options, text } = prompt;
  const cards = options.filter((o) => o.card).map((o) => o.card);
  let { cost } = prompt;
  if (!cost && prompt.kind === 'discard' && (handCosts.has(text) ||
      (text === 'prompt.q.energyFromHand' && prompt.en?.includes('discard'))) &&
      cards.length && cards.every((c) => p.hand.includes(c))) {
    cost = { zone: 'hand', remaining: cards, selected: [], count: 1 };
  }

  let score;
  if (cost?.zone === 'hand') {
    const handValue = handEvaluator(game, p, plan);
    const evaluate = (paid) => handValue(p.hand.filter((c) => !paid.includes(c)), paid);
    const drawBenefit = p.deck.length > 5 ? (text === 'prompt.q.sightseer' ? 9 : 12) : 0;
    if (setupRoutes?.length) {
      const preservesRoute = (paid) => {
        const counts = new Map();
        for (const card of p.hand) if (!paid.includes(card)) counts.set(card.id, (counts.get(card.id) || 0) + 1);
        return setupRoutes.some((cards) => cards.every((card, i) =>
          (counts.get(card.id) || 0) > cards.slice(0, i).filter((earlier) => earlier.id === card.id).length));
      };
      const protectedScores = paymentScores(cost, (paid) =>
        preservesRoute(paid) ? evaluate(paid) : -Infinity);
      const kept = options.filter((option) => option.id === 'none'
        ? preservesRoute(cost.selected)
        : Number.isFinite(protectedScores.get(option.card)));
      if (kept.length) {
        const value = (option) => option.id === 'none' ? evaluate(cost.selected) : protectedScores.get(option.card) + drawBenefit;
        return kept.sort((a, b) => value(b) - value(a) || (b.ai || 0) - (a.ai || 0));
      }
    }
    const best = paymentScores(cost, evaluate);
    score = (o) => o.id === 'none' ? evaluate(cost.selected) : (best.get(o.card) ?? -Infinity) + drawBenefit;
  } else if (cost?.zone === 'attached') {
    const evaluate = attachedEvaluator(game, p, cost.sources);
    const best = paymentScores(cost, evaluate);
    score = (o) => o.id === 'none' ? evaluate(cost.selected) : o.mon
      ? Math.max(-Infinity, ...cost.remaining.filter((c) => cost.sources.get(c) === o.mon).map((c) => best.get(c) ?? -Infinity))
      : best.get(o.card) ?? -Infinity;
  } else if (discardAmounts.has(text) && game.attacking && game.opp(p).active) {
    const attacker = game.attacking, defender = game.opp(p).active;
    const attack = p.until.lastAtk?.atk;
    const damagePerCard = prompt.params?.n ?? attack?.fx.hailBlade?.n ?? attack?.fx.discardBenchEnergyBonus?.n;
    if (attack && damagePerCard) {
      const [base] = game.baseRange(attacker, defender, attack);
      score = (o) => {
        const count = Number(o.id);
        const damage = game.finalDamage(attacker, defender, base + count * damagePerCard, {
          noWR: attack.fx.noWR, noWROnly: attack.fx.noWROnly, noRes: attack.fx.noRes, ignoreDef: attack.fx.ignoreDefEffects,
        }).dmg;
        return Math.min(damage, defender.hpLeft) * 0.4 + (damage >= defender.hpLeft ? 40 : 0) - count * 8;
      };
    }
  } else if (prompt.kind === 'discard' && text === 'prompt.q.discardWhichTool') {
    score = (o) => {
      const mon = game.players.flatMap((q) => game.allMons(q)).find((m) => m.tools.some((t) => t.card === o.card));
      const sign = game.ownerOf(mon) === p ? -1 : 1;
      return sign * ((mon === game.opp(p).active ? 6 : 0) +
        (o.card.tool === 'braveryCharm' || o.card.tool === 'bigCharm' ? 5 : 0));
    };
  } else if (prompt.kind === 'search' && genericSearch.has(text) && cards.length) {
    const handValue = handEvaluator(game, p, plan);
    const before = handValue(p.hand);
    score = (o) => o.card ? handValue([...p.hand, o.card]) - before +
      Math.min(8, o.ai || 0) + (plan?.searchPriority(o.card, p.hand) ?? 0) : 0;
  } else if (prompt.kind === 'attachTo' && options.some((o) => plan?.isTarget(o.mon))) {
    score = (o) => (plan.isTarget(o.mon) ? 15 : 0) + (o.ai || 0);
  } else if (prompt.kind === 'promote' && options.some((o) => o.mon)) {
    score = (o) => o.mon ? attackPotential(game, o.mon) + o.mon.hpLeft / 10 - game.retreatCost(p, o.mon) * 2 : -10;
  }
  return score && options.map((option) => ({ option, value: score(option) }))
    .sort((a, b) => (b.value - a.value) || ((b.option.ai || 0) - (a.option.ai || 0)))
    .map(({ option }) => option);
}
