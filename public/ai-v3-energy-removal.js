import { lostEnergyValue } from './ai-v3-targets.js';
import { readyDamage, withAttachedEnergy } from './ai-combat.js';

export const removesEnergy = (action) => ['energyRemoval', 'superEnergyRemoval', 'fanOfWaves'].includes(action.tkind);
function loss(game, p, mon, cards) {
  const foe = game.opp(p);
  const defense = lostEnergyValue(game, foe, mon, cards, game.turn + 1, !game.modern);
  if (mon !== foe.active || game.turn === 1 || !p.active) return defense;
  const { game: reduced, mon: stripped } = withAttachedEnergy(game, mon, mon.energy.filter((card) => !cards.includes(card)), foe);
  const options = { certain: true };
  const before = readyDamage(game, p.active, mon, undefined, options);
  const after = readyDamage(reduced, p.active, stripped, undefined, options);
  return defense + Math.max(0, after - before) * 0.5 + (before < mon.hpLeft && after >= stripped.hpLeft ? 100 : 0);
}
const payment = (game, p, mon, card) =>
  lostEnergyValue(game, p, mon, [card], Math.max(2, game.turn)) + 9 + (card.special ? 8 : 0);

function removalWithFirst(game, p, mon, first) {
  return Math.max(loss(game, p, mon, [first]),
    ...mon.energy.filter((card) => card !== first).map((second) => loss(game, p, mon, [first, second])));
}

export function energyDisruptionValue(game, p, action) {
  const foe = game.opp(p);
  if (!foe.deck.length) return 0;
  if (action.tkind === 'fanOfWaves') return Math.max(0, ...game.allMons(foe).flatMap((mon) =>
    mon.energy.filter((card) => card.special).map((card) => loss(game, p, mon, [card]))));
  const mon = action.target;
  if (action.tkind === 'energyRemoval') return Math.max(0, ...mon.energy.filter((card) => card.energyType === action.etype)
    .map((card) => loss(game, p, mon, [card])));
  const cost = Math.min(...game.allMons(p).flatMap((holder) => holder.energy.map((card) => payment(game, p, holder, card))));
  return Math.max(0, ...mon.energy.map((card) => removalWithFirst(game, p, mon, card) - cost));
}

export function rankEnergyDisruption(game, p, prompt, action) {
  if (!action || !removesEnergy(action)) return null;
  const holder = (option) => prompt.cost?.sources.get(option.card);
  const target = game.allMons(game.opp(p)).find((mon) => mon.id === action.target?.id);
  let score;
  switch (prompt.text) {
    case 'prompt.ser.text':
      score = ({ mon }) => -Math.min(...mon.energy.map((card) => payment(game, p, mon, card)));
      break;
    case 'prompt.q.discardWhichEnergy':
      if (action.tkind === 'superEnergyRemoval') score = (option) => -payment(game, p, holder(option), option.card);
      break;
    case 'prompt.q.removeWhichEnergy':
      score = (option) => action.tkind === 'superEnergyRemoval'
        ? removalWithFirst(game, p, holder(option), option.card) : loss(game, p, holder(option), [option.card]);
      break;
    case 'prompt.q.removeSecondEnergy':
      if (target) score = ({ card }) => card ? loss(game, p, target, [card]) - 0.1 : 0;
      break;
    case 'prompt.q.fanOfWaves':
      score = ({ mon }) => Math.max(...mon.energy.filter((card) => card.special).map((card) => loss(game, p, mon, [card])));
      break;
    case 'prompt.q.fanOfWavesWhich':
      score = (option) => loss(game, p, holder(option), [option.card]);
      break;
  }
  if (!score) return null;
  const ranked = prompt.options.map((option) => [option, score(option)]);
  const best = Math.max(...ranked.map(([, value]) => value));
  return ranked.filter(([, value]) => value === best).map(([option]) => option);
}
