// Resolve short lines with the game engine. Ratings only decide which unresolved lines to try first.
import { actionStep, answerId, fork, HiddenInformation, promptId, simulatedActions } from './ai-hard.js';
import { readyDamage } from './ai-combat.js';
import { canSearchKnownDeck, confirmedDeck } from './ai-search.js';
import { checkupDamage } from './ai-v3-targets.js';

const forcedSwitches = new Set(['escapeRope', 'warpPoint', 'ryme']);
const accelerators = new Set(['sadaVitality', 'melony', 'mela', 'darkPatch', 'aquaPatch', 'metalSaucer',
  'energySwitch', 'wondrousPatch', 'scrambleSwitch']);
const boosts = new Set(['plusPower', 'powerTablet', 'premiumPowerPro', 'leon', 'misty', 'koga', 'professorKukui', 'heatBoost']);
const removals = new Set(['fieldBlower', 'toolScrapper', 'fanOfWaves', 'energyRemoval', 'superEnergyRemoval']);
const rescues = new Set(['scoopUpNet', 'turoScenario', 'pokemonCenterLady', 'switchCart', 'switch', 'switchRaft',
  'potion', 'potion30', 'superPotion', 'defender', 'pokemonCenter']);
const gusts = new Set(['gust', 'bossOrders', 'primeCatcher', 'counterCatcher', 'guzma', 'pokemonCatcher']);
const pause = Symbol('unresolved');
const isAttackOrEnd = (a) => a.kind === 'attack' || a.kind === 'end';

function priority(game, p, action, checkupDanger, closing) {
  const { kind, tkind, pkind, target } = action;
  const key = tkind ?? pkind;
  if (isAttackOrEnd(action)) return 0;
  if (checkupDanger && (rescues.has(key) || forcedSwitches.has(key) || kind === 'retreat' || key === 'tool' ||
      kind === 'evolve' || kind === 'bench' || removals.has(key))) return 10;
  if (!closing) return 0;
  if (boosts.has(key) && !game.attacksOf(p.active).some((atk) => game.canUseAttack(p, p.active, game.opp(p).active, atk))) return 0;
  if (forcedSwitches.has(key) || boosts.has(key) || gusts.has(key) || accelerators.has(key) ||
      removals.has(key) || rescues.has(key) || key === 'stadium') return 8;
  if (key === 'tool') return target === p.active ? 8 : 5;
  if (kind === 'energy') return target === p.active ? 7 : 4;
  if (kind === 'retreat' || kind === 'evolve' || key === 'rareCandy') return 6;
  if (kind === 'power' && target === p.active) return 3;
  if (canSearchKnownDeck(action, true)) return 2;
  return 0;
}

export function checkupThreat(game, p) {
  const foe = game.opp(p);
  return p.active.hpLeft <= checkupDamage(p.active) &&
    (!p.bench.length || (game.modern ? game.prizeValue(p, p.active, { damage: false }) : 1) >= foe.prizes.length);
}

export function visibleLosingReply(game, p) {
  const foe = game.opp(p);
  if (!foe.deck.length) return checkupThreat(game, p);
  if (checkupThreat(game, p)) return true;
  const target = p.active;
  const prizes = game.modern ? game.prizeValue(p, target, { by: foe.active, damage: true, active: true }) : 1;
  return (!p.bench.length || prizes >= foe.prizes.length) &&
    readyDamage(game, foe.active, target, undefined, { turn: game.turn + 1, certain: true }) >= target.hpLeft - 2 * checkupDamage(target);
}

// A result only counts as a win when the engine completed the line. Hidden cards drawn by
// mixed effects have no playable identity. The real turn is replanned after a new board is revealed.
export async function verifyTactics(policy, game, p, legal) {
  const foe = game.opp(p);
  if (legal.length < 2 || !p.active || !foe.active || !policy.budget.probes) return null;
  const closing = game.turn > 1 && (p.prizes.length <= 3 || !foe.bench.length || p.deck.length <= 3);
  const checkupDanger = !foe.deck.length && checkupThreat(game, p);
  if (!closing && !checkupDanger) return null;
  if (!legal.some((a) => priority(game, p, a, checkupDanger, closing) >= 8 ||
      p.deck.length <= 3 && canSearchKnownDeck(a, true))) return null;
  const deck = p.deck.length <= 3 && legal.some((a) => canSearchKnownDeck(a, true))
    ? confirmedDeck(game, p, policy.prizes.get(game)) : null;
  const started = performance.now();
  const deadline = started + Math.min(6, policy.budget.milliseconds);
  let probes = Math.min(42, policy.budget.probes + 8);
  const minimum = probes - Math.min(16, policy.budget.probes);
  const available = () => probes > 0 && (probes > minimum || performance.now() < deadline);
  const seat = p.idx;
  const win = (steps, probability = 1) => ({ steps, probability });

  async function resolve(board, action, remaining, replay = [], catcherHeads = false) {
    if (!available()) return null;
    probes--;
    const ownAnswers = [];
    let promptIndex = 0, pending;
    const known = 'confirmedDeck' in board ? board.confirmedDeck : deck;
    const canSearch = !!known && canSearchKnownDeck(action, known.cards.length === known.length);
    const sim = fork(board, seat, (state, side, prompt) => {
      const options = prompt.options.filter((o) => !o.card?.simulatedDraw &&
        (!o.card?.simulatedSearch || !known?.ambiguousNames.has(o.card.name)));
      if (!options.length) throw pause;
      if (options.length === 1 && !options[0].card?.simulatedSearch) return options[0].id;
      const index = promptIndex++;
      let choice = options.find((o) => answerId(o) === replay[index]);
      const own = side.idx === seat;
      if (!choice) {
        if (replay.length > index) throw pause;
        if (own) {
          const current = { ...prompt, options };
          const ranked = policy.rankPrompt(state, side, current, action);
          const preferred = ranked?.[0] ?? options.find((o) => o.id === policy.pickCPU(state, side, current)) ?? options[0];
          if (index < 4) {
            const others = [...new Set([...(ranked ?? []), ...options])].filter((o) => o !== preferred);
            pending = { index, own, options: [preferred, ...others].slice(0, prompt.kind === 'search' ? 3 : 5) };
            throw pause;
          }
          choice = preferred;
        } else {
          if (index >= 4) throw pause;
          pending = { index, own, options };
          throw pause;
        }
      }
      if (own) ownAnswers.push([promptId(prompt), answerId(choice)]);
      return choice.id;
    }, known, canSearch, true);
    if (action.tkind === 'pokemonCatcher') {
      const flip = sim.flip.bind(sim);
      sim.flip = (why, ...args) => {
        if (why !== 'trainer') return flip(why, ...args);
        if (!catcherHeads) { pending = { coin: true }; throw pause; }
        return true;
      };
    }
    const q = sim.players[seat];
    const mapped = { ...action };
    if (action.target) mapped.target = sim.players.flatMap((side) => sim.allMons(side)).find((mon) => mon.id === action.target.id);
    try {
      const ended = await sim.perform(q, mapped);
      if (ended && !sim.winner) {
        await sim.checkup(q);
        const next = sim.opp(q);
        if (!sim.winner && !next.deck.length) await sim.startTurn(next);
      }
      const step = actionStep(action, ownAnswers);
      if (sim.winner === q) return win([step]);
      if (sim.winner || ended || remaining < 0 || sim.hiddenHand.has(seat)) return null;
      if (canSearch && known.cards.length !== known.length && sim.confirmedDeck?.length === known.length) return null;
      const follow = await find(sim, q, remaining - 1);
      return follow && win([step, ...follow.steps], follow.probability);
    } catch (error) {
      // The ordinary fork stops at hidden information. Other engine errors still surface.
      if (error !== pause && !(error instanceof HiddenInformation)) throw error;
      if (!pending) return null;
    }
    if (pending.coin) {
      const heads = await resolve(board, action, remaining, replay, true);
      return heads && win(heads.steps, heads.probability * 0.5);
    }
    const { index, own, options } = pending;
    if (own) {
      let best = null;
      for (const option of options) {
        const result = await resolve(board, action, remaining, [...replay.slice(0, index), answerId(option)], catcherHeads);
        if (result?.probability === 1) return result;
        if (result && (!best || result.probability > best.probability)) best = result;
        if (!available()) break;
      }
      return best;
    }

    const branches = [];
    for (const option of options) {
      const result = await resolve(board, action, remaining, [...replay.slice(0, index), answerId(option)], catcherHeads);
      if (!result || result.probability !== 1) return null;
      branches.push({ option, result });
    }
    // Only commit the current action. The continuation can depend on which Pokémon was promoted.
    // In a forced switch the answer to our promotion prompt can depend on their choice.
    if (!forcedSwitches.has(action.tkind)) return action.kind === 'end' && !ownAnswers.length ? win([actionStep(action, [])]) : null;
    const answers = [...ownAnswers];
    const promotion = new Map();
    for (const { option, result } of branches) {
      const answer = result.steps[0].answers.find(([prompt]) => prompt === promptId({ kind: 'promote', text: 'prompt.q.warpYou' }));
      if (answer) {
        const actives = board.players.map((side) => (side.idx === seat ? side.active : option.mon).stack[0].uid);
        promotion.set(actives.join('/'), answer[1]);
      }
    }
    if (promotion.size) answers.push([promptId({ kind: 'promote', text: 'prompt.q.warpYou' }), null, promotion]);
    return win([actionStep(action, answers)]);
  }

  async function find(board, side, remaining, root = false) {
    let actions;
    try { actions = root ? legal : simulatedActions(board, side); }
    catch (error) {
      if (!(error instanceof HiddenInformation)) throw error;
      return null;
    }
    const opponent = board.opp(side);
    const finish = actions.filter((a) => a.kind === 'attack' || a.kind === 'end' &&
      (!opponent.deck.length || checkupDamage(opponent.active) >= opponent.active?.hpLeft));
    if (!opponent.deck.length) finish.sort((a, b) => Number(b.kind === 'end') - Number(a.kind === 'end'));
    for (const action of finish) {
      const result = await resolve(board, action, -1);
      if (result?.probability === 1) return result;
    }
    if (remaining < 0) return null;
    const preparatory = actions.map((action) => ({ action, weight: priority(board, side, action, checkupDanger, closing) }))
      .filter(({ action, weight }) => weight && (deck || !canSearchKnownDeck(action, true) || weight >= 8))
      .sort((a, b) => b.weight - a.weight);
    let chance = null;
    for (const { action } of preparatory.slice(0, root ? 10 : 6)) {
      if (!available()) break;
      if (action.tkind === 'pokemonCatcher' && (!root || !visibleLosingReply(board, side) ||
          finish.some((a) => a.kind === 'attack' && readyDamage(board, side.active, board.opp(side).active,
            undefined, { certain: true }) >= board.opp(side).active.hpLeft))) continue;
      const result = await resolve(board, action, remaining);
      if (result?.probability === 1) return result;
      if (result && (!chance || result.probability > chance.probability)) chance = result;
    }
    return chance;
  }

  const result = await find(game, p, 1, true);
  return { ...result, elapsed: performance.now() - started };
}
