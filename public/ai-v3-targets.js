import { readyDamage, responseRisk, withAttachedEnergy } from './ai-combat.js';
import { switchedPosition } from './ai-position.js';

export const isChoiceBelt = (action) => action.tkind === 'tool' && action.card.tool === 'choiceBelt';
export const isPotion = (action) => action.tkind === 'potion' || action.tkind === 'potion30';

export function checkupDamage(mon) {
  return 10 * Number(mon?.status.poisoned || 0) + (mon?.status.burned ? 20 : 0);
}

function expireEffects(mon, turn) {
  mon.tools = mon.tools.filter(({ expires }) => expires >= turn);
  mon.effects = Object.fromEntries(Object.entries(mon.effects)
    .filter(([, effect]) => effect.expires == null || effect.expires >= turn));
}

export function choiceBeltValue(game, p, { target, card }) {
  const foe = game.opp(p);
  if (!foe.active) return 0;
  const gainsFromAnyTool = game.attacksOf(target).some(({ fx }) => fx.bonusIfTool);
  let value = 0;
  for (const defender of game.allMons(foe)) {
    if (!gainsFromAnyTool && !defender.card.tags?.some((tag) => ['V', 'VMAX', 'VSTAR'].includes(tag))) continue;
    const position = switchedPosition(game, p, target, defender);
    const attacker = position.players[p.idx];
    const { game: belted, mon } = withAttachedEnergy(position, target, target.energy, attacker);
    mon.tools = [...mon.tools, { card, expires: Infinity }];
    const options = { turn: game.turn === 1 ? 3 : game.turn, entering: target !== p.active, certain: true };
    const before = readyDamage(position, target, defender, undefined, options);
    const after = readyDamage(belted, mon, defender, undefined, options);
    if (before >= defender.hpLeft) continue;
    if (after <= before) {
      const risk = { turn: options.turn, includeSetup: false };
      if (responseRisk(belted, mon, defender, risk) > responseRisk(position, target, defender, risk)) {
        value = Math.max(value, 1);
      }
      continue;
    }
    const attackNow = game.turn !== 1 && defender === foe.active && target === p.active;
    if (attackNow && after >= defender.hpLeft) return Infinity;
    const knockout = after >= defender.hpLeft ? 100 : 0;
    const immediate = attackNow ? 30 : defender === foe.active ? 20 : 0;
    value = Math.max(value, knockout + immediate + 50 * Math.min(1, after / defender.hpLeft));
  }
  return value;
}

export function potionSurvival(game, p, action) {
  const active = p.active, foe = game.opp(p), attacker = foe.active;
  if (!active || action.target !== active || !attacker ||
      (game.modern && game.healLocked(active))) return 0;
  const heal = Math.min(active.damage, action.tkind === 'potion30' ? 30 : 20);
  if (!heal || (game.turn !== 1 && readyDamage(game, active, attacker, undefined, { certain: true }) >= attacker.hpLeft)) return 0;

  const checkup = checkupDamage(active);
  if (!foe.deck.length) return active.hpLeft <= checkup && active.hpLeft + heal > checkup ? 1 : 0;
  const { game: reply, mon: unhealed, owner } = withAttachedEnergy(game, active, active.energy, p);
  reply.turn = game.turn + 1;
  unhealed.damage += checkup;
  const { game: counterattack, mon: replying } = withAttachedEnergy(reply, attacker, attacker.energy, foe);
  expireEffects(unhealed, reply.turn);
  expireEffects(replying, reply.turn);
  const { game: after, mon: healed } = withAttachedEnergy(counterattack, unhealed, unhealed.energy, owner);
  healed.damage -= heal;
  const options = { certain: true };
  const replyBefore = readyDamage(counterattack, replying, unhealed, undefined, options);
  const replyAfter = readyDamage(after, replying, healed, undefined, options);
  if (replyBefore + checkup < unhealed.hpLeft) return 0;
  if (replyAfter + checkup < healed.hpLeft) return 1;
  return checkup && replyAfter < healed.hpLeft ? -1 : 0;
}

export function lostEnergyValue(game, side, target, cards, turn, contestActive = false) {
  const enemy = game.opp(side);
  if (!enemy.active || !cards.length) return 0;
  const position = switchedPosition(game, side, target, enemy.active);
  const holder = position.players[side.idx];
  const { game: reduced, mon, owner } = withAttachedEnergy(position, target, target.energy.filter((en) => !cards.includes(en)), holder);
  const options = { turn, entering: target !== side.active, certain: true };
  const before = readyDamage(position, target, enemy.active, undefined, options);
  const after = readyDamage(reduced, mon, enemy.active, undefined, options);
  const usable = (board, side, attacker) => board.attacksOf(attacker).some((attack) =>
    board.canUseAttack(side, attacker, enemy.active, attack, { turn }) && board.hasAttackBench(side, attack.fx));
  const cutsAttack = usable(position, holder, target) && !usable(reduced, owner, mon);
  const stopsKnockout = before >= enemy.active.hpLeft && after < enemy.active.hpLeft;
  const retreat = target === side.active && side.bench.length && !target.status.asleep && !target.status.paralyzed &&
    !(target.effects.noRetreat?.expires >= turn) && target.energyTypes.length >= game.retreatCost(side, target) &&
    mon.energyTypes.length < reduced.retreatCost(owner, mon);
  const effect = Math.max(0, before - after) + (cutsAttack ? 25 : 0) + (stopsKnockout ? 60 : 0) + (retreat ? 18 : 0);
  if (target === side.active) return effect;
  const active = side.active;
  const canRetreat = active && !active.status.paralyzed && !active.status.asleep &&
    !(active.effects.noRetreat?.expires >= turn) && active.energyTypes.length >= game.retreatCost(side, active);
  const direct = active ? readyDamage(game, active, enemy.active, undefined, { turn, certain: true }) : 0;
  // An inaccessible reserve can matter later, but it cannot stop this turn's attack.
  if (!active || active.hpLeft <= checkupDamage(active)) return effect;
  if (direct >= enemy.active.hpLeft) return effect * 0.20;
  // A healthy backup can outlast the current threat. A fragile one is a lower
  // priority when the Active already threatens damage plus an attack denial.
  if (contestActive && direct > 0 && target.hpLeft <= 20 && canRetreat && game.attacksOf(active).some((atk) =>
    (atk.fx.status || atk.fx.flipStatus || atk.fx.noAttack || atk.fx.flipNoAttack) &&
    readyDamage(game, active, enemy.active, undefined, { turn, certain: true, attacks: [atk] }) > 0)) return effect * 0.40;
  return effect * (canRetreat ? 0.85 : 0.15);
}
