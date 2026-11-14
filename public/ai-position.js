// Compare resource use and attack readiness from the player's visible position.
import { canPay, isType, keptEffects } from './engine.js';
import { attackEnergyTypes, attackPotential, energyAfterAttackCost, preferredRetreatPayment } from './ai-discard.js';
import { deckCatalog, energyMissing, supportValue, unseenCardCounts } from './ai-plan.js';
import { attackPrizes, prizeValue, readyDamage, replyThreat, visibleHit, withAttachedEnergy } from './ai-combat.js';

const switches = new Set(['switch', 'switchCart', 'scrambleSwitch', 'birdKeeper', 'surfer', 'primeCatcher', 'guzma',
  'trGiovanni', 'mallowLana', 'escapeRope', 'warpPoint', 'tateLiza']);
const safeBenchSearch = new Set(['nestBall', 'buddyPoffin', 'greatBall', 'levelBall', 'pokePad', 'evolutionIncense']);
const stalled = (m) => m.status.asleep || m.status.paralyzed || m.status.confused ||
  m.effects.noAttackAll || m.effects.cooldownAll;

function knockOutRisk(game, attacker, target, ownDamage = 0) {
  if (ownDamage >= attacker.hpLeft || stalled(attacker)) return 0;
  const attack = readyDamage(game, attacker, target);
  return attack >= target.hpLeft ? 24 + 12 * (game.modern ? target.card.prizes || 1 : 1) : 0;
}

function attackValue(game, damage, target) {
  return Math.min(damage, target.hpLeft) * 0.28 +
    (damage >= target.hpLeft ? 27 + 10 * prizeValue(game, target) : 0);
}

function activeRisk(game, p, target, defender, damage = 0) {
  const poison = target.status.poisoned ? 10 * Number(target.status.poisoned) : 0;
  const burn = target.status.burned ? 20 : 0;
  if (poison + burn >= target.hpLeft) return 34 + prizeValue(game, target) * 12;
  const foe = game.opp(p);
  return replyThreat(game, foe, target, { active: defender, removed: damage >= defender.hpLeft ? defender : null,
    hp: target.hpLeft - poison - burn });
}

export function gustTargetValue(game, p, target, { afterAttack = false } = {}) {
  const { active } = p, foe = game.opp(p);
  if (!active || !foe.active) return 0;
  const turn = game.turn + (afterAttack ? 2 : 0);
  const canAttack = game.turn !== 1 || afterAttack;
  const damage = canAttack ? readyDamage(game, active, target, active.payTypes, { turn }) : 0;
  const current = canAttack ? readyDamage(game, active, foe.active, active.payTypes, { turn }) : 0;
  const risk = activeRisk(game, p, active, foe.active, afterAttack ? 0 : current) -
    activeRisk(game, p, active, target, afterAttack ? 0 : damage);
  const retreat = game.retreatCost(foe, target);
  const trapped = retreat > target.energyTypes.length;
  const trap = (trapped ? Math.min(9, retreat * 3) : 0) *
    (foe.active.energy.length > 0 ? 1 : 0.5);
  const finish = damage >= target.hpLeft && p.prizes.length <= prizeValue(game, target) ? 70 : 0;
  const disrupt = (damage >= target.hpLeft ? supportValue(game, target) * 0.40 : 0) -
    (current >= foe.active.hpLeft ? supportValue(game, foe.active) * 0.40 : 0);
  const deckPressure = trapped && foe.deck.length <= 4 && p.deck.length > foe.deck.length + 1 ? 12 : 0;
  return attackValue(game, damage, target) - attackValue(game, current, foe.active) + risk + trap + finish + disrupt + deckPressure;
}

function switchGain(game, p, mon, defender, kind) {
  const active = p.active;
  const currentDefender = game.opp(p).active;
  const canAttack = game.turn !== 1 && !game.attacking;
  const currentDamage = canAttack
    ? readyDamage(game, active, currentDefender) : 0;
  const transferred = kind === 'scrambleSwitch' ? active.payTypes : [];
  const damage = canAttack ? readyDamage(game, mon, defender, [...mon.payTypes, ...transferred], { entering: true }) : 0;
  const offense = game.attacking
    ? 0.35 * (attackValue(game, readyDamage(game, mon, defender, mon.payTypes, { turn: game.turn + 2 }), defender) -
      attackValue(game, readyDamage(game, active, currentDefender, active.payTypes, { turn: game.turn + 2 }), currentDefender))
    : attackValue(game, damage, defender) - attackValue(game, currentDamage, currentDefender);
  const defense = activeRisk(game, p, active, currentDefender, currentDamage) - activeRisk(game, p, mon, defender, damage);
  const heal = kind === 'switchCart' ? Math.min(30, active.damage) * 0.4 :
    kind === 'mallowLana' && p.hand.length >= 2 ? Math.min(120, active.damage) * 0.25 : 0;
  const draw = p.deck.length > 5 ? kind === 'birdKeeper' ? 10 + Math.max(0, 4 - p.hand.length) * 4 :
    kind === 'surfer' ? Math.max(0, 6 - p.hand.length) * 4 : 0 : 0;
  const entry = mon.card.powerKind === 'tachyonBits' && !p.flags.tachyon ?
    (game.allMons(game.opp(p)).some((m) => m.hpLeft <= 20) ? 28 : 8) :
    mon.card.powerKind === 'libero' && !p.flags['libero' + mon.id] && game.powerOn(mon) &&
      p.discard.some((c) => c.energyType === 'Fire' && !c.special) ? 10 : 0;
  const returnCost = p.flags.switchedOut?.includes(mon.id) ? 22 : p.flags.previousActive === mon.id ? 6 : 0;
  return offense + defense + heal + draw + entry - returnCost;
}

// Set the Active Spot before evaluating effects that depend on the Pokémon's position.
export function switchedPosition(game, p, mon, defender) {
  const position = Object.create(game);
  position.players = [...game.players];
  for (const [side, active] of [[p, mon], [game.opp(p), defender]]) {
    if (side.active === active) continue;
    const bench = side.bench.filter((m) => m !== active);
    if (side.active) {
      const old = Object.assign(Object.create(side.active), { status: {}, effects: keptEffects(side.active.effects) });
      bench.push(old);
    }
    position.players[side.idx] = { ...side, active, bench };
  }
  position.current = position.players[game.current?.idx];
  return position;
}

export function nextAttachmentDamage(game, p, mon, defender, turn, hand = p.hand) {
  if (mon.effects.noEnergy && (mon.effects.noEnergy.expires == null || mon.effects.noEnergy.expires >= turn)) return 0;
  const attacks = game.attacksOf(mon);
  const energy = mon.payTypes;
  const missing = attacks.filter((a) => !canPay(energy, a.cost));
  if (!missing.length) return 0;
  const already = readyDamage(game, mon, defender, undefined, { certain: true, turn, entering: p.active !== mon, attacks });
  if (already >= defender.hpLeft) return 0;
  const seen = new Set();
  let best = already;
  for (const card of hand) {
    if (card.kind !== 'energy' || seen.has(card.id) ||
        (card.special === 'teamRocket' && !mon.name.startsWith("Team Rocket's")) ||
        (card.needsTag && !mon.card.tags?.includes(card.needsTag)) ||
        (card.special === 'aurora' && hand.length < 2) ||
        (card.special && p.until.noSpecialStadium === turn)) continue;
    seen.add(card.id);
    const projected = withAttachedEnergy(game, mon, [...mon.energy, card], p);
    projected.owner.hand = hand.filter((entry) => entry !== card);
    for (const attack of missing) {
      if (!projected.game.canUseAttack(projected.owner, projected.mon, defender, attack, { turn })) continue;
      if (projected.mon.status.confused || projected.mon.effects.sandAttack?.expires >= turn) continue;
      best = Math.max(best, visibleHit(projected.game, projected.mon, defender, attack, p.active !== mon));
    }
  }
  return best > already ? best : 0;
}

export function nextAttachmentValue(game, p, mon, defender, turn) {
  const hand = game.hiddenHand?.has(p.idx) ? game.knownHand ?? [] : p.hand;
  if (!hand.some((card) => card.kind === 'energy')) return 0;
  const damage = nextAttachmentDamage(game, p, mon, defender, turn, hand);
  if (!damage) return 0;
  const current = readyDamage(game, mon, defender, undefined, { certain: true, turn, entering: mon !== p.active });
  const risk = replyThreat(game, game.opp(p), mon, { includeSetup: false });
  const benefit = attackValue(game, damage, defender) - attackValue(game, current, defender);
  return Math.min(32, benefit * 0.62) * Math.max(0.12, 1 - risk / 65);
}

export function paidRetreatPenalty(game, p, action, moves, paid, necessity) {
  if (action.kind !== 'retreat' || !p.active || !game.opp(p).active) return 0;
  const active = p.active, target = action.target, foe = game.opp(p), defender = foe.active;
  const units = game.retreatCost(p, active);
  if (!units) return 0;
  const canAttack = game.turn !== 1;
  const hit = (mon, entering) => canAttack ? readyDamage(game, mon, defender, undefined, { certain: true, entering }) : 0;
  const stay = hit(active, false), move = hit(target, true);
  const ko = move >= defender.hpLeft && stay < defender.hpLeft;
  const risk = (mon, damage) => {
    const hp = mon.hpLeft - Number(mon.status.poisoned || 0) * 10 - (mon.status.burned ? 20 : 0);
    if (hp <= 0) return 45 + 12 * prizeValue(game, mon);
    return replyThreat(game, foe, mon, { hp, removed: damage >= defender.hpLeft ? defender : null, includeSetup: false });
  };
  const stayRisk = risk(active, stay);
  const savesActive = stayRisk >= 43 && stayRisk - risk(target, move) >= 20;
  const alternative = moves.some((a) => a.kind === 'trainer' && a.target === target &&
    (a.tkind === 'switch' || a.tkind === 'switchCart'));
  const returnNow = p.flags.switchedOut?.includes(target.id);
  paid ??= preferredRetreatPayment(game, active, active.energy, units);
  const highValue = paid.some((card) => card.special) || attackPotential(game, active) -
    attackPotential(game, active, active.energy.filter((card) => !paid.includes(card))) >= 12;
  const cost = 6 + paid.length * 5 + (highValue ? 6 : 0);
  const repeat = returnNow ? 16 : p.flags.previousActive === target.id ? 6 : 0;
  const fraction = necessity?.urgent ? 0 : ko || savesActive ? 0.18 : necessity?.tempo ? 0.45 : 1;
  return (cost + repeat) * fraction + (alternative ? 14 : 0);
}

export function retreatNecessity(game, p, target) {
  const foe = game.opp(p), defender = foe.active, active = p.active;
  const hit = (mon, entering) => game.turn === 1 ? 0 :
    readyDamage(game, mon, defender, undefined, { certain: true, entering });
  const stay = hit(active, false), move = hit(target, true);
  const checkupHp = (mon) => mon.hpLeft - Number(mon.status.poisoned || 0) * 10 - (mon.status.burned ? 20 : 0);
  const immediateDanger = (mon, damage) => checkupHp(mon) <= 0 ||
    (damage < defender.hpLeft && readyDamage(game, defender, mon, undefined, {
      certain: true, turn: game.turn + 1,
    }) >= checkupHp(mon));
  const avoidsKnockout = immediateDanger(active, stay) && !immediateDanger(target, move);
  const takesPrize = move >= defender.hpLeft && stay < defender.hpLeft;
  const cutsTurn = move > 0 && move >= stay + 20 &&
    Math.ceil(defender.hpLeft / move) <= 3 &&
    Math.ceil(defender.hpLeft / move) < Math.ceil(defender.hpLeft / Math.max(1, stay));
  return { urgent: takesPrize || avoidsKnockout, avoidsKnockout, tempo: cutsTurn };
}

export function activeLineValue(game, p, { attackNow = false, incoming = true, turn = game.turn, removed } = {}) {
  const mon = p.active, foe = game.opp(p), defender = foe.active;
  if (!mon || !defender) return 0;
  const hit = attackNow ? readyDamage(game, mon, defender, undefined, { certain: true, turn }) : 0;
  const ko = hit >= defender.hpLeft;
  const out = ko ? defender : removed;
  const hp = mon.hpLeft - Number(mon.status.poisoned || 0) * 10 - (mon.status.burned ? 20 : 0);
  const risk = incoming ? hp <= 0 ? 40 + 12 * prizeValue(game, mon) : replyThreat(game, foe, mon, {
    removed: out,
    hp,
    turn: attackNow ? turn + 1 : game.turn + Number(game.current === p),
  }) : 0;
  const next = turn + (attackNow ? 2 : 0);
  const retreat = game.retreatCost(p, mon);
  const targets = out ? foe.bench.filter((target) => target.hpLeft > 0) : [defender];
  const ready = (m) => Math.max(0, ...targets.map((target) =>
    Math.min(target.hpLeft, readyDamage(game, m, target, undefined, { certain: true, turn: next, entering: m !== mon }))));
  const backup = Math.max(0, ...p.bench.map(ready));
  const follow = ready(mon);
  const pivot = !hit && p.bench.length && (!follow || backup > follow)
    ? 9 - retreat * 6 - (retreat > mon.energyTypes.length ? 6 : 0) : 0;
  const exposure = Math.min(17, supportValue(game, mon) * risk / 100);
  return (attackNow ? attackValue(game, hit, defender) : 0) - risk * 0.78 - exposure +
    Math.min(mon.hpLeft, 170) * 0.075 - (prizeValue(game, mon) - 1) * 4 + pivot +
    Math.min(180, Math.max(follow, backup * (retreat === 0 ? 0.88 : 0.55))) * 0.14 +
    Math.min(110, backup) * 0.045;
}

function switchLineGain(game, p, mon, defender, kind) {
  const position = switchedPosition(game, p, mon, defender);
  const side = position.players[p.idx];
  const attackNow = game.turn !== 1 && !game.attacking;
  const turn = game.turn + (game.attacking ? 2 : 0);
  // Keep the shared card-specific scoring for effects that go beyond changing position.
  const base = switchGain(game, p, mon, defender, kind);
  if (kind === 'scrambleSwitch') return base;
  const improvement = activeLineValue(position, side, { attackNow, turn }) -
    activeLineValue(game, p, { attackNow, turn });
  return base * 0.45 + improvement * 0.65;
}

export function movementFor(game, p, action, paymentCost, opponentChooses = false, exchange = false, future) {
  const { kind, tkind, pkind, stadium, target } = action;
  const type = kind === 'retreat' ? kind : kind === 'trainer' && switches.has(tkind) ? tkind :
    kind === 'power' && pkind === 'witchRondo' ? pkind : kind === 'stadium' && stadium === 'surfingBeach' ? stadium : null;
  const foe = game.opp(p);
  const opposingSwitch = opponentChooses && ['escapeRope', 'warpPoint', 'ryme'].includes(tkind);
  if (opposingSwitch && p.active && foe.active) {
    const theirs = foe.bench.length && !(tkind === 'ryme' && game.poncho(foe.active)) ? foe.bench : [foe.active];
    if (tkind === 'ryme' && theirs[0] === foe.active) return null;
    const ours = tkind !== 'ryme' && p.bench.length ? p.bench : [p.active];
    const options = { attackNow: game.turn !== 1 };
    const baseline = activeLineValue(game, p, options);
    const worst = theirs.map((defender) => {
      const gain = Math.max(...ours.map((mon) => {
        const position = switchedPosition(game, p, mon, defender);
        return activeLineValue(position, position.players[p.idx], options) - baseline;
      }));
      return { defender, gain };
    }).reduce((a, b) => a.gain <= b.gain ? a : b);
    return { ...worst, cost: 7, gain: worst.gain - 7, candidates: ours };
  }
  if (!type || !p.bench.length) return null;
  const candidates = target && game.ownerOf(target) === p ? [target] :
    type === 'surfingBeach' ? p.bench.filter((m) => m.card.type === 'Water') :
    type === 'trGiovanni' ? p.bench.filter((m) => m.name.startsWith("Team Rocket's")) : p.bench;
  const defender = target && game.ownerOf(target) === foe ? target : foe.active;
  const cost = type === 'retreat' ? paymentCost() : kind === 'trainer' ? 7 : 2;
  const base = exchange ? switchLineGain : switchGain;
  const staying = future?.(p.active, foe.active) ?? 0;
  const score = (g, q, m, d, kind) => base(g, q, m, d, kind) + (future?.(m, d) ?? 0) - staying;
  const gainAgainst = (opponent) => Math.max(-Infinity, ...candidates.map((m) => score(game, p, m, opponent, type)));
  if (exchange && foe.bench.length && (type === 'escapeRope' || type === 'warpPoint')) {
    const worst = foe.bench.map((opponent) => ({ opponent, gain: gainAgainst(opponent) }))
      .reduce((a, b) => a.gain <= b.gain ? a : b);
    return { cost, gain: worst.gain - cost, candidates, defender: worst.opponent };
  }
  if (exchange && type === 'witchRondo' && foe.bench.length) {
    const replies = candidates.map((mon) => foe.bench.map((opponent) => ({
      mon, opponent, gain: score(game, p, mon, opponent, type),
    })).reduce((a, b) => a.gain <= b.gain ? a : b));
    const best = replies.reduce((a, b) => a.gain >= b.gain ? a : b);
    return { cost, gain: best.gain - cost, candidates: [best.mon], defender: best.opponent };
  }
  const gain = gainAgainst(defender) - cost;
  return { cost, gain, candidates, defender };
}

export function movementTargets(game, p, prompt, action, exchange = false, readyNext = false) {
  const defender = game.opp(p).active;
  if (!defender) return null;
  const switching = game.current === p && p.active && ['prompt.q.switchSelf', 'prompt.q.warpYou'].includes(prompt.text);
  const replacing = prompt.text === 'prompt.promote.text' || prompt.kind === 'whirlwind';
  const fleeing = exchange && prompt.kind === 'flee';
  if (!switching && !replacing && !fleeing) return null;
  const options = fleeing ? prompt.options : prompt.options.filter((o) => o.mon);
  if (!options.length) return null;
  const kind = action?.tkind ?? action?.pkind ?? action?.stadium;
  const nextTurn = game.turn + (game.current === p ? 2 : 1);
  const score = (mon) => {
    const future = readyNext && mon ? nextAttachmentValue(game, p, mon, defender, nextTurn) : 0;
    if (exchange) {
      if (fleeing) return mon ? switchLineGain(game, p, mon, defender, 'flee') + future : 0;
      if (switching && kind === 'witchRondo' && game.opp(p).bench.length) {
        return Math.min(...game.opp(p).bench.map((target) => switchLineGain(game, p, mon, target, kind) +
          (readyNext ? nextAttachmentValue(game, p, mon, target, nextTurn) : 0)));
      }
      if (switching) return switchLineGain(game, p, mon, defender, kind) + future;
      const position = switchedPosition(game, p, mon, defender);
      const turn = game.turn + (game.current === p ? 2 : 1);
      const hit = readyDamage(position, mon, defender, undefined, { certain: true, turn, entering: true });
      return activeLineValue(position, position.players[p.idx], { turn }) +
        attackValue(position, hit, defender) * (game.current === p ? 0.5 : 0.72) + future;
    }
    if (switching && ['warpPoint', 'escapeRope'].includes(kind) && readyNext) {
      const position = switchedPosition(game, p, mon, defender);
      return activeLineValue(position, position.players[p.idx], { attackNow: game.turn !== 1 }) + future;
    }
    if (switching) return switchGain(game, p, mon, defender, kind) + future;
    const damage = readyDamage(game, mon, defender, mon.payTypes, { entering: true, turn: nextTurn });
    return attackValue(game, damage, defender) * 0.85 - activeRisk(game, p, mon, defender, game.current !== p ? damage : 0) +
      mon.hpLeft * 0.10 + attackPotential(game, mon) * 0.25 - game.retreatCost(p, mon) * 2 + future;
  };
  return options.map((o) => [o, score(o.mon)])
    .sort((a, b) => b[1] - a[1]).map(([option]) => option);
}

// In a weak or neutral exchange, look for concrete setup that can happen before a switch.
export function preparationBeforeSwitch(game, p, rows, plan, prizes, moving) {
  if (!p.active || !game.opp(p).active || !moving.move || moving.move.gain >= 28) return null;
  const { list } = deckCatalog(p);
  const targets = plan?.setupTargets ?? [];
  const search = rows.some(({ action }) => safeBenchSearch.has(action.tkind));
  const unseen = search ? unseenCardCounts(game, p, list) : null;
  const count = (card) => Math.max(0, (unseen?.get(card.id) || 0) - (prizes?.get(card.id) || 0));
  const backup = p.bench.filter((m) => m !== moving.action.target);
  const useful = ({ action, move, score }) => {
    if (move || score < 10) return false;
    if (action.kind === 'evolve' || action.tkind === 'rareCandy') return true;
    if (action.kind === 'bench') return p.bench.length < 4 &&
      (p.bench.length < 2 || (plan?.actionPriority(action) ?? 0) > 0);
    if (!safeBenchSearch.has(action.tkind) || p.deck.length <= 7) return false;
    if ((plan?.actionPriority(action) ?? 0) >= 15) return true;
    if (action.tkind !== 'greatBall' || p.bench.length >= 4 || backup.some((m) => attackPotential(game, m) >= 28)) return false;
    const wants = new Set(targets.map(({ card }) => card.id));
    const usefulBasics = list.reduce((n, [card]) => n + (card.kind === 'pokemon' && card.stage === 0 &&
      (wants.has(card.id) || backup.some((m) => m.card.evolvesFrom === card.name)) &&
      !p.hand.some((c) => c.id === card.id) ? count(card) : 0), 0);
    const unknown = p.deck.length + (prizes ? 0 : p.prizes.length);
    return usefulBasics > 0 && 1 - (1 - Math.min(1, usefulBasics / unknown)) ** Math.min(7, p.deck.length) >= 0.25;
  };
  return rows.find(useful)?.action ?? null;
}

// Value a surplus attachment only when it changes the attack or the following exchange.
export function attackReserveBonus(game, p, action, preparation = []) {
  if (action.kind !== 'energy' || !p.active || !game.opp(p).active) return 0;
  const mon = action.target, foe = game.opp(p), defender = foe.active;
  const attacks = game.attacksOf(mon);
  const costs = attacks.filter(({ fx }) => fx.discard || fx.discardAllTypeTimes);
  const boostsDamage = [action.card, action.card2].some((card) => card?.special === 'singleStrike');
  const evolution = preparation.find((a) => a.target === mon && (a.kind === 'evolve' || a.tkind === 'rareCandy'));
  const evolutionCard = evolution?.evo ?? evolution?.card;
  const evolutionValue = (sourceGame, source, owner) => {
    if (!evolutionCard) return 0;
    const projected = withAttachedEnergy(sourceGame, source, source.energy, owner);
    projected.mon.stack = [...source.stack, evolutionCard];
    projected.mon.status = {};
    projected.mon.effects = {};
    return readyDamage(projected.game, projected.mon, defender, undefined, { certain: true, turn: game.turn + 2 });
  };
  if (!costs.length && !boostsDamage && !evolutionCard) return 0;
  const { game: charged, owner, mon: attacker } = withAttachedEnergy(game, mon,
    [...mon.energy, action.card, action.card2].filter(Boolean), p);
  const turn = game.turn + 2;
  const value = (position, side, source, attack) => {
    if (!position.canUseAttack(side, source, defender, attack)) return 0;
    const { fx } = attack;
    const remaining = fx.discardAllEnergy ? [] : fx.discard ? energyAfterAttackCost(position, side, source, fx.discard) :
      fx.discardAllTypeTimes ? source.energy.filter((card) => !isType(card.energyType, fx.discardAllTypeTimes.type)) : source.energy;
    const { game: spent, mon: spentMon } = withAttachedEnergy(position, source, remaining, side);
    // Ordinary fixed discards happen before damage modifiers such as Single Strike Energy.
    const hit = visibleHit(position, source, defender, attack, source !== side.active);
    const ko = hit >= defender.hpLeft;
    const targets = ko ? foe.bench : [defender];
    const spentOwner = spent.players[p.idx];
    const effects = { ...spentMon.effects };
    if (fx.cooldown) effects.cooldown = { atk: attack.name, expires: turn };
    if (fx.lockout) effects.cooldownAll = { expires: turn };
    if (fx.oncePerActive) effects.usedActive = { atk: attack.name, expires: turn };
    spentMon.effects = effects;
    if (fx.oncePerPlay) spentMon.used = { ...spentMon.used, [attack.name]: true };
    const follow = Math.max(0, ...targets.map((target) => {
      const nextPosition = target === defender ? spent : switchedPosition(spent, spentOwner, spentMon, target);
      const nextHit = readyDamage(nextPosition, spentMon, target, undefined, { certain: true, turn });
      const left = ko ? target.hpLeft : Math.max(1, target.hpLeft - hit);
      return Math.min(nextHit, left) * 0.23 + (nextHit >= left ? 12 : 0);
    }));
    const risk = replyThreat(spent, foe, spentMon, { removed: ko ? defender : null });
    return Math.min(hit, defender.hpLeft) * 0.24 +
      (ko ? 14 * attackPrizes(position, foe, defender, source) : 0) + follow * Math.max(0.15, 1 - risk / 65);
  };
  const gain = Math.max(0, ...(boostsDamage ? attacks : costs).map((attack) => {
    // A newly payable attack already receives its ordinary readiness bonus.
    if (!game.canUseAttack(p, mon, defender, attack)) return 0;
    return value(charged, owner, attacker, attack) - value(game, p, mon, attack);
  }));
  const evolving = evolutionCard ? Math.max(0, Math.min(defender.hpLeft, evolutionValue(charged, attacker, owner)) -
    Math.min(defender.hpLeft, evolutionValue(game, mon, p))) * 0.13 : 0;
  return Math.min(24, gain * (mon === p.active && game.turn > 1 ? 1.15 : 0.65) + evolving);
}

function energyDamageUse(game, p, target, cards) {
  const attacks = game.attacksOf(target);
  const payable = attacks.filter((a) => canPay(target.payTypes, a.cost));
  const types = cards.map((c) => c.energyType);
  const units = cards.reduce((n, card) => n + (card.provides || 1), 0);
  const matches = (type) => type && types.some((t) => isType(t, type));
  const boardScaling = (fx) => fx.timesAllEnergy || fx.timesOwnEnergyAll || matches(fx.plusTypeEnergyAll?.type) ||
    matches(fx.hailBlade?.type) || (fx.timesAttachedNameAll && cards.some((c) => c.name === fx.timesAttachedNameAll.name));
  // Some attacks scale with Energy in play, or spend attached Energy as part of the attack.
  const scaling = payable.some(({ fx, cost }) =>
    boardScaling(fx) || fx.timesBothActiveEnergy || target.energy.length < (fx.discardSelfTimes?.max ?? fx.discardSelfBonus?.max ?? 0) ||
    (fx.bonusIfExtraEnergy && target.energyTypes.length <= cost.length && target.energyTypes.length + units > cost.length) ||
    matches(fx.plusSelfEnergy?.type) || matches(fx.timesSelfType?.type) ||
    (fx.extraWater && types.includes('Water') && game.extraWater(target, { cost }) * 10 < fx.extraWater));
  const reserve = payable.some(({ fx, cost }) => fx.discard && (!fx.discard.type || matches(fx.discard.type)) &&
    target.energyTypes.length < cost.length + fx.discard.n);
  const supportsActive = target !== p.active && !stalled(p.active) &&
    game.attacksOf(p.active).some(({ fx, cost }) => canPay(p.active.payTypes, cost) && boardScaling(fx));
  return scaling || reserve || supportsActive || cards.some((c) => c.special === 'voltaic');
}

export function attachmentScore(game, p, action, planBonus = 0, cards = [action.card, action.card2].filter(Boolean), exactEnergy = false) {
  const { target } = action;
  const attached = [...target.energy, ...cards];
  const after = exactEnergy ? attackEnergyTypes(target, attached) :
    [...target.payTypes, ...cards.flatMap((c) => Array(c.provides || 1).fill(c.energyType))];
  const beforePotential = attackPotential(game, target);
  const afterPotential = attackPotential(game, target, attached);
  const delta = afterPotential - beforePotential;
  const opponent = game.opp(p).active;
  const currentDamage = readyDamage(game, target, opponent, undefined, { certain: exactEnergy });
  const enabledDamage = readyDamage(game, target, opponent, after, exactEnergy
    ? { attached, certain: true } : {});
  const attacks = game.attacksOf(target);
  const steps = Math.min(...attacks.filter((a) => a.base > 0).map((a) => energyMissing(after, a.cost)));
  const scaling = energyDamageUse(game, p, target, cards);
  if (delta <= 0.1 && enabledDamage <= currentDamage && !scaling && !planBonus) return 1;

  const active = target === p.active;
  const productiveNow = active && game.turn !== 1 && !game.attacking && !stalled(target);
  const attackGain = enabledDamage > currentDamage ? Math.min(24, (enabledDamage - currentDamage) * 0.3) : 0;
  const danger = active && knockOutRisk(game, opponent, target, productiveNow ? enabledDamage : 0);
  if (danger && (!productiveNow || (!attackGain && !scaling))) return 2;
  const base = attackGain && steps === 0 ? 49 : 38;
  return base + Math.min(32, Math.max(0, delta) * 1.3) + attackGain + (steps === 0 ? 8 : steps === 1 ? 5 : 0) +
    (productiveNow && attackGain ? 13 : 0) + (scaling ? 11 : 0) + planBonus - (danger ? (attackGain ? 9 : 23) : 0);
}

function attachmentTargetScore(game, p, mon, { cards, damage = 0 }, plan, exactEnergy, reserveEnergy) {
  if (mon.hpLeft <= damage) return -100;
  const action = { kind: 'energy', card: cards[0], card2: cards[1], target: mon };
  const value = attachmentScore(game, p, action, plan?.actionPriority(action) ?? 0, cards, exactEnergy);
  return value + (reserveEnergy ? attackReserveBonus(game, p, action) : 0) -
    damage * (mon.hpLeft <= damage + 30 ? 0.9 : 0.25);
}

export function attachmentTargets(game, p, prompt, plan, exactEnergy, reserveEnergy) {
  if (prompt.kind !== 'attachTo' || !prompt.attachment?.cards.length || !p.active || !game.opp(p).active) return null;
  return prompt.options.map((o) => [o, o.mon ? attachmentTargetScore(game, p, o.mon, prompt.attachment, plan, exactEnergy, reserveEnergy) : 3])
    .sort((a, b) => b[1] - a[1]).map(([option]) => option);
}

export function usefulRepeatableAttachment(game, p, action, plan, exactEnergy, reserveEnergy) {
  if (action.pkind === 'psychicEmbrace') {
    const card = p.discard.findLast((c) => c.energyType === 'Psychic' && !c.special);
    return !!card && game.allMons(p).some((m) => m.card.type === 'Psychic' &&
      attachmentTargetScore(game, p, m, { cards: [card], damage: 20 }, plan, exactEnergy, reserveEnergy) > 3);
  }
  const type = action.pkind === 'superCold' ? 'Water' : action.pkind === 'magneticCircuit' ? 'Lightning' : null;
  if (!type) return true;
  const card = p.hand.find((c) => c.energyType === type && !c.special);
  return !!card && game.allMons(p).some((m) => attachmentTargetScore(game, p, m, { cards: [card] }, plan, exactEnergy, reserveEnergy) > 3);
}
