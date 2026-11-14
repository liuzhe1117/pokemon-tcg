import { handEvaluator } from './ai-discard.js';
import { confirmedDeck } from './ai-search.js';
import { additiveDrawProfile } from './ai-redraw.js';
import { MAX_BENCH } from './cards.js';
import { isBasic } from './engine.js';

const benchSearches = new Set(['battleVipPass', 'buddyPoffin', 'nestBall', 'tandemUnit']);
const paidSearches = new Set(['ultraBall', 'quickBall', 'computerSearch', 'earthenVessel']);
const partialSearches = new Set(['greatBall', 'pokeBall', 'eggIncubator', 'cramOMatic']);

export function paidSearchValue(game, p, action, getPlan, prizes) {
  if (!paidSearches.has(action.tkind) || game.hiddenHand?.has(p.idx)) return null;
  const known = confirmedDeck(game, p, prizes);
  if (!known || known.length !== known.cards.length) return null;
  const plan = getPlan();
  const matches = (card) => action.tkind === 'computerSearch' ||
    (action.tkind === 'earthenVessel' ? card.kind === 'energy' && !card.special :
      action.tkind === 'quickBall' ? isBasic(card) : card.kind === 'pokemon');
  const targets = known.cards.filter(matches);
  if (!targets.length) return 0;
  const hand = p.hand.filter((card) => card !== action.card);
  const value = handEvaluator(game, p, plan);
  const kept = value(hand);
  const count = ['quickBall', 'earthenVessel'].includes(action.tkind) ? 1 : 2;
  if (hand.length > 12) return null; // The tactical probe still checks concrete payments in large hands.
  let gain = -Infinity;
  const unique = [...new Map(targets.map((card) => [card.id, card])).values()];
  const payoff = new Map(unique.map((card) => [card, (plan?.searchPriority(card) ?? 0) * 0.65]));
  const copies = new Map();
  for (const card of targets) copies.set(card.id, (copies.get(card.id) ?? 0) + 1);
  for (const [index, first] of hand.entries()) {
    for (const second of count === 1 ? [null] : hand.slice(index + 1)) {
      const discarded = second ? [first, second] : [first];
      const remaining = hand.filter((card) => !discarded.includes(card));
      for (const target of unique) {
        if (isBasic(target) && p.bench.length >= MAX_BENCH && action.tkind !== 'computerSearch' && !target.powerKind) continue;
        if (remaining.some((card) => card.name === target.name) && target.kind === 'pokemon') continue;
        gain = Math.max(gain, value([...remaining, target], discarded) - kept + payoff.get(target));
        if (action.tkind === 'earthenVessel') for (const other of unique) {
          if (other === target && copies.get(target.id) < 2) continue;
          gain = Math.max(gain, value([...remaining, target, other], discarded) - kept + Math.max(payoff.get(target), payoff.get(other)));
        }
      }
    }
  }
  return gain > 0 ? 42 + Math.min(38, gain) : 1;
}

export function searchPreparation(game, p, actions, before, plan) {
  if (p.deck.length <= 4 || p.bench.length >= MAX_BENCH || before.card?.ttype === 'supporter' && !additiveDrawProfile(game, p, before)) return null;
  const setup = actions.filter((action) => benchSearches.has(action.tkind ?? action.pkind));
  if (!setup.length) return null;
  if (before.kind !== 'bench' && before.kind !== 'energy' && before.kind !== 'end' &&
      !additiveDrawProfile(game, p, before) && !paidSearches.has(before.tkind) && !partialSearches.has(before.tkind)) return null;
  const vip = setup.find((action) => action.tkind === 'battleVipPass');
  if (vip && p.bench.length <= 3 && p.bench.length + p.hand.filter(isBasic).length < 4) return vip;
  if (p.bench.length >= 2) return null;
  if (before.kind === 'energy' || paidSearches.has(before.tkind) || partialSearches.has(before.tkind)) {
    const targets = plan()?.setupTargets;
    if (!targets?.length) return null;
    return setup.find((action) => action.pkind === 'tandemUnit' || action.tkind === 'buddyPoffin' ||
      (action.tkind === 'nestBall' && targets.length === 1));
  }
  if (before.kind === 'end') return setup.find((action) => action.pkind === 'tandemUnit' || action.tkind === 'buddyPoffin');
  return null;
}
