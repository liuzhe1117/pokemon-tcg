import { attackPrizes, readyDamage, replyThreat, withAttachedEnergy } from './ai-combat.js';
import { checkupDamage } from './ai-v3-targets.js';

const replyDamage = (game, attacker, target) => readyDamage(game, attacker, target, undefined, { turn: game.turn + 1, certain: true });
const attackDamage = (game, attacker, target) => game.turn === 1 ? 0 : readyDamage(game, attacker, target, undefined, { certain: true });
const hpAfterCheckup = (mon) => mon.hpLeft - checkupDamage(mon);
const attachmentsCost = (mon) => mon.energyTypes.length * 7 + mon.tools.length * 7;

function defenderValue(game, p, { target, card }) {
  const foe = game.opp(p);
  if (target !== p.active) return 0;
  const { game: guarded, mon } = withAttachedEnergy(game, target, target.energy, p);
  mon.tools = [...mon.tools, { card, expires: game.turn + 1 }];
  const removed = attackDamage(game, target, foe.active) >= foe.active.hpLeft ? foe.active : null;
  const hp = hpAfterCheckup(target);
  if (hp <= 0) return 0;
  const before = !removed ? replyDamage(game, foe.active, target) + checkupDamage(target) : 0;
  if (before >= hp) return replyDamage(guarded, foe.active, mon) + checkupDamage(target) < hp ? 80 : 0;
  const options = { removed, hp, includeSetup: false };
  const relief = replyThreat(game, foe, target, options) - replyThreat(guarded, foe, mon, options);
  return relief >= 5 ? 25 + relief : 0;
}

function pokemonCenterValue(game, p) {
  const foe = game.opp(p);
  let position = game, owner = p;
  let healed = 0, cost = 0;
  for (const target of game.allMons(p)) {
    if (!target.damage) continue;
    const projection = withAttachedEnergy(position, target, [], owner);
    position = projection.game;
    owner = projection.owner;
    projection.mon.damage = 0;
    healed += target.damage;
    cost += target.energyTypes.length * 7;
    const turn = game.turn + 2;
    cost += Math.max(0, readyDamage(game, target, foe.active, undefined, { turn }) -
      readyDamage(position, projection.mon, foe.active, undefined, { turn })) * 0.4;
  }
  const before = attackDamage(game, p.active, foe.active), after = attackDamage(position, owner.active, foe.active);
  if (before >= foe.active.hpLeft && after < foe.active.hpLeft) return 0;
  const saves = before < foe.active.hpLeft && replyDamage(game, foe.active, p.active) + checkupDamage(p.active) >= hpAfterCheckup(p.active) &&
    replyDamage(position, foe.active, owner.active) + checkupDamage(owner.active) < hpAfterCheckup(owner.active);
  const gain = healed * 0.45 - cost - Math.max(0, before - after) * 0.7 + (saves ? 65 : 0);
  return gain >= 12 ? 30 + gain : 0;
}

function scoopPromotionValue(game, p, target, next) {
  const foe = game.opp(p);
  const before = attackDamage(game, target, foe.active);
  const position = Object.create(game);
  const side = { ...p, active: next, bench: p.bench.filter((mon) => mon !== next) };
  position.players = game.players.map((player) => player === p ? side : player);
  position.current = side;
  const hit = game.turn === 1 ? 0 : readyDamage(position, next, foe.active, undefined, { entering: true, certain: true });
  const knockout = hit >= foe.active.hpLeft;
  if (knockout && (!foe.bench.length || attackPrizes(position, foe, foe.active, next) >= p.prizes.length)) return 170;
  if (before >= foe.active.hpLeft) return 0;

  const oldHP = hpAfterCheckup(target), nextHP = hpAfterCheckup(next);
  const saves = oldHP <= replyDamage(game, foe.active, target) &&
    (knockout || nextHP > replyDamage(position, foe.active, next));
  const risk = replyThreat(game, foe, target, { includeSetup: false, hp: oldHP });
  const nextRisk = nextHP <= 0 ? 60 : replyThreat(position, foe, next, {
    includeSetup: false, hp: nextHP, removed: knockout ? foe.active : null,
  });
  const relief = risk - nextRisk;
  const gain = (saves ? 58 : 0) + (knockout ? 45 : 0) + (Math.min(hit, foe.active.hpLeft) - before) * 0.65 +
    relief * 0.45 - attachmentsCost(target) - 10;
  return gain >= 15 ? 26 + gain : 0;
}

function scoopUpNetValue(game, p, { target }) {
  if (target !== p.active) {
    const basic = target.stack[0];
    // A Basic with Luminous Sign can search again when replayed from hand.
    if (!target.energy.length && !target.tools.length && basic.powerKind === 'luminousSign' &&
        !p.flags.supporter && p.deck.length > 1 && game.powerOn(target)) return 31;
    if (!target.energy.length && !target.tools.length && basic.powerKind === 'headbuttTantrum' &&
        game.allMons(game.opp(p)).some((mon) => mon.hpLeft <= 10 && !game.abilityImmune(mon)) && game.powerOn(target)) return 76;
    return 0;
  }
  return Math.max(0, ...p.bench.map((next) => scoopPromotionValue(game, p, target, next)));
}

export function rankScoopPromotion(game, p, prompt, action) {
  if (action?.tkind !== 'scoopUpNet' || prompt.text !== 'prompt.promote.text' || p.active) return null;
  const before = Object.create(game);
  const owner = { ...p, active: action.target };
  before.players = game.players.map((side) => side === p ? owner : side);
  before.current = owner;
  return prompt.options.map((option) => [option, scoopPromotionValue(before, owner, action.target, option.mon)])
    .sort((a, b) => b[1] - a[1]).map(([option]) => option);
}

export function defensiveTrainerValue(game, p, action) {
  if (!['defender', 'pokemonCenter', 'scoopUpNet'].includes(action.tkind)) return null;
  const foe = game.opp(p);
  if (!p.active || !foe.active || !foe.deck.length) return 0;
  if (action.tkind === 'defender') return defenderValue(game, p, action);
  if (action.tkind === 'pokemonCenter') return pokemonCenterValue(game, p);
  return scoopUpNetValue(game, p, action);
}
