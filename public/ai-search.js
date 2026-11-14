import { deckCatalog, unseenCardCounts } from './ai-plan.js';

const singleSearch = new Set(['ultraBall', 'nestBall', 'quickBall', 'pokePad',
  'computerSearch', 'energySearch', 'evolutionIncense', 'quickSearch', 'starAlchemy', 'precognitiveAura', 'artazon']);
const multiSearch = new Set(['battleVipPass', 'buddyPoffin', 'earthenVessel', 'arven', 'irida', 'jacq', 'clavell', 'capaciousBucket',
  'tandemUnit', 'shiveryChill', 'rareCandy', 'evolve']);

export function canSearchKnownDeck(action, exact = false) {
  const kind = action.tkind ?? action.pkind ?? action.stadium ?? action.kind;
  return singleSearch.has(kind) || (exact && multiSearch.has(kind));
}

export function confirmedDeck(game, p, prizes) {
  const { list } = deckCatalog(p);
  const unseen = unseenCardCounts(game, p, list);
  const cards = [];
  const seenNames = new Set(), ambiguousNames = new Set();
  for (const [card] of list) {
    if ((unseen.get(card.id) || 0) > (prizes?.get(card.id) || 0)) {
      if (seenNames.has(card.name)) ambiguousNames.add(card.name);
      seenNames.add(card.name);
    }
    // Before looking at the deck, every unknown Prize could be a copy of this card.
    const count = (unseen.get(card.id) || 0) - (prizes ? prizes.get(card.id) || 0 : p.prizes.length);
    for (let i = 0; i < count; i++) cards.push({ ...card, uid: -2 - cards.length, simulatedSearch: true });
  }
  return cards.length && cards.length <= p.deck.length ? { cards, length: p.deck.length, ambiguousNames } : null;
}

export function searchZone(state, allowed, blind) {
  let listing = false, selected = -1;
  return new Proxy({}, {
    get(_target, key) {
      if (key === 'length') return state.length;
      if (key === 'some' && listing) return state.cards.some.bind(state.cards);
      if (!allowed) return blind();
      if (key === 'indexOf') return (card) => selected = state.cards.indexOf(card);
      if (key === 'find') return (predicate) => {
        const card = state.cards.find(predicate);
        return card && state.ambiguousNames.has(card.name) ? blind() : card;
      };
      if (key === 'includes') return state.cards.includes.bind(state.cards);
      if (key === 'splice') return (index, count, ...rest) => {
        if (index < 0 || index !== selected || count !== 1 || rest.length ||
            state.ambiguousNames.has(state.cards[index]?.name)) return blind();
        selected = -1;
        state.length--;
        return state.cards.splice(index, 1);
      };
      return blind();
    },
    set(_target, key, value) {
      if (key !== 'listing') return blind();
      listing = value;
      return true;
    },
  });
}
