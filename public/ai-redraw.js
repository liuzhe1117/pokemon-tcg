// Assess a hand replacement before spending the card or the turn's Supporter.
import { handEvaluator } from './ai-discard.js';
import { deckCatalog, supportValue, unseenCardCounts } from './ai-plan.js';
import { readyDamage, visibleHit } from './ai-combat.js';

const fixedDraws = { cynthia: 6, youngster: 5, judge: 4, shauna: 5, marnie: 5, roxanne: 6, trArcher: 5, unfairStamp: 5, tateLiza: 5 };
const opponentDraws = { judge: 4, marnie: 4, roxanne: 2, trArcher: 3, unfairStamp: 2 };
const immediateDraws = { bill: 2, hop: 3, hau: 3, nemona: 3, barry: 3, dan: 3, bugCatcher: 3 };
const additiveTrainerDraws = {
  ...immediateDraws, kahili: 2, looker: 3, professorKukui: 2, rika: 2, roark: 2, trekkingShoes: 1,
};
const additivePowerDraws = { flipTheScript: 3, slushRush: 1, reconDirective: 1, shiningArcana: 2, attractCustomers: 0.5 };
const fusionStrike = (card) => card.tags?.includes('Fusion Strike');
const teamRocket = (card) => card.name.startsWith("Team Rocket's");

// Cards taken without paying with another card, switching Pokémon, or replacing a hand.
// Deck use can exceed the hand gain on a coin flip or when looking at the top card.
export function additiveDrawProfile(game, p, action) {
  const foe = game.opp(p);
  let count, limit, max;
  if (action.kind === 'trainer') {
    count = additiveTrainerDraws[action.tkind];
    switch (action.tkind) {
      case 'dan': count = 2.5; max = 4; break;
      case 'bugCatcher': max = 4; break;
      case 'trekkingShoes': max = 2; break;
      case 'gymTrainer': count = game.koLastTurn(p) ? 4 : 2; break;
      case 'ryme': if (!foe.bench.length || game.poncho(foe.active)) count = 3; break;
      case 'lillie': limit = game.lillieHandLimit(p); break;
      case 'korrinasFocus': limit = 6; break;
      case 'zisu': limit = foe.hand.length + 1; break;
      case 'trAriana': limit = game.allMons(p).every((m) => teamRocket(m.card)) ? 8 : 5; break;
    }
  } else if (action.kind === 'power') {
    count = additivePowerDraws[action.pkind];
    if (action.pkind === 'restart') limit = 3;
    if (action.pkind === 'industriousIncisors') limit = 5;
    if (action.pkind === 'fusionStrikeSystem') limit = game.allMons(p).filter((m) => fusionStrike(m.card)).length;
  } else if (action.kind === 'stadium' && action.stadium === 'trFactory') count = 2;
  if (limit != null) count = Math.max(0, limit - p.hand.length + Number(action.kind === 'trainer'));
  return count == null ? null : { count: Math.min(count, p.deck.length), max: max ?? count, limit };
}

export function setupImprovesDraw(action, setup, profile) {
  if (profile.limit == null || !setup) return false;
  const changesBoard = ['bench', 'evolve'].includes(setup.kind) || setup.tkind === 'rareCandy';
  // A non-Rocket Pokémon can lower Ariana's limit from eight to five.
  if (action.tkind === 'trAriana' && profile.limit === 8 && changesBoard && !teamRocket(setup.evo ?? setup.card)) return false;
  if (action.pkind === 'fusionStrikeSystem' && changesBoard && !fusionStrike(setup.evo ?? setup.card) &&
      fusionStrike(setup.target?.card ?? setup.card)) return false;
  return changesBoard || setup.kind === 'energy' || ['tool', 'stadium'].includes(setup.tkind);
}

// Maximum cards that leave the deck when the action resolves. A search may take
// fewer targets, and putting cards on the bottom (Rika) does not consume them.
const searchLimits = {
  nestBall: 1, ultraBall: 1, quickBall: 1, pokeBall: 1, greatBall: 1, levelBall: 1, pokePad: 1, pokegear: 1,
  computerSearch: 1, energySearch: 1, evolutionIncense: 1, pokeKid: 1, trTransceiver: 1, trPetrel: 1,
  quickSearch: 1, starAlchemy: 1, precognitiveAura: 1, artazon: 1, luminousSign: 1,
  buddyPoffin: 2, battleVipPass: 2, earthenVessel: 2, capaciousBucket: 2, tandemUnit: 2, shiveryChill: 2,
  arven: 2, irida: 2, jacq: 2, sonia: 2, pokemonFanClub: 2, technoRadar: 2, elesasSparkle: 2,
  clavell: 3, drayton: 2, explorersGuidance: 6, ryme: 3, sadaVitality: 3, melony: 3,
  makeDo: 2, refinement: 2, concealedCards: 2, underworldDoor: 2, luckyIcePop: 1, matterExchange: 1,
};

export function emptiesDeck(game, p, action) {
  const count = p.deck.length;
  if (!count) return false;
  const redraw = redrawProfile(game, p, action);
  if (redraw) return redraw.deckAfter === 0 && action.tkind !== 'tateLiza';
  const key = action.tkind ?? action.pkind ?? action.stadium;
  const draw = additiveDrawProfile(game, p, action);
  return Math.max(draw?.max ?? 0, searchLimits[key] ?? 0) >= count;
}

export function redrawProfile(game, p, action) {
  const kind = action.kind === 'trainer' ? action.tkind : action.kind === 'power' ? action.pkind : null;
  const handSize = p.hand.length - Number(p.hand.includes(action.card));
  const foe = game.opp(p);
  let draw = fixedDraws[kind], opponentDraw = opponentDraws[kind], destination = 'shuffle';
  switch (kind) {
    case 'professorOak': case 'professorsResearch': draw = 7; destination = 'discard'; break;
    case 'sprint': draw = 4; destination = 'discard'; break;
    case 'lilliesDetermination': draw = p.prizes.length === 6 ? 8 : 6; break;
    case 'bruno': draw = game.koLastTurn(p) ? 7 : 4; break;
    case 'copycat': draw = foe.hand.length; break;
    case 'sabrinasGaze': draw = handSize; opponentDraw = foe.hand.length; break;
    case 'iono': draw = p.prizes.length; opponentDraw = foe.prizes.length; destination = 'bottom'; break;
    case 'marnie': destination = 'bottom'; break;
  }
  if (draw == null) return null;
  const available = p.deck.length + (destination === 'discard' ? 0 : handSize);
  if (opponentDraw != null) opponentDraw = Math.min(opponentDraw, foe.deck.length + foe.hand.length);
  return { draw: Math.min(draw, available), opponentDraw, destination, deckAfter: Math.max(0, available - draw) };
}

export function lillieDrawCount(game, p, action) {
  const kept = p.hand.length - Number(p.hand.includes(action.card));
  return Math.min(p.deck.length, Math.max(0, game.lillieHandLimit(p) - kept));
}

export function deckClockCost(game, p, { action, redraw }, race, additive = additiveDrawProfile(game, p, action)) {
  const foe = game.opp(p);
  const draw = redraw?.draw ?? (action.pkind === 'matterExchange' ? 1 :
    action.pkind === 'underworldDoor' ? 2 : additive?.max);
  if (!draw || !foe.deck.length) return 0;
  const remaining = redraw?.deckAfter ?? Math.max(0, p.deck.length - draw);
  if (remaining >= p.deck.length || remaining > 7) return 0;
  let prizes = p.prizes.length, rounds = 0;
  for (const step of race?.steps ?? []) {
    rounds++;
    prizes -= step?.take ?? 0;
    if (prizes <= 0) break;
  }
  const needed = prizes <= 0 ? rounds - 1 : Math.max(2, rounds + Math.ceil(prizes / 2) - 1);
  const shortage = Math.max(0, Math.min(needed, foe.deck.length) - remaining + 1);
  return Math.min(78, shortage * 13 + (7 - remaining) * 3);
}

function averageDrawValue(game, p, value, prizes, returned = []) {
  const { list } = deckCatalog(p);
  const unseen = unseenCardCounts(game, p, list);
  for (const card of returned) unseen.set(card.id, (unseen.get(card.id) || 0) + 1);
  let total = 0, weightedValue = 0;
  for (const [card] of list) {
    const count = Math.max(0, (unseen.get(card.id) || 0) - (prizes?.get(card.id) || 0));
    if (!count) continue;
    total += count;
    weightedValue += count * value([card]);
  }
  return total ? weightedValue / total : 9;
}

export function prepareAttackDraw(game, p, actions, attack, plan, prizes) {
  if (game.turn > 9 || p.deck.length < 12 || p.hand.length > 5) return null;
  const defender = game.opp(p).active;
  if (visibleHit(game, p.active, defender, attack, false) >= defender.hpLeft ||
      attack.fx.timesHand || attack.fx.bonusIfEqualHands || attack.fx.discardHandTypeTimes || attack.fx.discardHandDraw) return null;
  const value = handEvaluator(game, p, plan);
  const average = averageDrawValue(game, p, value, prizes);
  const held = value(p.hand);
  let best = null;
  for (const action of actions) {
    if (action.kind !== 'trainer') continue;
    const count = additiveDrawProfile(game, p, action)?.count;
    if (!(count >= 2)) continue;
    const spent = held - value(p.hand.filter((card) => card !== action.card));
    const benefit = (count * average * 0.75 - spent * 0.62 - (action.card.ttype === 'supporter' ? 5 : 1)) * 0.35;
    if (benefit > 0 && (!best || benefit > best.benefit)) best = { action, benefit };
  }
  return best;
}

export function redrawScore(game, p, action, profile, plan, prizes) {
  const foe = game.opp(p);
  if (!p.deck.length && profile.deckAfter > 0) return 200;
  if (!profile.deckAfter && foe.deck.length > 0) return 1;

  const hand = p.hand.filter((card) => card !== action.card);
  const value = handEvaluator(game, p, plan);
  const average = averageDrawValue(game, p, value, prizes, profile.destination === 'shuffle' ? hand : []);
  const expected = profile.draw * average * (profile.draw > 3 ? 0.82 : 0.92);
  const keptValue = value(hand) * (profile.destination === 'discard' ? 1.12 : 1);
  const shrink = profile.opponentDraw == null ? 0 : foe.hand.length - profile.opponentDraw;
  let disruption = Math.max(-30, Math.min(45, shrink * 9));
  if (shrink >= 2 && profile.opponentDraw <= 4 && foe.active && p.active) {
    const activeEngine = supportValue(game, foe.active);
    const willRemove = activeEngine && game.turn > 1 && readyDamage(game, p.active, foe.active) >= foe.active.hpLeft;
    const remaining = Math.max(0, ...game.allMons(foe).filter((m) => !willRemove || m !== foe.active).map((m) => supportValue(game, m)));
    if (willRemove) disruption += 8;
    disruption -= Math.min(12, remaining * 0.35);
  }
  const gain = expected - keptValue + disruption;
  const handGain = profile.draw - hand.length;
  if (gain < (handGain > 0 ? 5 : 14)) return 1;
  return Math.min(93, 41 + gain * 0.65 + Math.max(-6, Math.min(10, handGain * 2)));
}

// Secret Mission trades a chosen subset one for one. Evaluate the next discard
// against keeping it, then stop as soon as the remaining hand is worth keeping.
export function selectiveExchangeValues(game, p, action, plan, prizes, alreadyPicked = 0) {
  if (p.deck.length - alreadyPicked <= 1) return new Map();
  const hand = p.hand.filter((card) => card !== action.card);
  const value = handEvaluator(game, p, plan);
  const keep = value(hand);
  const drawn = averageDrawValue(game, p, value, prizes) * 0.9;
  return new Map(hand.map((card) => [card, drawn + value(hand.filter((c) => c !== card), [card]) - keep - 5]));
}
