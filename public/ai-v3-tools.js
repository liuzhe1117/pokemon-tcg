import { attackPrizes, readyDamage, responseRisk, withAttachedEnergy } from './ai-combat.js';
import { supportValue } from './ai-plan.js';
import { nextAttachmentDamage, switchedPosition } from './ai-position.js';
import { checkupDamage } from './ai-v3-targets.js';

export const isPersistentTool = (action) => action.tkind === 'tool' && !action.card.tool?.startsWith('tm');
export const removesTools = (action) => ['fieldBlower', 'toolScrapper'].includes(action.tkind);

function damageValue(hit, hp) {
  return Math.min(hit, hp) * 0.30 + (hit >= hp ? 44 : 0);
}

function toolValue(game, side, mon, card) {
  const foe = game.opp(side), defender = foe.active;
  if (!defender) return 0;
  const position = switchedPosition(game, side, mon, defender);
  const owner = position.players[side.idx];
  const { game: equipped, mon: holder, owner: equippedSide } = withAttachedEnergy(position, mon, mon.energy, owner);
  holder.tools = [...mon.tools, { card, expires: Infinity }];
  if (equipped.statusImmune(holder)) holder.status = {};
  const turn = side.idx === game.current?.idx ? (game.turn === 1 ? 3 : game.turn) : game.turn + 1;
  const options = { turn, certain: true, entering: mon !== side.active };
  const attack = (board, player, pokemon) => Math.max(readyDamage(board, pokemon, defender, undefined, options),
    mon === side.active && !player.flags.energy && !board.hiddenHand?.has(player.idx) && side === game.current
      ? nextAttachmentDamage(board, player, pokemon, defender, turn) : 0);
  const before = attack(position, owner, mon), after = attack(equipped, equippedSide, holder);
  let value = damageValue(after, defender.hpLeft) - damageValue(before, defender.hpLeft);
  if (mon === side.active && game.turn !== 1 && before < defender.hpLeft && after >= defender.hpLeft) value += 70;
  if (!value) value = Math.max(0, responseRisk(equipped, holder, defender, { turn, includeSetup: false }) -
    responseRisk(position, mon, defender, { turn, includeSetup: false }));
  if (value > 0 && mon === side.active) value += 7;
  const hpGain = holder.hpLeft - mon.hpLeft;
  const incoming = readyDamage(position, defender, mon, undefined, { turn: turn + 1, certain: true });
  const guarded = readyDamage(equipped, defender, holder, undefined, { turn: turn + 1, certain: true });
  value += hpGain * (mon === side.active ? 0.25 : 0.12);
  if (incoming >= mon.hpLeft && guarded < holder.hpLeft) value += mon === side.active ? 44 : 18;
  if (guarded < incoming) value += (incoming - guarded) * (mon === side.active ? 0.28 : 0.12);
  const retreat = game.retreatCost(side, mon), lower = equipped.retreatCost(equippedSide, holder);
  const backup = Math.max(0, ...side.bench.filter((target) => target !== mon).map((target) =>
    readyDamage(game, target, defender, undefined, { turn, entering: true, certain: true })));
  if (lower < retreat) {
    const opensRetreat = retreat > mon.energyTypes.length && lower <= mon.energyTypes.length && backup > before;
    value += (retreat - lower) * (mon === side.active && backup > before ? 13 : 4) + (opensRetreat ? 12 : 0);
  }
  if (mon === side.active && backup > 0 && (mon.status.asleep || mon.status.paralyzed) && equipped.canRetreatStuck(holder)) value += 23;
  if (equipped.statusImmune(holder) && !game.statusImmune(mon)) {
    const condition = game.attacksOf(defender).some(({ fx }) =>
      fx.status || fx.flipStatus || fx.headsStatus || fx.tailsStatus || fx.flipStatusEither);
    if (condition) value += mon === side.active ? 12 : 4;
  }
  switch (card.tool) {
    case 'expShare': if (mon !== side.active && side.active?.energy.some((en) => !en.special)) {
      const inherited = Math.max(...side.active.energy.filter((en) => !en.special).map((energy) => {
        const charged = withAttachedEnergy(equipped, holder, [...holder.energy, energy], equippedSide);
        return attack(charged.game, charged.owner, charged.mon);
      }));
      value += Math.max(0, inherited - after) * 0.3;
    } break;
    case 'wishfulBaton': if (mon === side.active && side.bench.length && incoming >= mon.hpLeft) {
      value += 8 * Math.min(3, mon.energy.filter((en) => !en.special).length);
    } break;
    case 'forestSealStone': if (!side.vstarUsed && side.deck.length && mon.card.tags?.includes('V')) {
      value += 36 + (mon === side.active && incoming >= mon.hpLeft ? 0 : 6);
    } break;
    case 'leafyCamoPoncho': if (equipped.poncho(holder) && mon !== side.active) {
      const exposed = foe.prizes.length <= (mon.card.prizes || 1) && incoming >= mon.hpLeft;
      value += 6 + before * 0.08 + (exposed ? 23 : 0);
    } break;
    case 'punkHelmet': if (mon.card.type === 'Darkness' && mon === side.active && incoming > 0) value += 24; break;
  }
  return Math.max(0, value);
}

export function persistentToolValue(game, p, action) {
  if (!game.opp(p).deck.length) return 0;
  return toolValue(game, p, action.target, action.card);
}

function withoutTool(game, owner, mon, tool) {
  const projected = withAttachedEnergy(game, mon, mon.energy, owner);
  projected.mon.tools = mon.tools.filter((attached) => attached !== tool);
  return projected;
}

export function stadiumChangeValue(game, p, stadium) {
  if (!game.stadium && !stadium) return 0;
  const foe = game.opp(p);
  const view = Object.assign(Object.create(game), { stadium });
  view.players = game.players.map((side) => {
    const clone = (mon) => mon && Object.assign(Object.create(mon), { game: view });
    return { ...side, active: clone(side.active), bench: side.bench.map(clone) };
  });
  view.current = view.players[game.current?.idx];
  const impact = (side, enemy, projectedSide, projectedEnemy) => {
    let value = game.allMons(side).reduce((sum, mon, index) => {
      const after = view.allMons(projectedSide)[index];
      if (after.hpLeft <= 0 && mon.hpLeft > 0) return sum - 200;
      return sum + (after.hpLeft - mon.hpLeft) * 0.16 + (game.retreatCost(side, mon) - view.retreatCost(projectedSide, after)) *
        (mon === side.active ? 9 : 3) + supportValue(view, after) - supportValue(game, mon) +
        8 * (Number(view.powerOn(after)) - Number(game.powerOn(mon)));
    }, 0);
    if (projectedEnemy.active.hpLeft > 0 && projectedSide.active.hpLeft > 0) {
      const hit = readyDamage(game, side.active, enemy.active, undefined, { certain: true });
      const after = readyDamage(view, projectedSide.active, projectedEnemy.active, undefined, { certain: true });
      value += damageValue(after, projectedEnemy.active.hpLeft) - damageValue(hit, enemy.active.hpLeft);
    }
    if (game.stadiumIs('oldCemetery') !== view.stadiumIs('oldCemetery') && side.active.card.type !== 'Psychic' &&
        (side.idx !== game.current?.idx || !side.flags.energy)) {
      value += (side.active.hpLeft <= 20 ? 32 : 6) * (stadium?.card.stadium === 'oldCemetery' ? -1 : 1);
    }
    return value;
  };
  const ownLosses = game.allMons(p).filter((mon, i) => mon.hpLeft > 0 && view.allMons(view.players[p.idx])[i].hpLeft <= 0);
  const foeLosses = game.allMons(foe).filter((mon, i) => mon.hpLeft > 0 && view.allMons(view.players[foe.idx])[i].hpLeft <= 0);
  const loses = (side, losses) => losses.length === game.allMons(side).length ||
    losses.reduce((count, mon) => count + game.prizeValue(side, mon, { damage: false }), 0) >= game.opp(side).prizes.length;
  if (ownLosses.length && loses(p, ownLosses)) return -1000;
  if (foeLosses.length && loses(foe, foeLosses)) return 150;
  const replyEndsGame = (board, side) => {
    const opponent = board.opp(side);
    if (side.active.hpLeft <= 0 || opponent.active.hpLeft <= 0) return false;
    const takes = attackPrizes(board, side, side.active, opponent.active);
    if (side.bench.length && takes < opponent.prizes.length) return false;
    if (checkupDamage(side.active) >= side.active.hpLeft) return true;
    if (!opponent.deck.length || (board.turn > 1 &&
        readyDamage(board, side.active, opponent.active, undefined, { certain: true }) >= opponent.active.hpLeft)) return false;
    const hit = readyDamage(board, opponent.active, side.active, undefined, { certain: true, turn: board.turn + 1 });
    return hit + 2 * checkupDamage(side.active) >= side.active.hpLeft;
  };
  if (replyEndsGame(view, view.players[p.idx]) && !replyEndsGame(game, p)) return -150;
  return impact(p, foe, view.players[p.idx], view.players[foe.idx]) - impact(foe, p, view.players[foe.idx], view.players[p.idx]);
}

function removalValue(game, p, mon, tool) {
  const owner = game.ownerOf(mon);
  const { game: view, owner: projected, mon: stripped } = withoutTool(game, owner, mon, tool);
  const sign = owner === p ? -1 : 1;
  if (stripped.hpLeft <= 0) {
    if (owner === p) return -1000;
    return mon === owner.active ? 110 : 85;
  }
  if (tool.card.tool?.startsWith('tm')) {
    const enemy = game.opp(owner);
    const turn = owner === p ? game.turn : game.turn + 1;
    if (tool.expires < turn || mon !== owner.active) return 0;
    const before = readyDamage(game, mon, enemy.active, undefined, { certain: true, turn });
    const after = readyDamage(view, stripped, enemy.active, undefined, { certain: true, turn });
    return sign * Math.max(0, damageValue(before, enemy.active.hpLeft) - damageValue(after, enemy.active.hpLeft));
  }
  const value = toolValue(view, projected, stripped, tool.card);
  if (owner !== p && mon === owner.active && game.turn !== 1) {
    const hit = readyDamage(view, p.active, stripped, undefined, { certain: true });
    const before = readyDamage(game, p.active, mon, undefined, { certain: true });
    if (hit >= stripped.hpLeft && before < mon.hpLeft &&
        (!owner.bench.length || attackPrizes(view, projected, stripped, p.active) >= p.prizes.length)) return 125;
  }
  return sign * value;
}

export function toolRemovalValue(game, p, action) {
  if (!p.active || !game.opp(p).active || !game.opp(p).deck.length) return 0;
  const tools = game.players.flatMap((side) => game.allMons(side).flatMap((mon) =>
    mon.tools.map((tool) => removalValue(game, p, mon, tool))));
  return Math.max(0, ...tools, action.tkind === 'fieldBlower' ? stadiumChangeValue(game, p, null) : 0);
}

export function rankToolRemoval(game, p, prompt, action) {
  if (!action || !removesTools(action)) return null;
  let score;
  if (prompt.kind === 'blower' || prompt.text === 'prompt.q.toolScrapper') {
    score = (option) => {
      if (option.id === 'stadium') return stadiumChangeValue(game, p, null);
      if (!option.mon) return 0;
      return Math.max(...option.mon.tools.map((tool) => removalValue(game, p, option.mon, tool)));
    };
  } else if (prompt.text === 'prompt.q.discardWhichTool') {
    score = ({ card }) => {
      const mon = game.players.flatMap((side) => game.allMons(side)).find((holder) => holder.tools.some((tool) => tool.card === card));
      return removalValue(game, p, mon, mon.tools.find((tool) => tool.card === card));
    };
  }
  if (!score) return null;
  const values = prompt.options.map((option) => [option, score(option)]);
  const best = Math.max(...values.map(([, value]) => value));
  const stop = prompt.options.find((option) => option.id === 'none');
  return stop && best <= 0 ? [stop] : values.filter(([, value]) => value === best).map(([option]) => option);
}
