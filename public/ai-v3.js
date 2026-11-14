import { HardPolicy } from './ai-hard.js';
import { attackScore, readyDamage, replyThreat, visibleHit, withAttachedEnergy } from './ai-combat.js';
import { energyAfterAttackCost } from './ai-discard.js';
import { deckCatalog, unseenCardCounts } from './ai-plan.js';
import { attachmentScore, movementFor, nextAttachmentDamage } from './ai-position.js';
import { redrawProfile } from './ai-redraw.js';
import { isType } from './engine.js';
import { opponentTrainerValue } from './ai-v3-opponent-trainers.js';
import { defensiveTrainerValue, rankScoopPromotion } from './ai-v3-defense.js';
import { energyDisruptionValue, rankEnergyDisruption, removesEnergy } from './ai-v3-energy-removal.js';
import { heavyBallValue, rankRecovery, shortDeck, superRodTargets } from './ai-v3-recovery.js';
import { rankSelection } from './ai-v3-selection.js';
import { paidSearchValue } from './ai-v3-search-order.js';
import { isPersistentTool, persistentToolValue, rankToolRemoval, removesTools, toolRemovalValue } from './ai-v3-tools.js';
import { unsafeStadiumAction } from './ai-v3-safety.js';
import { checkupDamage, choiceBeltValue, isChoiceBelt, isPotion, potionSurvival } from './ai-v3-targets.js';

const setupTrainers = new Set(['nestBall', 'buddyPoffin', 'pokeBall', 'greatBall', 'levelBall', 'pokePad',
  'pokemonFanClub', 'sonia', 'drayton', 'jacq', 'arven', 'bill', 'hop', 'hau', 'barry', 'nemona']);
const setupPowers = new Set(['tandemUnit', 'attractCustomers', 'stellarWish', 'quickSearch', 'restart',
  'reconDirective', 'precognitiveAura', 'industriousIncisors']);
const shortDraws = new Map([['makeDo', 2], ['refinement', 2], ['concealedCards', 2], ['flipTheScript', 3],
  ['bill', 2], ['nemona', 3], ['hop', 3], ['barry', 3], ['hau', 3]]);
const harmfulAttack = new Set(['selfDamage', 'riskyTails', 'tailsSelf', 'selfStatus', 'selfKO', 'benchAll',
  'discard', 'discardSelfTimes', 'discardSelfBonus', 'discardAllTypeTimes', 'optionalDiscardTypeAll', 'millSelf',
  'fadeOut', 'selfToHandAll', 'shuffleSelf', 'selfSwitch', 'lockout', 'cooldown', 'tailsCooldown']);
const attackBoosts = new Set(['plusPower', 'leon', 'powerTablet', 'premiumPowerPro', 'misty', 'koga', 'professorKukui', 'heatBoost']);
const boostFlags = { leon: 'leon', premiumPowerPro: 'ppp', misty: 'misty', professorKukui: 'kukui', heatBoost: 'heatBoost' };
const tacticalTrainers = new Set(['misty', 'koga', 'blaine', 'giovanni', 'scoopUpNet']);
const boostKind = (action) => action.kind === 'trainer' ? action.tkind : action.kind === 'power' ? action.pkind : null;
const isTechnicalMachine = (action) => action.tkind === 'tool' && action.card.tool?.startsWith('tm');
const canAttackWith = (game, p, mon, target, attack) => game.turn !== 1 &&
  game.canUseAttack(p, mon, target, attack) && game.hasAttackBench(p, attack.fx);

function attackDamageRanges(game, p, attack, includeSplash) {
  const foe = game.opp(p), a = p.active, d = foe.active, { fx } = attack;
  if (!game.hasAttackBench(p, fx) || (fx.discardHandOrFail &&
      p.hand.filter((c) => c.kind === 'energy' && c.energyType === fx.discardHandOrFail.type).length < fx.discardHandOrFail.n)) return [];
  const hits = [];
  const add = (target, range, options) => {
    const blocked = target.effects.shield?.kind === 'all' || (game.modern && game.smBarrier(a, target));
    if (!blocked || options?.ignoreDef || options?.noWR) hits.push({ target, range, options });
  };
  if (!fx.mirrorMove) {
    const rangeFor = (target) => fx.lure ? [fx.fixedBase || 0, fx.fixedBase || 0] : game.baseRange(a, target, attack);
    for (const target of fx.lure ? foe.bench : [d]) add(target, rangeFor(target), {
      noWR: fx.noWR, noWROnly: fx.noWROnly, noRes: fx.noRes, noWeakness: fx.noWeakness, ignoreDef: fx.ignoreDefEffects,
    });
  }
  if (includeSplash) {
    if (fx.snipeAny) add(d, [fx.snipeAny.n, fx.snipeAny.n], { noWR: fx.snipeAny.noWR, noWROnly: !game.modern });
    if (fx.snipeMulti) add(d, [fx.snipeMulti.n, fx.snipeMulti.n]);
    if (fx.snipeDamaged && d.damage) add(d, [fx.snipeDamaged, fx.snipeDamaged]);
    if (fx.spiral) add(d, [fx.spiral, fx.spiral], { noWROnly: !game.modern });
    if (fx.bonfire && a.energyTypes.includes('Fire')) add(d, [0, 10 * Math.min(3, game.countType(a, 'Fire'))], { noWROnly: true });
  }
  return hits;
}

function followUpDamage(game, p, first, resolved, firstHit) {
  const { fx } = resolved;
  const active = p.active, defender = game.opp(p).active, turn = game.turn + 2;
  const leavesPlay = fx.fadeOut || fx.selfToHandAll || fx.shuffleSelf || fx.flipShuffleSelf ||
    fx.selfKO || fx.switchSelfMust || fx.switchSelf;
  const stopped = fx.lockout || fx.tailsCooldown || [].concat(fx.selfStatus || []).some((s) =>
    s === 'asleep' || s === 'paralyzed' || s === 'confused');
  if (leavesPlay || stopped || defender.effects.mirrorShell) return 0;

  let energy = active.energy;
  if (fx.discardAllEnergy) energy = [];
  else if (fx.discardAllTypeTimes) energy = energy.filter((c) => !isType(c.energyType, fx.discardAllTypeTimes.type));
  else if (fx.flipTailsDiscard) energy = energyAfterAttackCost(game, p, active, { type: fx.flipTailsDiscard, n: 1 });
  // These costs depend on an optional payment. Wait for a line we can project from known Energy.
  if (fx.discardSelfTimes || fx.discardSelfBonus || fx.optionalDiscardTypeAll || fx.hailBlade || fx.discardTypeTimes) return 0;

  const { game: next, mon, owner } = withAttachedEnergy(game, active, energy, p);
  const foe = next.opp(owner);
  const target = Object.assign(Object.create(defender), { game: next, damage: defender.damage + firstHit });
  next.players[foe.idx] = { ...foe, active: target };
  const stillActive = (effects) => Object.fromEntries(Object.entries(effects).filter(([, effect]) => effect.expires == null || effect.expires >= turn));
  mon.effects = { ...stillActive(mon.effects), lastAtk: { atk: first.name, expires: turn } };
  if (fx.cooldown) mon.effects.cooldown = { atk: resolved.name, expires: turn };
  if (fx.oncePerActive) mon.effects.usedActive = { atk: resolved.name };
  mon.used = fx.oncePerPlay ? { ...mon.used, [resolved.name]: true } : mon.used;
  owner.gxUsed ||= first.fx.gx;
  mon.damage += fx.selfDamage || 0;
  mon.tools = mon.tools.filter((tool) => tool.expires >= turn);
  target.effects = stillActive(target.effects);
  target.tools = target.tools.filter((tool) => tool.expires >= turn);
  next.turn = turn;
  owner.flags = {};

  const hpBeforeReply = mon.hpLeft - checkupDamage(mon);
  const reply = readyDamage(game, defender, active, undefined, { turn: turn - 1, certain: true });
  if (hpBeforeReply - reply <= Number(mon.status.poisoned || 0) * 10) return 0;
  const attacks = next.attacksOf(mon).filter((attack) => canAttackWith(next, owner, mon, target, attack));
  return Math.max(readyDamage(next, mon, target, undefined, { attacks, certain: true }),
    nextAttachmentDamage(next, owner, mon, target, turn));
}

// An immediate Knock Out has priority over setting up a Knock Out next turn.
export function boostKnockoutTiming(game, p, kind, action, additional = []) {
  const active = p.active, defender = game.opp(p).active;
  if (!active || !defender || game.turn === 1) return 0;
  const attacks = game.attacksOf(active).filter((attack) => canAttackWith(game, p, active, defender, attack));
  if (!attacks.length) return 0;
  const directKnockout = readyDamage(game, active, defender, undefined, { attacks, certain: true }) +
    checkupDamage(defender) >= defender.hpLeft;

  const { game: projected, mon, owner } = withAttachedEnergy(game, active, active.energy, p);
  owner.flags = { ...p.flags };
  if (kind === 'plusPower') mon.tools = [...mon.tools, ...[action.card, ...additional].map((card) => ({ card, expires: game.turn }))];
  else if (kind === 'powerTablet') owner.flags.powerTablet = (p.flags.powerTablet || 0) + 1 + additional.length;
  else if (boostFlags[kind]) owner.flags[boostFlags[kind]] = true;
  if (kind === 'heatBoost') {
    const energy = p.hand.find((card) => card.kind === 'energy' && card.energyType === 'Fire');
    if (!energy) return 0;
    owner.hand = p.hand.filter((card) => card !== energy);
    owner.discard = [...p.discard, energy];
  } else if (action.card) {
    owner.hand = p.hand.filter((card) => card !== action.card && !additional.includes(card));
    if (kind !== 'plusPower') owner.discard = [...p.discard, action.card];
  }

  let enablesFollowUp = false, hasUnboostedFollowUp = false;
  const firstAttacks = attacks.flatMap((first) =>
    (game.copiedAttacks(p, defender, first) ?? [first]).map((attack) => ({ first, attack })));
  for (const { first, attack } of firstAttacks) {
    const attackPosition = (board, side) => attack.fx.discard ?
      withAttachedEnergy(board, side.active, energyAfterAttackCost(board, side, side.active, attack.fx.discard), side) :
      { game: board, mon: side.active, owner: side };
    const beforeAttack = attackPosition(game, p), afterAttack = attackPosition(projected, owner);
    const beforeHits = attackDamageRanges(beforeAttack.game, beforeAttack.owner, attack, kind !== 'koga');
    const afterHits = attackDamageRanges(afterAttack.game, afterAttack.owner, attack, kind !== 'koga');
    for (const [index, { target, range, options }] of afterHits.entries()) {
      if (target === defender && directKnockout) continue;
      const previous = beforeHits[index]?.range ?? [0, 0];
      const canPoison = kind === 'koga' && active.name.includes('Koga') && !target.status.poisoned &&
        ![].concat(attack.fx.status || []).includes('poisoned') && !(game.modern && game.statusImmune(target));
      const { fx } = attack;
      const steps = fx.flipMulti || (fx.flipPerEnergy && afterAttack.mon.energyTypes.length) ||
        (fx.waterPunch && projected.countType(afterAttack.mon, 'Water')) || fx.flipMultiBonus?.n || 1;
      const lastStep = range[0] === range[1] && previous[0] === previous[1] ? 0 : steps;
      for (let step = 0; step <= lastStep; step++) {
        const base = range[0] + (range[1] - range[0]) * step / steps;
        const previousBase = previous[0] + (previous[1] - previous[0]) * step / steps;
        const before = beforeAttack.game.finalDamage(beforeAttack.mon, target, previousBase, options).dmg;
        const after = kind === 'koga' ? before + (before > 0 && canPoison ? 10 : 0) :
          afterAttack.game.finalDamage(afterAttack.mon, target, base, options).dmg;
        const betweenTurns = target === defender ? checkupDamage(target) : 0;
        const hp = target.hpLeft - betweenTurns;
        if (after > before && before < hp && after >= hp) return 2;
        if (target !== defender || hasUnboostedFollowUp || hp <= 0) continue;
        if (step !== 0 && (enablesFollowUp || after <= before)) continue;
        const nextBefore = followUpDamage(beforeAttack.game, beforeAttack.owner, first, attack, before + betweenTurns);
        if (step === 0 && before + nextBefore >= hp) {
          hasUnboostedFollowUp = true;
          continue;
        }
        if (enablesFollowUp || after <= before) continue;
        const nextAfter = followUpDamage(afterAttack.game, afterAttack.owner, first, attack, after + betweenTurns);
        enablesFollowUp = before + nextBefore < hp && nextAfter > 0 && after + nextAfter >= hp;
      }
    }
  }
  return enablesFollowUp && !hasUnboostedFollowUp ? 1 : 0;
}

function boostTimingWithCopies(game, p, kind, action) {
  const timing = boostKnockoutTiming(game, p, kind, action);
  if (timing === 2 || !['plusPower', 'powerTablet'].includes(kind)) return timing;
  const copies = p.hand.filter((card) => card !== action.card && card.tkind === kind);
  return copies.length && boostKnockoutTiming(game, p, kind, action, copies) === 2 ? 2 : timing;
}

function hasDiscardPayoff(game, p, name) {
  const benefits = (card) => card.attacks?.some(({ fx }) => fx.plusDiscardNamed?.name === name);
  if (game.allMons(p).some((mon) => benefits(mon.card)) || p.hand.some(benefits)) return true;
  const { list } = deckCatalog(p);
  const unseen = unseenCardCounts(game, p, list);
  return list.some(([card]) => unseen.get(card.id) > 0 && benefits(card));
}

function machineAttackValue(game, p, attack, prizes) {
  if (attack.fx.tmDevolution) {
    const targets = game.allMons(game.opp(p)).filter((m) => m.stack.length > 1 && !game.effectsBlocked(m));
    return targets.reduce((value, m) => value + (m.damage >= m.stack.at(-2).hp ? 80 : 14), 0);
  }
  if (attack.fx.tmEvolution && p.deck.length && p.bench.length) {
    const { list } = deckCatalog(p);
    const unseen = unseenCardCounts(game, p, list);
    const canEvolve = (m) => list.some(([card]) => card.evolvesFrom === m.name &&
      (unseen.get(card.id) ?? 0) > (prizes?.get(card.id) ?? 0));
    return Math.min(2, p.bench.filter(canEvolve).length) * 29;
  }
  return 0;
}

function machineValue(game, p, action, prizes) {
  const target = action.target, defender = game.opp(p).active;
  if (target !== p.active || !defender || game.turn === 1) return 0;
  const { game: projected, mon, owner } = withAttachedEnergy(game, target, target.energy, p);
  mon.tools = [...mon.tools, { card: action.card, expires: game.turn }];
  return Math.max(0, ...projected.attacksOf(mon).filter((attack) => attack.tm && canAttackWith(projected, owner, mon, defender, attack))
    .map((attack) => machineAttackValue(projected, owner, attack, prizes)));
}

function blaineValue(game, p, actions) {
  const fires = p.hand.filter((card) => card.kind === 'energy' && card.energyType === 'Fire' && !card.special);
  if (fires.length < 2) return 0;
  const single = Math.max(3, ...actions.filter((a) => a.kind === 'energy')
    .map((a) => attachmentScore(game, p, a, 0, undefined, true)));
  const double = Math.max(0, ...game.allMons(p).filter((m) => m.name.includes('Blaine') && !m.effects.noEnergy)
    .map((target) => attachmentScore(game, p, { target, card: fires[0], card2: fires[1] }, 0, undefined, true)));
  return double > single + 3 ? double + 1 : 0;
}

function usefulAttack(game, p, action) {
  if (action.kind !== 'attack' || !p.active || !game.opp(p).active) return null;
  const a = p.active, d = game.opp(p).active;
  const attack = game.attacksOf(a)[action.index], { fx } = attack;
  if (a.status.confused || a.effects.sandAttack || d.effects.destinyBond || d.effects.mirrorShell ||
      Object.keys(fx).some((key) => harmfulAttack.has(key))) return null;
  const draws = Math.max(fx.draw || 0, p.hand.length ? fx.discardHandDraw || 0 : 0);
  if (draws && p.deck.length <= draws + 1) return null;
  const damage = visibleHit(game, a, d, attack, false);
  const charge = fx.attachDiscardBench && p.bench.length && p.discard.some((c) => c.kind === 'energy' && !c.special &&
    (!fx.attachDiscardBench.type || c.energyType === fx.attachDiscardBench.type));
  const status = [].concat(fx.status || []).some((s) => !d.status[s]) && !game.effectsBlocked(d) &&
    !game.statusImmune(d) && !(game.modern && game.smBarrier(a, d));
  if (damage <= 0 && !charge && !status && !(draws && p.hand.length < 5) && !fx.callFamily && !fx.callFriend) return null;
  const score = attackScore(game, p, action.index);
  // Several cards attach one Energy without an explicit count in their effect data.
  return Number.isFinite(score) ? score : 25 + Math.min(d.hpLeft, damage) * 0.25 + (charge ? 6 : 0) +
    (damage >= d.hpLeft ? 33 : 0);
}

function delayPaidRetreat(game, p, action, canAttack) {
  if (action.kind !== 'retreat' || game.retreatCost(p, p.active) === 0) return false;
  const foe = game.opp(p), active = p.active, target = action.target;
  if (!target || !foe.active) return false;
  const damage = (mon) => game.turn === 1 ? 0 : readyDamage(game, mon, foe.active, mon.payTypes, { entering: mon !== active });
  const stay = damage(active), move = damage(target);
  if (move >= foe.active.hpLeft && stay < foe.active.hpLeft) return false;
  if (Math.min(move, foe.active.hpLeft) > Math.min(stay, foe.active.hpLeft) + 15) return false;
  const risk = (mon, hit) => replyThreat(game, foe, mon, {
    removed: hit >= foe.active.hpLeft ? foe.active : null,
    hp: mon.hpLeft - (mon.status.poisoned ? Number(mon.status.poisoned) * 10 : 0) - (mon.status.burned ? 20 : 0),
  });
  const stayingRisk = risk(active, stay), movingRisk = risk(target, move);
  if (stayingRisk - movingRisk >= 14 || (active.status.poisoned && active.hpLeft <= 10 * Number(active.status.poisoned)) ||
      (active.status.burned && active.hpLeft <= 20)) return false;
  if (active.status.asleep || active.status.paralyzed || active.status.confused) return false;
  return canAttack || move === 0;
}

function openingSetup(game, p, actions, prizes) {
  if (game.turn > 5 || p.bench.length || p.deck.length < 8) return [];
  const { list } = deckCatalog(p);
  const unseen = unseenCardCounts(game, p, list);
  const basics = list.reduce((n, [c]) => n + (c.kind === 'pokemon' && c.stage === 0
    ? Math.max(0, (unseen.get(c.id) || 0) - (prizes?.get(c.id) || 0)) : 0), 0);
  return actions.filter((a) => a.kind === 'bench' ||
    (a.kind === 'trainer' && setupTrainers.has(a.tkind)) ||
    (a.kind === 'power' && setupPowers.has(a.pkind)) ||
    (a.kind === 'stadium' && a.stadium === 'artazon') ||
    (a.kind === 'trainer' && basics * (redrawProfile(game, p, a)?.draw || 0) >= (p.deck.length + p.prizes.length) * 0.25));
}

function bestUsefulAttack(game, p, actions) {
  return actions.map((action) => ({ action, value: usefulAttack(game, p, action) }))
    .filter(({ value }) => value !== null).sort((a, b) => b.value - a.value)[0];
}

// V3 extends the frozen V2 policy. Version-specific overrides live here.
export class GaryV3Policy extends HardPolicy {
  actionCandidates(game, p, actions) {
    const tools = new Map(actions.filter(isPersistentTool).map((action) => [action,
      isChoiceBelt(action) ? choiceBeltValue(game, p, action) : persistentToolValue(game, p, action)]));
    const bestTools = new Map();
    for (const [action, value] of tools) bestTools.set(action.card, Math.max(bestTools.get(action.card) ?? 0, value));
    const potions = new Map(actions.filter(isPotion).map((action) => [action, potionSurvival(game, p, action)]));
    const savingPotions = new Set(actions.filter((action) => potions.get(action) > 0).map((action) => action.tkind));
    const removals = new Map(actions.filter(removesEnergy).map((action) => [action, energyDisruptionValue(game, p, action)]));
    const bestRemovals = new Map();
    for (const [action, value] of removals) bestRemovals.set(action.tkind, Math.max(bestRemovals.get(action.tkind) ?? 0, value));
    const available = actions.filter((action) => {
      if (this.strategy?.opponentChooses && ['escapeRope', 'warpPoint', 'ryme'].includes(action.tkind)) {
        const move = movementFor(game, p, action, undefined, true);
        if (move && move.gain + (action.tkind === 'ryme' && p.deck.length > 3 ? 22 : 0) <= 0) return false;
      }
      if (unsafeStadiumAction(game, p, action)) return false;
      if (defensiveTrainerValue(game, p, action) === 0) return false;
      if (opponentTrainerValue(game, p, action, this.prizes.get(game)) === 0) return false;
      if (action.tkind === 'hisuianHeavyBall') return heavyBallValue(game, p, this.prizes.get(game)) > 0;
      if (action.tkind === 'superRod') return shortDeck(game, p) || superRodTargets(game, p, this.prizes.get(game)).size > 0;
      if (tools.has(action)) return tools.get(action) > 0 && tools.get(action) === bestTools.get(action.card);
      if (removesTools(action)) return toolRemovalValue(game, p, action) > 0;
      if (action.tkind === 'potion30' && game.healLocked(action.target)) return false;
      if (potions.get(action) < 0) return false;
      if (savingPotions.has(action.tkind)) return action.target === p.active;
      if (removals.has(action)) return removals.get(action) > 0 && removals.get(action) === bestRemovals.get(action.tkind);
      const kind = boostKind(action);
      if (attackBoosts.has(kind)) {
        if (kind === 'professorKukui' && p.deck.length > 1) return true;
        if (kind === 'leon' && hasDiscardPayoff(game, p, action.card.name)) return true;
        // Charge or switch first, then evaluate the boost with the resulting attacker.
        return boostTimingWithCopies(game, p, kind, action) > 0;
      }
      if (isTechnicalMachine(action)) return machineValue(game, p, action, this.prizes.get(game)) > 0;
      if (kind === 'blaine') return blaineValue(game, p, actions) > 0;
      if (kind === 'giovanni') return game.turn <= 2 || action.target.playedTurn >= game.turn;
      return true;
    });
    return available.length ? available : actions;
  }

  actionValue(game, p, action, base, actions) {
    if (this.strategy?.confirmedSearch) {
      const search = paidSearchValue(game, p, action, () => this.plan(game, p), this.prizes.get(game));
      if (search !== null) return search;
    }
    if (removesTools(action)) return Math.min(125, 26 + toolRemovalValue(game, p, action));
    if (isPersistentTool(action) && !isChoiceBelt(action)) return Math.min(120, 12 + persistentToolValue(game, p, action));
    if (action.tkind === 'ryme' && this.strategy?.opponentChooses) {
      if (p.deck.length <= 3) return 1;
      const move = movementFor(game, p, action, undefined, true);
      if (move) return Math.max(1, (p.hand.length <= 4 ? 55 : 30) + move.gain);
      return Math.max(base, p.hand.length <= 4 ? 54 : 20);
    }
    if (removesEnergy(action)) return Math.min(95, 38 + energyDisruptionValue(game, p, action));
    const defense = defensiveTrainerValue(game, p, action);
    if (defense !== null) return defense;
    const disruption = opponentTrainerValue(game, p, action, this.prizes.get(game));
    if (disruption !== null) return disruption;
    if (action.tkind === 'hisuianHeavyBall') return heavyBallValue(game, p, this.prizes.get(game));
    if (action.tkind === 'superRod') return shortDeck(game, p) ? 96 : 76;
    if (isChoiceBelt(action) && choiceBeltValue(game, p, action) === Infinity) return Math.max(base, 125);
    if (isPotion(action) && potionSurvival(game, p, action) > 0) return Math.max(base, 75);
    const kind = boostKind(action);
    if (attackBoosts.has(kind)) {
      const timing = boostTimingWithCopies(game, p, kind, action);
      const boostScore = timing === 2 ? 86 : timing === 1 ? 55 : 1;
      if (kind === 'professorKukui') {
        const draw = p.deck.length <= 2 || p.deck.length <= 10 && p.hand.length > 3 ? 1 : p.hand.length <= 3 ? 45 : 12;
        return Math.max(draw, boostScore);
      }
      if (kind === 'leon' && !timing) return hasDiscardPayoff(game, p, action.card.name) ? 5 : 1;
      return boostScore;
    }
    if (isTechnicalMachine(action)) return 23 + machineValue(game, p, action, this.prizes.get(game));
    if (kind === 'blaine') return blaineValue(game, p, actions);
    if (kind === 'giovanni') return 84;
    if (action.kind === 'attack') {
      const attack = game.attacksOf(p.active)[action.index];
      if (attack.tm) return base + machineAttackValue(game, p, attack, this.prizes.get(game));
    }
    return base;
  }

  rankPrompt(game, p, prompt, action, plan, setupRoutes) {
    const promotion = rankScoopPromotion(game, p, prompt, action);
    if (promotion) return promotion;
    const recovery = rankRecovery(game, p, prompt, action, plan, this.prizes.get(game), this.answers.get(game)?.rodPlay);
    if (recovery) return recovery;
    const selection = rankSelection(game, p, prompt, action, plan, this.answers.get(game)?.ordering);
    if (selection) return selection;
    const removal = rankEnergyDisruption(game, p, prompt, action);
    if (removal) return removal;
    const tools = rankToolRemoval(game, p, prompt, action);
    if (tools) return tools;
    return super.rankPrompt(game, p, prompt, action, plan, setupRoutes);
  }

  play(game, p, action, step, reason, searched, setupRoutes) {
    const result = super.play(game, p, action, step, reason, searched, setupRoutes);
    if (action.tkind === 'superRod') this.answers.get(game).rodPlay = { fillDeck: shortDeck(game, p), cards: [] };
    return result;
  }

  choose(game, p, prompt) {
    const answer = super.choose(game, p, prompt);
    const current = this.answers.get(game);
    if (current?.seat !== p.idx || current.turn !== game.turn) return answer;
    const card = prompt.options.find((option) => option.id === answer)?.card;
    if (current.rodPlay && prompt.text === 'prompt.q.toDeck') {
      if (card) current.rodPlay.cards.push(card);
    } else if (prompt.text === 'prompt.q.pokedexK' || (prompt.text === 'prompt.q.searchAny' && current.action?.tkind === 'ciphermaniac')) {
      current.ordering ??= { count: 0, cards: [] };
      if (card) current.ordering.cards.push(card);
    }
    return answer;
  }

  tacticalTrainer(action) {
    return super.tacticalTrainer(action) || tacticalTrainers.has(action.tkind) || removesTools(action);
  }

  async chooseAction(game, p, actions, priorSearchTime = 0) {
    const result = await super.chooseAction(game, p, actions, priorSearchTime);
    if (result.reason === 'lethal' || result.reason === 'setup-knockout' || actions.length < 2 || !p.active || !game.opp(p).active) return result;

    const foe = game.opp(p);
    const picked = result.action;
    if ((picked.kind === 'attack' || picked.kind === 'end') && result.reason !== 'chance-finish' &&
        p.active.tools.some(({ card }) => card.tool?.startsWith('tm'))) {
      const attacks = game.attacksOf(p.active);
      const score = (action) => action.kind === 'attack'
        ? this.actionValue(game, p, action, attackScore(game, p, action.index), actions) : 3;
      const machine = actions.filter((a) => a.kind === 'attack' && attacks[a.index].tm)
        .sort((a, b) => score(b) - score(a))[0];
      if (machine && machineAttackValue(game, p, attacks[machine.index], this.prizes.get(game)) > 0 && score(machine) > score(picked)) {
        return this.play(game, p, machine, null, 'technical-machine');
      }
    }
    const draw = shortDraws.get(picked.pkind ?? picked.tkind);
    if (draw && p.deck.length > 0 && p.deck.length <= draw && foe.deck.length > 1 &&
        readyDamage(game, p.active, foe.active) >= foe.active.hpLeft) {
      const attacks = actions.filter((action) => action.kind === 'attack' &&
        visibleHit(game, p.active, foe.active, game.attacksOf(p.active)[action.index], false) >= foe.active.hpLeft);
      const attack = bestUsefulAttack(game, p, attacks);
      if (attack) return this.play(game, p, attack.action, null, 'conserve-deck');
    }
    if (result.action.kind === 'end' && foe.deck.length > 0) {
      const poison = Number(foe.active.status.poisoned || 0) * 10;
      const burn = foe.active.status.burned ? 20 : 0;
      if (poison + burn >= foe.active.hpLeft) return result;
      const attack = bestUsefulAttack(game, p, actions);
      if (attack) return this.play(game, p, attack.action, null, 'productive-attack');
      const setup = openingSetup(game, p, actions, this.prizes.get(game));
      if (setup.length) {
        const next = await super.chooseAction(game, p, setup);
        return next.reason === 'lethal' ? next : { ...next, reason: 'opening-setup' };
      }
    }

    if (result.action.kind === 'retreat') {
      const canAttack = actions.some((action) => usefulAttack(game, p, action) !== null);
      if (!delayPaidRetreat(game, p, result.action, canAttack)) return result;
      const available = actions.filter((action) => !delayPaidRetreat(game, p, action, canAttack));
      if (available.length) {
        const replacement = await super.chooseAction(game, p, available);
        if (replacement.reason === 'lethal') return replacement;
        if (replacement.action.kind === 'end') {
          const attack = bestUsefulAttack(game, p, available);
          if (attack) return this.play(game, p, attack.action, null, 'delay-retreat');
        }
        return { ...replacement, reason: 'delay-retreat' };
      }
    }
    return result;
  }
}
