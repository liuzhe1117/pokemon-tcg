import { handEvaluator } from './ai-discard.js';
import { deckCatalog, unseenCardCounts } from './ai-plan.js';
import { nextAttachmentDamage } from './ai-position.js';
import { CARDS, MAX_BENCH } from './cards.js';
import { isBasic } from './engine.js';

const basicEnergy = (card) => card.kind === 'energy' && !card.special;

export function heavyBallValue(game, p, prizes) {
  if (!p.prizes.length || !game.opp(p).deck.length) return 0;
  if (!prizes) return 12; // Looking at unknown Prizes can still inform later decisions.
  if (![...prizes].some(([id, count]) => count > 0 && CARDS[id] && isBasic(CARDS[id]))) return 0;
  return p.bench.length === 0 && !p.hand.some(isBasic) ? 60 : 32;
}

export function shortDeck(game, p) {
  const remaining = game.opp(p).deck.length;
  return remaining > 0 && p.deck.length <= Math.min(3, remaining);
}

function confirmedInDeck(game, p, prizes) {
  const { list } = deckCatalog(p);
  const unseen = unseenCardCounts(game, p, list);
  return list.map(([card]) => card).filter((card) =>
    (unseen.get(card.id) ?? 0) > (prizes ? (prizes.get(card.id) ?? 0) : p.prizes.length));
}

function canFetchRecycled(game, p, card) {
  if (p.until.noTrainers === game.turn) return false;
  const spare = p.hand.filter((entry) => entry.tkind !== 'superRod').length;
  return p.hand.some(({ tkind }) => {
    if (basicEnergy(card)) {
      return tkind === 'energySearch' || (tkind === 'earthenVessel' && spare >= 2) ||
        (tkind === 'capaciousBucket' && card.energyType === 'Water');
    }
    if (tkind === 'ultraBall') return spare >= 3;
    if (tkind === 'pokePad') return !card.ruleBox;
    if (tkind === 'evolutionIncense') return card.stage > 0;
    if (!isBasic(card) || p.bench.length >= MAX_BENCH) return false;
    return tkind === 'nestBall' || (tkind === 'buddyPoffin' && card.hp <= 70) || (tkind === 'quickBall' && spare >= 2);
  });
}

function neededAfterRecycling(game, p, card, alternatives) {
  const active = p.active, defender = game.opp(p).active;
  if (basicEnergy(card)) {
    if (!active || !defender || game.turn === 1 || p.flags.energy) return 0;
    const energy = alternatives.filter((entry) => basicEnergy(entry) && canFetchRecycled(game, p, entry));
    const held = nextAttachmentDamage(game, p, active, defender, game.turn, [...p.hand, ...energy]);
    const withRecycled = nextAttachmentDamage(game, p, active, defender, game.turn, [...p.hand, card]);
    return withRecycled > held ? 20 + Math.min(25, (withRecycled - held) / 3) : 0;
  }
  if (p.hand.some((entry) => entry.name === card.name)) return 0;
  if (isBasic(card)) return !p.bench.length && p.active?.name !== card.name && !p.hand.some(isBasic) ? 23 : 0;
  return game.turn > 2 && game.allMons(p).some((mon) => mon.name === card.evolvesFrom && mon.playedTurn < game.turn) ? 35 : 0;
}

export function superRodTargets(game, p, prizes, recycled = []) {
  if (!game.opp(p).deck.length) return new Map();
  const alternatives = [...confirmedInDeck(game, p, prizes), ...recycled];
  const scores = new Map();
  for (const card of p.discard) {
    if ((card.kind !== 'pokemon' && !basicEnergy(card)) || !canFetchRecycled(game, p, card)) continue;
    const equivalent = (other) => basicEnergy(card) ? basicEnergy(other) && other.energyType === card.energyType : other.name === card.name;
    if (alternatives.some(equivalent)) continue;
    const score = neededAfterRecycling(game, p, card, alternatives);
    if (score) scores.set(card, score);
  }
  return scores;
}

export function rankRecovery(game, p, prompt, action, plan, prizes, rodPlay) {
  const heavyBall = prompt.text === 'prompt.q.heavyBall';
  const rod = action?.tkind === 'superRod' && prompt.text === 'prompt.q.toDeck';
  if (!heavyBall && !rod) return null;
  const value = handEvaluator(game, p, plan);
  const urgent = rod && (rodPlay?.fillDeck ?? shortDeck(game, p));
  const targets = rod ? superRodTargets(game, p, prizes, rodPlay?.cards) : null;
  const retained = [...p.hand, ...(rodPlay?.cards ?? [])];
  return prompt.options.map((option) => {
    if (!option.card) return [option, heavyBall || urgent ? -Infinity : 0];
    const card = option.card;
    const need = targets?.get(card) ?? 0;
    const score = heavyBall || urgent || need > 0 ? value([...retained, card]) + need : -1;
    return [option, score];
  }).sort((a, b) => b[1] - a[1]).map(([option]) => option);
}
