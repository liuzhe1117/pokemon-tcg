import { GaryV3Policy } from './ai-v3.js';
import { expectedAttackDamage, readyDamage, visibleHit, withAttachedEnergy } from './ai-combat.js';
import { energyMissing } from './ai-plan.js';
import { buildV3Strategy } from './ai-v3-strategy.js';
import { attackReserveBonus, gustTargetValue, movementFor, nextAttachmentDamage, switchedPosition } from './ai-position.js';
import { additiveDrawProfile, deckClockCost, emptiesDeck, setupImprovesDraw } from './ai-redraw.js';
import { deckRefill } from './ai-v3-safety.js';
import { searchPreparation } from './ai-v3-search-order.js';
import { checkupThreat, verifyTactics, visibleLosingReply } from './ai-v3-tactics.js';
import { plannedAnswer } from './ai-hard.js';

const ordersDeck = (action) => action.tkind === 'pokedex' || action.tkind === 'ciphermaniac';

function usefulRivalSupporter(game, p, action) {
  if (action.tkind !== 'bossOrders' || !p.active || !game.opp(p).active) return true;
  if (gustTargetValue(game, p, action.target) > 6) return true;
  if (game.turn === 1 || p.flags.energy) return false;
  const view = switchedPosition(game, p, p.active, action.target);
  const damage = nextAttachmentDamage(view, p, p.active, action.target, game.turn);
  return damage >= action.target.hpLeft;
}

function topDraw(game, p, action) {
  if (action.tkind === 'looker' || action.tkind === 'trekkingShoes' || action.pkind === 'attractCustomers') return null;
  const profile = additiveDrawProfile(game, p, action);
  return profile?.count >= 1 && p.deck.length > profile.max ? profile : null;
}

function drawAfterOrdering(game, p, order, preferred, actions) {
  const profile = (action) => order.tkind === 'ciphermaniac' && action.card?.ttype === 'supporter' ? null : topDraw(game, p, action);
  if (profile(preferred)) return preferred;
  return actions.map((action) => ({ action, count: profile(action)?.count ?? 0 }))
    .filter(({ count }) => count).sort((a, b) => b.count - a.count)[0]?.action;
}

function drawPriority(game, p, actions, before, race) {
  const candidates = actions.map((action) => ({ action, profile: additiveDrawProfile(game, p, action) }));
  const rivalSupporter = candidates.some(({ action, profile }) => action.card?.ttype === 'supporter' && !profile && usefulRivalSupporter(game, p, action));
  const alreadyDrawing = additiveDrawProfile(game, p, before ?? {});
  let choice = null, priority = 0;
  for (const { action, profile } of candidates) {
    if (!profile?.count || p.deck.length <= profile.max) continue;
    if (setupImprovesDraw(action, before, profile)) continue;
    const supporter = action.card?.ttype === 'supporter';
    // A useful rival Supporter can be worth keeping the once-per-turn play open.
    if (supporter && (rivalSupporter || p.hand.length > 6 || profile.count < 2 ||
        before?.card?.ttype === 'supporter' && !alreadyDrawing && usefulRivalSupporter(game, p, before))) continue;
    if (before?.tkind === 'professorKukui' && supporter && before !== action) continue;
    const benefit = profile.count * 9 - deckClockCost(game, p, { action }, race, profile);
    if (benefit <= 0) continue;
    const score = benefit + (supporter ? 0 : 100);
    if (score <= priority) continue;
    choice = action;
    priority = score;
  }
  return choice;
}

export function drawBeforeAttack(game, p, actions, attack) {
  const defender = game.opp(p).active;
  if (attack && visibleHit(game, p.active, defender, attack, false) >= defender.hpLeft) return null;
  return drawPriority(game, p, actions);
}

export function basicAttachment(action) {
  return action.kind === 'energy' && !action.card2 && !action.card.special;
}

function attackRoute(game, p, action, exactEnergy) {
  const mon = action.target, foe = game.opp(p).active;
  const active = mon === p.active;
  const energy = mon.payTypes;
  const type = mon.card.powerKind === 'energyBurn' && !mon.conditions().length && !mon.effects.noPower
    ? 'Fire' : action.card.energyType;
  const projected = exactEnergy ? withAttachedEnergy(game, mon, [...mon.energy, action.card], p) : null;
  const after = projected?.mon.payTypes ?? [...energy, type];
  const beforeHit = readyDamage(game, mon, foe, energy, { certain: exactEnergy });
  const nextHit = readyDamage(projected?.game ?? game, projected?.mon ?? mon, foe, after,
    { entering: !active, certain: exactEnergy });
  if (active && beforeHit < foe.hpLeft && nextHit >= foe.hpLeft) return { score: 100, attackGain: nextHit - beforeHit };

  const wouldFall = active && readyDamage(game, foe, mon, foe.payTypes, { turn: game.turn + 1 }) >= mon.hpLeft;
  let score = 0, attackGain = Math.max(0, nextHit - beforeHit);
  for (const attack of game.attacksOf(mon)) {
    const before = energyMissing(energy, attack.cost), gap = energyMissing(after, attack.cost);
    const actualTypes = projected?.mon.energyTypes ?? after;
    if (gap >= before || gap > 1 || (attack.fx.needsType && !actualTypes.includes(attack.fx.needsType))) continue;
    const damage = visibleHit(projected?.game ?? game, projected?.mon ?? mon, foe, attack, !active);
    const { fx } = attack;
    const effect = fx.status || fx.callFamily || fx.callFriend || fx.searchAttach || fx.attachDiscardBench ? 12 : 0;
    const power = Math.max(Math.min(damage, foe.hpLeft), attack.base * 0.5) + effect;
    const tempo = active && gap === 0 && game.turn > 1 ? Math.min(16, Math.max(0, damage - beforeHit) * 0.45) : 0;
    const value = power * (gap ? 0.38 : 0.65) + tempo - (wouldFall ? 14 : 0);
    score = Math.max(score, value);
  }
  return { score, attackGain };
}

export function betterAttachment(game, p, actions, chosen, exactEnergy = false, reserveEnergy = false) {
  if (game.turn > 11 || !basicAttachment(chosen)) return null;
  const alternatives = actions.filter((a) => basicAttachment(a) && a.card === chosen.card && a.target !== chosen.target);
  if (!alternatives.length) return null;
  const foe = game.opp(p).active;
  const base = attackRoute(game, p, chosen, exactEnergy);
  // A new two-hit or knockout line against the current defender can be worth charging the Active.
  if (chosen.target === p.active && base.attackGain > 0 && base.attackGain >= Math.min(40, foe.hpLeft / 2)) return null;
  let result = null, best = base.score + 14 + (reserveEnergy ? attackReserveBonus(game, p, chosen) : 0);
  for (const alternative of alternatives) {
    const { score: route } = attackRoute(game, p, alternative, exactEnergy);
    const score = route + (reserveEnergy ? attackReserveBonus(game, p, alternative) : 0);
    if (score <= best) continue;
    best = score;
    result = alternative;
  }
  return result;
}

function attachmentForSwitch(game, p, actions, chosen) {
  if (game.modern || game.turn === 1 || !basicAttachment(chosen) || chosen.target !== p.active || !p.bench.length) return null;
  // Confusion can KO a low-HP Active before its attack goes through.
  if (!p.active.status.confused || p.active.hpLeft > 30) return null;
  const moves = actions.filter((move) => move.kind === 'retreat' || ['switch', 'warpPoint'].includes(move.tkind));
  if (!moves.length) return null;
  const foe = game.opp(p);
  const { game: charged, owner } = withAttachedEnergy(game, p.active, [...p.active.energy, chosen.card], p);
  owner.hand = owner.hand.filter((held) => held !== chosen.card);
  const confusionCost = p.active.hpLeft * 0.5 + 15;
  const stay = expectedAttackDamage(charged, owner, foe.active) - confusionCost;
  let best = null, bestDamage = Math.max(8, stay + 8);
  const attachments = actions.filter((attach) => attach.target !== p.active && basicAttachment(attach));
  for (const move of moves) {
    const targets = move.target ? [move.target] : p.bench;
    const defenders = move.tkind === 'warpPoint' && foe.bench.length ? foe.bench : [foe.active];
    for (const target of targets) {
      const damage = (card) => Math.min(...defenders.map((defender) => {
        const view = switchedPosition(game, p, target, defender);
        if (!card) return expectedAttackDamage(view, view.players[p.idx], defender);
        const { game: position, owner } = withAttachedEnergy(view, target, [...target.energy, card]);
        owner.hand = owner.hand.filter((held) => held !== card);
        return expectedAttackDamage(position, owner, defender);
      }));
      const before = damage(null);
      for (const attach of attachments) {
        if (attach.target !== target) continue;
        const after = damage(attach.card);
        if (after < bestDamage || best && after === bestDamage || after <= before) continue;
        best = { attach, move, target };
        bestDamage = after;
      }
    }
  }
  return best;
}

function prizeBeforeExchange(game, p, actions) {
  if (!actions.some((action) => action.pkind === 'matterExchange')) return null;
  const foe = game.opp(p);
  if (game.turn === 1 || readyDamage(game, p.active, foe.active, undefined, { certain: true }) >= foe.active.hpLeft) return null;
  return actions.find((action) => {
    if (action.tkind !== 'switch') return false;
    const move = movementFor(game, p, action, () => 0, true);
    if (!move || move.gain <= 0) return false;
    const view = switchedPosition(game, p, action.target, foe.active);
    return readyDamage(view, action.target, foe.active, undefined, { certain: true }) >= foe.active.hpLeft;
  });
}

export const garyV3Profile = ['draw-before-attack', 'redirect-energy', 'energy-readiness', 'board-readiness', 'search-diversity',
  'tactical-confidence', 'resource-cost', 'attack-effects', 'reply-risk',
  'exact-energy', 'paid-prize-retreats', 'prize-active-lock', 'exact-prizes',
  'deck-clock', 'chance-finish',
  'retreat-payment', 'next-attachment',
  'necessary-retreat', 'setup-knockout', 'opponent-switch-choice', 'confirmed-search'];

export class GaryCurrentV3Policy extends GaryV3Policy {
  constructor(scoreCPU, pickCPU, limits) {
    super(scoreCPU, pickCPU, { ...limits, strategy: buildV3Strategy(garyV3Profile) });
    this.switchAfterAttachment = new WeakMap();
  }

  actionCandidates(game, p, actions) {
    const available = super.actionCandidates(game, p, actions);
    const safe = available.filter((action) => this.preservesDraw(game, p, action));
    return safe.length ? safe : available;
  }

  preservesDraw(game, p, action) {
    return !p.active || !game.opp(p).active || !game.opp(p).deck.length && !checkupThreat(game, p) ||
      !emptiesDeck(game, p, action);
  }

  async chooseAction(game, p, actions) {
    const pendingSwitch = this.switchAfterAttachment.get(game);
    this.switchAfterAttachment.delete(game);
    if (pendingSwitch?.seat === p.idx && pendingSwitch.turn === game.turn &&
        pendingSwitch.target.energy.includes(pendingSwitch.attach.card)) {
      const planned = pendingSwitch.move;
      const move = actions.find((a) => a.kind === planned.kind && a.card === planned.card && a.target === planned.target);
      if (move) {
        const answers = move.tkind === 'warpPoint'
          ? [plannedAnswer('promote', 'prompt.q.warpYou', { mon: pendingSwitch.target })] : [];
        return this.play(game, p, move, { answers }, 'switch-after-attachment');
      }
    }
    let verified;
    if (!this.lines.has(game)) {
      verified = await verifyTactics(this, game, p, actions);
      if (verified?.probability === 1) return this.playVerified(game, p, verified.steps);
    }
    const previous = this.answers.get(game);
    const ordering = previous?.seat === p.idx && previous.turn === game.turn && previous.ordering?.take &&
      previous.ordering.cards.length && p.discard.includes(previous.action.card) ? previous.ordering : null;
    const result = await super.chooseAction(game, p, actions, verified?.elapsed);
    if (result.reason === 'lethal' || !p.active || !game.opp(p).active) return result;
    actions = actions.filter((action) => this.preservesDraw(game, p, action));

    const refill = deckRefill(game, p, actions);
    if (refill?.kind === 'trainer' && refill !== result.action) {
      this.clearLine(game);
      return this.play(game, p, refill, null, 'avoid-deckout');
    }
    if (result.reason === 'setup-knockout') return result;
    const exchange = result.action.pkind === 'matterExchange' && prizeBeforeExchange(game, p, actions);
    if (exchange) {
      this.clearLine(game);
      return this.play(game, p, exchange, null, 'prize-before-exchange');
    }
    if (verified?.steps && ['attack', 'end'].includes(result.action.kind) && result.reason !== 'chance-finish') {
      const [step] = verified.steps;
      this.clearLine(game);
      return this.play(game, p, step.action, step, 'catcher-finish');
    }
    const action = result.action;
    // Jubilife Village ends the turn, so first consider the available win lines.
    if (refill?.kind === 'stadium' && result.reason !== 'chance-finish' && (action.kind === 'attack' || action.kind === 'end')) {
      this.clearLine(game);
      return this.play(game, p, refill, null, 'avoid-deckout');
    }
    const change = attachmentForSwitch(game, p, actions, action);
    if (change) {
      this.clearLine(game);
      this.switchAfterAttachment.set(game, { ...change, turn: game.turn, seat: p.idx });
      return this.play(game, p, change.attach, null, 'attach-before-switch');
    }
    if (result.reason !== 'chance-finish') {
      const foe = game.opp(p), attack = action.kind === 'attack' && game.attacksOf(p.active)[action.index];
      const knockOut = attack && visibleHit(game, p.active, foe.active, attack, false) >= foe.active.hpLeft;
      // Selective draws can assemble a hand-paid attack. Their options are only
      // evaluated once the game reveals them, just like other draw effects.
      const handCost = (attack || action.kind === 'end') && game.attacksOf(p.active).some((atk) =>
        (atk.fx.discardHandOrFail || atk.fx.discardHandTypeTimes) && game.canUseAttack(p, p.active, foe.active, atk));
      const selectiveDraw = handCost && !knockOut && visibleLosingReply(game, p) &&
        actions.find((a) => a.tkind === 'rika' || a.tkind === 'explorersGuidance');
      if (selectiveDraw) return this.play(game, p, selectiveDraw, null, 'draw-before-commitment');
      const preparedDraw = ordering && actions.find((candidate) => candidate.kind === ordering.take.kind &&
        candidate.card === ordering.take.card && candidate.pkind === ordering.take.pkind && candidate.target === ordering.take.target);
      if (preparedDraw && !knockOut && foe.deck.length && topDraw(game, p, preparedDraw)) {
        this.clearLine(game);
        return this.play(game, p, preparedDraw, null, 'draw-arranged-cards');
      }
      const draw = result.reason !== 'planned-draw' && !knockOut && foe.deck.length &&
        drawPriority(game, p, actions, action, this.races.get(game)?.race);
      const take = draw || action;
      const search = !knockOut && foe.deck.length && searchPreparation(game, p, actions, take, () => this.plan(game, p));
      if (search) {
        if (search === action) return result;
        this.clearLine(game);
        return this.play(game, p, search, null, 'search-before-commitment');
      }
      const order = !ordering && !knockOut && foe.deck.length && (ordersDeck(action) ? action :
        topDraw(game, p, take) && actions.find((candidate) => candidate.tkind === 'pokedex' ||
          candidate.tkind === 'ciphermaniac' && take.card?.ttype !== 'supporter' &&
          !actions.some((rival) => rival !== candidate && rival.card?.ttype === 'supporter' && usefulRivalSupporter(game, p, rival))));
      const follow = order && drawAfterOrdering(game, p, order, take, actions);
      if (follow) {
        this.clearLine(game);
        const preparation = this.play(game, p, order, null, 'arrange-before-draw');
        this.answers.get(game).ordering = { count: Math.floor(topDraw(game, p, follow).count), cards: [], take: follow };
        return preparation;
      }
      if (draw && draw !== action) return this.play(game, p, draw, null, 'draw-before-commitment');
    }
    const attachment = garyV3Profile.includes('redirect-energy') && !this.strategy?.jointAttachment &&
      betterAttachment(game, p, actions, action, this.strategy?.exactEnergy, this.strategy?.reserveEnergy);
    return attachment ? this.play(game, p, attachment, null, 'redirect-energy') : result;
  }
}
