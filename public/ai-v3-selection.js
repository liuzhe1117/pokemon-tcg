import { readyDamage, withAttachedEnergy } from './ai-combat.js';
import { handEvaluator } from './ai-discard.js';
import { deckCatalog } from './ai-plan.js';
import { nextAttachmentDamage } from './ai-position.js';
import { keptEffects } from './engine.js';

function selectionValue(game, p, plan, turn) {
  const handValue = handEvaluator(game, p, plan);
  const defender = game.opp(p).active;
  const active = p.active;
  const evolutions = deckCatalog(p).pokemon;
  const hit = (board, side, mon, hand) => Math.max(
    readyDamage(board, mon, defender, undefined, { certain: true, turn }),
    side.flags.energy && turn === game.turn ? 0 : nextAttachmentDamage(board, side, mon, defender, turn, hand),
  );
  return (cards) => {
    const hand = [...p.hand, ...cards];
    const value = handValue(hand);
    if (!active || !defender || turn === 1) return value;
    const { game: position, owner, mon } = withAttachedEnergy(game, active, active.energy, p);
    owner.hand = hand;
    let damage = hit(position, owner, mon, hand);
    if (turn > 2 && active.playedTurn < turn) {
      const candy = game.modern && active.card.stage === 0 && p.until.noTrainers !== turn && hand.some((card) => card.tkind === 'rareCandy');
      for (const card of hand) {
        if (card.kind !== 'pokemon' || !(card.evolvesFrom === active.name ||
            (candy && card.stage === 2 && evolutions.get(card.evolvesFrom)?.evolvesFrom === active.name))) continue;
        const { game: view, owner: evolvedOwner, mon: evolved } = withAttachedEnergy(position, mon, mon.energy, owner);
        evolved.stack = [...mon.stack, card];
        evolved.status = {};
        evolved.effects = game.modern ? { ...keptEffects(mon.effects), evolvedNow: { expires: turn } } : {};
        const remaining = hand.filter((entry) => entry !== card);
        evolvedOwner.hand = remaining;
        if (evolved.hpLeft > 0) damage = Math.max(damage, hit(view, evolvedOwner, evolved, remaining));
      }
    }
    return value + Math.min(damage, defender.hpLeft) * 0.55 + (damage >= defender.hpLeft ? 36 : damage > 0 ? 12 : 0);
  };
}

export function rankSelection(game, p, prompt, action, plan, ordering) {
  const { text, options, params } = prompt;
  const keepTwo = text === 'prompt.q.keepK' && ['rika', 'explorersGuidance'].includes(action?.tkind);
  const recon = text === 'prompt.q.keepOne' && action?.pkind === 'reconDirective';
  const order = text === 'prompt.q.pokedexK' || (text === 'prompt.q.searchAny' && action?.tkind === 'ciphermaniac');
  if (!keepTwo && !recon && !order) return null;
  const picks = ordering?.cards ?? [];
  const takeNow = ordering?.count ?? 0;
  const goesToBottom = order && ordering?.take?.pkind === 'reconDirective' && picks.length === 1;
  const turn = order && picks.length >= takeNow ? game.turn + 2 : game.turn;
  const value = selectionValue(game, p, plan, turn);
  const together = (keepTwo && params.k === 1) || (order && picks.length === 0 && takeNow >= 2);
  const equivalents = new Map();
  if (together) for (const { card } of options) {
    const group = equivalents.get(card.id) ?? [];
    if (group.length < 2) group.push(card);
    equivalents.set(card.id, group);
  }
  const pairValues = new Map();
  const ranked = options.map((option) => {
    const cards = [...picks, option.card];
    let score = value(cards);
    if (goesToBottom) return [option, -score];
    if (together) {
      let best = -Infinity;
      for (const group of equivalents.values()) {
        const other = group.find((card) => card !== option.card);
        if (!other) continue;
        const key = [option.card.id, other.id].sort().join('/');
        if (!pairValues.has(key)) pairValues.set(key, value([...cards, other]));
        best = Math.max(best, pairValues.get(key));
      }
      if (Number.isFinite(best)) score = order ? best + score * 0.25 : best;
    }
    return [option, score];
  });
  return ranked.sort((a, b) => b[1] - a[1]).map(([option]) => option);
}
