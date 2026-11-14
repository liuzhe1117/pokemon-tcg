import { handEvaluator } from './ai-discard.js';
import { deckCatalog, unseenCardCounts } from './ai-plan.js';

function pokemonDrawEstimate(game, side, prizes, own) {
  if (!side.deck.length) return { expected: 0, emptiesDeck: false };
  const { list } = deckCatalog(side);
  // The opponent's hand and face-down Prizes stay in the unseen pool.
  const unseen = unseenCardCounts(game, own ? side : { ...side, hand: [] }, list);
  let pokemon = 0, total = 0;
  for (const [card] of list) {
    const remaining = unseen.get(card.id) - (prizes?.get(card.id) ?? 0);
    if (remaining < 0) return null;
    total += remaining;
    if (card.kind === 'pokemon') pokemon += remaining;
  }
  const unknown = side.deck.length + (own ? 0 : side.hand.length) + (prizes ? 0 : side.prizes.length);
  if (total !== unknown) return null;
  return {
    expected: Math.min(3, side.deck.length) * pokemon / total,
    emptiesDeck: side.deck.length <= 3 && pokemon === total,
  };
}

export function opponentTrainerValue(game, p, action, prizes) {
  const kind = action.tkind;
  if (kind !== 'lureModule' && kind !== 'specialRedCard' && kind !== 'imposterOak') return null;
  const foe = game.opp(p);
  if (!foe.deck.length) return 0;

  if (kind === 'lureModule') {
    const theirs = pokemonDrawEstimate(game, foe, null, false);
    if (theirs?.emptiesDeck) return 150;
    if (p.deck.length <= 3 || !theirs || game.hiddenHand?.has(p.idx)) return 0;
    const ours = pokemonDrawEstimate(game, p, prizes, true);
    if (!ours) return 0;
    const gain = ours.expected - theirs.expected;
    return gain > 1 ? 15 + 9 * gain : 0;
  }

  const available = foe.deck.length + foe.hand.length;
  const newHand = Math.min(kind === 'specialRedCard' ? 3 : 4, available);
  const newDeck = available - newHand;
  if (!newDeck) return 150;
  const shrink = foe.hand.length - newHand;
  // Keep the opponent's short draw clock rather than adding turns to it.
  if (shrink <= 0 || (newDeck > foe.deck.length && foe.deck.length <= 2)) return 0;

  let discardCost = 0;
  if (kind === 'imposterOak') {
    if (game.hiddenHand?.has(p.idx)) return 0;
    const hand = p.hand.filter((card) => card !== action.card);
    if (!hand.length) return 0;
    const value = handEvaluator(game, p);
    discardCost = value(hand) - Math.max(...hand.map((card) => value(hand.filter((entry) => entry !== card), [card])));
  }
  const gain = 9 * shrink - Math.max(0, discardCost) - 5;
  return gain > 0 ? Math.min(68, 22 + gain) : 0;
}
