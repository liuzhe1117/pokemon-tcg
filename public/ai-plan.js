// A deck plan is a preferred attacker and the next missing pieces of its setup.
// Unseen counts cover both the deck and face-down Prizes.
import { CARDS, DECKS } from './cards.js';
import { isType } from './engine.js';

const searchTargets = {
  nestBall: 'basic', buddyPoffin: 'smallBasic', quickBall: 'basic', ultraBall: 'pokemon',
  greatBall: 'pokemon', pokeBall: 'pokemon', levelBall: 'lowHP', pokePad: 'noRuleBox',
  evolutionIncense: 'evolution', jacq: 'evolution', pokemonFanClub: 'basic', sonia: 'basicOrEnergy',
  arven: 'itemOrTool', trPetrel: 'trainer', trProton: 'basic', hilda: 'evolutionOrEnergy',
  energySearch: 'energy', earthenVessel: 'energy', lady: 'energy', capaciousBucket: 'waterEnergy',
  energyLoto: 'energy', fogCrystal: 'psychicBasicOrEnergy', fightingGong: 'fightingBasicOrEnergy',
  rareCandy: 'candy', nightStretcher: 'discard', superRod: 'recycle',
  dawn: 'pokemon', brocksScouting: 'pokemon', irida: 'waterOrItem', energySpinner: 'energy',
};

const abilitySearch = {
  quickSearch: 'any', precognitiveAura: 'any', starAlchemy: 'any', smoothOver: 'any',
  cottonLift: 'energy', shiveryChill: 'waterEnergy', tandemUnit: 'lightningBasic',
  rapidStrikeSearch: 'rapidStrike', illuminate: 'grassPokemon', queensCall: 'noGXorEX',
  evolutionRoar: 'perrserker',
};
const accelerators = {
  roaringResolve: 'Fire', electrogenesis: 'Lightning', magneticAbsorption: 'Fighting',
  psychicEmbrace: 'Psychic', clairvoyantSense: 'Psychic', magneticCircuit: 'Lightning',
  dynamotor: 'Lightning', starPortal: 'Water', infernalReign: 'Fire',
};
const handReset = new Set(['lilliesDetermination', 'iono', 'judge', 'marnie', 'roxanne', 'copycat', 'cynthia', 'youngster',
  'shauna', 'tateLiza', 'professorOak', 'professorsResearch']);
const drawAbilities = new Set(['rumblingEngine', 'concealedCards', 'refinement', 'restart', 'industriousIncisors',
  'flipTheScript', 'lunarCycle', 'reconDirective', 'flaringMagic', 'makeDo', 'fusionStrikeSystem', 'shiningArcana',
  'powerDraw', 'sprint', 'slushRush', 'roastReveal', 'runErrand', 'trade']);
const plainDraw = new Set(['bill', 'nemona', 'hop', 'barry', 'hau', 'grantDraw', 'zisu', 'irisFightingSpirit']);
const engineValue = {
  quickSearch: 34, refinement: 29, reconDirective: 27, clairvoyantSense: 24, concealedCards: 24,
  industriousIncisors: 28, rumblingEngine: 23, makeDo: 24, restart: 18,
  trade: 22, stellarWish: 23, attractCustomers: 18, shiningArcana: 23, slushRush: 18,
  magneticCircuit: 19, dynamotor: 21, sinisterSurge: 21, psychicEmbrace: 26, firestarter: 22,
  superCold: 22, iceDance: 22, shiveryChill: 17, lunarCycle: 18, tandemUnit: 35,
};
const benchEntry = new Set(['luminousSign', 'crobatDraw', 'dedechange', 'supportNavigation', 'summoningGate']);

export function supportValue(game, mon) {
  const value = mon.card.powerKind === 'flipTheScript' ? 18 : engineValue[mon.card.powerKind] || 0;
  return value && game.powerOn(mon) ? value : 0;
}

const matchesSearch = {
  any: () => true,
  basic: (c) => c.kind === 'pokemon' && c.stage === 0,
  smallBasic: (c) => c.kind === 'pokemon' && c.stage === 0 && c.hp <= 70,
  pokemon: (c) => c.kind === 'pokemon',
  lowHP: (c) => c.kind === 'pokemon' && c.hp <= 90,
  noRuleBox: (c) => c.kind === 'pokemon' && !c.ruleBox,
  evolution: (c) => c.kind === 'pokemon' && c.stage > 0,
  energy: (c) => c.kind === 'energy' && !c.special,
  waterEnergy: (c) => c.kind === 'energy' && !c.special && c.energyType === 'Water',
  itemOrTool: (c) => c.ttype === 'item' || c.ttype === 'tool',
  trainer: (c) => c.kind === 'trainer',
  basicOrEnergy: (c) => matchesSearch.basic(c) || matchesSearch.energy(c),
  evolutionOrEnergy: (c) => matchesSearch.evolution(c) || matchesSearch.energy(c),
  psychicBasicOrEnergy: (c) => (matchesSearch.basic(c) && c.type === 'Psychic') || (matchesSearch.energy(c) && c.energyType === 'Psychic'),
  fightingBasicOrEnergy: (c) => (matchesSearch.basic(c) && c.type === 'Fighting') || (matchesSearch.energy(c) && c.energyType === 'Fighting'),
  waterOrItem: (c) => (c.kind === 'pokemon' && c.type === 'Water') || c.ttype === 'item',
  lightningBasic: (c) => matchesSearch.basic(c) && c.type === 'Lightning',
  rapidStrike: (c) => c.tags?.includes('Rapid Strike'),
  grassPokemon: (c) => c.kind === 'pokemon' && c.type === 'Grass',
  noGXorEX: (c) => c.kind === 'pokemon' && !c.tags?.some((t) => t === 'GX' || t === 'EX'),
  perrserker: (c) => c.name === 'Galarian Perrserker',
};

const catalogs = new Map();
export function deckCatalog(p) {
  if (!catalogs.has(p.deckKey)) {
    const list = Object.entries(DECKS[p.deckKey]?.list || {}).map(([id, count]) => [CARDS[id], count]).filter(([card]) => card);
    catalogs.set(p.deckKey, { list, pokemon: new Map(list.filter(([c]) => c.kind === 'pokemon').map(([c]) => [c.name, c])) });
  }
  return catalogs.get(p.deckKey);
}

function evolutionChain(card, pokemon) {
  const parent = pokemon.get(card.evolvesFrom);
  return [parent?.stage ? pokemon.get(parent.evolvesFrom) : null, parent, card].filter(Boolean);
}

export function openingScore(game, p, card, choices) {
  const { list, pokemon } = deckCatalog(p);
  const energy = p.hand.filter((c) => c.kind === 'energy');
  const future = list.filter(([c]) => c.kind === 'pokemon' && c.stage && evolutionChain(c, pokemon)[0]?.name === card.name);
  const attack = Math.max(0, ...(card.attacks || []).map((atk) => {
    const now = energyMissing([], atk.cost) === 0 || energy.some((c) => energyMissing(attachedTypes(c), atk.cost) === 0);
    const pressure = Math.min(95, atk.base) * 0.42 + (atk.fx.draw || atk.fx.callFamily || atk.fx.callFriend ? 18 : 0) +
      (atk.fx.status || atk.fx.flipStatus ? 9 : 0);
    return pressure * (now ? 1 : atk.cost.length === 1 ? 0.30 : 0.10);
  }));
  const second = game.first !== p;
  const benchEngine = future.some(([c]) => engineValue[c.powerKind] >= 22) && choices.length > 1;
  const switchInHand = p.hand.some((c) => c.tkind === 'switch' || c.tkind === 'switchCart');
  return card.hp * 0.22 - card.retreat * (switchInHand ? 5 : 8) + (card.retreat === 0 ? 11 : 0) +
    attack * (second ? 1.3 : 0.65) + (card.powerKind === 'electricStart' && second ? 22 : 0) +
    (card.powerKind === 'attractCustomers' ? 13 : 0) + (card.powerKind === 'tandemUnit' ? 12 : 0) -
    (benchEngine ? 7 : 0) - (benchEntry.has(card.powerKind) ? 11 : 0) -
    (game.modern && choices.length > 1 ? Math.max(0, (card.prizes || 1) - 1) * 7 : 0);
}

export function openingBench(game, p, basics) {
  const { list, pokemon } = deckCatalog(p);
  const inPlay = new Set([p.active?.name]);
  const cards = [];
  while (cards.length < 4 && cards.length < basics.length) {
    const ranked = basics.filter((c) => !cards.includes(c)).map((card) => {
      const lines = list.map(([c]) => c).filter((c) => c.kind === 'pokemon' && c.stage &&
        evolutionChain(c, pokemon)[0]?.name === card.name);
      const support = Math.max(engineValue[card.powerKind] || 0, ...lines.map((c) => engineValue[c.powerKind] || 0));
      const line = lines.length ? 14 + (p.hand.some((c) => lines.some((form) => c.name === form.name)) ? 7 : 0) : 0;
      const utility = card.hp * 0.08 + line + support * 0.55 -
        (inPlay.has(card.name) ? (game.modern ? 16 : 11) : 0) - (benchEntry.has(card.powerKind) ? 25 : 0) -
        (game.modern ? Math.max(0, (card.prizes || 1) - 1) * 9 : 0);
      return { card, utility };
    }).sort((a, b) => b.utility - a.utility);
    const best = ranked[0];
    if (cards.length && best.utility < (game.modern ? 9 + cards.length * 4 : 9 + cards.length * 2)) break;
    cards.push(best.card);
    inPlay.add(best.card.name);
  }
  return cards.map((c) => c.uid);
}

export function energyMissing(energy, cost) {
  const pool = [...energy];
  let missing = 0;
  for (const type of cost.filter((t) => t !== 'Colorless')) {
    let i = pool.indexOf(type);
    if (i < 0) i = pool.findIndex((t) => isType(t, type));
    if (i < 0) missing++;
    else pool.splice(i, 1);
  }
  return missing + Math.max(0, cost.filter((t) => t === 'Colorless').length - pool.length);
}

const attackStrength = (a) => a.base + (a.fx.spread ? 20 : 0) + (a.fx.plusOwnBench || a.fx.plusDefEnergy || a.fx.plusSelfCounters ? 30 : 0);
const attachedTypes = (card) => Array(card.provides || 1).fill(card.energyType);
const compatibleEnergy = (card, attack, energy) => card.kind === 'energy' &&
  energyMissing([...energy, ...attachedTypes(card)], attack.cost) < energyMissing(energy, attack.cost);

export function unseenCardCounts(game, p, list) {
  const visible = [...p.hand, ...p.discard, ...(p.lost || []), ...game.allMons(p).flatMap((m) => m.allCards())];
  if (game.stadium?.owner === p.idx) visible.push(game.stadium.card);
  const counts = new Map(list.map(([c, count]) => [c.id, count]));
  for (const card of visible) counts.set(card.id, (counts.get(card.id) || 0) - 1);
  return counts;
}

export function observePrizeCounts(game, p, deckCounts) {
  const counts = unseenCardCounts(game, p, deckCatalog(p).list);
  for (const [id, count] of deckCounts) counts.set(id, (counts.get(id) || 0) - count);
  const remaining = [...counts.values()];
  if (remaining.some((count) => count < 0) || remaining.reduce((a, b) => a + b, 0) !== p.prizes.length) return null;
  return counts;
}

export function planAttacker(game, p, previous, prizes, tuning) {
  const { list, pokemon } = deckCatalog(p);
  const board = game.allMons(p);
  const unseen = unseenCardCounts(game, p, list);
  if (prizes) for (const [id, count] of prizes) unseen.set(id, (unseen.get(id) || 0) - count);
  const handNames = new Set(p.hand.map((c) => c.name));
  const available = (c) => handNames.has(c.name) || (unseen.get(c.id) || 0) > 0;
  const candy = list.find(([c]) => c.tkind === 'rareCandy')?.[0];
  let best = null;

  for (const [card] of list) {
    if (card.kind !== 'pokemon' || !card.attacks.length) continue;
    const chain = evolutionChain(card, pokemon);
    const parent = chain.at(-2), basic = parent && chain[0].stage === 0 ? chain[0] : null;
    const candidates = board.filter((m) => chain.some((c) => m.name === c.name));
    const mon = candidates.sort((a, b) => b.card.stage - a.card.stage || b.energyTypes.length - a.energyTypes.length)[0];
    const candyRoute = card.stage === 2 && basic && candy && available(candy) &&
      (!mon || mon.name === basic.name) && (!parent || !handNames.has(parent.name));
    const path = candyRoute ? [basic, card] : chain;
    const steps = path.slice(mon ? path.findIndex((c) => c.name === mon.name) + 1 : 0);
    const pieces = candyRoute ? [...steps, candy] : steps;
    const missing = pieces.filter((c) => !handNames.has(c.name));
    if (missing.some((c) => !available(c))) continue;
    const attached = mon?.payTypes || [];
    const firesInDeck = card.powerKind === 'infernalReign' && steps.includes(card)
      ? list.reduce((n, [c]) => n + (c.kind === 'energy' && !c.special && c.energyType === 'Fire'
        ? Math.max(0, unseen.get(c.id) || 0) : 0), 0) : 0;
    const energy = [...attached, ...Array(Math.min(p.deck.length, firesInDeck, 3)).fill('Fire')];

    for (const attack of card.attacks) {
      const power = attackStrength(attack);
      if (!power) continue;
      const gap = energyMissing(energy, attack.cost);
      const haveEnergy = p.hand.some((c) => compatibleEnergy(c, attack, energy));
      const score = power * 0.38 + card.hp * 0.05 - steps.length * 10 - missing.length * 9 - gap * 9 +
        (mon ? 12 + mon.hpLeft / 18 : 0) + (mon === p.active && !steps.length && !gap ? 9 : 0) +
        (haveEnergy ? 4 : 0) + (previous === card.name ? 4 : 0) +
        (tuning?.(game, p, { card, mon, attack, power, gap, steps, missing, haveEnergy }) ?? 0);
      if (best && best.score >= score) continue;
      best = { card, mon, attack, path, pieces, missing, energy, gap, score, unseen };
    }
  }
  if (!best) return null;

  let support;
  if (game.turn > 0 && game.turn <= 9) {
    const primary = best.path[0]?.name;
    for (const [card] of list) {
      if (!engineValue[card.powerKind] || board.some((m) => m.name === card.name) || !available(card)) continue;
      const chain = evolutionChain(card, pokemon);
      if (chain[0].name === primary) continue;
      const developed = chain.findLastIndex((c) => board.some((m) => m.name === c.name));
      if (developed < 0 && (chain[0].stage > 0 || p.bench.length >= 5)) continue;
      const canCandy = card.stage === 2 && chain[0].stage === 0 && developed <= 0 && candy && available(candy) &&
        !handNames.has(chain[1]?.name);
      const pieces = canCandy ? [...(developed < 0 ? [chain[0]] : []), card] : chain.slice(developed + 1);
      const resources = canCandy ? [...pieces, candy] : pieces;
      if (!resources.every(available)) continue;
      const missing = resources.filter((c) => !handNames.has(c.name));
      const value = engineValue[card.powerKind] - missing.length * 6 - (pieces.length - 1) * 5 + (developed >= 0 ? 6 : 0);
      if (value >= 9 && value > (support?.value || 0)) support = { pieces, resources, missing, value };
    }
  }

  const basic = best.path[0];
  const backup = best.mon === p.active && best.card.stage > 0 && basic?.stage === 0 &&
    game.turn >= 3 && game.turn <= 10 && p.bench.length < 4 && p.prizes.length >= 3 &&
    !p.bench.some((m) => m.stack[0].name === basic.name) && available(best.card) && available(basic) ? basic : null;
  const isNeededEnergy = (c) => compatibleEnergy(c, best.attack, best.energy);
  const holdsEnergy = p.hand.some(isNeededEnergy);
  const heldPieces = best.pieces.length - best.missing.length;
  const primaryTarget = (c) => best.missing.some((x) => x.id === c.id) || (!holdsEnergy && isNeededEnergy(c));
  const wanted = (c) => primaryTarget(c) || support?.missing.some((x) => x.id === c.id) ||
    (backup?.id === c.id && !handNames.has(c.name));
  const targets = list.map(([c]) => c).filter((c) => p.deck.length > 0 && (unseen.get(c.id) || 0) > 0 && wanted(c));
  const findsTarget = (card) => {
    const matches = matchesSearch[searchTargets[card.tkind]];
    return !!matches && targets.some(matches);
  };
  const hasDirectSearch = p.hand.some(findsTarget);
  const enablers = hasDirectSearch ? [] : list.map(([c]) => c).filter((c) => (unseen.get(c.id) || 0) > 0 && findsTarget(c));
  return {
    name: best.card.name,
    setupTargets: targets.filter((c) => c.kind === 'pokemon' && c.stage === 0 && !board.some((m) => m.name === c.name))
      .map((c) => ({ card: c, unseen: Math.max(0, unseen.get(c.id) || 0) })),
    isTarget: (m) => !!m && best.mon?.stack[0]?.uid === m.stack[0]?.uid,
    searchPriority(card) {
      if (best.missing.some((c) => c.id === card.id)) {
        return 23 + (best.missing[0]?.id === card.id ? 7 : 0);
      }
      if (isNeededEnergy(card) && !holdsEnergy) return 19;
      if (support?.missing.some((c) => c.id === card.id)) return support.missing[0].id === card.id ? 22 : 13;
      if (backup?.id === card.id && !handNames.has(card.name)) return 14;
      return findsTarget(card) ? 13 : 0;
    },
    keepPriority(card) {
      if (best.pieces.some((c) => c.name === card.name)) return 15;
      if (isNeededEnergy(card)) return 9;
      if (support?.resources.some((c) => c.name === card.name)) return 8;
      if (backup?.id === card.id) return 6;
      return 0;
    },
    actionPriority(action) {
      const { kind, card, target } = action;
      if (kind === 'evolve' && best.path.some((c) => c.name === card.name)) return 14;
      if (kind === 'bench' && !best.mon && best.path[0]?.name === card.name) return 15;
      if ((kind === 'bench' || kind === 'evolve') && support?.pieces[0]?.name === card.name) return 15;
      if (kind === 'bench' && backup?.id === card.id) return 12;
      if (kind === 'energy' && target === best.mon && isNeededEnergy(card)) return 18;
      if (kind === 'trainer') {
        const search = matchesSearch[searchTargets[card.tkind]];
        if (search && targets.some((c) => search(c) && primaryTarget(c))) return 28;
        if (search && targets.some(search)) return 15;
        if (search && enablers.some((c) => c.tkind !== card.tkind && search(c))) return 13;
        if (handReset.has(card.tkind) && p.deck.length > 6) {
          if (heldPieces) return -Math.min(25, heldPieces * 15);
          if ((best.missing.length || (best.gap && !holdsEnergy)) && p.hand.length <= 4) return 18;
        }
        if (card.tkind === 'rareCandy' && best.pieces.includes(candy) && p.hand.some((c) => c.name === best.card.name)) return 16;
        if (card.tkind === 'rareCandy' && support?.pieces.some((c) => c.name === action.evo?.name)) return 11;
        if (searchTargets[card.tkind] === 'discard' && p.discard.some((c) =>
          best.pieces.some((piece) => piece.name === c.name) && !handNames.has(c.name))) return 33;
      }
      if (kind === 'power') {
        const search = matchesSearch[abilitySearch[action.pkind]];
        if (search) {
          const findsPiece = targets.some(search);
          if (action.vstar) return findsPiece ? 42 : -65;
        if (action.pkind === 'smoothOver' && !p.hand.some((c) => plainDraw.has(c.tkind)) &&
              !board.some((m) => drawAbilities.has(m.card.powerKind) && m !== target && game.powerOn(m))) return findsPiece ? 8 : -10;
          return targets.some((c) => search(c) && primaryTarget(c)) ? 30 : findsPiece ? 17 : 0;
        }
        const type = accelerators[action.pkind];
        if (type && best.mon && best.gap && (target === best.mon ||
            ['clairvoyantSense', 'magneticCircuit', 'dynamotor', 'starPortal'].includes(action.pkind)) &&
            energyMissing([...best.energy, type], best.attack.cost) < best.gap) return 26;
        if (drawAbilities.has(action.pkind) && p.deck.length > 6 && !heldPieces &&
            (best.missing.length || (best.gap && !holdsEnergy))) return p.hand.length <= 4 ? 14 : 0;
      }
      return 0;
    },
  };
}

const extraDraw = { bill: 2, nemona: 3, hop: 3, barry: 3, hau: 3 };

// Keep a one-target search available until a draw narrows which Basics are missing.
export function sequenceSetup(game, p, rows, plan, prizes) {
  const targets = plan?.setupTargets;
  if (game.turn > 6 || p.bench.length > 3 || !targets?.length || p.deck.length <= 8) return new Set();
  const wants = new Set(targets.map(({ card }) => card.name));
  const delayed = new Set();
  for (const row of rows) {
    const { action } = row;
    const artazon = action.kind === 'stadium' && action.stadium === 'artazon';
    if (!artazon && action.tkind !== 'nestBall') continue;
    const reachable = targets.filter(({ card }) => !artazon || !card.ruleBox);
    if (!reachable.length) continue;
    const count = reachable.reduce((n, { unseen }) => n + unseen, 0);
    const unknown = p.deck.length + (prizes ? 0 : p.prizes.length);
    const draw = rows.filter(({ action: candidate, redraw, score }) => score >= 30 &&
      (extraDraw[candidate.tkind] || (artazon && redraw && redraw.draw >= 3)))
      .sort((a, b) => b.score - a.score)[0];
    if (!draw) continue;
    if (wants.size === 1) {
      if (artazon && p.bench.length <= 1) row.score = Math.max(row.score, draw.score + 1);
      continue;
    }
    const n = draw.redraw?.draw || extraDraw[draw.action.tkind];
    let miss = 1;
    for (let i = 0; i < n && i < unknown; i++) miss *= Math.max(0, 1 - count / (unknown - i));
    if (1 - miss < 0.28) continue;
    row.score = Math.min(row.score, draw.score - 1);
    delayed.add(action);
  }
  return delayed;
}
