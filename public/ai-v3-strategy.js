import { attackPrizes, lastPrizeGustRisk, prizeValue, readyDamage, replyThreat, responseRisk, visibleHit, withAttachedEnergy } from './ai-combat.js';
import { deckCatalog, energyMissing, supportValue, unseenCardCounts } from './ai-plan.js';
import { isType, Mon } from './engine.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const draws = new Set(['bill', 'hop', 'hau', 'nemona', 'barry', 'lillie', 'dan', 'bugCatcher']);
const gusts = new Set(['gust', 'bossOrders', 'counterCatcher', 'guzma', 'primeCatcher', 'pokemonCatcher', 'trGiovanni']);

function readiness(game, p, turn, ownHand) {
  const defender = game.opp(p).active;
  if (!defender) return 0;
  const active = p.active;
  const retreat = active ? game.retreatCost(p, active) : 0;
  const status = active?.status;
  const stuck = (status?.asleep || status?.paralyzed) && !(game.modern && game.canRetreatStuck(active));
  const lock = active?.effects.noRetreat;
  const canRetreat = !stuck && !(lock && (lock.expires == null || lock.expires >= turn)) &&
    (turn !== game.turn || !p.flags.retreat);
  const hand = ownHand && !game.hiddenHand?.has(p.idx) ? p.hand : [];
  const canSwitch = p.bench.length && hand.some(({ tkind, ttype }) => {
    if (p.until.noTrainers === turn || ttype === 'supporter' && turn === game.turn && p.flags.supporter) return false;
    if (tkind === 'switchCart') return active?.card.stage === 0;
    return ['switch', 'birdKeeper', 'surfer', 'tateLiza', 'primeCatcher', 'scrambleSwitch'].includes(tkind);
  });
  const pays = (active?.energyTypes.length ?? 0) >= retreat;
  // Bench strength is useful in a future exchange even when it cannot enter now.
  const reserve = !active || active.hpLeft <= 0 || canRetreat && pays && retreat === 0 ? 0.95 :
    canSwitch ? 0.85 : canRetreat && pays ? 0.75 :
    canRetreat && retreat - active.energyTypes.length === 1 ? 0.55 : game.turn <= 5 ? 0.5 : 0.32;
  const potential = game.allMons(p).map((mon) => {
    const energy = mon.payTypes, attacks = game.attacksOf(mon);
    const damage = readyDamage(game, mon, defender, energy, { turn, entering: mon !== p.active, owner: p, attacks });
    const close = attacks.some((atk) => atk.base >= 20 && energyMissing(energy, atk.cost) <= 1);
    const value = Math.min(30, damage * 0.21) + (damage >= defender.hpLeft ? 9 : 0) + (close ? 6 : 0);
    return value * (mon === active ? 1 : reserve);
  }).sort((a, b) => b - a);
  return (potential[0] || 0) + (potential[1] || 0) * 0.55;
}

function development(game, p, a, { goal, base, redraw }) {
  if (game.turn > 12 || !p.active || !game.opp(p).active || base < 2) return 0;
  const foe = game.opp(p);
  const pressure = replyThreat(game, foe, p.active, { includeSetup: true });
  const noBackup = p.bench.length === 0;
  if (a.kind === 'bench') {
    const useful = (goal?.actionPriority(a) || 0) > 0;
    return (noBackup ? (pressure >= 36 ? 24 : 11) : useful ? 7 : p.bench.length >= 3 ? -8 : 0);
  }
  if (a.kind === 'evolve') return (goal?.actionPriority(a) || 0) > 0 ? 8 : 3;
  if (a.kind === 'trainer' || a.kind === 'power') {
    const planned = goal?.actionPriority(a) || 0;
    if (planned >= 15) return noBackup ? 12 : 6;
    if (p.hand.length <= 5 && p.deck.length >= 12 && (redraw || draws.has(a.tkind))) return noBackup ? 11 : 5;
  }
  return 0;
}

function attackPath(game, p, { card, mon, attack, power, gap, steps, missing }) {
  const defender = game.opp(p).active;
  if (!defender) return 0;
  const weakness = isType(card.type, defender.card.weakness) && !attack.fx.noWR && !attack.fx.noWeakness;
  const resistance = isType(card.type, defender.card.resistance) && !attack.fx.noWR && !attack.fx.noRes;
  const matchup = weakness ? Math.min(23, power * 0.20) : resistance ? -Math.min(15, power * 0.20) : 0;
  const danger = mon === p.active && (steps.length || gap) && responseRisk(game, defender, mon) >= 43 ? 12 : 0;
  return matchup - danger - Math.max(gap - 1, 0) * 4 - missing.length * 2 + (mon && !steps.length && gap <= 1 ? 5 : 0);
}

function attachment(game, p, a, { goal, exactEnergy }) {
  if (a.kind !== 'energy' || !a.target || !game.opp(p).active) return 0;
  const m = a.target, foe = game.opp(p).active;
  const cards = [a.card, a.card2].filter(Boolean);
  const extra = cards.flatMap((card) => Array(card.provides || 1).fill(card.energyType));
  const before = m.payTypes;
  const projected = exactEnergy ? withAttachedEnergy(game, m, [...m.energy, ...cards], p) : null;
  const after = projected?.mon.payTypes ?? [...before, ...extra];
  const path = Math.max(0, ...game.attacksOf(m).map((attack) => {
    const oldGap = energyMissing(before, attack.cost);
    const gap = energyMissing(after, attack.cost);
    if (gap >= oldGap || gap > 2) return 0;
    const impact = Math.max(attack.base * 0.6, visibleHit(projected?.game ?? game, projected?.mon ?? m, foe, attack, m !== p.active));
    return Math.min(23, impact * (gap === 0 ? 0.20 : gap === 1 ? 0.13 : 0.06));
  }));
  const enablesHit = readyDamage(projected?.game ?? game, projected?.mon ?? m, foe, after, { certain: exactEnergy }) >
    readyDamage(game, m, foe, before, { certain: exactEnergy });
  const endangered = m === p.active && !enablesHit && responseRisk(game, foe, m) >= 45;
  return path + (goal?.isTarget(m) ? 5 : 0) - (endangered ? 16 : 0);
}

function contest(game, p, a, { move }) {
  const foe = game.opp(p), active = p.active;
  if (move && active && foe.active && move.defender) {
    const oldRisk = replyThreat(game, foe, active);
    const newRisk = Math.min(...move.candidates.map((target) => replyThreat(game, foe, target, { active: move.defender })));
    if (Number.isFinite(newRisk)) return clamp((oldRisk - newRisk) * 0.28, -12, 12);
  }
  if (a.kind === 'trainer' && gusts.has(a.tkind) && foe.bench.includes(a.target) && active && game.turn > 1) {
    const hit = readyDamage(game, active, a.target);
    if (hit >= a.target.hpLeft) return prizeValue(game, a.target) * 4 + Math.min(10, supportValue(game, a.target) / 4);
  }
  return 0;
}

function resourceCost(game, p, action) {
  if (action.kind === 'retreat') {
    const paid = game.retreatCost(p, p.active);
    return paid ? 2 + paid * 2 : 0;
  }
  if (action.kind === 'trainer' && action.card?.ttype === 'supporter') return 1.5;
  return 0;
}

const accelerators = new Set(['underworldDoor', 'psychicEmbrace', 'darkPatch', 'metalSaucer', 'aquaPatch',
  'magmaBasin', 'magneticCircuit', 'dynamotor', 'starPortal', 'clairvoyantSense', 'superCold', 'electricGenerator',
  'energySwitch', 'melony', 'bede', 'mela']);

function accelerateFirst(game, p, action, { base, goal }) {
  if (game.turn > 16 || p.flags.energy || base < 5) return 0;
  if (!accelerators.has(action.pkind ?? action.tkind ?? action.stadium)) return 0;
  return 12 + ((goal?.actionPriority(action) || 0) > 0 ? 4 : 0) +
    (action.pkind === 'underworldDoor' && p.deck.length > 5 ? 6 : 0);
}

function attachmentSequence(game, p, actions, prizes) {
  if (!p.active || p.flags.energy || !actions.some((a) => a.kind === 'energy')) return null;
  const foe = game.opp(p);
  if (!foe.active) return null;
  const basic = (c, type) => c.kind === 'energy' && !c.special && c.energyType === type;
  const door = p.deck.length > 5 && actions.find((a) => a.pkind === 'underworldDoor');
  const psychic = door && p.hand.find((c) => basic(c, 'Psychic'));
  const resolve = actions.find((a) => a.pkind === 'roaringResolve');
  const list = resolve ? deckCatalog(p).list : [];
  const fire = list.find(([c]) => basic(c, 'Fire'))?.[0];
  const unseen = fire ? unseenCardCounts(game, p, list) : null;
  const fireCount = fire ? list.reduce((n, [c]) => n + (basic(c, 'Fire') ?
    Math.max(0, (unseen.get(c.id) || 0) - (prizes?.get(c.id) || 0)) : 0), 0) : 0;
  const confirmedFire = fireCount - (prizes ? 0 : p.prizes.length);
  const bonus = new Map();
  if (resolve?.target && confirmedFire >= 2) {
    const mon = resolve.target;
    const after = readyDamage(game, mon, foe.active, undefined,
      { entering: mon !== p.active, attached: [...mon.energy, fire, fire], certain: true });
    if (after > readyDamage(game, mon, foe.active, undefined, { certain: true })) bonus.set(resolve, 26);
  }
  const freeRetreat = actions.some((a) => a.kind === 'retreat') && game.retreatCost(p, p.active) === 0;
  const switchInHand = actions.some((a) => a.tkind === 'switch' || a.tkind === 'switchCart');
  const before = new Map();
  const value = (m, cards) => {
    const { game: position, mon } = withAttachedEnergy(game, m, cards, p);
    const damage = readyDamage(position, mon, foe.active, undefined, { entering: m !== p.active, certain: true });
    const canEnter = m === p.active || freeRetreat || switchInHand;
    const prizes = damage >= foe.active.hpLeft ? attackPrizes(game, foe, foe.active, m) : 0;
    const immediate = game.turn > 1 && canEnter ? 1 : 0.52;
    const strength = Math.max(0, ...position.attacksOf(mon).map((a) => {
      const gap = energyMissing(mon.payTypes, a.cost);
      return Math.min(15, a.base * 0.10) * 0.58 ** gap;
    }));
    return (Math.min(damage, foe.active.hpLeft) * 0.21 + prizes * 10) * immediate +
      strength - (damage && m === p.active && !prizes ? responseRisk(game, foe.active, m) * 0.10 : 0);
  };
  const valueBefore = (mon) => {
    if (!before.has(mon)) before.set(mon, value(mon, mon.energy));
    return before.get(mon);
  };
  const psychicTargets = psychic ? p.bench.filter((mon) => mon.card.type === 'Psychic') : [];
  const psychicCount = psychic ? p.hand.filter((c) => basic(c, 'Psychic')).length : 0;
  const doorGain = psychic ? Math.max(0, ...psychicTargets.map((m) => value(m, [...m.energy, psychic]) - valueBefore(m))) : 0;
  if (psychic) bonus.set(door, 16 + Math.min(14, doorGain * 0.6));
  return (action) => {
    if (action.kind !== 'energy') return bonus.get(action) ?? 0;
    const m = action.target;
    const cards = [action.card, action.card2].filter(Boolean);
    const attached = [...m.energy, ...cards];
    const gain = value(m, attached) - valueBefore(m);
    const spentDoor = psychic && cards.filter((c) => basic(c, 'Psychic')).length >= psychicCount;
    const doorAfter = !spentDoor && psychicTargets.includes(m) ?
      Math.max(0, value(m, [...attached, psychic]) - value(m, attached)) : doorGain;
    return clamp(gain * 0.64, -10, 21) - (gain < 2 ? 9 : 0) -
      (spentDoor && gain < 25 ? 15 + Math.min(10, doorGain * 0.45) : 0) +
      clamp((doorAfter - doorGain) * 0.35, -8, 8) -
      (bonus.has(resolve) && m === resolve.target && gain < 25 ? 12 : 0);
  };
}

function engineExposure(game, p) {
  if (!p.active || !game.opp(p).active) return 0;
  return Math.min(26, supportValue(game, p.active) * replyThreat(game, game.opp(p), p.active) / 95);
}

function closeKnockout(game, p, action) {
  if (action.kind !== 'attack' || !p.active || p.active.status.confused || p.active.effects.sandAttack) return 0;
  const foe = game.opp(p), attack = game.attacksOf(p.active)[action.index];
  if (!foe.active || foe.active.effects.destinyBond || (attack.fx.selfDamage || 0) >= p.active.hpLeft) return 0;
  if (visibleHit(game, p.active, foe.active, attack, false) < foe.active.hpLeft) return 0;
  return 7 + Math.min(8, prizeValue(game, foe.active) * 3);
}

function exposure(game, p, ended) {
  const foe = game.opp(p);
  const risk = (q, attacker) => !q.active || !attacker.active ? 0 :
    replyThreat(game, attacker, q.active, { includeSetup: true, exposure: ended && attacker.prizes.length <= 3 });
  const own = risk(p, foe), theirs = risk(foe, p);
  const reserve = (side) => side.bench.some((mon) => mon.hpLeft > 0) ? 10 : 0;
  return (theirs - own) * (ended ? 0.48 : 0.18) - lastPrizeGustRisk(game, p) * 78 + reserve(p) - reserve(foe);
}

function newBenchExposure(game, p, action) {
  const foe = game.opp(p);
  if (action.kind !== 'bench' || !p.bench.length || foe.prizes.length > 3 || !foe.active) return 0;
  const next = Object.create(game);
  const side = { ...p, bench: [...p.bench, new Mon(action.card, game.turn, next, -1)] };
  next.players = game.players.map((player) => player === p ? side : player);
  next.current = next.players[game.current?.idx];
  return (lastPrizeGustRisk(game, p) - lastPrizeGustRisk(next, side)) * 48;
}

function diversify(ranked, size) {
  if (ranked.length <= size) return ranked;
  const chosen = ranked.slice(0, Math.ceil(size / 2));
  const family = ({ action }) => action.tkind || action.pkind || action.stadium || action.kind;
  const families = new Set(chosen.map(family));
  for (const entry of ranked) {
    if (chosen.length >= size) break;
    const kind = family(entry);
    if (families.has(kind)) continue;
    families.add(kind);
    chosen.push(entry);
  }
  for (const entry of ranked) {
    if (chosen.length >= size) break;
    if (!chosen.includes(entry)) chosen.push(entry);
  }
  return chosen;
}

const strategies = {
  'exact-energy': { exactEnergy: true },
  'joint-attachment': { jointAttachment: attachmentSequence },
  'attack-energy-reserve': { reserveEnergy: true },
  'active-exchange': { activeExchange: true },
  'retreat-payment': { retreatPayment: true },
  'necessary-retreat': { necessaryRetreat: true },
  'next-attachment': { nextAttachment: true },
  'switch-alternatives': { switchAlternatives: true, engineExposure, opponentChooses: true },
  'deck-clock': { deckClock: true },
  'chance-finish': { chanceFinish: true },
  'exact-prizes': { prizeRules: { exactPrizes: true } },
  'paid-prize-retreats': { prizeRules: { paidRetreats: true } },
  'prize-active-lock': { prizeRules: { trackActiveLock: true } },
  'opponent-switch-choice': { opponentChooses: true },
  'confirmed-search': { confirmedSearch: true },
  'compare-preparation': { comparePreparation: true },
  'setup-knockout': { setupKnockout: true },
  'attack-effects': { attack: { finiteEffects: true, control: 1.14, futureCost: 1.18, acceleration: 1.28 } },
  'attack-sustain': { attack: { finiteEffects: true, control: 0.92, healing: 0.38, futureCost: 1.45 } },
  'stage-development': { action: development },
  'matchup-development': { attacker: attackPath },
  'energy-readiness': { action: attachment },
  'board-readiness': { position: (g, p, ended) =>
    (readiness(g, p, g.turn + (ended ? 2 : 0), true) - readiness(g, g.opp(p), g.turn + 1, false)) * 0.7 },
  'reply-risk': { position: exposure, action: newBenchExposure },
  'reserve-protection': { position: (g, p) => (Number(p.bench.length > 0) - Number(g.opp(p).bench.length > 0)) * 12 },
  'resource-cost': { cost: resourceCost },
  'acceleration-order': { action: accelerateFirst },
  'knockout-order': { action: closeKnockout },
  'prize-pressure': { action: contest },
  'search-diversity': { shortlist: diversify },
  'tactical-confidence': { tacticalMargin: 3 },
  'patient-tactics': { tacticalMargin: 13 },
};

const scoreFields = ['action', 'position', 'attacker', 'cost'];
const attackDefaults = { control: 1, healing: 0.24, futureCost: 1, acceleration: 1 };
function strategyPart(feature) {
  const [name, scale = '1'] = feature.split('@');
  const original = strategies[name], weight = Number(scale);
  if (!original || !Number.isFinite(weight) || weight <= 0) return null;
  if (weight === 1) return original;
  const part = { ...original };
  for (const key of scoreFields) {
    if (original[key]) part[key] = (...args) => weight * original[key](...args);
  }
  if (original.tacticalMargin !== undefined) part.tacticalMargin = 8 + weight * (original.tacticalMargin - 8);
  if (original.attack) {
    part.attack = { ...original.attack };
    for (const [key, neutral] of Object.entries(attackDefaults)) {
      if (original.attack[key] !== undefined) part.attack[key] = neutral + weight * (original.attack[key] - neutral);
    }
  }
  return part;
}

export function buildV3Strategy(profile) {
  const parts = profile.map(strategyPart).filter(Boolean);
  if (!parts.length) return undefined;
  const strategy = Object.assign({}, ...parts);
  if (strategy.prizeRules) strategy.prizeRules = Object.assign({}, ...parts.map((part) => part.prizeRules));
  if (strategy.attack) strategy.attack = { ...strategy.attack,
    anyBasicAcceleration: strategy.exactEnergy, exactPrizes: strategy.prizeRules?.exactPrizes };
  for (const key of scoreFields) {
    const scores = parts.map((part) => part[key]).filter(Boolean);
    if (scores.length > 1) strategy[key] = (...args) => scores.reduce((sum, score) => sum + score(...args), 0);
  }
  return strategy;
}
