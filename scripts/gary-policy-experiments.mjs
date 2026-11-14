import { GaryV3Policy } from '../public/ai-v3.js';
import { attackScore, readyDamage, visibleHit } from '../public/ai-combat.js';
import { basicAttachment, betterAttachment, drawBeforeAttack } from '../public/ai-v3-current.js';
import { buildV3Strategy } from '../public/ai-v3-strategy.js';

const drawsFromDeck = new Map([['bill', 2], ['hop', 3], ['hau', 3], ['nemona', 3], ['barry', 3],
  ['dan', 4], ['bugCatcher', 4], ['melony', 3], ['ryme', 3], ['makeDo', 2], ['refinement', 2],
  ['concealedCards', 2], ['flipTheScript', 3], ['professorOak', 7], ['professorsResearch', 7]]);
const backupSearch = new Set(['nestBall', 'buddyPoffin', 'pokemonFanClub', 'clavell', 'levelBall']);
const freeSwitches = new Set(['switch', 'switchCart', 'switchRaft']);

class GaryExperimentPolicy extends GaryV3Policy {
  constructor(scoreCPU, pickCPU, limits, features = ['draw-before-attack', 'redirect-energy']) {
    super(scoreCPU, pickCPU, { ...limits, strategy: buildV3Strategy(features) });
    this.features = new Set(features);
  }

  async chooseAction(game, p, actions) {
    const result = await super.chooseAction(game, p, actions);
    if (result.reason === 'lethal' || result.reason === 'setup-knockout' || !p.active || !game.opp(p).active) return result;
    const action = result.action;
    const enabled = this.features;
    const foe = game.opp(p), active = p.active;
    const hit = (mon = active, turn = game.turn) => readyDamage(game, mon, foe.active, mon.payTypes, { turn, entering: mon !== active });
    const pick = (next, reason) => this.play(game, p, next, null, reason);
    const paidRetreat = action.kind === 'retreat' && game.retreatCost(p, active) > 0;
    if (paidRetreat && enabled.has('draw-before-retreat') && hit(action.target) < foe.active.hpLeft) {
      const draw = drawBeforeAttack(game, p, actions);
      if (draw) return pick(draw, 'draw-before-retreat');
    }
    if (paidRetreat && enabled.has('switch-instead-of-retreat')) {
      const free = actions.find((a) => a.kind === 'trainer' && freeSwitches.has(a.tkind) &&
        (a.target === action.target || (!a.target && p.bench.length === 1)));
      if (free) return pick(free, 'switch-instead-of-retreat');
    }
    if (paidRetreat && enabled.has('charge-before-retreat') && hit(action.target) < foe.active.hpLeft) {
      const charge = actions.find((a) => basicAttachment(a) && a.target === active &&
        readyDamage(game, active, foe.active, [...active.payTypes, a.card.energyType]) >= foe.active.hpLeft);
      if (charge) return pick(charge, 'charge-before-retreat');
    }
    if (paidRetreat && enabled.has('stay-with-safe-attack') && hit() > 0 &&
        hit(action.target) < foe.active.hpLeft && hit(action.target) <= hit() + 10 &&
        readyDamage(game, foe.active, active, foe.active.payTypes, { turn: game.turn + 1 }) * 2 < active.hpLeft) {
      const safe = actions.filter((a) => a.kind === 'attack' &&
        visibleHit(game, active, foe.active, game.attacksOf(active)[a.index], false) > 0)
        .sort((a, b) => attackScore(game, p, b.index) - attackScore(game, p, a.index))[0];
      if (safe) return pick(safe, 'stay-with-safe-attack');
    }
    const draw = drawsFromDeck.get(action.tkind ?? action.pkind);
    if (enabled.has('reserve-deck') && draw && p.deck.length > 0 && p.deck.length <= draw && foe.deck.length > 1) {
      const next = await super.chooseAction(game, p, actions.filter((a) =>
        (drawsFromDeck.get(a.tkind ?? a.pkind) || 0) < p.deck.length));
      return next.reason === 'lethal' ? next : { ...next, reason: 'reserve-deck' };
    }
    if (action.kind === 'bench' && enabled.has('preserve-bench-slots') && game.turn > 6 && p.bench.length >= 3) {
      const plan = this.plan(game, p);
      const weakBench = (a) => a.kind === 'bench' && prizeValueFor(game, a.card) >= foe.prizes.length && !plan?.actionPriority(a);
      if (weakBench(action)) {
        const replacement = await super.chooseAction(game, p, actions.filter((a) => !weakBench(a)));
        return replacement.reason === 'lethal' ? replacement : { ...replacement, reason: 'preserve-bench-slots' };
      }
    }
    if (action.kind === 'attack') {
      const attacks = game.attacksOf(active), attack = attacks[action.index];
      const damage = visibleHit(game, active, foe.active, attack, false);
      if (enabled.has('draw-before-attack') && result.reason !== 'chance-finish') {
        const prep = drawBeforeAttack(game, p, actions, attack);
        if (prep) return pick(prep, 'draw-before-attack');
      }
      if (enabled.has('backup-before-attack') && game.turn <= 7 && !p.bench.length && damage < foe.active.hpLeft) {
        const backup = actions.find((a) => a.kind === 'bench') ||
          actions.find((a) => a.kind === 'trainer' && backupSearch.has(a.tkind));
        if (backup) return pick(backup, 'backup-before-attack');
      }
      if (enabled.has('search-before-attack') && game.turn <= 9 && p.deck.length >= 12 && damage * 2 < foe.active.hpLeft) {
        const plan = this.plan(game, p);
        const search = actions.find((a) => a.kind === 'trainer' && plan?.actionPriority(a) >= 26 &&
          !['professorsResearch', 'professorOak'].includes(a.tkind));
        if (search) return pick(search, 'search-before-attack');
      }
      if (enabled.has('cleaner-attack') && damage < foe.active.hpLeft &&
          (attack.fx.discard || attack.fx.cooldown || attack.fx.lockout || attack.fx.selfDamage)) {
        const clean = actions.find((a) => {
          if (a.kind !== 'attack' || a === action) return false;
          const other = attacks[a.index], fx = other.fx;
          return !fx.discard && !fx.cooldown && !fx.lockout && !fx.selfDamage &&
            visibleHit(game, active, foe.active, other, false) >= Math.max(10, damage);
        });
        if (clean) return pick(clean, 'cleaner-attack');
      }
    }
    const attachment = enabled.has('redirect-energy') && !this.strategy?.jointAttachment &&
      betterAttachment(game, p, actions, action, this.strategy?.exactEnergy, this.strategy?.reserveEnergy);
    return attachment ? pick(attachment, 'redirect-energy') : result;
  }
}

const prizeValueFor = (game, card) => game.modern ? card.prizes || 1 : 1;

export function experimentControllerOptions(version, features) {
  const options = { version: () => version === 'v4' ? 'v3' : version };
  if (version === 'v4') options.garyPolicy = GaryExperimentPolicy;
  if (version === 'v3' && features) {
    options.garyPolicy = features.length ? class extends GaryExperimentPolicy {
      constructor(scoreCPU, pickCPU, limits) {
        super(scoreCPU, pickCPU, limits, features);
      }
    } : GaryV3Policy;
  }
  return options;
}
