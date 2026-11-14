// A short forward search over the real game rules, from Gary's current information.
import { attackPotential, preferredRetreatPayment, rankHardPrompt, retreatResourceCost } from './ai-discard.js';
import { observePrizeCounts, openingBench, openingScore, planAttacker, sequenceSetup } from './ai-plan.js';
import { canPlanPrizeRace, planPrizeRace, prizePlan, projectPrizeRace, rankClosingRisk } from './ai-prizes.js';
import { attackScore, attackTargets, readyDamage, replyThreat } from './ai-combat.js';
import { activeLineValue, attackReserveBonus, attachmentScore, attachmentTargets, gustTargetValue, movementFor,
  movementTargets, nextAttachmentValue, paidRetreatPenalty, preparationBeforeSwitch, retreatNecessity,
  usefulRepeatableAttachment } from './ai-position.js';
import { deckClockCost, prepareAttackDraw, redrawProfile, redrawScore, selectiveExchangeValues } from './ai-redraw.js';
import { canSearchKnownDeck, confirmedDeck, searchZone } from './ai-search.js';
import { Mon } from './engine.js';
import { knockoutSetups, redundantPokemonSearch, setupCards } from './ai-setup.js';

export class HiddenInformation extends Error {}
const OPPONENT_CHOICE = Symbol('opponent choice');
const budget = { probes: 34, milliseconds: 16, depth: 3, width: 3 };
const blind = () => { throw new HiddenInformation('The simulated branch needs a hidden card or a random result.'); };

function hiddenZone(length, deck = false, countOnly = false) {
  return new Proxy({ length }, {
    get(target, key) {
      if (key === 'length') return target.length;
      if (deck && key === 'some' && target.listing) return () => false;
      if (deck && countOnly && key === 'unshift') return (...cards) => (target.length += cards.length);
      return blind();
    },
    set(target, key, value) {
      if (key !== 'listing') return blind();
      target.listing = value;
      return true;
    },
  });
}

export function fork(game, seat, choose, confirmed, allowSearch, countOnly = false) {
  const sim = Object.assign(Object.create(Object.getPrototypeOf(game)), {
    modern: game.modern, turn: game.turn, phase: game.phase, winner: null,
    stadium: game.stadium && { ...game.stadium }, learned: new Set(),
    hooks: {}, controllers: [{ choose }, { choose }], random: blind,
    simulationMonId: game.simulationMonId ?? -1, hiddenHand: new Set(),
    async takePrize(p) {
      p.prizes = hiddenZone(p.prizes.length - 1);
      if (p.idx === seat && !this.hiddenHand.has(seat)) this.knownHand = [...p.hand];
      p.hand = hiddenZone(p.hand.length + 1);
      this.hiddenHand.add(p.idx);
    },
  });
  const copyMon = (m) => m && Object.assign(Object.create(Object.getPrototypeOf(m)), m, {
    game: sim, stack: [...m.stack], energy: [...m.energy], tools: m.tools.map((t) => ({ ...t })),
    ...structuredClone({ status: m.status, effects: m.effects, used: m.used }),
  });
  sim.players = game.players.map((p) => ({
    idx: p.idx, deckKey: p.deckKey, deck: hiddenZone(p.deck.length, true, countOnly), prizes: hiddenZone(p.prizes.length),
    hand: p.idx === seat ? [...p.hand] : hiddenZone(p.hand.length),
    discard: [...p.discard], lost: [...(p.lost || [])], active: copyMon(p.active), bench: p.bench.map(copyMon),
    ...structuredClone({ flags: p.flags, until: p.until, koTurn: p.koTurn, vstarUsed: p.vstarUsed, gxUsed: p.gxUsed }),
  }));
  if (countOnly) sim.hiddenHand.add(1 - seat);
  sim.current = sim.players[game.current?.idx ?? seat];
  sim.first = sim.players[game.first?.idx];
  if (countOnly) {
    sim.draw = (side, requested = 1) => {
      const count = Math.min(requested, side.deck.length);
      if (count <= 0) return 0;
      side.deck = hiddenZone(side.deck.length - count, true, true);
      if (side.idx === seat) {
        sim.confirmedDeck = null;
        sim.viewDeck = () => blind();
        const unknown = { kind: 'unknown', name: '', tags: [], simulatedDraw: true };
        for (let i = 0; i < count; i++) side.hand.push(unknown);
      } else side.hand = hiddenZone(side.hand.length + count);
      return count;
    };
  }
  if (confirmed) {
    const deck = { ...confirmed, cards: [...confirmed.cards] };
    const owner = sim.players[seat];
    owner.deck = searchZone(deck, allowSearch, blind);
    sim.confirmedDeck = deck;
    if (allowSearch) {
      sim.viewDeck = (p) => p === owner ? deck.cards : blind();
      // Searching can shuffle the unknown order. Nothing in the fork can draw that order.
      sim.shuffle = (cards) => cards === owner.deck ? cards : blind();
    }
  } else if (countOnly) sim.confirmedDeck = null;
  return sim;
}

// The real engine can test whether a search target is in its deck. On a fork,
// omit these actions. Executing any effect that needs unseen cards also stops the probe.
export function simulatedActions(game, p) {
  p.deck.listing = true;
  try { return game.legalActions(p); }
  finally { p.deck.listing = false; }
}

const monId = (mon) => mon?.stack[0]?.uid;
const actionId = (a) => JSON.stringify([a.kind, a.tkind, a.pkind, a.stadium, a.index, a.card?.uid, a.card2?.uid,
  monId(a.target), a.etype, a.vstar, a.evo?.uid]);
function matchesStep(action, step, searched) {
  const replay = { ...action };
  for (const key of ['card', 'card2', 'evo']) {
    const card = step.action[key];
    if (card?.simulatedSearch && matchesSearchCard(action[key], card.uid, card.id, searched)) replay[key] = card;
  }
  const base = step.action.target?.stack[0];
  if (base?.simulatedSearch && matchesSearchCard(action.target?.stack[0], base.uid, base.id, searched)) {
    replay.target = step.action.target;
  }
  return actionId(replay) === step.id;
}
function optionId(o) {
  const base = o.mon?.stack[0];
  if (base?.simulatedSearch) return ['deck-mon', base.uid, base.id];
  if (o.card?.simulatedSearch) return ['deck-card', o.card.uid, o.card.id];
  return o.mon ? ['mon', monId(o.mon)] : o.card ? ['card', o.card.uid] : ['option', o.id];
}
export const promptId = (p) => JSON.stringify([p.kind, p.text, p.params?.k]);
export const answerId = (o) => JSON.stringify(optionId(o));
export const actionStep = (action, answers) => ({ id: actionId(action), action, answers });
export const activeKey = (game) => game.players.map((side) => monId(side.active)).join('/');
export const plannedAnswer = (kind, text, option) => [promptId({ kind, text }), answerId(option)];
const matchesSearchCard = (card, uid, id, searched) => card?.id === id &&
  (!searched?.has(uid) || searched.get(uid) === card.uid);
function plannedOption(prompt, answer, searched) {
  if (!answer.startsWith('["deck-')) return prompt.options.find((option) => answerId(option) === answer);
  const [kind, uid, id] = JSON.parse(answer);
  const cardOf = (option) => kind === 'deck-mon' ? option.mon?.stack[0] : option.card;
  const option = prompt.options.find((entry) => matchesSearchCard(cardOf(entry), uid, id, searched));
  if (option) searched?.set(uid, cardOf(option).uid);
  return option;
}

const gust = new Set(['gust', 'bossOrders', 'counterCatcher', 'primeCatcher', 'trGiovanni', 'guzma', 'pokemonCatcher']);
const drawCards = new Set(['bill', 'professorOak', 'professorsResearch', 'nemona', 'lilliesDetermination', 'iono', 'marnie',
  'cynthia', 'hop', 'youngster', 'barry', 'judge', 'shauna', 'hau', 'birdKeeper', 'surfer', 'trAriana', 'roxanne']);
const drawPowers = new Set(['rumblingEngine', 'concealedCards', 'refinement', 'restart', 'industriousIncisors', 'flipTheScript',
  'lunarCycle', 'reconDirective', 'flaringMagic', 'makeDo', 'fusionStrikeSystem', 'shiningArcana', 'powerDraw', 'sprint', 'slushRush',
  'roastReveal', 'runErrand', 'trade', 'brightLook', 'dedechange', 'crobatDraw', 'stellarWish', 'reconstitute', 'deepSeaKing']);
const tacticalTrainers = new Set([...gust, 'pokemonCatcher', 'rareCandy', 'plusPower', 'defender', 'leon', 'powerTablet', 'premiumPowerPro',
  'energySwitch', 'darkPatch', 'metalSaucer', 'aquaPatch', 'potion', 'potion30', 'superPotion', 'pokeCenterLady', 'turoScenario',
  'energyRemoval', 'superEnergyRemoval', 'toolScrapper', 'fanOfWaves', 'energyRetrievalM', 'scrambleSwitch', 'stadium', 'tool']);

function actionScore(game, p, a, scoreCPU, plan, move, ownHand, exactEnergy, reserveEnergy) {
  const planBonus = plan?.actionPriority(a) ?? 0;
  const route = plan?.routePriority?.(a) || 0;
  const foe = game.opp(p);
  if (a.kind === 'energy') return attachmentScore(game, p, a, planBonus, undefined, exactEnergy) + route;
  if (a.kind === 'attack') return attackScore(game, p, a.index, { ownHand }) + route;
  if (!move && a.kind === 'trainer' && gust.has(a.tkind) && foe.bench.includes(a.target)) {
    const gain = gustTargetValue(game, p, a.target) * (a.tkind === 'pokemonCatcher' ? 0.5 : 1) + route;
    return gain > 10 ? 22 + gain : 1;
  }
  if (a.kind === 'power' && !usefulRepeatableAttachment(game, p, a, plan, exactEnergy, reserveEnergy)) return 1;
  let score = scoreCPU(game, p, a) + planBonus + route;
  if (move) score = move.gain + route > 6 ? Math.max(score, 24 + move.gain + route) : Math.min(score, 1);
  if (a.kind === 'bench' && p.bench.length > 1) {
    score -= a.card.prizes > 1 ? 30 : 18;
  }
  if (a.kind === 'bench' && game.modern && p.bench.length && a.card.prizes >= foe.prizes.length &&
      foe.discard.some((c) => gust.has(c.tkind)) && replyThreat(game, foe, new Mon(a.card, game.turn, game, -1)) >= 45) score -= 24;
  const draws = (a.kind === 'trainer' && drawCards.has(a.tkind)) || (a.kind === 'power' && drawPowers.has(a.pkind));
  if (draws && p.deck.length <= (foe.deck.length <= 4 ? 7 : 3)) score = Math.min(score, 1);
  return score;
}

function redrawPreparation({ action, move, redraw, score }) {
  if (!action.card || move || redraw) return false;
  if (action.kind === 'energy') return score >= 32;
  if (action.kind === 'evolve' || action.kind === 'bench') return score >= 60;
  return action.kind === 'trainer' && action.card.ttype !== 'supporter' &&
    action.tkind !== 'secretMission' && !drawCards.has(action.tkind) && score >= 55;
}

function priority(game, p, a, score, move, exactEnergy) {
  const d = game.opp(p).active;
  if (move) {
    const { candidates, defender } = move;
    const possible = Math.max(0, ...candidates.map((m) => readyDamage(game, m, defender, m.payTypes, { entering: true })));
    return possible >= defender.hpLeft ? 147 - Math.min(move.cost, 24) + Math.max(0, move.gain) / 10 :
      Math.max(score, 72 + possible / 5 - move.cost);
  }
  if (a.kind === 'trainer' && gust.has(a.tkind) && a.target && game.ownerOf(a.target) !== p) {
    const possible = Math.max(...game.allMons(p).map((m) => readyDamage(game, m, a.target)));
    if (possible >= a.target.hpLeft) return 150 + (a.target.card.prizes || 1);
    return Math.max(72, score);
  }
  if (a.kind === 'energy') {
    const m = a.target, cards = [a.card, a.card2].filter(Boolean);
    const extra = cards.flatMap((c) => Array(c.provides || 1).fill(c.energyType));
    if (readyDamage(game, m, d, undefined, { certain: exactEnergy }) < d.hpLeft &&
        readyDamage(game, m, d, [...m.payTypes, ...extra], exactEnergy
          ? { attached: [...m.energy, ...cards], certain: true } : {}) >= d.hpLeft) {
      return m === p.active ? 154 : 127;
    }
  }
  if (a.kind === 'power' && a.target) return score + 8;
  return score;
}

function positionValue(game, p, ended = false) {
  const other = game.opp(p);
  const board = (q) => game.allMons(q).reduce((total, m) => total + m.hpLeft * 0.18 +
    attackPotential(game, m) * (q.active === m ? 0.9 : 0.65) + m.energy.length * 2.5, 0);
  const incoming = (q, foe, turn) => replyThreat(game, foe, q.active, {
    includeSetup: false, exposure: ended && foe.prizes.length <= 3, benchAccess: ended && game.turn >= 6, turn,
  });
  return 85 * (other.prizes.length - p.prizes.length) + board(p) - board(other) -
    incoming(p, other, game.turn + 1) * 0.72 + incoming(other, p, game.turn + (ended ? 2 : 0)) * 0.40 +
    Math.min(p.hand.length, 6) * 1.25 -
    (p.deck.length === 0 ? 38 : p.deck.length <= 2 ? 12 : 0);
}

export class HardPolicy {
  constructor(scoreCPU, pickCPU, limits = {}) {
    this.scoreCPU = scoreCPU;
    this.pickCPU = pickCPU;
    this.budget = { ...budget, ...limits };
    this.strategy = limits.strategy;
    this.plans = new WeakMap();
    this.races = new WeakMap();
    this.lines = new WeakMap();
    this.answers = new WeakMap();
    this.prizes = new WeakMap();
  }

  observeDeck(game, p, deck) {
    const counts = observePrizeCounts(game, p, deck);
    if (counts) this.prizes.set(game, counts);
  }

  observePrize(game, card) {
    const counts = this.prizes.get(game);
    if (!counts) return;
    const count = counts.get(card.id) || 0;
    if (count < 1) this.prizes.delete(game);
    else counts.set(card.id, count - 1);
  }

  observePrizes(game, p) {
    const counts = new Map();
    for (const card of p.prizes) counts.set(card.id, (counts.get(card.id) || 0) + 1);
    this.prizes.set(game, counts);
  }

  clearLine(game) {
    this.lines.delete(game);
    this.answers.delete(game);
  }

  plan(game, p) {
    const plan = planAttacker(game, p, this.plans.get(game), this.prizes.get(game), this.strategy?.attacker);
    this.plans.set(game, plan?.name);
    return plan;
  }

  rankPrompt(game, p, prompt, action, plan, setupRoutes) {
    if (prompt.kind === 'setup-active' && game.turn === 0) {
      const cards = prompt.options.map((o) => o.card);
      return prompt.options.map((o) => [o, openingScore(game, p, o.card, cards)])
        .sort((a, b) => b[1] - a[1]).map(([o]) => o);
    }
    if (action?.tkind === 'secretMission' && prompt.text === 'prompt.q.discardMore') {
      const values = selectiveExchangeValues(game, p, action, plan, this.prizes.get(game), prompt.params.n);
      const score = (option) => option.id === 'none' ? 0 : values.get(option.card) ?? -Infinity;
      return [...prompt.options].sort((a, b) => score(b) - score(a));
    }
    if (prompt.kind === 'tate' && action?.tkind === 'tateLiza') {
      const future = this.strategy?.nextAttachment
        ? (mon, defender) => nextAttachmentValue(game, p, mon, defender, game.turn + 2) : undefined;
      const move = movementFor(game, p, action, undefined, this.strategy?.opponentChooses, this.strategy?.activeExchange, future);
      const draw = redrawScore(game, p, action, redrawProfile(game, p, action), plan, this.prizes.get(game));
      const choice = move?.gain > 6 && 24 + move.gain > draw ? 'switch' : 'draw';
      return [...prompt.options].sort((a, b) => Number(b.id === choice) - Number(a.id === choice));
    }
    if (prompt.kind === 'lure' && p.active && game.opp(p).active && prompt.options.every((o) => o.mon)) {
      return prompt.options.map((o) => [o, gustTargetValue(game, p, o.mon, { afterAttack: !!game.attacking })])
        .sort((a, b) => b[1] - a[1]).map(([o]) => o);
    }
    return movementTargets(game, p, prompt, action, this.strategy?.activeExchange, this.strategy?.nextAttachment) ??
      attackTargets(game, p, prompt, action) ??
      attachmentTargets(game, p, prompt, plan, this.strategy?.exactEnergy, this.strategy?.reserveEnergy) ??
      rankHardPrompt(game, p, prompt, plan, setupRoutes);
  }

  choose(game, p, prompt) {
    const current = this.answers.get(game);
    if (current?.seat === p.idx && current.turn === game.turn && current.searchCard && prompt.text === 'prompt.q.searchAny') {
      const option = prompt.options.find((o) => o.card?.id === current.searchCard);
      if (option) return option.id;
      this.clearLine(game);
    }
    if (prompt.options.length === 1 && !this.strategy?.confirmedSearch) return prompt.options[0].id;
    if (current?.seat === p.idx && current.turn === game.turn && current.answers.length) {
      const [expected, answer, board] = current.answers[0];
      const matching = expected === promptId(prompt);
      const choice = board === undefined ? answer : board.get(activeKey(game));
      const option = matching && choice && plannedOption(prompt, choice, current.searched);
      if (option) {
        current.answers.shift();
        return option.id;
      }
      if (prompt.options.length !== 1) this.clearLine(game);
    }
    if (prompt.options.length === 1) return prompt.options[0].id;
    if (prompt.kind === 'setup-active' && game.turn === 0) return this.rankPrompt(game, p, prompt)?.[0]?.id;
    const recent = this.races.get(game);
    const plan = prizePlan(this.plan(game, p), recent?.turn === game.turn ? recent.race : null, p);
    const ranked = this.rankPrompt(game, p, prompt, current?.action, plan, current?.setupRoutes);
    return ranked?.[0]?.id ?? this.pickCPU(game, p, prompt);
  }

  setupBench(game, p, basics) {
    return openingBench(game, p, basics);
  }

  play(game, p, action, step, reason, searched, setupRoutes) {
    this.answers.set(game, { seat: p.idx, turn: game.turn, action, searchCard: step?.searchCard,
      answers: [...(step?.answers || [])], searched, setupRoutes });
    return { action, reason };
  }

  playVerified(game, p, steps) {
    const [step, ...rest] = steps;
    const searched = new Map();
    this.clearLine(game);
    if (rest.length) this.lines.set(game, { seat: p.idx, turn: game.turn, steps: rest, searched, verified: true });
    return this.play(game, p, step.action, step, 'lethal', searched);
  }

  actionCandidates(game, p, actions) { return actions; }
  actionValue(game, p, action, base, actions) { return base; }
  tacticalTrainer(action) { return tacticalTrainers.has(action.tkind); }

  async chooseAction(game, p, actions, priorSearchTime = 0) {
    const { budget, strategy } = this;
    const pending = this.lines.get(game);
    const legal = actions;
    actions = this.actionCandidates(game, p, actions);
    if (pending?.seat === p.idx && pending.turn === game.turn) {
      const step = pending.steps.shift();
      const action = (pending.verified ? legal : actions).find((a) => matchesStep(a, step, pending.searched));
      if (!pending.steps.length || !action) this.lines.delete(game);
      if (action) return this.play(game, p, action, step, pending.reason ?? 'lethal', pending.searched);
    }
    this.clearLine(game);
    const knownPrizes = this.prizes.get(game);
    const race = planPrizeRace(game, p, actions, knownPrizes, strategy?.prizeRules);
    if (race) this.races.set(game, { turn: game.turn, race });
    else this.races.delete(game);
    const plan = prizePlan(this.plan(game, p), race, p);
    const describe = (g, q, actions, goal, rootPosition = false) => {
      let payment, paidCards;
      const futureValues = rootPosition && strategy?.nextAttachment ? new Map() : null;
      const future = futureValues && ((mon, defender) => {
        const key = mon.id + '/' + defender.id;
        if (!futureValues.has(key)) futureValues.set(key, nextAttachmentValue(g, q, mon, defender, g.turn + 2));
        return futureValues.get(key);
      });
      const alternatives = strategy?.retreatPayment
        ? actions.filter((a) => a.tkind === 'switch' || a.tkind === 'switchCart') : [];
      const adjustAttachment = rootPosition ? strategy?.jointAttachment?.(g, q, actions, knownPrizes) : null;
      const energyPreparation = rootPosition && strategy?.reserveEnergy
        ? actions.filter((a) => a.kind === 'evolve' || a.tkind === 'rareCandy') : [];
      const rows = actions.map((action) => {
        const move = movementFor(g, q, action, () => payment ??= retreatResourceCost(g, q),
          strategy?.opponentChooses, strategy?.activeExchange, future);
        if (move && strategy?.retreatPayment && action.kind === 'retreat') {
          const units = g.retreatCost(q, q.active);
          if (units) {
            paidCards ??= preferredRetreatPayment(g, q.active, q.active.energy, units);
            if (strategy.necessaryRetreat) move.necessity = retreatNecessity(g, q, action.target);
            move.paymentPenalty = paidRetreatPenalty(g, q, action, alternatives, paidCards, move.necessity);
            move.gain -= move.paymentPenalty;
          }
        }
        if (action.tkind === 'secretMission') {
          const gain = Math.max(0, ...selectiveExchangeValues(g, q, action, goal, this.prizes.get(game)).values());
          return { action, score: gain > 0 ? 40 + gain : 1 };
        }
        const redraw = redrawProfile(g, q, action);
        if (!redraw) {
          const score = action.kind === 'attack' && strategy?.attack
            ? attackScore(g, q, action.index, { ownHand: !g.hiddenHand?.has(q.idx), tuning: strategy.attack }) + (goal?.routePriority?.(action) || 0)
            : actionScore(g, q, action, this.scoreCPU, goal, move, !g.hiddenHand?.has(q.idx), strategy?.exactEnergy, strategy?.reserveEnergy);
          const base = this.actionValue(g, q, action, score, actions);
          const adjustment = strategy?.action?.(g, q, action, { goal, move, base, exactEnergy: strategy.exactEnergy }) ?? 0;
          const reserve = rootPosition && strategy?.reserveEnergy ? attackReserveBonus(g, q, action, energyPreparation) : 0;
          const paidScore = move?.paymentPenalty ? Math.min(base, 24 + move.gain + (goal?.routePriority?.(action) ?? 0)) : base;
          return { action, move, reserve, score: paidScore + adjustment + reserve + (adjustAttachment?.(action) ?? 0) };
        }
        const base = redrawScore(g, q, action, redraw, goal, this.prizes.get(game));
        const score = base + (strategy?.action?.(g, q, action, { goal, move, base, redraw }) ?? 0);
        return move?.gain > 6 && 24 + move.gain > score ? { action, move, score: 24 + move.gain } : { action, redraw, score };
      });
      const delayed = sequenceSetup(g, q, rows, goal, this.prizes.get(game));
      if (q.deck.length && rows.some(({ redraw, score }) => redraw && score > 1)) {
        const prepare = Math.max(-Infinity, ...rows.filter((row) => !delayed.has(row.action) && redrawPreparation(row)).map(({ score }) => score));
        if (Number.isFinite(prepare)) {
          for (const row of rows) if (row.redraw) row.score = Math.min(row.score, prepare - 0.5);
        }
      }
      return rows;
    };
    const root = describe(game, p, actions, plan, true);
    const closingDraw = rankClosingRisk(game, p, root, race, knownPrizes, strategy?.prizeRules, {
      deckClock: strategy?.deckClock, chanceFinish: strategy?.chanceFinish,
    });
    if (strategy?.deckClock) {
      for (const row of root) {
        if (row.action !== closingDraw?.action) row.score -= deckClockCost(game, p, row, race);
      }
    }
    root.sort((a, b) => b.score - a.score);
    const rootMoves = new Map(root.filter(({ move }) => move).map(({ action, move }) => [action, move]));
    const fallback = root[0].action;
    if (actions.length === 1 || !p.active || !game.opp(p).active) return this.play(game, p, fallback, null, 'policy');

    const seat = p.idx;
    const deadline = performance.now() + Math.max(0, budget.milliseconds - priorSearchTime);
    let probes = 0;
    const hasBudget = () => probes < budget.probes && performance.now() < deadline;
    let best = null, bestFallback = null, bestStaying = null, lethal = null;
    let bestSetup = null, directKnockout = null;
    const setupRoutes = [];
    const compareSearch = strategy?.setupKnockout && redundantPokemonSearch(game, p, fallback, knownPrizes);
    const directAttacks = strategy?.comparePreparation ? new Map() : null;
    const comparedSwitches = strategy?.switchAlternatives && rootMoves.size > 0;
    const compareExchange = strategy?.activeExchange && rootMoves.size > 0;
    const defending = strategy?.necessaryRetreat && root.some(({ move }) => move?.necessity?.avoidsKnockout);
    const valueOf = (g, q, ended) => positionValue(g, q, ended) + (strategy?.position?.(g, q, ended) ?? 0);
    const rootValue = valueOf(game, p);
    const assessReply = canPlanPrizeRace(game, p);
    const deck = strategy?.confirmedSearch && p.deck.length && actions.some((a) => canSearchKnownDeck(a, !!knownPrizes))
      ? confirmedDeck(game, p, knownPrizes) : null;

    const probe = async (node, a, replay = [], move) => {
      probes++;
      const answers = [], alternatives = [];
      let resolved = false, ended = false;
      const knownDeck = node.game.confirmedDeck ?? deck;
      const exact = knownDeck && knownDeck.cards.length === knownDeck.length;
      const allowSearch = knownDeck?.cards.length && canSearchKnownDeck(a, exact);
      const sim = fork(node.game, seat, (g, q, prompt) => {
        const knownPick = allowSearch && prompt.kind === 'search' && prompt.options.some((o) => o.card?.simulatedSearch);
        if (prompt.options.length === 1 && !knownPick) return prompt.options[0].id;
        if (q.idx !== seat) throw OPPONENT_CHOICE;
        const legal = knownPick ? prompt.options.filter((o) =>
          !o.card?.simulatedSearch || !knownDeck.ambiguousNames.has(o.card.name)) : prompt.options;
        if (!legal.length || (knownPick && !legal.some((o) => o.card))) return blind();
        const choice = legal === prompt.options ? prompt : { ...prompt, options: legal };
        const ranked = this.rankPrompt(g, q, choice, a, node.plan ?? plan, node.steps.length ? undefined : setupRoutes);
        const preferred = ranked?.[0] ?? legal.find((o) => o.id === this.pickCPU(g, q, choice));
        const options = [preferred, ...(ranked ?? legal).filter((o) => o !== preferred)];
        const i = answers.length;
        const option = (i < replay.length && options.find((o) => answerId(o) === replay[i])) || preferred;
        if (!option) return blind();
        answers.push([promptId(prompt), answerId(option)]);
        if (i < 3 && options.length > 1 &&
            (knownPick || a.kind === 'attack' || ['discard', 'discardFrom', 'promote', 'snipe', 'lure'].includes(prompt.kind))) {
          for (const alternate of options.filter((o) => o && o !== option).slice(0, 2)) {
            alternatives.push([...answers.slice(0, -1).map(([, id]) => id), answerId(alternate)]);
          }
        }
        return option.id;
      }, knownDeck, allowSearch);
      const q = sim.players[seat];
      const known = !allowSearch && race?.search?.source === a ? race.search.card : null;
      if (known) {
        const card = { ...known, uid: -1, simulatedSearch: true };
        // Only this exact search can use the inferred card. Order and ordinary draws stay hidden.
        sim.viewDeck = (owner) => owner === q ? [card] : blind();
        sim.searchDeck = (owner, selected) => {
          if (owner !== q || selected !== card || !q.deck.length) return blind();
          q.deck = hiddenZone(q.deck.length - 1, true);
          return card;
        };
        sim.shuffle = (deck) => deck === q.deck ? deck : blind();
      }
      // Rebind the referenced cards and Pokémon to the fork before executing.
      const action = { ...a };
      if (a.target) action.target = sim.players.flatMap((x) => sim.allMons(x)).find((m) => m.id === a.target.id);
      try {
        ended = await sim.perform(q, action);
        resolved = true;
        if (allowSearch && !exact && knownDeck.length === q.deck.length) return { alternatives };
      } catch (error) {
        if (!(error instanceof HiddenInformation) && error !== OPPONENT_CHOICE) throw error;
        if (error !== OPPONENT_CHOICE || !sim.hiddenHand.size) return { alternatives };
        ended = true; // A KO was resolved before the opponent chose a replacement.
      }
      const step = { id: actionId(a), answers, action: a, searchCard: known?.id };
      const steps = [...node.steps, step];
      let value = valueOf(sim, q, ended);
      if (resolved && ended && !sim.winner) {
        try {
          await sim.checkup(q);
          if (!sim.winner && !sim.opp(q).deck.length) await sim.startTurn(sim.opp(q));
          value = valueOf(sim, q, ended);
        } catch (error) {
          if (!(error instanceof HiddenInformation) && error !== OPPONENT_CHOICE) throw error;
        }
      }
      if (sim.winner === q) lethal = steps;
      else if (sim.winner === sim.opp(q)) value = -1e6;
      else if (sim.winner === 'draw') value = -rootValue - 25;
      else if (ended && assessReply && hasBudget()) {
        const knownHand = sim.hiddenHand.has(seat) ? sim.knownHand : q.hand;
        const reply = projectPrizeRace(sim, q, knownHand, { ...strategy?.prizeRules, afterTurn: true, attacks: 1 });
        if (reply) value += reply.value * (Math.abs(reply.value) >= 110 ? 0.82 : 0.30);
      }
      const old = node.game.players[seat];
      const returned = q.active?.id !== old.active?.id && old.flags.switchedOut?.includes(q.active?.id);
      const moved = node.moved || (!ended && q.active?.id !== old.active?.id);
      const engineExposure = comparedSwitches && moved && ended && !sim.winner
        ? Math.max(0, strategy.engineExposure(sim, q) - strategy.engineExposure(game, p)) : 0;
      if (compareExchange && ended && !sim.winner && q.active && sim.opp(q).active) {
        const defender = sim.opp(q).active;
        value += activeLineValue(sim, q, { turn: sim.turn + 2, removed: defender.hpLeft <= 0 ? defender : null }) * 0.58;
      }
      const defensiveRetreat = node.defensiveRetreat || move?.necessity?.avoidsKnockout;
      const penalty = (node.penalty || 0) + (returned ? 14 : 0) + (move?.paymentPenalty ?? 0) +
        (strategy?.cost?.(node.game, old, a) ?? 0);
      return { game: sim, steps, alternatives, penalty, moved, defensiveRetreat,
        value: value - penalty - engineExposure - (steps.length - 1) * 1.5, ended,
        expandable: resolved && !ended && !sim.winner && !sim.hiddenHand.has(seat) };
    };

    const tryProbe = async (node, action, replay, move) => {
      try { return await probe(node, action, replay, move); }
      catch (error) {
        if (!(error instanceof HiddenInformation)) throw error;
        return { alternatives: [] };
      }
    };
    const inspect = async (node, action, next, retry, move) => {
      const run = (replay) => tryProbe(node, action, replay, move);
      const record = (result) => {
        if (!result.steps) return;
        if (result.ended || result.game.winner) {
          if (compareSearch && result.steps.length === 1 && action.kind === 'attack' && !loses(result) &&
              prizesTaken(result) > 0 && betterSetup(result, directKnockout)) directKnockout = result;
          if (directAttacks && result.steps.length === 1 && action.kind === 'attack' && !result.game.winner &&
              result.value > (directAttacks.get(action)?.value ?? -Infinity)) directAttacks.set(action, result);
          const stayed = comparedSwitches || compareExchange ? !result.moved : !rootMoves.has(result.steps[0].action);
          if (stayed && (!bestStaying || result.value > bestStaying.value)) bestStaying = result;
          if (!best || result.value > best.value) best = result;
          if (result.steps[0].action === fallback && (!bestFallback || result.value > bestFallback.value)) bestFallback = result;
        } else if (result.expandable) next.push(result);
      };
      const result = await run();
      record(result);
      if (retry) for (const replay of result.alternatives.slice(0, 2)) {
        if (!hasBudget() || lethal) break;
        record(await run(replay));
      }
    };

    const rootNode = { game, steps: [] };
    const prizesTaken = (node) => p.prizes.length - node.game.players[seat].prizes.length;
    const setupValue = (node) => {
      const hand = node.game.hiddenHand.has(seat) ? node.game.knownHand : node.game.players[seat].hand;
      const spent = p.hand.reduce((n, card) => n + (hand.includes(card) ? 0 : card.ttype === 'supporter' || card.aceSpec ? 5 : 3), 0);
      return node.value - spent;
    };
    const loses = (node) => node.game.winner === node.game.opp(node.game.players[seat]) || node.game.winner === 'draw';
    const betterSetup = (a, b) => !b || loses(b) || prizesTaken(a) > prizesTaken(b) ||
      prizesTaken(a) === prizesTaken(b) && setupValue(a) > setupValue(b);
    if (strategy?.setupKnockout && hasBudget()) {
      const routes = knockoutSetups(game, p, actions, hasBudget);
      const available = Math.min(budget.probes, 10);
      const hasSetupBudget = () => probes < available && hasBudget();
      for (const route of routes) {
        let node = rootNode;
        for (const wanted of route) {
          if (!hasSetupBudget()) { node = null; break; }
          const action = node === rootNode ? wanted : simulatedActions(node.game, node.game.players[seat])
            .find((a) => actionId(a) === actionId(wanted));
          if (!action) { node = null; break; }
          const result = await tryProbe(node, action, [], node === rootNode ? rootMoves.get(wanted) : undefined);
          if (!result.expandable) { node = null; break; }
          node = result;
        }
        if (!node) continue;
        const q = node.game.players[seat];
        const foe = game.opp(p).active;
        for (const action of simulatedActions(node.game, q)) {
          if (!hasSetupBudget() || lethal) break;
          if (action.kind !== 'attack') continue;
          const result = await tryProbe(node, action);
          if (!result.steps || loses(result) || prizesTaken(result) <= 0 ||
              result.game.allMons(result.game.opp(result.game.players[seat])).some((m) => m.id === foe.id)) continue;
          setupRoutes.push(setupCards(result.steps));
          if (betterSetup(result, bestSetup)) bestSetup = result;
        }
        if (lethal || !hasSetupBudget()) break;
      }
    }

    let frontier = [rootNode];
    for (let depth = 0; depth <= budget.depth && frontier.length && hasBudget() && !lethal; depth++) {
      const next = [];
      for (const node of frontier) {
        if (!hasBudget() || lethal) break;
        const q = node.game.players[seat];
        let list = root;
        if (depth) {
          try {
            if (deck && q.deck.length < deck.length) node.plan = planAttacker(node.game, q, plan?.name, knownPrizes, strategy?.attacker);
            list = describe(node.game, q, this.actionCandidates(node.game, q, simulatedActions(node.game, q)), node.plan);
          }
          catch (error) {
            if (!(error instanceof HiddenInformation)) throw error;
            continue;
          }
        }
        const hasAttack = list.some(({ action }) => action.kind === 'attack');
        const finish = list.filter(({ action }) => action.kind === 'attack' ||
          (action.kind === 'end' && (node.game.opp(q).active?.status.poisoned || !node.game.opp(q).deck.length ||
            (comparedSwitches && (depth === 0 || node.moved) && !hasAttack) ||
            (compareExchange && !hasAttack && (depth > 0 || fallback.kind === 'end')) ||
            (!hasAttack && (node.defensiveRetreat || defending && depth === 0 && fallback.kind === 'end')))));
        if (!node.game.opp(q).deck.length) finish.sort((a, b) => Number(b.action.kind === 'end') - Number(a.action.kind === 'end'));
        for (const { action } of finish) {
          if (!hasBudget() || lethal) break;
          await inspect(node, action, next, true);
        }
        if (depth === budget.depth || lethal) continue;
        const setup = list.filter(({ action: a, move }) => move || a.kind === 'energy' || a.kind === 'evolve' || a.kind === 'bench' ||
          (a.kind === 'trainer' && this.tacticalTrainer(a)) || a.kind === 'power' || a.kind === 'stadium' ||
          (deck && canSearchKnownDeck(a, deck.cards.length === deck.length)))
          .map(({ action, score: base, move }) => ({ action, move,
            priority: priority(node.game, q, action, base, move, strategy?.exactEnergy) +
              (move?.necessity?.avoidsKnockout ? 22 : 0) }))
          .sort((a, b) => b.priority - a.priority);
        const size = depth ? 3 : 6;
        const shortlist = strategy?.shortlist?.(setup, size) ?? setup.slice(0, size);
        if (compareExchange && depth === 0 && !hasAttack) {
          const preparation = setup.find(({ action }) => !list.find((row) => row.action === action)?.move);
          if (preparation && !shortlist.includes(preparation)) shortlist.push(preparation);
        }
        const baseline = !depth && setup.find(({ action }) => action === fallback);
        if (baseline && !shortlist.includes(baseline)) shortlist.push(baseline);
        for (const { action, move } of shortlist) {
          if (!hasBudget() || lethal) break;
          await inspect(node, action, next, depth === 0, move);
        }
      }
      next.sort((a, b) => b.value - a.value);
      frontier = next.slice(0, budget.width);
      if (compareExchange && frontier.length && frontier.every((node) => node.moved === frontier[0].moved)) {
        const other = next.find((node) => node.moved !== frontier[0].moved);
        if (other && budget.width > 1) frontier.splice(budget.width - 1, 1, other);
      }
    }

    if (lethal) {
      const [step, ...steps] = lethal;
      const searched = deck ? new Map() : undefined;
      if (steps.length) this.lines.set(game, { seat, turn: game.turn, steps, searched });
      return this.play(game, p, step.action, step, 'lethal', searched);
    }
    if (bestSetup && best?.game.winner !== p && betterSetup(bestSetup, best) && setupValue(bestSetup) > rootValue) {
      const [step, ...steps] = bestSetup.steps;
      this.lines.set(game, { seat, turn: game.turn, steps, reason: 'setup-knockout' });
      return this.play(game, p, step.action, step, 'setup-knockout');
    }
    if (directKnockout && (!best || betterSetup(directKnockout, best) || directKnockout === best)) {
      const [step] = directKnockout.steps;
      return this.play(game, p, step.action, step, 'setup-knockout');
    }
    const pick = (action, step, reason) => {
      const direct = directAttacks?.get(action);
      if (direct) {
        const attack = game.attacksOf(p.active)[action.index];
        const draw = prepareAttackDraw(game, p, actions, attack, plan, knownPrizes);
        // Drawing stays probabilistic. Compare it to the completed attack line, and search again
        // after the actual draw. It never supplies cards or proves a win in a fork.
        if (draw && direct.value + draw.benefit >= (best?.value ?? direct.value)) {
          return this.play(game, p, draw.action, null, 'planned-draw');
        }
      }
      return this.play(game, p, action, step, reason, undefined, setupRoutes.length ? setupRoutes : undefined);
    };
    if (!p.deck.length && root[0].redraw?.deckAfter > 0 ||
        race?.search?.source === fallback || closingDraw?.action === fallback) return pick(fallback, null, 'policy');
    if (strategy?.chanceFinish && root[0].finishChance >= 0.5 &&
        !best?.steps.some((step) => step.action.kind === 'attack' && step.action.index === fallback.index)) {
      return this.play(game, p, fallback, null, 'chance-finish');
    }
    if (compareExchange) {
      const move = root.find(({ action }) => action === (best?.steps[0].action ?? fallback) && rootMoves.has(action)) ??
        (rootMoves.has(fallback) ? root[0] : null);
      const prep = move && preparationBeforeSwitch(game, p, root, plan, knownPrizes, move);
      if (prep) return this.play(game, p, prep, null, 'prepare-before-switch');
    }
    const reserve = strategy?.reserveEnergy && fallback.kind === 'energy' && fallback.target === p.active &&
      root[0].reserve >= 10;
    if (bestStaying && best && (comparedSwitches || compareExchange ? best.moved : rootMoves.has(best.steps[0].action)) &&
        best.value < bestStaying.value + 7) {
      best = bestStaying;
    }
    if (bestStaying && bestFallback && rootMoves.has(fallback) && bestFallback.value < bestStaying.value + 7) {
      const step = best.steps[0];
      return pick(step.action, step, 'tactical');
    }
    if (best && (best.steps[0].action === fallback ||
        (bestFallback && best.value >= bestFallback.value + (strategy?.tacticalMargin ?? 8)) ||
        (!bestFallback && best.value >= rootValue + (fallback.kind === 'attack' ? 24 : 76)))) {
      const step = best.steps[0];
      if (!reserve || step.action.kind !== 'attack' || best.value >= (bestFallback?.value ?? best.value) + 14) {
        return pick(step.action, step, 'tactical');
      }
    }
    return pick(fallback, null, reserve ? 'energy-reserve' : 'policy');
  }
}
