// Project a few direct exchanges from visible Pokémon and resources in our hand.
// Exact play, including any effect-dependent win, is still decided by the engine probe.
import { canPay, isType, keptEffects } from './engine.js';
import { afterFixedAttackCost, attackChoices, attackFinishChance, attackPrizes, handEnergyCost,
  modeledCoinFinish, prizeValue, replyThreat, visibleHit, withAttachedEnergy } from './ai-combat.js';
import { attackEnergyTypes, preferredRetreatPayment } from './ai-discard.js';
import { deckCatalog, unseenCardCounts } from './ai-plan.js';
import { attachmentTargets } from './ai-position.js';

const gusts = new Set(['gust', 'bossOrders', 'counterCatcher', 'primeCatcher', 'guzma']);
const switches = new Set(['switch', 'switchCart', 'primeCatcher', 'guzma']);
const doubleSwitch = new Set(['primeCatcher', 'guzma']);
const searchPowers = new Set(['quickSearch', 'precognitiveAura']);
// These effects change attached Energy through a choice the direct exchange does
// not simulate. Let the engine probe price those attacks and their payments.
const unresolvedEnergyEffects = ['optionalDiscardBonus', 'optionalDiscardReduce', 'optionalDiscardTypeAll', 'optionalDiscardRemove',
  'discardSelfTimes', 'discardSelfBonus', 'discardTypeTimes', 'discardBenchEnergyBonus', 'hailBlade', 'returnEnergyBonus'];
const energyUnits = (card) => Array(card.provides || 1).fill(card.energyType);
const enablesEnergy = (game, p, card) => card.kind === 'energy' && !card.special &&
  game.allMons(p).some((mon) => game.attacksOf(mon).some((atk) =>
    !canPay(mon.payTypes, atk.cost) && canPay([...mon.payTypes, ...energyUnits(card)], atk.cost)));
const resourceKey = (card) => card.kind === 'energy'
  ? [card.energyType, card.provides || 1, card.special || ''].join('/') : card.tkind || card.name;

export function canPlanPrizeRace(game, p) {
  const foe = game.opp(p);
  return game.turn >= 3 && p.prizes.length > 0 && foe.prizes.length > 0 &&
    Math.min(p.prizes.length, foe.prizes.length) <= 4 && (p.bench.length > 0 || foe.bench.length > 0);
}

export function projectPrizeRace(game, p, hand, {
  afterTurn = false, attacks = 3, paidRetreats = false, trackActiveLock = false, exactPrizes = false,
} = {}) {
  if (!canPlanPrizeRace(game, p)) return null;
  const players = [p, game.opp(p)];
  const sides = players.map((q) => game.allMons(q).map((mon) => ({
    mon, prizes: prizeValue(game, mon), attacks: game.attacksOf(mon), retreat: game.retreatCost(q, mon),
  })));
  const state = {
    active: players.map((q, i) => sides[i].findIndex(({ mon }) => mon === q.active)),
    hp: sides.map((side) => side.map(({ mon }) => mon.hpLeft)),
    energy: sides.map((side) => side.map(({ mon }) => mon.payTypes)),
    attached: sides.map((side) => side.map(({ mon }) => mon.energy)),
    discarded: [[], []],
    cleared: [[], []],
    prizes: players.map((q) => q.prizes.length),
    cooldown: [-1, -1], lastAttack: [-1, -1],
    ...(trackActiveLock ? { activeLock: players.map((q) => {
      const lock = q.active?.effects.usedActive;
      return lock && (lock.expires == null || lock.expires >= game.turn) ? lock.atk : null;
    }) } : {}),
    used: sides.map((side) => side.map(() => [])),
    hand,
  };
  if (state.hp.some((hp) => !hp.some(Boolean))) return null;

  const start = afterTurn ? 1 : 0;

  // Let the engine evaluate damage on the branch's current board and Prize counts.
  // Build a read-only view here, reserving full engine forks for the tactical search.
  function position(s, seat, turn, ownActive, foeActive, changedEnergy) {
    const active = seat === 0 ? [ownActive, foeActive] : [foeActive, ownActive];
    const view = Object.create(game);
    view.turn = turn;
    view.players = new Array(2);
    view.hiddenHand = new Set([players[1].idx]);
    for (const [side, player] of players.entries()) {
      const originalActive = s.active[side];
      const leaves = originalActive !== active[side];
      const mons = sides[side].map(({ mon }, index) => {
        if (!s.hp[side][index]) return null;
        const cleared = s.cleared[side].includes(index) || (leaves && index === originalActive);
        let effects = cleared ? keptEffects(mon.effects) : mon.effects;
        if (turn > game.turn) {
          effects = Object.fromEntries(Object.entries(effects).filter(([key, effect]) =>
            effect?.expires == null || effect.expires >= turn));
        }
        if (leaves && index === active[side]) effects = { ...effects, movedActive: { expires: turn } };
        return Object.assign(Object.create(mon), {
          game: view, effects, status: cleared ? {} : mon.status,
          damage: mon.damage + state.hp[side][index] - s.hp[side][index],
          energy: changedEnergy?.side === side && changedEnergy.index === index ? changedEnergy.cards : s.attached[side][index],
        });
      });
      view.players[player.idx] = { ...player, active: mons[active[side]],
        bench: mons.filter((mon, index) => mon && index !== active[side]),
        hand: side === 0 ? s.hand : { length: player.hand.length },
        discard: s.discarded[side].length ? [...player.discard, ...s.discarded[side]] : player.discard,
        prizes: { length: s.prizes[side] } };
    }
    view.current = view.players[players[seat].idx];
    view.first = view.players[game.first?.idx];
    return view;
  }

  function options(s, seat, ply) {
    const other = 1 - seat, turn = game.turn + ply + start;
    const active = s.hp[seat][s.active[seat]] ? s.active[seat] : -1;
    const defender = s.hp[other][s.active[other]] ? s.active[other] : s.hp[other].findIndex(Boolean);
    const moves = seat === 0 ? s.hand.filter((c) => switches.has(c.tkind)) : [];
    const pulls = seat === 0 ? s.hand.filter((c) => gusts.has(c.tkind) &&
      (c.tkind !== 'counterCatcher' || s.prizes[0] > s.prizes[1])) : [];
    const isCurrent = ply === 0 && !afterTurn;
    const usable = (c) => !isCurrent || c?.ttype !== 'supporter' || !p.flags.supporter;
    const energies = seat === 0 && (!isCurrent || !p.flags.energy) ? s.hand.filter((c) => c.kind === 'energy' && !c.special) : [];
    const uniqueEnergy = [...new Map(energies.map((c) => [resourceKey(c), c])).values()];
    const result = [];
    for (const [a, source] of sides[seat].entries()) {
      if (!s.hp[seat][a]) continue;
      const changing = active >= 0 && a !== active;
      const retreat = changing ? sides[seat][active].retreat : 0;
      const currentMon = changing ? sides[seat][active].mon : null;
      const canRetreat = changing && (!isCurrent || !p.flags.retreat) &&
        ((s.cleared[seat].includes(active) || (!currentMon.status.asleep && !currentMon.status.paralyzed)) ||
          (paidRetreats && game.modern && game.canRetreatStuck(currentMon))) &&
        !(currentMon.effects.noRetreat?.expires >= turn) &&
        s.energy[seat][active].length >= retreat;
      const freeMove = !changing || (canRetreat && retreat === 0);
      const switchCard = changing && !freeMove ? moves.find((c) => usable(c) && !doubleSwitch.has(c.tkind) &&
        (c.tkind !== 'switchCart' || currentMon.card.stage === 0)) : undefined;
      // A ready opposing Benched attacker can enter via a visible payable retreat.
      const paidMove = (seat === 1 || paidRetreats) && canRetreat && retreat > 0;
      const payment = paidMove
        ? preferredRetreatPayment(game, currentMon, s.attached[seat][active], retreat) : null;
      for (const [d, target] of sides[other].entries()) {
        if (!s.hp[other][d]) continue;
        const needsGust = d !== defender;
        const gust = needsGust ? pulls.find((c) => usable(c) &&
          (!(c.tkind === 'bossOrders' || c.tkind === 'guzma') || !game.poncho(target.mon)) &&
          (!doubleSwitch.has(c.tkind) || (changing || (c.tkind === 'primeCatcher' && s.hp[seat].filter(Boolean).length === 1))) &&
          (!switchCard || c.ttype !== 'supporter' || switchCard.ttype !== 'supporter' || doubleSwitch.has(c.tkind))) : undefined;
        const move = doubleSwitch.has(gust?.tkind) ? gust : switchCard;
        if ((needsGust && !gust) || (!freeMove && !move && (!paidMove || (payment && !payment.length)))) continue;
        const paid = paidMove && (!paidRetreats || !move);
        const view = position(s, seat, turn, a, d, paid ? {
          side: seat, index: active, cards: s.attached[seat][active].filter((card) => !payment.includes(card)),
        } : null);
        const owner = view.current, opponent = view.opp(owner), defenderMon = opponent.active;
        let strike;
        for (const [i, attack] of source.attacks.entries()) {
          if ((a === active && s.lastAttack[seat] === a && (s.cooldown[seat] === i || s.cooldown[seat] === -2)) ||
              s.used[seat][a].includes(i) || (a === active && s.activeLock?.[seat] === attack.name) || attack.fx.flipMetronome) continue;
          const attached = owner.active.payTypes;
          const energy = canPay(attached, attack.cost) ? undefined :
            uniqueEnergy.find((c) => canPay([...attached, ...energyUnits(c)], attack.cost));
          const charged = energy || gust || move
            ? withAttachedEnergy(view, owner.active, energy ? [...owner.active.energy, energy] : owner.active.energy, owner)
            : { game: view, mon: owner.active, owner };
          const attacker = charged.mon;
          if (attacker.status.confused || attacker.effects.sandAttack?.expires >= turn) continue;
          if (!charged.game.canUseAttack(charged.owner, attacker, defenderMon, attack, { usedActive: s.activeLock ? null : undefined })) continue;
          if (seat === 0 && (gust || move || energy)) {
            charged.owner.hand = s.hand.filter((c) => c !== gust && c !== move && c !== energy);
          }
          for (const atk of attackChoices(charged.game, charged.owner, defenderMon, attack, turn)) {
            const { fx } = atk;
            if (game.modern && unresolvedEnergyEffects.some((key) => fx[key])) continue;
            const handPaid = handEnergyCost(seat === 0 ? charged.owner.hand : null, atk);
            if (!handPaid) continue;
            const hit = afterFixedAttackCost(charged.game, attacker, fx.discard);
            const paidCards = hit.mon.energy;
            const damage = visibleHit(hit.game, hit.mon, defenderMon, atk, false, true, true);
            if (!damage) continue;
            const takesOutTarget = damage >= defenderMon.hpLeft;
            const prizes = takesOutTarget && exactPrizes ?
              attackPrizes(hit.game, opponent, defenderMon, hit.mon) : target.prizes;
            const take = takesOutTarget ? Math.min(s.prizes[seat], prizes) : 0;
            const cost = Number(!!gust) + Number(!!move && move !== gust) + Number(!!energy) +
              (paid && payment ? payment.length : 0) + handPaid.length;
            const rank = take * 75 + Math.min(damage, s.hp[other][d]) * 0.23 +
              (take ? s.energy[other][d].length * 4 : 0) - cost * 3 -
              (atk.fx.cooldown || atk.fx.lockout || atk.fx.discard ? 3 : 0);
            if (!strike || rank > strike.rank) {
              const remaining = game.modern && fx.discardAllEnergy ? [] : game.modern && fx.discardAllTypeTimes ?
                paidCards.filter((card) => !isType(card.energyType, fx.discardAllTypeTimes.type)) : paidCards;
              const effect = game.modern && fx.moveEnergyToBench;
              const movedEnergy = effect && charged.owner.bench.length && (!effect.may || attacker.hpLeft <= 60) ?
                (effect.all ? remaining : remaining.filter((card) => !effect.type || card.energyType === effect.type).slice(0, effect.n)) : [];
              let receiver = -1;
              if (movedEnergy.length) {
                const prompt = { kind: 'attachTo', attachment: { cards: movedEnergy },
                  options: charged.owner.bench.map((mon) => ({ mon })) };
                const chosen = attachmentTargets(charged.game, charged.owner, prompt, undefined, true)?.[0]?.mon;
                receiver = sides[seat].findIndex(({ mon }) => mon.id === chosen?.id);
              }
              strike = { a, d, i, atk, damage, take, gust, move, energy, handPaid, cost, rank, retreat: paid ? retreat : 0, payment,
                remaining, receiver, movedEnergy, discardedEnergy: attacker.energy.filter((card) => !remaining.includes(card)) };
            }
          }
        }
        if (strike) result.push(strike);
      }
    }
    return result.sort((a, b) => b.rank - a.rank);
  }

  function apply(s, seat, strike) {
    if (!strike) return s;
    const other = 1 - seat;
    const next = {
      ...s, active: [...s.active], hp: s.hp.map((hp) => [...hp]), prizes: [...s.prizes],
      cooldown: [...s.cooldown], lastAttack: [...s.lastAttack],
      energy: s.energy.map((en) => [...en]), used: s.used.map((used) => [...used]),
    };
    next.attached = s.attached.map((side) => [...side]);
    next.discarded = [...s.discarded];
    next.cleared = [...s.cleared];
    const replaceEnergy = (index, cards) => {
      next.attached[seat][index] = cards;
      next.energy[seat][index] = attackEnergyTypes(sides[seat][index].mon, cards);
    };
    const { a, d, atk, i, damage, take, gust, move, energy, handPaid, retreat, payment, remaining, receiver, movedEnergy, discardedEnergy } = strike;
    if (s.activeLock) {
      next.activeLock = [...s.activeLock];
      if (s.active[seat] !== a) next.activeLock[seat] = null;
      if (s.active[other] !== d || damage >= s.hp[other][d]) next.activeLock[other] = null;
      if (atk.fx.oncePerActive) next.activeLock[seat] = atk.name;
    }
    if (retreat) {
      const active = s.active[seat];
      replaceEnergy(active, s.attached[seat][active].filter((card) => !payment.includes(card)));
    }
    if (s.active[seat] >= 0 && s.active[seat] !== a) next.cleared[seat] = [...s.cleared[seat], s.active[seat]];
    if (s.active[other] >= 0 && s.active[other] !== d) next.cleared[other] = [...s.cleared[other], s.active[other]];
    next.active[seat] = a;
    next.active[other] = d;
    next.hp[other][d] = Math.max(0, next.hp[other][d] - damage);
    next.hp[seat][a] = Math.max(0, next.hp[seat][a] - (atk.fx.selfDamage || 0));
    next.prizes[seat] -= take;
    if (!next.hp[seat][a]) next.prizes[other] = Math.max(0, next.prizes[other] - sides[seat][a].prizes);
    replaceEnergy(a, receiver >= 0 ? remaining.filter((card) => !movedEnergy.includes(card)) : remaining);
    if (receiver >= 0) replaceEnergy(receiver, [...next.attached[seat][receiver], ...movedEnergy]);
    if (retreat || discardedEnergy.length || handPaid.length) {
      next.discarded[seat] = [...s.discarded[seat], ...(retreat ? payment : []), ...discardedEnergy, ...handPaid];
    }
    if (atk.fx.oncePerPlay) next.used[seat][a] = [...next.used[seat][a], i];
    next.cooldown[seat] = atk.fx.lockout ? -2 : atk.fx.cooldown ? i : -1;
    next.lastAttack[seat] = a;
    if (gust || move || energy || handPaid.length) {
      next.hand = s.hand.filter((c) => c !== gust && c !== move && c !== energy && !handPaid.includes(c));
    }
    return next;
  }

  const score = (s, ply) => {
    const won = !s.prizes[0] || !s.hp[1].some(Boolean);
    const lost = !s.prizes[1] || !s.hp[0].some(Boolean);
    if (won && lost) return 0;
    if (won || lost) return (won ? 1 : -1) * (150 - ply * 8);
    const taken = state.prizes.map((n, seat) => n - s.prizes[seat]);
    const chip = state.hp.map((hp, seat) => hp.reduce((n, value, i) => n + (s.hp[seat][i] ? value - s.hp[seat][i] : 0), 0));
    return 21 * (taken[0] - taken[1]) + 0.09 * (chip[1] - chip[0]);
  };
  const isFinished = (s) => !s.prizes.every(Boolean) || s.hp.some((hp) => !hp.some(Boolean));
  const plies = attacks * 2 - 1 + start;
  let beam = [{ state, steps: [], spent: 0, value: 0 }];
  for (let ply = 0; ply < plies; ply++) {
    const seat = (ply + start) % 2;
    const next = [];
    for (const node of beam) {
      if (isFinished(node.state)) {
        next.push(node);
        continue;
      }
      const choices = options(node.state, seat, ply).slice(0, seat === 0 ? 3 : 1);
      for (const strike of choices.length ? choices : [null]) {
        let outcome = apply(node.state, seat, strike);
        if (!strike && !outcome.hp[seat][outcome.active[seat]]) {
          const active = [...outcome.active];
          active[seat] = outcome.hp[seat].reduce((best, hp, i, list) => hp > (list[best] || 0) ? i : best, -1);
          outcome = { ...outcome, active };
          if (outcome.activeLock) {
            outcome.activeLock = [...outcome.activeLock];
            outcome.activeLock[seat] = null;
          }
        }
        const spent = node.spent + (seat === 0 ? strike?.cost || 0 : 0);
        const steps = seat === 0 ? [...node.steps, strike && { ...strike, attacker: sides[0][strike.a].mon, target: sides[1][strike.d].mon }] : node.steps;
        next.push({ state: outcome, steps, spent, value: score(outcome, ply) - spent * 2 });
      }
    }
    beam = next.sort((a, b) => b.value - a.value).slice(0, 3);
    if (beam.every((node) => isFinished(node.state))) break;
  }
  return beam[0];
}

export function planPrizeRace(game, p, actions, knownPrizes, rules) {
  const race = projectPrizeRace(game, p, p.hand, rules);
  if (!race || race.value >= 138 || !knownPrizes || p.prizes.length > 3) return race;
  const source = actions.find((action) => action.kind === 'power' && searchPowers.has(action.pkind));
  if (!source) return race;
  const { list } = deckCatalog(p);
  const unseen = unseenCardCounts(game, p, list);
  const available = list.map(([card]) => card).filter((card) => (unseen.get(card.id) || 0) > (knownPrizes.get(card.id) || 0));
  const missing = (card) => !p.hand.some((held) => resourceKey(held) === resourceKey(card));
  const gust = available.find((card) => gusts.has(card.tkind) && missing(card));
  const move = available.find((card) => switches.has(card.tkind) && !doubleSwitch.has(card.tkind) && missing(card));
  const energy = available.find((card) => missing(card) && enablesEnergy(game, p, card));
  let best = race;
  for (const card of [...new Set([gust, move, energy].filter(Boolean))].slice(0, 2)) {
    const withCard = projectPrizeRace(game, p, [...p.hand, card], rules);
    const usesCard = withCard?.steps.some((step) => step && [step.gust, step.move, step.energy].includes(card));
    if (usesCard && withCard.value >= 110 && withCard.value > best.value + 12) best = { ...withCard, search: { source, card } };
  }
  return best;
}

const plainFinishDraw = { bill: 2, nemona: 3, hop: 3, barry: 3, hau: 3 };
const drawPower = { flipTheScript: 3 };

// Evaluate single missing cards that can produce a win this turn. Each trial adds a hypothetical
// resource to the visible hand, and uses counts rather than the real order of the deck.
export function rankClosingRisk(game, p, rows, race, knownPrizes, rules, { deckClock, chanceFinish } = {}) {
  if (p.prizes.length > 3 || !p.active || !game.opp(p).active) return null;
  if (!chanceFinish && (!race || race.value >= 110)) return null;
  const foe = game.opp(p);
  const danger = race?.value <= -110 || (foe.prizes.length <= prizeValue(game, p.active) &&
    replyThreat(game, foe, p.active, { exposure: true }) >= 45);
  if (!foe.deck.length || (!chanceFinish && (!race || race.value >= 110 || !danger))) return null;
  const attacks = rows.filter(({ action }) => action.kind === 'attack');
  const chance = Math.max(0, ...attacks.map((row) => {
    const win = attackFinishChance(game, p, row.action.index, rules?.exactPrizes);
    if (win > 0 && win < 1 && danger && race && race.value < 110) {
      row.score = Math.max(row.score, 45 + 125 * win);
    }
    if (chanceFinish && win > 0 && win < 1) {
      const modeled = modeledCoinFinish(game, p, row.action.index, rules?.exactPrizes);
      if (modeled >= 0.5) {
        row.finishChance = modeled;
        row.score = Math.max(row.score, 45 + 125 * modeled);
      }
    }
    return win;
  }));
  if (chance === 1 || p.deck.length < 2 || !danger || !race || race.value >= 110) return null;

  const drawCount = (action) => plainFinishDraw[action.tkind] ||
    (action.pkind === 'restart' ? Math.max(0, 3 - p.hand.length) : drawPower[action.pkind]) || 0;
  const draws = rows.filter(({ action, redraw }) => (redraw?.draw || drawCount(action)) >= 2 &&
    (!redraw || redraw.deckAfter > 0)).sort((a, b) => b.score - a.score);
  if (!draws.length) return null;
  const { list } = deckCatalog(p);
  const unseen = unseenCardCounts(game, p, list);
  const candidates = list.map(([card]) => {
    const count = Math.max(0, (unseen.get(card.id) || 0) - (knownPrizes?.get(card.id) || 0));
    return { card, count };
  }).filter(({ card, count }) => count && (gusts.has(card.tkind) || switches.has(card.tkind) || enablesEnergy(game, p, card)));
  if (!candidates.length) return null;
  const ownWin = (result) => result?.steps[0] && (!result.state.prizes[0] || !result.state.hp[1].some(Boolean)) &&
    result.state.prizes[1] > 0 && result.state.hp[0].some(Boolean);
  let best = null;
  for (const row of draws.slice(0, 2)) {
    const { action, redraw } = row;
    if (deckClock && !redraw && p.deck.length <= drawCount(action)) continue;
    const hand = redraw ? [] : p.hand.filter((c) => c !== action.card);
    let outs = 0;
    for (const { card, count } of candidates) {
      const result = projectPrizeRace(game, p, [...hand, card], { ...rules, attacks: 1 });
      const move = result?.steps[0];
      const usedSupporter = [move?.gust, move?.move].some((c) => c?.ttype === 'supporter');
      if (ownWin(result) && (action.card?.ttype !== 'supporter' || !usedSupporter)) outs += count;
    }
    let unknown = p.deck.length + (knownPrizes ? 0 : p.prizes.length);
    if (redraw?.destination === 'shuffle') unknown += p.hand.length - Number(p.hand.includes(action.card));
    const drawn = Math.min(redraw?.draw || drawCount(action), p.deck.length);
    let miss = 1;
    for (let i = 0; i < drawn && i < unknown; i++) miss *= Math.max(0, 1 - outs / (unknown - i));
    const win = 1 - miss;
    if (win < 0.15 || win <= chance + 0.05) continue;
    row.score = Math.max(row.score, 48 + 125 * win);
    if (!best || win > best.win) best = { action, win };
  }
  return best;
}

export function prizePlan(base, race, p) {
  if (!race?.steps.some(Boolean) || race.value < 12) return base;
  const [now, ...future] = race.steps;
  const cards = (step) => step ? [...new Set([step.gust, step.move, step.energy].filter(Boolean))] : [];
  const thisTurn = cards(now);
  const needed = new Map();
  for (const card of [...thisTurn, ...future.flatMap(cards)]) {
    const key = resourceKey(card);
    needed.set(key, (needed.get(key) || 0) + 1);
  }
  return {
    ...base,
    isTarget: (mon) => base?.isTarget(mon) || future.some((step) => step?.attacker === mon),
    keepPriority: (card) => base?.keepPriority(card) || 0,
    actionPriority: (action) => base?.actionPriority(action) || 0,
    searchPriority(card, hand = p.hand) {
      const key = resourceKey(card);
      const missing = needed.has(key) && hand.filter((c) => resourceKey(c) === key).length < needed.get(key);
      return (base?.searchPriority(card) || 0) + (missing ? (card.id === race.search?.card.id ? 65 : 16) : 0);
    },
    reserveValue(hand) {
      const counts = new Map();
      let value = 0;
      for (const card of hand) {
        const key = resourceKey(card), count = counts.get(key) || 0;
        if (count >= (needed.get(key) || 0)) continue;
        counts.set(key, count + 1);
        value += card.kind === 'energy' ? 13 : 23;
      }
      return value;
    },
    routePriority(action) {
      const { card, target } = action;
      if (action === race.search?.source) return 45;
      if (action.kind === 'attack' && now?.attacker === p.active && action.index === now.i && !thisTurn.length) return 6;
      if (action.kind === 'energy' && card === now?.energy && target === now?.attacker) return 14;
      if (action.kind === 'energy' && future.some((step) => step?.energy === card && step.attacker === target) && !now?.energy) return 10;
      if (action.kind === 'retreat' && target === now?.attacker && !now?.move) return 8;
      if (action.kind === 'trainer' && thisTurn.includes(card) &&
          (!target || target === (now.gust === card ? now.target : now.attacker))) return 18;
      if (card && future.some((step) => cards(step).includes(card)) &&
          (action.kind === 'energy' || action.kind === 'trainer')) return -20;
      return 0;
    },
  };
}
