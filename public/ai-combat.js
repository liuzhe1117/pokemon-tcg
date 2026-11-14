// Matchup estimates use public board information. Exact turn search still runs the rules engine.
import { deckCatalog, energyMissing, supportValue } from './ai-plan.js';
import { energyAfterAttackCost } from './ai-discard.js';
import { switchedPosition } from './ai-position.js';

export const prizeValue = (game, mon) => game.modern ? mon.card.prizes || 1 : 1;
export const attackPrizes = (game, owner, target, attacker, { active = true, inPlay } = {}) =>
  game.modern ? game.prizeValue(owner, target, { by: attacker, damage: true, active, inPlay }) : 1;
const blocksEffects = (game, a, d) => d.effects.shield?.kind === 'all' || (game.modern && game.smBarrier(a, d));
const isInfiltrator = (game, d, fx) => game.modern && !fx.ignoreDefEffects && !fx.noWR &&
  d.card.powerKind === 'infiltrator' && game.powerOn(d);

function mainDamage(game, a, d, fx, base) {
  if (base <= 0 || (blocksEffects(game, a, d) && !(fx.ignoreDefEffects || fx.noWR))) return 0;
  return fx.mirrorMove ? base : game.finalDamage(a, d, base, {
    noWR: fx.noWR, noWROnly: fx.noWROnly, noRes: fx.noRes, ignoreDef: fx.ignoreDefEffects, noWeakness: fx.noWeakness,
  }).dmg;
}

export function handEnergyCost(hand, attack) {
  const cost = attack.fx.discardHandOrFail || attack.fx.discardHandTypeTimes;
  if (!cost) return [];
  if (!hand) return null;
  const energy = hand.filter((card) => card.kind === 'energy' && card.energyType === cost.type);
  if (attack.fx.discardHandOrFail && energy.length < cost.n) return null;
  return energy.slice(0, attack.fx.discardHandOrFail ? cost.n : cost.max);
}

function damageBounds(game, a, d, atk, entering, ownHand = false) {
  if (atk.fx.needsBenchName && !game.hasAttackBench(game.ownerOf(a), atk.fx)) return [0, 0];
  if (atk.fx.discardHandOrFail || atk.fx.discardHandTypeTimes) {
    const owner = game.ownerOf(a);
    const known = owner?.idx === game.current?.idx && !game.hiddenHand?.has(owner?.idx);
    if (!known || (atk.fx.discardHandTypeTimes && !ownHand) || !handEnergyCost(owner.hand, atk)) return [0, 0];
  }
  const [min, max] = game.baseRange(a, d, atk);
  const bonus = entering && !a.effects.movedActive ? atk.fx.bonusIfMovedToActive || 0 : 0;
  return [min + bonus, max + bonus];
}

export function visibleHit(game, a, d, atk, entering, fixedCostPaid = false, handPayment = false) {
  const { fx } = atk;
  if (isInfiltrator(game, d, fx)) return 0;
  return lowerDamage(game, a, d, atk, entering, fixedCostPaid, handPayment);
}

export function afterFixedAttackCost(game, mon, cost) {
  const owner = game.ownerOf(mon);
  if (!cost || !owner || !mon.energy.length) return { game, mon };
  return withAttachedEnergy(game, mon, energyAfterAttackCost(game, owner, mon, cost), owner);
}

export function attackChoices(game, owner, defender, attack, turn = game.turn) {
  return game.copiedAttacks(owner, defender, attack, turn) ?? [attack];
}

export function withAttachedEnergy(game, mon, attached, owner = game.ownerOf(mon)) {
  const projected = Object.create(game);
  const source = Object.assign(Object.create(mon), { game: projected, energy: attached });
  const side = { ...owner, active: owner.active === mon ? source : owner.active,
    bench: owner.bench.map((m) => m === mon ? source : m) };
  projected.players = game.players.map((p) => p === owner ? side : p);
  projected.current = projected.players[game.current?.idx];
  return { game: projected, mon: source, owner: side };
}

export function readyDamage(game, a, d, energy = a?.payTypes, {
  entering = false, turn = game.turn, owner = game.ownerOf(a), attacks, attached, certain = false, usedActive,
} = {}) {
  if (!owner || !d || a.status.confused || a.effects.sandAttack?.expires >= turn) return 0;
  if (attached) {
    ({ game, mon: a, owner } = withAttachedEnergy(game, a, attached, owner));
    energy = a.payTypes;
  }
  let damage = 0;
  for (const atk of attacks ?? game.attacksOf(a)) {
    if (game.canUseAttack(owner, a, d, atk, { payTypes: energy, turn, usedActive })) {
      if (atk.fx.flipMetronome) continue;
      const candidates = attackChoices(game, owner, d, atk, turn);
      for (const attack of candidates) {
        const hit = certain ? visibleHit(game, a, d, attack, entering) : lowerDamage(game, a, d, attack, entering);
        damage = Math.max(damage, hit);
      }
    }
  }
  return damage;
}

function lowerDamage(game, a, d, atk, entering, fixedCostPaid = false, handPayment = false) {
  if (atk.fx.discard && !fixedCostPaid) ({ game, mon: a } = afterFixedAttackCost(game, a, atk.fx.discard));
  const [lo, hi] = damageBounds(game, a, d, atk, entering, handPayment);
  return mainDamage(game, a, d, atk.fx, handPayment && atk.fx.discardHandTypeTimes ? hi : lo);
}

// Asleep may clear during Checkup. An attack one attachment away gets a smaller weight.
function response(game, attacker, target, { hp = target?.hpLeft, turn = game.turn + 1, includeSetup = true } = {}) {
  const p = game.ownerOf(attacker);
  if (!p || !target || hp <= 0 || attacker.hpLeft <= 0) return { risk: 0, knockout: 0 };
  const defender = game.ownerOf(target);
  const attached = attacker.payTypes;
  const canPrepare = includeSetup && !(attacker.effects.noEnergy?.expires >= turn) && (p.hand.length > 0 || p.deck.length > 0);
  const condition = (attacker.status.asleep ? 0.5 : 1) * (attacker.status.confused || attacker.effects.sandAttack?.expires >= turn ? 0.5 : 1);
  const best = { risk: 0, knockout: 0 };
  for (const atk of game.attacksOf(attacker)) {
    const ready = game.canUseAttack(p, attacker, target, atk, { payTypes: attached, turn, asleep: false });
    if (!ready && (!canPrepare || energyMissing(attached, atk.cost) !== 1 ||
        !game.canUseAttack(p, attacker, target, atk, { payTypes: atk.cost, turn, asleep: false }))) continue;
    for (const choice of attackChoices(game, p, target, atk, turn)) {
      const { game: position, mon: source } = afterFixedAttackCost(game, attacker, choice.fx.discard);
      const cost = choice.fx.discardHandOrFail || choice.fx.discardHandTypeTimes;
      const hidden = p.idx !== game.current?.idx || game.hiddenHand?.has(p.idx);
      if (cost && hidden && !includeSetup) continue;
      const [lo, hi] = cost && hidden
        ? choice.fx.discardHandOrFail ? position.baseRange(source, target, choice) : [0, cost.n * cost.max]
        : damageBounds(position, source, target, choice, false, true);
      const { damage, knockout } = expectedHit(position, source, target, choice,
        choice.fx.discardHandTypeTimes ? hi : lo, hi, { hp, interfere: 1, uncertainUpper: false });
      const prizes = defender ? attackPrizes(game, defender, target, source) : prizeValue(game, target);
      const ending = defender && (prizes >= p.prizes.length || !defender.bench.length && defender.active === target);
      const risk = damage * (0.13 + 15 / hp) + knockout * (18 + prizes * 12 + (ending ? 20 : 0)) +
        (damage * 2 >= hp && !knockout ? 5 : 0);
      const payment = cost && hidden ? hiddenEnergyChance(game, p, cost.type, choice.fx.discardHandOrFail ? cost.n : cost.max) : 1;
      const weight = condition * (ready ? 1 : 0.45) * (atk.fx.flipMetronome ? 0.5 : 1) * payment;
      best.risk = Math.max(best.risk, risk * weight);
      best.knockout = Math.max(best.knockout, knockout * weight);
    }
  }
  return best;
}

function hiddenEnergyChance(game, p, type, required) {
  const matches = (card) => card.kind === 'energy' && card.energyType === type;
  const unknown = p.hand.length + p.deck.length + p.prizes.length;
  const hand = Math.min(unknown, p.hand.length + Number(p.deck.length > 0));
  if (hand < required) return 0;
  const remaining = deckCatalog(p).list.reduce((n, [card, count]) => n + (matches(card) ? count : 0), 0) -
    [...p.discard, ...(p.lost || []), ...game.allMons(p).flatMap((mon) => mon.energy)].filter(matches).length;
  // Probability of at least the required copies in the unseen hand and next draw.
  const copies = Math.max(0, Math.min(remaining, unknown));
  if (copies < required) return 0;
  const chance = [1, ...Array(required).fill(0)];
  for (let i = 0; i < hand; i++) {
    for (let n = Math.min(i + 1, required); n > 0; n--) {
      const hit = Math.max(0, (copies - n + 1) / (unknown - i));
      const miss = n === required ? 1 : Math.max(0, 1 - (copies - n) / (unknown - i));
      chance[n] = chance[n] * miss + chance[n - 1] * hit;
    }
    chance[0] *= Math.max(0, 1 - copies / (unknown - i));
  }
  return Math.min(1, chance[required]);
}

export function responseRisk(game, attacker, target, options) {
  return response(game, attacker, target, options).risk;
}

export function expectedAttackDamage(game, owner, defender) {
  const attacker = owner.active;
  let best = 0;
  for (const attack of game.attacksOf(attacker)) {
    if (!game.canUseAttack(owner, attacker, defender, attack) || !game.hasAttackBench(owner, attack.fx)) continue;
    for (const choice of attackChoices(game, owner, defender, attack)) {
      const { game: board, mon } = afterFixedAttackCost(game, attacker, choice.fx.discard);
      const [lo, hi] = damageBounds(board, mon, defender, choice, false, true);
      const { damage } = expectedHit(board, mon, defender, choice, lo, hi, { uncertainUpper: false });
      best = Math.max(best, damage * (attack.fx.flipMetronome ? 0.5 : 1));
    }
  }
  return best;
}

const switchTrainers = new Set(['switch', 'switchCart', 'primeCatcher', 'guzma', 'birdKeeper', 'switchRaft']);
const gustTrainers = new Set(['gust', 'bossOrders', 'counterCatcher', 'primeCatcher', 'guzma', 'pokemonCatcher', 'trGiovanni']);

export function lastPrizeGustRisk(game, defender, turn = game.turn + 1) {
  const attacker = game.opp(defender);
  if (!attacker.active || !attacker.deck.length || attacker.prizes.length > 3 ||
      !defender.bench.length || attacker.until.noTrainers === turn) return 0;
  const known = [...new Set(attacker.discard.filter(({ tkind, aceSpec }) => gustTrainers.has(tkind) && !aceSpec).map(({ tkind }) => tkind))];
  if (!known.length) return 0;
  const active = attacker.active;
  const retreat = game.retreatCost(attacker, active);
  const canRetreat = active.energyTypes.length >= retreat && !(active.effects.noRetreat?.expires >= turn) &&
    ((!active.status.asleep && !active.status.paralyzed) || (game.modern && game.canRetreatStuck(active)));
  let risk = 0;
  for (const target of defender.bench) {
    if (target.hpLeft <= 0) continue;
    const kinds = known.filter((tkind) =>
      (!(tkind === 'bossOrders' || tkind === 'guzma' || tkind === 'trGiovanni') || !game.poncho(target)) &&
      (tkind !== 'counterCatcher' || attacker.prizes.length > defender.prizes.length));
    if (!kinds.length) continue;
    for (const source of game.allMons(attacker)) {
      const switches = source !== active;
      const possible = kinds.filter((tkind) => {
        if (tkind === 'trGiovanni') return switches && active.name.startsWith("Team Rocket's") && source.name.startsWith("Team Rocket's");
        if (tkind === 'guzma' || tkind === 'primeCatcher') return switches || !attacker.bench.length;
        return !switches || canRetreat;
      });
      if (!possible.length || attackPrizes(game, defender, target, source) < attacker.prizes.length) continue;
      const position = switchedPosition(game, attacker, source, target);
      const chance = response(position, source, target, { turn, includeSetup: false }).knockout;
      const gust = possible.every((tkind) => tkind === 'pokemonCatcher') ? 0.5 : 1;
      risk = Math.max(risk, chance * gust);
    }
  }
  return risk;
}

export function replyThreat(game, p, target, { active = p.active, removed, hp = target?.hpLeft, turn = game.turn + 1,
  includeSetup = true, exposure = false, benchAccess = true } = {}) {
  if (!target || hp <= 0) return 0;
  const risk = (attacker, defender, left) => responseRisk(game, attacker, defender, { hp: left, turn, includeSetup });
  const activeSurvives = active && active !== removed && active.hpLeft > 0;
  const direct = activeSurvives ? risk(active, target, hp) : 0;
  if (activeSurvives && !benchAccess && !exposure) return direct;
  const canGust = exposure && p.prizes.length <= 3 && p.hand.length && p.discard.some((c) => gustTrainers.has(c.tkind));
  if (!p.bench.length && activeSurvives && !canGust) return direct;
  const retreat = activeSurvives ? game.retreatCost(p, active) : 0;
  const canRetreat = activeSurvives && !active.status.paralyzed && !(active.effects.noRetreat?.expires >= turn) &&
    active.energyTypes.length >= retreat;
  // An item in the public discard shows a line the deck can play. It only adds a risk estimate.
  const revealedSwitch = !canRetreat && includeSetup && p.hand.length && p.discard.some((c) => switchTrainers.has(c.tkind));
  const move = !activeSurvives ? 1 : Math.max(canRetreat ? (retreat ? 0.72 : 0.94) * (active.status.asleep ? 0.5 : 1) : 0,
    revealedSwitch ? 0.32 : 0);
  const attackers = move ? game.allMons(p).filter((m) => m !== active && m !== removed && m.hpLeft > 0) : [];
  const bench = move ? Math.max(0, ...attackers.map((m) => risk(m, target, hp))) * move : 0;
  let gust = 0;
  if (canGust) {
    const defending = game.opp(p);
    for (const mon of defending.bench) {
      if (mon.hpLeft <= 0 || prizeValue(game, mon) < p.prizes.length || game.poncho(mon)) continue;
      gust = Math.max(gust, (activeSurvives ? risk(active, mon, mon.hpLeft) : 0),
        ...(move ? attackers.map((m) => risk(m, mon, mon.hpLeft) * move) : []));
    }
  }
  return Math.max(direct, bench, gust * 0.52);
}

function expectedHit(game, a, d, atk, lo, hi, {
  hp = d.hpLeft,
  interfere = (a.status.confused ? 0.5 : 1) * (a.effects.sandAttack ? 0.5 : 1),
  uncertainUpper = true,
} = {}) {
  const { fx } = atk;
  const infiltrator = isInfiltrator(game, d, fx);
  let hpDamage = 0, knockout = 0;
  const add = (base, weight) => {
    const n = mainDamage(game, a, d, fx, base);
    const chance = weight * interfere * (infiltrator ? 0.5 : 1);
    hpDamage += Math.min(n, hp) * chance;
    if (n >= hp) knockout += chance;
  };
  const coins = fx.flipMulti || (fx.flipPerEnergy && a.energyTypes.length) ||
    (fx.waterPunch && game.countType(a, 'Water')) || fx.flipMultiBonus?.n;
  if (lo === hi) add(lo, 1);
  else if (coins) {
    let weight = 0.5 ** coins;
    for (let heads = 0; heads <= coins; heads++) {
      add(lo + (hi - lo) * heads / coins, weight);
      weight *= (coins - heads) / (heads + 1);
    }
  } else if (fx.flipUntilTails || fx.flipUntilTailsBonus) {
    const unit = fx.flipUntilTailsBonus || atk.base;
    for (let heads = 0; heads <= 8; heads++) add(lo + heads * unit, 0.5 ** Math.min(heads + 1, 8));
  } else if (uncertainUpper || modelsRandomDamage(fx) || fx.riskyTails) {
    const chance = fx.flipAll ? 0.5 ** fx.flipAll : fx.bothHeadsBonus ? 0.25 : 0.5;
    add(lo, 1 - chance);
    add(hi, chance);
  } else add(lo, 1);
  return { damage: hpDamage, knockout, success: interfere };
}

export function attackFinishChance(game, p, index, exactPrizes = false) {
  let a = p.active;
  const foe = game.opp(p), d = foe.active;
  const atk = game.attacksOf(a)[index];
  if (!atk || !d || (foe.bench.length && p.prizes.length > (exactPrizes ? attackPrizes(game, foe, d, a) : prizeValue(game, d))) ||
      (atk.fx.selfDamage || 0) >= a.hpLeft || d.effects.destinyBond) return 0;
  if (atk.fx.discard) ({ game, mon: a } = afterFixedAttackCost(game, a, atk.fx.discard));
  const [lo, hi] = damageBounds(game, a, d, atk, false, true);
  if (lo !== hi && !atk.fx.discardHandTypeTimes && !modelsRandomDamage(atk.fx)) return 0;
  // The player can choose to spend the known hand Energy when it wins the game.
  return expectedHit(game, a, d, atk, atk.fx.discardHandTypeTimes ? hi : lo, hi).knockout;
}

function modelsRandomDamage(fx) {
  return fx.flipMulti || fx.flipPerEnergy || fx.waterPunch || fx.flipBonus || fx.bothHeadsBonus ||
    fx.flipFail || fx.flipAll || fx.flipMultiBonus;
}

// Only use a closed-form finish probability for damage rolls whose outcomes we model.
// Choice-dependent damage, recoil and reactions still need the engine probe.
export function modeledCoinFinish(game, p, index, exactPrizes) {
  const a = p.active, d = game.opp(p).active;
  const { fx } = game.attacksOf(a)[index];
  if (!modelsRandomDamage(fx) || Object.keys(fx).some((key) => !coinFinishEffects.has(key)) ||
      d.effects.mirrorShell || d.card.powerKind === 'automatedCombat' ||
      d.tools.some(({ card }) => card.tool === 'punkHelmet') ||
      (game.stadiumIs('vermilion') && a.name.includes('Lt. Surge')) ||
      (a.status.confused && a.hpLeft <= (game.modern ? 30 : 20))) return 0;
  return attackFinishChance(game, p, index, exactPrizes);
}

const coinFinishEffects = new Set(['flipMulti', 'flipPerEnergy', 'waterPunch', 'flipBonus', 'bothHeadsBonus',
  'flipFail', 'flipAll', 'flipMultiBonus', 'noWR', 'noWROnly', 'noRes', 'ignoreDefEffects', 'noWeakness']);

function splashDamage(game, p, source, target, amount, counters = false, fromAttack = !!game.attacking) {
  if (amount <= 0) return 0;
  const owner = game.ownerOf(target);
  const bench = owner?.bench.includes(target);
  if (source && owner !== p && fromAttack && blocksEffects(game, source, target)) return 0;
  if (counters || !game.modern) return amount;
  if (bench && (target.card.tera || game.allMons(owner).some((m) => m.card.powerKind === 'waveVeil' && game.powerOn(m)))) return 0;
  const reduced = bench && source ? game.modernDefense(source, target, amount, []) : amount;
  return target.card.powerKind === 'infiltrator' && game.powerOn(target) ? reduced * 0.5 : reduced;
}

function damageValue(game, p, target, n, followUp = 0, hp = target.hpLeft) {
  if (n <= 0 || hp <= 0) return 0;
  const prizes = prizeValue(game, target);
  const ko = n >= hp;
  return Math.min(n, hp) * 0.21 + Math.min(1, n / hp) * 5 +
    (ko ? 20 + 15 * prizes + (p.prizes.length <= prizes ? 90 : 0) + supportValue(game, target) * 0.28 :
      followUp > 0 && hp > followUp && hp - n <= followUp ? 9 + prizes * 2 : 0);
}

export function attackScore(game, p, index, { ownHand = true, tuning } = {}) {
  const a = p.active, foe = game.opp(p), d = foe.active, atk = game.attacksOf(a)[index];
  const incoming = replyThreat(game, foe, a, { benchAccess: game.turn >= 6 });
  const choices = attackChoices(game, p, d, atk);
  if (!choices.length) return 1;
  const scores = choices.map((choice) => scoreAttack(game, p, a, d, choice, incoming, ownHand, tuning, atk.cost.length));
  const best = Math.max(...scores);
  return atk.fx.flipMetronome ? 25 + (best - 25) * 0.5 : best;
}

function scoreAttack(game, p, a, d, atk, incoming, ownHand, tuning, attackCost = atk.cost.length) {
  const foe = game.opp(p);
  const { fx } = atk;
  const { game: position, mon: source } = afterFixedAttackCost(game, a, fx.discard);
  const [lo, hi] = damageBounds(position, source, d, atk, false, ownHand);
  const { damage, knockout, success } = expectedHit(position, source, d, atk, lo, fx.discardHandTypeTimes ? lo : hi);
  const prizes = tuning?.exactPrizes ? attackPrizes(game, foe, d, a) : prizeValue(game, d);
  const vulnerable = Math.max(0, 1 - knockout);
  const activeOpen = !blocksEffects(game, a, d) && !game.effectsBlocked(d);
  let control = 0;
  if (activeOpen) {
    const status = [].concat(fx.status || []);
    const chance = [].concat(fx.flipStatus || [], fx.headsStatus || [], fx.tailsStatus || [], fx.flipStatusEither || []);
    const weight = (s) => status.includes(s) ? 1 : chance.includes(s) ? 0.5 : 0;
    const deny = Math.max(weight('paralyzed'), weight('asleep') * 0.5, weight('confused') * 0.5,
      fx.noAttackIfBasic && d.card.stage === 0 ? 1 : 0, fx.sandAttack || fx.flipNoAttack ? 0.5 : 0);
    const poison = !d.status.poisoned && weight('poisoned') * (damage + 10 >= d.hpLeft ? 24 : 7);
    const burn = !d.status.burned && weight('burned') * (damage + 20 >= d.hpLeft ? 28 : 9);
    const remove = d.energy.length && (fx.removeEnergy || fx.flipRemoveEnergy || fx.discardOppEnergy || fx.amnesia) ? 7 + incoming * 0.26 : 0;
    control = ((game.modern && game.statusImmune(d) ? 0 : deny * (9 + incoming * 0.92) + poison + burn) + remove) * vulnerable;
  }
  const lost = fx.discardAllEnergy ? a.energy.length : fx.discard ? a.energy.length - source.energy.length :
    fx.discardAllTypeTimes ? a.energy.filter((en) => en.energyType === fx.discardAllTypeTimes.type).length : 0;
  const futureCost = (fx.lockout ? 19 : fx.cooldown || fx.tailsCooldown ? 10 : 0) + lost * (a.energy.length - lost < atk.cost.length ? 9 : 5);
  const selfDamage = (fx.selfDamage || 0) + (fx.riskyTails || 0) / 2 + (d.effects.mirrorShell ? damage : 0);
  const selfCost = selfDamage * 0.23 + (selfDamage >= a.hpLeft || (knockout && d.effects.destinyBond) ? 25 + 12 * prizeValue(game, a) : 0);
  const healing = Math.min(a.damage, fx.healAll ? a.damage : fx.drainAll ? damage : fx.drainHalf ? damage / 2 : fx.heal || 0);
  const defense = vulnerable * Math.min(38, incoming) * (fx.shield ? 0.8 : fx.flipShield ? 0.4 : fx.reduce ? Math.min(0.65, fx.reduce / 70) : 0);
  const charge = fx.attachDiscardBench;
  const acceleration = charge && p.bench.length
    ? Math.min(tuning?.finiteEffects ? charge.n ?? 1 : charge.n,
      p.discard.filter((c) => !c.special && (tuning?.anyBasicAcceleration && !charge.type ?
        c.kind === 'energy' : c.energyType === charge.type)).length) * 6 : 0;
  const draw = fx.draw ? p.deck.length <= fx.draw ? (foe.deck.length > 1 ? -32 : -5) :
    Math.min(fx.draw, Math.max(0, 7 - p.hand.length)) * 4 : 0;
  const setup = (fx.callFamily || fx.callFriend || fx.searchPokemonToHand || fx.searchEnergy || fx.attachSelf) && p.deck.length > 1 ? 8 : 0;
  const snipe = splashValue(game, p, a, fx);
  const ending = knockout * (p.prizes.length <= prizes || !foe.bench.length ? 120 : 0);
  const mill = (fx.millOpp ? Math.min(fx.millOpp, foe.deck.length) * (foe.deck.length <= 5 ? 12 : 1) : 0) -
    (fx.millSelf && p.deck.length <= fx.millSelf + 1 && foe.deck.length > 1 ? 30 : 0);
  return 25 + damage * 0.25 + knockout * (24 + prizes * 9) + ending + draw +
    success * (control * (tuning?.control ?? 1) + healing * (tuning?.healing ?? 0.24) + defense +
      acceleration * (tuning?.acceleration ?? 1) + setup + snipe + mill - selfCost - futureCost * (tuning?.futureCost ?? 1)) -
    vulnerable * incoming * 0.20 - attackCost * 0.75;
}

function splashValue(game, p, a, fx) {
  const foe = game.opp(p);
  const spread = fx.benchSnipe || fx.snipeAny || fx.snipeMulti;
  const counters = fx.placeCounters?.bench ? fx.placeCounters.n * 10 : fx.benchCounters;
  const amount = counters || spread?.n || fx.oppBenchAll || 0;
  if (!amount) return 0;
  const pool = fx.snipeAny || fx.snipeMulti ? game.allMons(foe) : foe.bench;
  const hits = pool.filter((m) => (!spread?.damagedOnly || m.damage) && (!counters || !game.effectsBlocked(m)))
    .map((m) => {
      const damage = m === foe.active && (fx.snipeMulti || (game.modern && fx.snipeAny && !fx.snipeAny.noWR))
        ? game.finalDamage(a, m, amount).dmg : amount;
      return damageValue(game, p, m, splashDamage(game, p, a, m, damage, !!counters, true));
    });
  // Repeated counter placement may split across targets. The exact probe evaluates the allocation.
  const count = spread?.count || (fx.oppBenchAll ? pool.length : 1);
  return hits.sort((x, y) => y - x).slice(0, count).reduce((x, y) => x + y, 0) * (spread?.flip ? 0.5 : 1) * 0.75;
}

const counterPrompts = new Set(['prompt.q.counters', 'prompt.q.counterK']);
const damagePrompts = new Set(['prompt.q.snipe', 'prompt.q.snipeAny', 'prompt.q.snipeDamaged',
  'prompt.q.snipeByCounters', 'prompt.q.ownBenchSnipe', 'prompt.q.swim']);

export function attackTargets(game, p, prompt, action) {
  if (prompt.kind === 'metronome' && game.attacking && game.opp(p).active) {
    const a = game.attacking, foe = game.opp(p), attack = p.until.lastAtk?.atk;
    if (!attack) return null;
    const choices = attackChoices(game, p, foe.active, attack);
    const incoming = replyThreat(game, foe, a, { benchAccess: game.turn >= 6 });
    return prompt.options.map((option) => {
      const choice = choices[Number(option.id)];
      return [option, choice ? scoreAttack(game, p, a, foe.active, choice, incoming, true, undefined, attack.cost.length) : -Infinity];
    }).sort((a, b) => b[1] - a[1]).map(([option]) => option);
  }
  const counters = counterPrompts.has(prompt.text);
  if (!counters && !damagePrompts.has(prompt.text)) return null;
  const foe = game.opp(p), source = game.attacking || (action?.kind === 'power' ? action.target : null);
  const atk = game.attacking && p.until.lastAtk?.atk;
  const options = prompt.options.filter((o) => o.mon);
  if (!options.length || !prompt.params?.n) return null;
  const split = prompt.text === 'prompt.q.counterK';
  const amount = split ? 10 : atk?.fx.moonglowReverse ? game.allMons(p).reduce((n, m) => n + Math.min(20, m.damage), 0) :
    prompt.params.n * (counters ? 10 : 1);
  const hpLeft = (m) => m.hpLeft - (prompt.pendingDamage?.get(m) || 0);
  const followUp = new Map(options.map(({ mon }) => [mon, p.active ? readyDamage(game, p.active, mon, p.active.payTypes, { turn: game.turn + 2 }) : 0]));
  const score = (o) => {
    const m = o.mon;
    if (!m) return prompt.text === 'prompt.q.swim' && source && foe.active
      ? damageValue(game, p, foe.active, mainDamage(game, source, foe.active, atk?.fx || {}, amount)) : 0;
    let n = prompt.text === 'prompt.q.snipeByCounters' ? m.counters * amount : amount;
    if (source && m === foe.active && (atk?.fx.snipeMulti || atk?.fx.snipeDamaged ||
        (game.modern && atk?.fx.snipeAny && !atk.fx.snipeAny.noWR))) n = game.finalDamage(source, m, n).dmg;
    n = splashDamage(game, p, source, m, n, counters);
    if (game.ownerOf(m) === p) return -damageValue(game, foe, m, n) - (n ? 4 * n / Math.max(1, m.hpLeft) : 0);
    const threat = n && p.active ? responseRisk(game, m, p.active) : 0;
    const hp = hpLeft(m);
    const value = damageValue(game, p, m, n, followUp.get(m), hp) + threat * (n >= hp ? 0.35 : n > 0 ? 0.08 : 0);
    if (!split) return value;
    const remaining = prompt.params.n - prompt.params.k;
    // Allocate the remaining counters across all reachable knockouts, then use the current hit as a tiebreaker.
    const best = Array(remaining + 1).fill(0);
    for (const { mon } of options) {
      const hp = hpLeft(mon) - (mon === m ? n : 0);
      if (hp <= 0 && mon !== m) continue;
      const cost = Math.max(0, Math.ceil(hp / 10));
      const koValue = 10 + 40 * prizeValue(game, mon);
      for (let i = remaining; i >= cost; i--) best[i] = Math.max(best[i], best[i - cost] + koValue);
    }
    return best[remaining] + (n >= hp ? Math.min(9, value * 0.1) : value);
  };
  return prompt.options.map((o) => [o, score(o)]).sort((a, b) => b[1] - a[1]).map(([o]) => o);
}
