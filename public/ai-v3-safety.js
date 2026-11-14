import { readyDamage, withAttachedEnergy } from './ai-combat.js';
import { redrawProfile } from './ai-redraw.js';
import { stadiumChangeValue } from './ai-v3-tools.js';

const basicEnergy = (card) => card.kind === 'energy' && !card.special;

export function deckRefill(game, p, actions) {
  if (p.deck.length || !game.opp(p).deck.length) return null;
  const restores = (action) => {
    if (action.kind === 'stadium') return action.stadium === 'jubilifeVillage' ? Math.max(0, p.hand.length - 5) : 0;
    if (action.kind !== 'trainer') return 0;
    switch (action.tkind) {
      case 'energyRecycler': return Math.min(5, p.discard.filter(basicEnergy).length);
      case 'superRod': return Math.min(3, p.discard.filter((card) => basicEnergy(card) || card.kind === 'pokemon').length);
      case 'ordinaryRod': return Math.min(2, p.discard.filter(basicEnergy).length) + Math.min(2, p.discard.filter((card) => card.kind === 'pokemon').length);
      case 'brocksGrit': return Math.min(6, p.discard.filter((card) => basicEnergy(card) || card.kind === 'pokemon').length);
      case 'palPad': return Math.min(2, p.discard.filter((card) => card.ttype === 'supporter').length);
      case 'urnOfVitality': return Math.min(2, p.discard.filter((card) => card.special === 'singleStrike').length);
      case 'tateLiza': return 0; // Its prompt may pick the switch mode instead.
      default: return redrawProfile(game, p, action)?.deckAfter ?? 0;
    }
  };
  let best = null, cards = 0;
  for (const action of actions) {
    const count = restores(action);
    if (count > cards) {
      best = action;
      cards = count;
    }
  }
  return best;
}

export function unsafeStadiumAction(game, p, action) {
  if (action.kind === 'stadium' && action.stadium === 'saffron' && action.target && action.target === p.active && p.flags.energy) {
    const active = p.active, defender = game.opp(p).active;
    const paid = active.energy.findIndex((card) => !card.special);
    if (paid < 0 || game.turn === 1 || !defender) return false;
    const { game: view, mon } = withAttachedEnergy(game, active, active.energy.filter((_, index) => index !== paid), p);
    return readyDamage(view, mon, defender, undefined, { certain: true }) < readyDamage(game, active, defender, undefined, { certain: true });
  }
  if (action.kind !== 'trainer' || action.tkind !== 'stadium') return false;
  const stadium = action.card.stadium;
  const foe = game.opp(p);
  const replacement = { card: action.card, owner: p.idx };
  if (stadium === 'gravityMountain') {
    const view = Object.assign(Object.create(game), { stadium: replacement });
    const own = game.allMons(p), opposing = game.allMons(foe);
    const knockouts = (mons) => mons.filter((mon) => mon.hpLeft && !Object.assign(Object.create(mon), { game: view }).hpLeft);
    const ownKOs = knockouts(own);
    if (!ownKOs.length) return !!game.stadium && stadiumChangeValue(game, p, replacement) <= -12;
    const opposingKOs = knockouts(opposing);
    const prizes = (side, mons) => mons.reduce((total, mon) => total + game.prizeValue(side, mon, { damage: false }), 0);
    const lose = ownKOs.length === own.length || prizes(p, ownKOs) >= foe.prizes.length;
    const win = opposingKOs.length === opposing.length || prizes(foe, opposingKOs) >= p.prizes.length;
    return lose || !win;
  }
  if (game.stadium) return stadiumChangeValue(game, p, replacement) <= -12;
  if (stadium === 'oldCemetery') return p.active?.card.type !== 'Psychic' && p.active?.hpLeft <= 20 &&
    game.allMons(foe).every((mon) => mon.card.type === 'Psychic');
  if (stadium === 'pathToThePeak') {
    const suppressed = (side) => game.allMons(side).some((mon) => mon.card.ruleBox && game.powerOn(mon));
    return suppressed(p) && !suppressed(foe);
  }
  if (stadium === 'beachCourt') {
    const benefits = (side) => game.allMons(side).some((mon) => mon.card.stage === 0 && game.retreatCost(side, mon) > 0);
    return !benefits(p) && benefits(foe);
  }
  return false;
}
