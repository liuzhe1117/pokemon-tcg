import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AIController, aiConfig, cpuRank, cpuScore, cpuPick, cpuWin, rankActions } from '../public/ai.js';
import { play, replayProfiles } from '../scripts/gary-arena.mjs';
import { experimentControllerOptions } from '../scripts/gary-policy-experiments.mjs';
import { attackFinishChance, attackPrizes, readyDamage, replyThreat, responseRisk } from '../public/ai-combat.js';
import { HardPolicy } from '../public/ai-hard.js';
import { rankHardPrompt } from '../public/ai-discard.js';
import { GaryV3Policy } from '../public/ai-v3.js';
import { betterAttachment, drawBeforeAttack, garyV3Profile } from '../public/ai-v3-current.js';
import { buildV3Strategy } from '../public/ai-v3-strategy.js';
import { CARDS, loadDeck } from '../public/cards.js';
import { Game } from '../public/engine.js';
import { observePrizeCounts, planAttacker } from '../public/ai-plan.js';
import { attackReserveBonus, movementFor, movementTargets, nextAttachmentDamage, paidRetreatPenalty, retreatNecessity } from '../public/ai-position.js';
import { prizePlan, projectPrizeRace, rankClosingRisk } from '../public/ai-prizes.js';
import { lillieDrawCount, redrawProfile, redrawScore } from '../public/ai-redraw.js';

await Promise.all(['svl-charizard', 'svl-dragapult', 'svl-gardevoir', 'sv-miraidon', 'mel-lucario', 'me-gengar', 'swl-mew', 'swsh-zacian',
  'sv-chien-pao', 'sm-bright-tide', 'sabrina', 'lt-surge', 'brock', 'blackout', 'swl-palkia',
  'sv-melmetal', 'svd-miraidon', 'sv-steven', 'swsh-cinderace'].map(loadDeck));
let uid = 900000;
function card(name) {
  const found = CARDS[name] || Object.values(CARDS).find((c) => c.name === name);
  assert.ok(found, name);
  return { ...found, uid: uid++ };
}

function fixture({ hard = true, deck = 'svl-charizard', opposingDeck = 'sv-miraidon' } = {}) {
  const decisions = [];
  const controller = new AIController({ hard: () => hard, onDecision: (_, decision) => decisions.push(decision) });
  controller.hardPolicy = new HardPolicy(cpuScore, cpuPick, { milliseconds: Infinity });
  controller.v3Policy.prizes = controller.hardPolicy.prizes;
  let rngCalls = 0;
  const game = new Game({
    decks: [deck, opposingDeck],
    controllers: [controller, new AIController({ hard: () => false })],
    random: () => { rngCalls++; return 0.8; },
  });
  const [p, foe] = game.players;
  game.turn = 5;
  game.phase = 'turn';
  game.current = game.first = p;
  p.active = game.createMon(card('sv4pt5-7'), 1);
  foe.active = game.createMon(card('Miraidon ex'), 1);
  for (const q of game.players) q.prizes = q.deck.splice(0, 6);
  return { game, p, foe, controller, decisions, randomCalls: () => rngCalls };
}

function withReviewStrategy(game, feature) {
  const controller = new AIController({
    ...experimentControllerOptions('v3', [...garyV3Profile, feature]), policyLimits: { milliseconds: Infinity },
  });
  game.controllers[0] = controller;
  return controller;
}

test('A thin deck keeps enough turns to finish instead of using an unnecessary hand reset', async () => {
  const { game, p, foe } = fixture();
  const controller = withReviewStrategy(game, 'deck-clock');
  game.turn = 14;
  p.active = game.createMon(card('Mega Lucario ex'), 1);
  p.active.energy = [card('Basic Fighting Energy')];
  p.hand = [card("Professor's Research (Professor Sada)")];
  p.deck.length = 10;
  foe.active = game.createMon(card('Wattrel'), 1);
  foe.bench = [game.createMon(card('Dragapult ex'), 1)];
  assert.equal((await controller.chooseAction(game, p, game.legalActions(p))).kind, 'attack');
});

test('V3 replenishes an empty deck before a nonwinning attack', async () => {
  await Promise.all(['sv-marnie', 'svd-ninetales'].map(loadDeck));
  for (const deck of ['sv-marnie', 'svd-ninetales']) {
    const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
    controller.version = () => 'v3';
    const active = (hp, attacks = []) => game.createMon({ ...card('Squirtle'), hp, weakness: null, resistance: null, attacks }, 0);
    p.active = active(40, [{ name: 'Hit', base: 20, cost: [], fx: {} }]);
    foe.active = active(150);
    p.deck = [];
    const water = () => card('Water Energy');
    if (deck === 'sv-marnie') {
      p.hand = [card('Energy Recycler')];
      p.discard = Array.from({ length: 5 }, water);
    } else {
      p.hand = Array.from({ length: 7 }, water);
      p.flags.energy = true;
      game.stadium = { card: card('Jubilife Village'), owner: p.idx };
    }
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    const action = await choose();
    assert.equal(action.tkind ?? action.stadium, deck === 'sv-marnie' ? 'energyRecycler' : 'jubilifeVillage');
    const ended = await game.perform(p, action);
    assert.equal(p.deck.length, deck === 'sv-marnie' ? 5 : 2);
    if (!ended) await game.perform(p, await choose());
    await game.startTurn(foe);
    await game.startTurn(p);
    assert.equal(game.winner, null);

    p.deck = [];
    foe.active.damage = foe.active.maxHp - 20;
    if (deck === 'sv-marnie') {
      p.hand = [card('Energy Recycler')];
      p.discard = [water()];
    } else {
      p.hand = Array.from({ length: 7 }, water);
    }
    const finish = await choose();
    assert.equal(finish.kind, 'attack');
    await game.perform(p, finish);
    assert.equal(game.winner, p);
  }
});

test('V3 only empties its deck with Melony when the attachment wins now', async () => {
  await loadDeck('swl-calyrex-ice');
  for (const lethal of [false, true]) {
    const deck = 'swl-calyrex-ice';
    const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
    controller.version = () => 'v3';
    p.active = game.createMon({ ...card('Squirtle'), tags: ['V'], attacks: [{ name: 'Hit', base: 20, cost: ['Water'], fx: {} }] }, 0);
    foe.active = game.createMon({ ...card('Squirtle'), hp: lethal ? 20 : 150, attacks: [] }, 0);
    p.hand = [card('Melony')];
    p.deck = Array.from({ length: 3 }, () => card('Water Energy'));
    p.discard = [card('Water Energy')];
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    assert.ok(game.legalActions(p).some((a) => a.tkind === 'melony'));
    const action = await choose();
    assert.equal(action.tkind ?? action.kind, lethal ? 'melony' : 'end');
    await game.perform(p, action);
    assert.equal(p.deck.length, lethal ? 0 : 3);
    if (lethal) {
      await game.perform(p, await choose());
      assert.equal(game.winner, p);
    }
  }
});

test('V3 uses known Prizes to keep or play Hisuian Heavy Ball', async () => {
  const deck = 'swl-palkia';
  const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
  controller.version = () => 'v3';
  p.active = targetingMon(game);
  foe.active = targetingMon(game, { hp: 150 });
  const ball = card('Hisuian Heavy Ball');
  p.hand = [ball];
  p.flags.energy = true;
  p.prizes = Array.from({ length: 6 }, () => card('Water Energy'));
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  assert.equal((await choose()).tkind, 'hisuianHeavyBall', 'Unknown Prizes are worth checking');
  controller.observePrizes(game, p);
  const prizes = p.prizes;
  p.prizes = new Proxy(prizes, {
    get(target, key) {
      if (key === 'length') return target.length;
      assert.fail(`Read face-down Prizes through ${String(key)}`);
    },
  });
  assert.ok(game.legalActions(p).some((action) => action.tkind === 'hisuianHeavyBall'));
  assert.equal((await choose()).kind, 'end');

  p.prizes = prizes;
  const basic = card('Origin Forme Palkia V');
  p.prizes[0] = basic;
  controller.observePrizes(game, p);
  const take = await choose();
  assert.equal(take.tkind, 'hisuianHeavyBall');
  await game.perform(p, take);
  assert.ok(p.hand.includes(basic));
  assert.ok(p.prizes.includes(ball));

  p.hand = [card('Hisuian Heavy Ball')];
  assert.notEqual((await choose()).tkind, 'hisuianHeavyBall');
});

test('V3 saves Super Rod with ample draws but recovers up to three cards to prevent deckout', async () => {
  const deck = 'sv-marnie';
  await loadDeck(deck);
  const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
  controller.version = () => 'v3';
  p.active = targetingMon(game);
  foe.active = targetingMon(game, { hp: 150 });
  p.hand = [card('Super Rod')];
  const water = card('Water Energy');
  p.discard = [water];
  p.flags.energy = true;
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  assert.ok(game.legalActions(p).some((action) => action.tkind === 'superRod'));
  assert.equal((await choose()).kind, 'end');
  assert.deepEqual(p.discard, [water]);

  p.deck = [];
  const basic = card("Marnie's Impidimp");
  const darkness = card('Basic Darkness Energy');
  p.discard.push(basic, darkness, card('Iono'));
  p.active = targetingMon(game, { base: 20 });
  const rod = await choose();
  assert.equal(rod.tkind, 'superRod');
  await game.perform(p, rod);
  assert.deepEqual(new Set(p.deck), new Set([water, basic, darkness]));
  await game.perform(p, await choose());
  await game.startTurn(foe);
  await game.startTurn(p);
  assert.equal(game.winner, null);
});

test('V3 uses Super Rod before a search that needs a card from the discard pile', async () => {
  const deck = 'sv-marnie';
  await loadDeck(deck);
  const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
  controller.version = () => 'v3';
  const active = targetingMon(game, { base: 60, cost: ['Darkness'] });
  p.active = active;
  foe.active = targetingMon(game, { hp: 150 });
  const all = [...p.deck, ...p.prizes];
  p.discard = all.filter((entry) => entry.kind === 'energy');
  p.deck = all.filter((entry) => entry.kind !== 'energy');
  p.prizes = p.deck.splice(0, 6);
  const rod = p.deck.splice(p.deck.findIndex((entry) => entry.tkind === 'superRod'), 1)[0];
  p.hand = [rod, card('Energy Search')];
  controller.observePrizes(game, p);
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  assert.ok(p.deck.length > 20);
  p.deck.push(p.discard.pop());
  assert.equal((await choose()).tkind, 'energySearch');
  p.discard.push(p.deck.pop());
  assert.ok(!game.legalActions(p).some((action) => action.tkind === 'energySearch'));
  const recycle = await choose();
  assert.equal(recycle.tkind, 'superRod');
  await game.perform(p, recycle);
  assert.equal(p.deck.filter((entry) => entry.kind === 'energy').length, 1);
  const search = await choose();
  assert.equal(search.tkind, 'energySearch');
  await game.perform(p, search);
  const attach = await choose();
  assert.equal(attach.kind, 'energy');
  assert.equal(attach.target, active);
  await game.perform(p, attach);
  await game.perform(p, await choose());
  assert.equal(foe.active.damage, 60);
});

test('V3 keeps Gravity Mountain when it would Knock Out its own Stage 2', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'mel-lucario', opposingDeck: 'mel-lucario' });
  controller.version = () => 'v3';
  p.active = game.createMon({ ...card('Squirtle'), stage: 2, hp: 100, attacks: [] }, 0);
  p.active.damage = 80;
  p.bench = [game.createMon({ ...card('Squirtle'), hp: 100, attacks: [] }, 0)];
  foe.active = game.createMon({ ...card('Squirtle'), hp: 150, attacks: [] }, 0);
  p.hand = [card('Gravity Mountain')];
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  assert.ok(game.legalActions(p).some((a) => a.tkind === 'stadium'));
  assert.equal((await choose()).kind, 'end');
  assert.equal(p.active.hpLeft, 20);
  assert.equal(foe.prizes.length, 6);

  p.active.damage = 0;
  foe.active.stack.push({ ...card('Squirtle'), stage: 2, hp: 100, attacks: [] });
  foe.active.damage = 80;
  const finish = await choose();
  assert.equal(finish.tkind, 'stadium');
  await game.perform(p, finish);
  assert.equal(game.winner, p);
});

test('V3 skips the audited one-sided harmful Stadiums', async () => {
  await Promise.all(['swl-calyrex-ice', 'svl-miraidon'].map(loadDeck));
  for (const name of ['Beach Court', 'Old Cemetery', 'Path to the Peak']) {
    const { game, p, foe, controller } = fixture({ deck: 'swl-calyrex-ice', opposingDeck: 'swl-calyrex-ice' });
    controller.version = () => 'v3';
    p.active = game.createMon({ ...card('Squirtle'), stage: 1, hp: 20, attacks: [] }, 0);
    foe.active = game.createMon({ ...card('Squirtle'), type: 'Psychic', hp: 150, retreat: 1, attacks: [] }, 0);
    if (name === 'Path to the Peak') {
      p.active = game.createMon(card('Fezandipiti ex'), 0);
      p.koTurn = game.turn - 1;
      p.deck = Array.from({ length: 15 }, () => card('Water Energy'));
      p.flags.energy = true;
    }
    p.hand = [card(name)];
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    assert.ok(game.legalActions(p).some((a) => a.tkind === 'stadium'), name);
    if (name === 'Path to the Peak') {
      const draw = await choose();
      assert.equal(draw.pkind, 'flipTheScript');
      await game.perform(p, draw);
    }
    assert.equal((await choose()).kind, 'end', name);
    assert.equal(game.stadium, null);
  }
});

test('V3 leaves the Energy it needs to attack attached under Saffron City Gym', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'sabrina', opposingDeck: 'sabrina' });
  controller.version = () => 'v3';
  p.active = game.createMon({ ...card('Squirtle'), name: "Sabrina's test", attacks: [{ name: 'Hit', base: 20, cost: ['Water'], fx: {} }] }, 0);
  foe.active = game.createMon({ ...card('Squirtle'), hp: 150, attacks: [] }, 0);
  p.active.energy = [card('Water Energy')];
  p.flags.energy = true;
  game.stadium = { card: card('Saffron City Gym'), owner: p.idx };
  const actions = game.legalActions(p);
  assert.ok(actions.some((a) => a.stadium === 'saffron'));
  const attack = await controller.chooseAction(game, p, actions);
  assert.equal(attack.kind, 'attack');
  await game.perform(p, attack);
  assert.equal(foe.active.damage, 20);
  assert.equal(p.active.energy.length, 1);
});

function targetingMon(game, { base, cost = [], ...props } = {}) {
  const attacks = base === undefined ? [] : [{ name: 'Hit', base, cost, fx: {} }];
  return game.createMon({ ...card('Squirtle'), weakness: null, resistance: null, attacks, ...props }, 0);
}

test('V3 charges the attacker it can switch in instead of the confused Active', async () => {
  await loadDeck('giovanni');
  for (const confused of [true, false]) {
    const { game, p, foe, controller } = fixture({ deck: 'giovanni', opposingDeck: 'giovanni' });
    controller.version = () => 'v3';
    game.turn = 7;
    p.active = game.createMon(card('gym2-74'), 0);
    p.active.damage = p.active.maxHp - 10;
    p.active.status.confused = confused;
    p.active.energy = [card('Grass Energy'), card('Grass Energy')];
    const target = game.createMon(card("Giovanni's Nidoran♀"), 0);
    p.bench = [target];
    p.hand = [card('Warp Point'), card('Grass Energy'), card('Grass Energy'), card('Grass Energy')];
    foe.active = game.createMon(card('gym2-74'), 0);
    foe.active.energy = [card('Fighting Energy'), card('Fighting Energy')];
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    const attach = await choose();
    assert.equal(attach.kind, 'energy');
    assert.equal(attach.target, confused ? target : p.active);
    if (!confused) continue;
    await game.perform(p, attach);
    const move = await choose();
    assert.equal(move.tkind, 'warpPoint');
    await game.perform(p, move);
    assert.equal(p.active, target);
    assert.equal(game.legalActions(p).find((a) => a.kind === 'attack')?.index, 0);
  }
});

test('V3 can cut a damaging front attack that has a non-damaging fallback', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'lt-surge', opposingDeck: 'lt-surge' });
  controller.version = () => 'v3';
  game.turn = 23;
  p.active = targetingMon(game, { hp: 40 });
  p.flags.energy = true;
  foe.active = game.createMon(card("Lt. Surge's Pikachu"), 0);
  foe.active.energy = [card('Lightning Energy'), card('Lightning Energy')];
  const bench = game.createMon(card('gym1-52'), 0);
  bench.damage = bench.maxHp - 10;
  bench.energy = [card('Lightning Energy')];
  foe.bench = [bench];
  p.hand = [card('Energy Removal')];
  const removal = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(removal.tkind, 'energyRemoval');
  assert.equal(removal.target, foe.active);
  await game.perform(p, removal);
  assert.equal(foe.active.energy.length, 1);
  assert.equal(bench.energy.length, 1);
});

test('V3 takes a reachable Prize before trading away Switch, and keeps its final draw', async () => {
  await loadDeck('trouble');
  for (const mode of ['prize', 'draw', 'deckout']) {
    const { game, p, foe, controller } = fixture({ deck: 'trouble', opposingDeck: 'trouble' });
    controller.version = () => 'v3';
    game.turn = 11;
    p.active = game.createMon(card('Dark Arbok'), 0);
    p.active.energy = [card('Psychic Energy')];
    const attacker = game.createMon(card('Dark Kadabra'), 0);
    attacker.energy = [card('Psychic Energy'), card('Psychic Energy')];
    p.bench = [attacker];
    p.hand = [card(mode === 'prize' ? 'Switch' : 'Grass Energy')];
    if (mode === 'deckout') {
      p.deck.length = 1;
      p.flags.energy = true;
    }
    foe.active = targetingMon(game, { hp: mode === 'prize' ? 30 : 60 });
    foe.bench = [targetingMon(game, { hp: 60 })];
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    const move = await choose();
    assert.equal(move.tkind ?? move.pkind ?? move.kind, { prize: 'switch', draw: 'matterExchange', deckout: 'end' }[mode]);
    if (mode !== 'prize') continue;
    await game.perform(p, move);
    assert.equal(p.active, attacker);
    const attack = await choose();
    assert.equal(attack.kind, 'attack');
    await game.perform(p, attack);
    assert.equal(p.prizes.length, 5);
  }
});

test('V3 saves Defender without a threat and uses it to survive a Knock Out', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'blackout', opposingDeck: 'blackout' });
  controller.version = () => 'v3';
  const active = targetingMon(game, { hp: 30 });
  p.active = active;
  foe.active = targetingMon(game, { hp: 150 });
  p.hand = [card('Defender')];
  p.flags.energy = true;
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  assert.equal((await choose()).kind, 'end');
  foe.active = targetingMon(game, { hp: 150, base: 40 });
  const defend = await choose();
  assert.equal(defend.tkind, 'defender');
  await game.perform(p, defend);
  await game.checkup(p);
  game.current = foe;
  await game.startTurn(foe);
  await game.perform(foe, game.legalActions(foe).find((action) => action.kind === 'attack'));
  assert.equal(p.active, active);
  assert.equal(active.hpLeft, 10);
});

test('V3 uses Pokémon Center when saving the Active justifies the discarded Energy', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'bodyguard', opposingDeck: 'bodyguard' });
  controller.version = () => 'v3';
  p.active = targetingMon(game, { hp: 100, base: 20, cost: ['Water'] });
  p.active.damage = 10;
  const water = card('Water Energy');
  p.active.energy = [water];
  p.active.status.paralyzed = true;
  foe.active = targetingMon(game, { hp: 150 });
  p.hand = [card('Pokémon Center')];
  p.flags.energy = true;
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  assert.equal((await choose()).kind, 'end');
  assert.deepEqual(p.active.energy, [water]);
  foe.active = targetingMon(game, { hp: 150, base: 90 });
  const center = await choose();
  assert.equal(center.tkind, 'pokemonCenter');
  await game.perform(p, center);
  assert.equal(p.active.hpLeft, 100);
  assert.ok(p.discard.includes(water));
});

test('V3 keeps Scoop Up Net on a safe board and uses it to rescue the Active', async () => {
  const deck = 'swl-inteleon';
  await loadDeck(deck);
  const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
  controller.version = () => 'v3';
  const active = targetingMon(game, { hp: 120 });
  p.active = active;
  active.damage = 95;
  active.energy = [card('Water Energy'), card('Water Energy')];
  const backup = targetingMon(game);
  p.bench = [backup];
  foe.active = targetingMon(game, { hp: 150 });
  p.hand = [card('Scoop Up Net')];
  p.flags.energy = true;
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  assert.notEqual((await choose()).tkind, 'scoopUpNet');
  assert.equal(active.energy.length, 2);

  foe.active = targetingMon(game, { hp: 150, base: 30 });
  p.flags.retreat = true;
  p.bench.unshift(targetingMon(game, { hp: 160 }));
  backup.card.attacks = [{ name: 'Finish', base: 160, cost: [], fx: {} }];
  const scoop = await choose();
  assert.equal(scoop.tkind, 'scoopUpNet');
  assert.equal(scoop.target?.id, active.id);
  await game.perform(p, scoop);
  assert.equal(p.active, backup);
  assert.ok(p.hand.includes(active.card));
  await game.perform(p, await choose());
  assert.equal(game.winner, p);
});

test('V3 attaches Choice Belt to the attacker that can use it', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'swl-mew', opposingDeck: 'swl-mew' });
  controller.version = () => 'v3';
  p.active = targetingMon(game, { name: 'Idle', hp: 100 });
  const ready = targetingMon(game, { name: 'Ready', base: 60 });
  p.bench = [ready];
  foe.active = targetingMon(game, { hp: 150, tags: ['V'] });
  p.hand = [card('Choice Belt')];
  p.flags.energy = true;
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  const belt = await choose();
  assert.equal(belt.card?.tool, 'choiceBelt');
  assert.equal(belt.target?.name, ready.name);
  await game.perform(p, belt);
  assert.equal(ready.tools[0]?.card.tool, 'choiceBelt');
  assert.equal(p.active.tools.length, 0);

  // A second Belt in hand should stay there when there's no V in play.
  p.active = ready;
  p.bench = [];
  ready.tools = [];
  foe.active = targetingMon(game, { hp: 90 });
  p.hand = [card('Choice Belt')];
  assert.equal((await choose()).kind, 'attack');

  foe.active = targetingMon(game, { hp: 90, tags: ['V'], prizes: 2 });
  p.bench = [targetingMon(game, { name: 'Backup', base: 70 })];
  foe.bench = [targetingMon(game, { hp: 100, tags: ['V'], prizes: 2 })];
  p.prizes.length = 2;
  const finisher = await choose();
  assert.equal(finisher.card?.tool, 'choiceBelt');
  assert.equal(finisher.target?.id, p.active.id);
  await game.perform(p, finisher);
  await game.perform(p, await choose());
  assert.equal(game.winner, p);
});

test('V3 uses Potion on the Active when healing changes whether it survives', async () => {
  for (const [reply, probes] of [[85, 24], [90, 24], [90, 0], [100, 24]]) {
    const { game, p, foe, controller } = fixture({ deck: 'blackout', opposingDeck: 'blackout' });
    controller.version = () => 'v3';
    controller.v3Policy.budget.probes = probes;
    p.active = targetingMon(game, { name: 'Active', hp: 100, base: 20 });
    p.active.damage = 10;
    const bench = targetingMon(game, { name: 'Bench', hp: 100 });
    bench.damage = 70;
    p.bench = [bench];
    foe.active = targetingMon(game, { hp: 150, base: reply });
    p.hand = [card('Potion')];
    p.flags.energy = true;
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    const potion = await choose();
    if (reply !== 90) {
      assert.notEqual(potion.target, p.active, `${reply} damage does not change the Knock Out threshold`);
      continue;
    }
    const active = p.active;
    assert.equal(potion.tkind, 'potion');
    assert.equal(potion.target, active);
    await game.perform(p, potion);
    assert.equal(bench.damage, 70);
    await game.perform(p, await choose());
    await game.checkup(p);
    game.current = foe;
    await game.startTurn(foe);
    await game.perform(foe, game.legalActions(foe).find((action) => action.kind === 'attack'));
    assert.equal(p.active, active);
    assert.equal(active.hpLeft, 10);
  }
});

test('V3 uses the modern Potion amount and respects effects that prevent healing', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'sv-melmetal', opposingDeck: 'sv-melmetal' });
  controller.version = () => 'v3';
  controller.v3Policy.budget.probes = 0;
  p.active = targetingMon(game, { hp: 100, base: 20 });
  p.active.damage = 40;
  const bench = targetingMon(game, { hp: 100 });
  bench.damage = 70;
  p.bench = [bench];
  foe.active = targetingMon(game, { hp: 150, base: 80 });
  p.hand = [card('sv1-188')];
  p.flags.energy = true;
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  foe.bench = [targetingMon(game, { powerKind: 'lifeLocked' })];
  assert.notEqual((await choose()).target?.id, p.active.id);
  foe.bench = [];
  const potion = await choose();
  assert.equal(potion.tkind, 'potion30');
  assert.equal(potion.target?.id, p.active.id);
  await game.perform(p, potion);
  assert.equal(p.active.hpLeft, 90);
});

test('V3 removes the Energy that cuts off a ready attack', async () => {
  for (const mixed of [false, true]) {
    const { game, p, foe, controller } = fixture({ deck: 'blackout', opposingDeck: 'blackout' });
    controller.version = () => 'v3';
    p.active = targetingMon(game);
    foe.active = targetingMon(game, { name: 'Active', hp: 150, base: 20, cost: ['Water'] });
    foe.active.energy = Array.from({ length: 3 }, () => card('Water Energy'));
    const threat = targetingMon(game, { name: 'Threat', hp: 150, base: 100, cost: ['Water'] });
    threat.energy = [card('Water Energy')];
    if (mixed) threat.energy.unshift(card('Fire Energy'));
    foe.bench = [threat];
    p.hand = [card('Energy Removal')];
    p.flags.energy = true;
    const removal = await controller.chooseAction(game, p, game.legalActions(p));
    assert.equal(removal.tkind, 'energyRemoval');
    assert.equal(removal.target?.name, threat.name);
    assert.equal(removal.etype, 'Water');
    await game.perform(p, removal);
    assert.equal(foe.active.energy.length, 3);
    assert.equal(game.canUseAttack(foe, threat, p.active, threat.card.attacks[0]), false);
  }
});

test('V3 selects the right Energy card when two attached cards share a type', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'blackout', opposingDeck: 'blackout' });
  controller.version = () => 'v3';
  p.active = targetingMon(game);
  foe.active = targetingMon(game, { hp: 150, base: 60, cost: ['Colorless', 'Colorless'] });
  foe.active.energy = [card('Potion Energy'), card('Double Colorless Energy')];
  p.hand = [card('Energy Removal')];
  p.flags.energy = true;
  const removal = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(removal.tkind, 'energyRemoval');
  await game.perform(p, removal);
  assert.deepEqual(foe.active.energy.map((energy) => energy.name), ['Potion Energy']);
});

test('V3 holds Energy Removal when the only Energy is surplus', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'blackout', opposingDeck: 'blackout' });
  controller.version = () => 'v3';
  p.active = targetingMon(game);
  p.hand = [card('Energy Removal')];
  p.flags.energy = true;
  foe.active = targetingMon(game, { hp: 150, base: 20, cost: ['Water'] });
  foe.active.energy = Array.from({ length: 3 }, () => card('Water Energy'));
  assert.equal((await controller.chooseAction(game, p, game.legalActions(p))).kind, 'end');
});

test('V3 pays Super Energy Removal with spare Energy and cuts a two-card attack cost', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'blackout', opposingDeck: 'blackout' });
  controller.version = () => 'v3';
  p.active = targetingMon(game, { hp: 80, base: 20, cost: ['Water'] });
  const backup = targetingMon(game);
  p.bench = [backup];
  const water = card('Water Energy'), spare = card('Fire Energy');
  p.active.energy = [water];
  backup.energy = [spare];
  p.hand = [card('Super Energy Removal')];
  p.flags.energy = true;
  foe.active = targetingMon(game, { hp: 150, base: 100, cost: ['Water'] });
  foe.active.energy = [card('Fire Energy'), card('Water Energy'), card('Water Energy')];
  const remove = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(remove.tkind, 'superEnergyRemoval');
  await game.perform(p, remove);
  assert.deepEqual(p.active.energy, [water]);
  assert.ok(p.discard.includes(spare));
  assert.deepEqual(foe.active.energy.map((entry) => entry.energyType), ['Fire']);
});

test('V3 uses Fan of Waves on the benched attack it can stop', async () => {
  const deck = 'swl-urshifu-rapid';
  await loadDeck(deck);
  const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
  controller.version = () => 'v3';
  p.active = targetingMon(game);
  p.hand = [card('Fan of Waves')];
  p.flags.energy = true;
  foe.active = targetingMon(game, { hp: 150, base: 20, cost: ['Water'] });
  foe.active.energy = [card('Water Energy'), card('Double Turbo Energy')];
  const threat = targetingMon(game, { hp: 150, base: 100, cost: ['Colorless', 'Colorless'] });
  const turbo = card('Double Turbo Energy');
  threat.energy = [turbo];
  foe.bench = [threat];
  const fan = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(fan.tkind, 'fanOfWaves');
  await game.perform(p, fan);
  assert.equal(foe.deck[0], turbo);
  assert.equal(foe.active.energy.length, 2);
});

test('V3 keeps a beneficial Stadium and removes the Tool that opens a knockout', async () => {
  const deck = 'sm-tropical-takedown';
  await Promise.all([loadDeck(deck), loadDeck('svl-miraidon'), loadDeck('swl-zacian')]);
  const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
  controller.version = () => 'v3';
  p.active = targetingMon(game, { retreat: 2 });
  foe.active = targetingMon(game, { hp: 150 });
  foe.active.stack.push({ ...foe.active.card, stage: 1 });
  const stadium = card('Beach Court');
  game.stadium = { card: stadium, owner: p.idx };
  p.flags.energy = true;
  p.hand = [card('Field Blower')];
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  assert.equal((await choose()).kind, 'end');
  foe.active = targetingMon(game, { hp: 60, retreat: 0 });
  const charm = card('Big Charm');
  foe.active.tools = [{ card: charm, expires: Infinity }];
  p.active = targetingMon(game, { base: 70, retreat: 2 });
  const remove = await choose();
  assert.equal(remove.tkind, 'fieldBlower');
  await game.perform(p, remove);
  assert.equal(game.stadium.card, stadium);
  assert.deepEqual(foe.discard, [charm]);
  await game.perform(p, await choose());
  assert.equal(game.winner, p);
});

test('V3 attaches offensive and retreat Tools to the Pokémon that can use them', async () => {
  await loadDeck('swl-calyrex-ice');
  const { game, p, foe, controller } = fixture({ deck: 'svl-charizard' });
  controller.version = () => 'v3';
  p.active = targetingMon(game, { retreat: 2 });
  const attacker = targetingMon(game, { hp: 90, base: 60, retreat: 0 });
  p.bench = [attacker];
  foe.active = targetingMon(game, { hp: 150 });
  p.flags.energy = true;
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  p.hand = [card('Vitality Band')];
  assert.equal((await choose()).target?.id, attacker.id);
  p.hand = [card('Air Balloon')];
  assert.equal((await choose()).target?.id, p.active.id);
});

test('V3 Tool Scrapper removes the opposing HP Tool and leaves its own intact', async () => {
  const deck = 'swl-urshifu-single';
  await Promise.all([loadDeck(deck), loadDeck('swl-zacian')]);
  const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
  controller.version = () => 'v3';
  p.active = targetingMon(game, { hp: 60 });
  foe.active = targetingMon(game, { hp: 60 });
  const ownCharm = card('Big Charm'), opposingCharm = card('Big Charm');
  p.active.damage = foe.active.damage = 60;
  p.active.tools = [{ card: ownCharm, expires: Infinity }];
  foe.active.tools = [{ card: opposingCharm, expires: Infinity }];
  p.hand = [card('Tool Scrapper')];
  p.flags.energy = true;
  const remove = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(remove.tkind, 'toolScrapper');
  await game.perform(p, remove);
  assert.equal(p.active.tools[0].card, ownCharm);
  assert.equal(game.winner, p);
});

test('V3 keeps Lure Module when there is no evidence of a net gain', async () => {
  const deck = 'swv-melmetal';
  await loadDeck(deck);
  const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
  controller.version = () => 'v3';
  p.active = targetingMon(game);
  foe.active = targetingMon(game, { hp: 150 });
  p.flags.energy = true;
  p.hand = [card('Lure Module')];
  p.deck = Array.from({ length: 4 }, () => card('Water Energy'));
  foe.deck = Array.from({ length: 4 }, () => ({ ...card('Squirtle'), attacks: [] }));
  assert.ok(game.legalActions(p).some((action) => action.tkind === 'lureModule'));
  const choice = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(choice.kind, 'end');
  await game.perform(p, choice);
  assert.equal(foe.hand.length, 0);
});

test('V3 uses Lure Module with favorable publicly inferable deck contents', async () => {
  const deck = 'swv-melmetal';
  await loadDeck(deck);
  const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
  controller.version = () => 'v3';
  for (const side of [p, foe]) {
    const all = [...side.deck, ...side.prizes];
    side.prizes = all.filter((entry) => entry.kind !== 'pokemon').slice(0, 6);
    const pool = all.filter((entry) => !side.prizes.includes(entry));
    side.active = game.createMon(pool.splice(pool.findIndex((entry) => entry.kind === 'pokemon' && entry.stage === 0), 1)[0], 0);
    side.deck = pool.filter((entry) => side === p ? entry.kind === 'pokemon' : entry.kind === 'energy');
    side.hand = side === p ? [pool.find((entry) => entry.tkind === 'lureModule')] : [];
    side.discard = pool.filter((entry) => !side.deck.includes(entry) && !side.hand.includes(entry));
  }
  controller.v3Policy.observePrizes(game, p);
  p.flags.energy = true;
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  const surplus = p.deck.splice(0, p.deck.length - 3);
  p.discard.push(...surplus);
  assert.notEqual((await choose()).tkind, 'lureModule');
  p.deck.unshift(...p.discard.splice(-surplus.length));

  const hide = (cards) => new Proxy(cards, {
    get(target, key) {
      if (key === 'length') return target.length;
      assert.fail(`Read hidden cards through ${String(key)}`);
    },
  });
  const ourDeck = p.deck, opposingDeck = foe.deck, opposingHand = foe.hand;
  p.deck = hide(ourDeck);
  foe.deck = hide(opposingDeck);
  foe.hand = hide(opposingHand);
  const choice = await choose();
  assert.equal(choice.tkind, 'lureModule');
  p.deck = ourDeck;
  foe.deck = opposingDeck;
  foe.hand = opposingHand;
  await game.perform(p, choice);
  assert.equal(p.hand.length, 3);
  assert.equal(foe.hand.length, 0);

  // All remaining cards on the opponent's hidden side are now Pokémon.
  foe.discard.push(...foe.deck, ...foe.prizes);
  foe.prizes = [];
  foe.hand = foe.discard.filter((entry) => entry.kind === 'pokemon');
  foe.discard = foe.discard.filter((entry) => entry.kind !== 'pokemon');
  foe.deck = foe.hand.splice(-2);
  p.hand = [card('Lure Module')];
  const finish = await choose();
  assert.equal(finish.tkind, 'lureModule');
  await game.perform(p, finish);
  assert.equal(foe.deck.length, 0);
  await game.startTurn(foe);
  assert.equal(game.winner, p);
});

test('V3 uses opposing hand resets for disruption or deckout instead of refilling a small hand', async () => {
  await loadDeck('mel-greninja');
  for (const [deck, trainer, kind, draw] of [
    ['mel-greninja', 'Special Red Card', 'specialRedCard', 3],
    ['devastation', "Imposter Oak's Revenge", 'imposterOak', 4],
  ]) {
    const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
    controller.version = () => 'v3';
    p.active = targetingMon(game);
    foe.active = targetingMon(game, { hp: 150 });
    p.flags.energy = true;
    p.hand = kind === 'imposterOak' ? [card(trainer), card('Water Energy')] : [card(trainer)];
    if (kind === 'specialRedCard') foe.prizes.length = 3;
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    const opposingDeck = foe.deck;
    const water = () => card('Water Energy');
    for (const [hand, deckSize] of [[1, opposingDeck.length], [draw, opposingDeck.length], [draw + 1, 0], [draw + 2, 1]]) {
      foe.hand = Array.from({ length: hand }, water);
      foe.deck = opposingDeck.slice(0, deckSize);
      assert.ok(game.legalActions(p).some((action) => action.tkind === kind));
      assert.equal((await choose()).kind, 'end', `${kind}, ${hand} in hand and ${deckSize} in deck`);
    }

    foe.hand = Array.from({ length: draw + 4 }, water);
    foe.deck = [...opposingDeck];
    const disruption = await choose();
    assert.equal(disruption.tkind, kind);
    await game.perform(p, disruption);
    assert.equal(foe.hand.length, draw);
    if (kind === 'imposterOak') assert.ok(p.discard.some((entry) => entry.kind === 'energy'));

    p.hand = [card(trainer), ...(kind === 'imposterOak' ? [water()] : [])];
    foe.hand = [water()];
    foe.deck = Array.from({ length: draw - 1 }, water);
    p.active = targetingMon(game, { base: 20 });
    const finish = await choose();
    assert.equal(finish.tkind, kind);
    await game.perform(p, finish);
    assert.equal(foe.deck.length, 0);
    assert.equal((await choose()).kind, 'end');
    await game.startTurn(foe);
    assert.equal(game.winner, p);
  }
});

test('V3 plays Sada and attaches the Energy needed for the last Prize', async () => {
  await loadDeck('svd-koraidon');
  for (const extraTargets of [false, true]) {
    const { game, p, foe, controller, randomCalls } = fixture({ deck: 'svd-koraidon', opposingDeck: 'svd-koraidon' });
    controller.version = () => 'v3';
    const attack = (name, base, cost = []) => ({ name, base, cost, fx: {} });
    p.active = game.createMon({ ...card('Squirtle'), tags: ['Ancient'], attacks: [attack('Hit', 20), attack('Charged', 90, ['Water', 'Water'])] }, 0);
    foe.active = game.createMon({ ...card('Squirtle'), hp: 80, attacks: [attack('Reply', 100)] }, 0);
    p.prizes.length = 1;
    p.active.energy = [card('Water Energy')];
    p.discard = [card('Water Energy')];
    if (extraTargets) {
      p.bench = [game.createMon({ ...card('Koraidon'), attacks: [] }, 0)];
      p.discard.unshift(card('Fire Energy'));
    }
    p.hand = [card("Professor Sada's Vitality")];
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    const calls = randomCalls(), before = game.serialize();
    const sada = await choose();
    assert.equal(sada.tkind, 'sadaVitality');
    assert.deepEqual(game.serialize(), before);
    assert.equal(randomCalls(), calls);
    await game.perform(p, sada);
    assert.equal(p.active.energyTypes.filter((type) => type === 'Water').length, 2);
    const finish = await choose();
    assert.equal(finish.kind, 'attack');
    assert.equal(game.attacksOf(p.active)[finish.index].name, 'Charged');
    await game.perform(p, finish);
    assert.equal(game.winner, p);
  }
});

test('V3 tries Pokémon Catcher when heads wins and the visible reply loses the game', async () => {
  await loadDeck('sm-let-s-play-eevee');
  for (const heads of [false, true]) {
    const deck = 'sm-let-s-play-eevee';
    const { game, p, foe, controller, randomCalls } = fixture({ deck, opposingDeck: deck });
    controller.version = () => 'v3';
    p.active = game.createMon({ ...card('Squirtle'), attacks: [{ name: 'Hit', base: 70, cost: [], fx: {} }] }, 0);
    foe.active = game.createMon({ ...card('Squirtle'), hp: 150, attacks: [{ name: 'Reply', base: 100, cost: [], fx: {} }] }, 0);
    const lastPrize = game.createMon({ ...card('Squirtle'), hp: 60, attacks: [] }, 0);
    foe.bench = [game.createMon({ ...card('Squirtle'), hp: 120, attacks: [] }, 0), lastPrize];
    p.prizes.length = 1;
    p.hand = [card('Pokémon Catcher')];
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    const calls = randomCalls(), before = game.serialize();
    const catcher = await choose();
    assert.equal(catcher.tkind, 'pokemonCatcher');
    assert.equal(randomCalls(), calls);
    assert.deepEqual(game.serialize(), before);
    game.random = () => heads ? 0.2 : 0.8;
    await game.perform(p, catcher);
    assert.equal(foe.active === lastPrize, heads);
    const attack = await choose();
    assert.equal(attack.kind, 'attack');
    await game.perform(p, attack);
    assert.equal(game.winner, heads ? p : null);
  }
});

test('A known coin-flip chance to take the last Prize competes with a slower deterministic line', async () => {
  await loadDeck('sm-roaring-heat');
  const { game, p, foe, randomCalls } = fixture({ deck: 'sm-roaring-heat' });
  const controller = withReviewStrategy(game, 'chance-finish');
  game.turn = 22;
  p.active = game.createMon(card('Incineroar'), 1);
  p.active.energy = [card('Fire Energy'), card('Fire Energy'), card('Fire Energy')];
  p.prizes.length = 1;
  foe.active = game.createMon(card('Wattrel'), 1);
  foe.bench = [game.createMon(card('Dragapult ex'), 1)];
  const actions = game.legalActions(p);
  const candidate = actions.find((a) => a.kind === 'attack' && game.attacksOf(p.active)[a.index].name === 'Darkest Lariat');
  assert.ok(candidate);
  assert.equal(attackFinishChance(game, p, candidate.index, true), 0.75);
  const calls = randomCalls();
  assert.equal(await controller.chooseAction(game, p, actions), candidate);
  assert.equal(randomCalls(), calls);
});

test('Joint attachment keeps the only Psychic Energy available to Underworld Door', async () => {
  await loadDeck('swl-calyrex-shadow');
  const { game, p, foe } = fixture({ deck: 'swl-calyrex-shadow' });
  const controller = withReviewStrategy(game, 'joint-attachment');
  p.active = game.createMon(card('Shadow Rider Calyrex VMAX'), 1);
  p.bench = [game.createMon(card('Shadow Rider Calyrex V'), 1)];
  p.hand = [card('Basic Psychic Energy')];
  foe.active = game.createMon(card('Dragapult ex'), 1);
  const actions = game.legalActions(p);
  assert.ok(actions.some((a) => a.kind === 'energy'));
  assert.equal((await controller.chooseAction(game, p, actions)).pkind, 'underworldDoor');
});

test('A surplus Energy can keep a discard attack payable on the following turn', async () => {
  await loadDeck('sm-battle-mind');
  const { game, p, foe } = fixture({ deck: 'sm-battle-mind' });
  p.active = game.createMon(card('sm10-29'), 1);
  p.active.energy = [card('Fire Energy'), card('Fire Energy')];
  p.hand = [card('Fire Energy')];
  foe.active = game.createMon(card('Mega Lucario ex'), 1);
  foe.bench = [game.createMon(card('Wattrel'), 1)];
  const actions = game.legalActions(p);
  const attach = actions.find((action) => action.kind === 'energy');
  const before = game.serialize();
  const controller = withReviewStrategy(game, 'attack-energy-reserve');
  assert.ok(attackReserveBonus(game, p, attach) > 10);
  assert.equal(await controller.chooseAction(game, p, actions), attach);
  assert.deepEqual(game.serialize(), before);
  p.active.energy.push(card('Fire Energy'));
  assert.equal(attackReserveBonus(game, p, attach), 0);
});

test('Switch targets consider resistance and a free exit while the attacker is not ready', () => {
  const { game, p, foe } = fixture();
  const tank = (name, weakness, resistance, retreat) => game.createMon({
    ...card('Wattrel'), name, hp: 100, weakness, resistance, retreat, attacks: [],
  }, 1);
  const exposed = tank('Exposed', 'Psychic', null, 2);
  const pivot = tank('Pivot', null, 'Psychic', 0);
  p.active = tank('Current', 'Psychic', null, 1);
  p.active.energy = [card('Basic Fighting Energy')];
  p.bench = [exposed, pivot];
  foe.active = game.createMon({
    ...card('Wattrel'), type: 'Psychic',
    attacks: [{ name: 'Hit', base: 60, cost: [], fx: {} }],
  }, 1);
  const prompt = { kind: 'promote', text: 'prompt.q.switchSelf', options: [
    { id: 'exposed', mon: exposed }, { id: 'pivot', mon: pivot },
  ] };
  for (const action of [{ tkind: 'primeCatcher' }, { pkind: 'witchRondo' }, { stadium: 'surfingBeach' }]) {
    assert.equal(movementTargets(game, p, prompt, action, true)[0].mon, pivot);
  }
  const retreat = (target) => movementFor(game, p, { kind: 'retreat', target }, () => 5, false, true);
  assert.ok(retreat(pivot).gain > retreat(exposed).gain);

  const attacker = game.createMon(card('Mega Lucario ex'), 1);
  attacker.energy = [card('Basic Fighting Energy')];
  p.bench = [pivot, attacker];
  foe.active.damage = 40;
  prompt.options = [{ id: 'pivot', mon: pivot }, { id: 'attacker', mon: attacker }];
  assert.equal(movementTargets(game, p, prompt, { tkind: 'primeCatcher' }, true)[0].mon, attacker);
});

test('A known compatible hand attachment counts in the choice of a replacement', () => {
  const { game, p, foe, randomCalls } = fixture();
  const main = game.createMon(card('Mega Lucario ex'), 1);
  const pivot = game.createMon({ ...card('Wattrel'), hp: 110, retreat: 0, attacks: [] }, 1);
  p.bench = [pivot, main];
  foe.active = game.createMon(card('Wattrel'), 1);
  const prompt = { kind: 'promote', text: 'prompt.q.switchSelf', options: [
    { id: 'pivot', mon: pivot }, { id: 'main', mon: main },
  ] };
  p.hand = [card('Basic Water Energy')];
  assert.equal(nextAttachmentDamage(game, p, main, foe.active, game.turn + 2), 0);
  assert.equal(movementTargets(game, p, prompt, { tkind: 'switch' }, false, true)[0].mon, pivot);
  p.hand.push(card('Basic Fighting Energy'));
  const calls = randomCalls();
  assert.ok(nextAttachmentDamage(game, p, main, foe.active, game.turn + 2) >= foe.active.hpLeft);
  assert.equal(movementTargets(game, p, prompt, { tkind: 'switch' }, false, true)[0].mon, main);
  assert.equal(main.energy.length, 0);
  assert.equal(randomCalls(), calls);
});

test('Paid retreats need extra gain after a switch and cost more with an equivalent Item', () => {
  const { game, p, foe } = fixture();
  p.active = game.createMon({ ...card('Wattrel'), retreat: 1, attacks: [] }, 1);
  p.active.energy = [card('Basic Lightning Energy')];
  const target = game.createMon(card('Mega Lucario ex'), 1);
  p.bench = [target];
  foe.active = game.createMon({ ...card('Wattrel'), attacks: [] }, 1);
  const retreat = { kind: 'retreat', target };
  const ordinary = paidRetreatPenalty(game, p, retreat, []);
  p.flags.switchedOut = [target.id];
  const returning = paidRetreatPenalty(game, p, retreat, []);
  assert.ok(returning > ordinary);
  assert.ok(paidRetreatPenalty(game, p, retreat, [{ kind: 'trainer', tkind: 'switch', target }]) > returning);
  target.energy = [card('Basic Fighting Energy')];
  assert.ok(paidRetreatPenalty(game, p, retreat, []) < ordinary);
});

test('An endangered Active can pay to retreat to a survivor that cannot attack', async () => {
  const { game, p, foe } = fixture();
  game.turn = 13;
  p.active = game.createMon({ ...card('Wattrel'), retreat: 1, hp: 60 }, 1);
  p.active.damage = 40;
  p.active.energy = [card('Basic Lightning Energy')];
  p.hand = [];
  const survivor = game.createMon({ ...card('Wattrel'), hp: 100, attacks: [] }, 1);
  p.bench = [survivor];
  foe.active = game.createMon({ ...card('Wattrel'),
    attacks: [{ name: 'Hit', base: 20, cost: [], fx: {} }],
  }, 1);
  const actions = game.legalActions(p);
  const retreat = actions.find((a) => a.kind === 'retreat');
  const necessity = retreatNecessity(game, p, survivor);
  assert.equal(necessity.avoidsKnockout, true);
  assert.equal(paidRetreatPenalty(game, p, retreat, actions, undefined, necessity), 0);
  const controller = new AIController({
    ...experimentControllerOptions('v3', [...garyV3Profile, 'retreat-payment', 'next-attachment', 'necessary-retreat']),
    policyLimits: { milliseconds: Infinity },
  });
  assert.equal(await controller.chooseAction(game, p, actions), retreat);
});

test('Gary proves and executes a gust, switch, attach and attack line without reading hidden cards', async () => {
  const { game, p, foe, controller, decisions, randomCalls } = fixture();
  p.active = game.createMon(card('Moltres'), 1);
  p.bench.push(game.createMon(card('Mega Lucario ex'), 1));
  foe.active = game.createMon(card('Mega Gengar ex'), 1);
  foe.bench.push(game.createMon(card('Wattrel'), 1));
  p.hand = [card("Boss's Orders"), card('Switch'), card('Basic Fighting Energy')];
  p.prizes.length = 1;
  const before = JSON.stringify(game.serialize());
  const rngBefore = randomCalls();
  const hidden = (cards) => new Proxy(cards, {
    get(target, key) {
      if (key === 'length') return target.length;
      assert.fail(`Read hidden zone: ${String(key)}`);
    },
  });
  const originalHand = foe.hand, originalDeck = p.deck;
  foe.hand = hidden(originalHand);
  p.deck = hidden(originalDeck);
  const first = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(decisions[0].reason, 'lethal');
  foe.hand = originalHand;
  p.deck = originalDeck;
  assert.equal(JSON.stringify(game.serialize()), before);
  assert.equal(randomCalls(), rngBefore);

  const kinds = [];
  for (let action = first; action && !game.winner; action = await controller.chooseAction(game, p, game.legalActions(p))) {
    kinds.push(action.kind);
    const ended = await game.perform(p, action);
    if (ended) break;
    assert.ok(kinds.length < 5);
  }
  assert.deepEqual(kinds.toSorted(), ['attack', 'energy', 'trainer', 'trainer']);
  assert.equal(game.winner, p);
});

test('A coin flip and an unknown draw are outside deterministic search', async () => {
  const { game, p, foe, controller, decisions, randomCalls } = fixture();
  p.active = game.createMon(card('Mega Lucario ex'), 1);
  p.active.energy.push(card('Basic Fighting Energy'));
  foe.active = game.createMon(card('Mega Gengar ex'), 1);
  foe.bench.push(game.createMon(card('Wattrel'), 1));
  p.prizes.length = 1;
  p.hand = [card('Pokémon Catcher'), card("Professor's Research (Professor Sada)")];
  const rngBefore = randomCalls();
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.ok(action);
  assert.notEqual(decisions[0].reason, 'lethal');
  assert.equal(randomCalls(), rngBefore);
});

test('An opposing attack paid from hand can be evaluated without looking at those cards', async () => {
  const { game, p, foe, controller } = fixture();
  foe.active = game.createMon(card('Golduck'), 1);
  foe.active.energy.push(card('Basic Water Energy'));
  foe.hand = new Proxy({ length: 2 }, {
    get(target, key) {
      assert.equal(key, 'length');
      return target.length;
    },
  });
  p.hand = [card('Basic Fire Energy')];
  const legal = game.legalActions(p);
  assert.ok(legal.includes(await controller.chooseAction(game, p, legal)));
});

test('Multi-card discard preserves Rare Candy, the main evolution and the only useful Energy', async () => {
  const { game, p } = fixture();
  p.active.energy.push(card('Basic Fire Energy'));
  const charizard = card('Charizard ex'), candy = card('Rare Candy'), fire = card('Basic Fire Energy');
  const switch1 = card('Switch'), switch2 = card('Switch');
  p.hand = [fire, charizard, switch1, switch2, candy];
  const paid = await game.discardHandCards(p, p.hand, 2);
  assert.deepEqual(paid.map((c) => c.tkind), ['switch', 'switch']);
  assert.deepEqual(p.hand, [fire, charizard, candy]);
});

test('Retreat pays with one Double Turbo Energy and saves the attacker’s typed Energy', async () => {
  const { game, p } = fixture();
  p.active = game.createMon(card('Mega Lucario ex'), 1);
  const fighting = card('Basic Fighting Energy');
  p.active.energy = [fighting, card('Double Turbo Energy')];
  const cost = game.retreatCost(p, p.active);
  assert.equal(cost, 2);
  const paid = await game.payRetreat(p, p.active);
  assert.deepEqual(paid.map((c) => c.special), ['doubleTurbo']);
  assert.deepEqual(p.active.energy, [fighting]);
});

test('The corrected prize projection matches the engine after paying retreat and taking prizes', async () => {
  const { game, p, foe } = fixture();
  p.active = game.createMon(card('Mega Lucario ex'), 1);
  const fire = card('Basic Fire Energy'), double = card('Double Turbo Energy');
  p.active.energy = [double, fire];
  p.bench = [game.createMon(card('Mega Lucario ex'), 1)];
  p.bench[0].energy = [card('Basic Fighting Energy')];
  p.prizes.length = 2;
  foe.active = game.createMon(card('Miraidon ex'), 1);
  foe.active.damage = foe.active.maxHp - 60;
  assert.ok(projectPrizeRace(game, p, p.hand, { attacks: 1 }).state.prizes[0] > 0);
  const race = projectPrizeRace(game, p, p.hand, { attacks: 1, paidRetreats: true });
  assert.equal(race.state.prizes[0], 0);
  assert.equal(race.steps[0].attacker, p.bench[0]);
  assert.deepEqual(race.state.attached[0][0], [fire]);
  assert.deepEqual(p.active.energy, [double, fire]);
  const retreat = game.legalActions(p).find((a) => a.kind === 'retreat' && a.target === race.steps[0].attacker);
  assert.ok(retreat);
  const oldActive = p.active;
  await game.perform(p, retreat);
  assert.deepEqual(oldActive.energy, race.state.attached[0][0]);
  const attack = game.legalActions(p).find((a) => a.kind === 'attack' && a.index === race.steps[0].i);
  assert.ok(attack);
  await game.perform(p, attack);
  assert.equal(p.prizes.length, race.state.prizes[0]);
  assert.equal(game.winner, p);
});

test('A projected attacker must leave the Active Spot before reusing Meteor Assault', async () => {
  await loadDeck('swv-lycanroc');
  const { game, p, foe } = fixture({ deck: 'swv-lycanroc' });
  p.active = game.createMon(card("Galarian Sirfetch'd"), 1);
  p.active.energy = [card('Basic Fighting Energy'), card('Double Turbo Energy')];
  p.prizes.length = 3;
  const victim = () => game.createMon(card('Wattrel'), 1);
  foe.active = victim();
  foe.bench = [victim(), victim()];
  const original = projectPrizeRace(game, p, p.hand);
  assert.ok(original.steps.filter((s) => s?.atk.name === 'Meteor Assault').length > 1);
  const corrected = projectPrizeRace(game, p, p.hand, { trackActiveLock: true });
  assert.equal(corrected.steps.filter((s) => s?.atk.name === 'Meteor Assault').length, 1);
  assert.ok(corrected.state.prizes[0] > 0);
  const findAttack = () => game.legalActions(p).find((a) =>
    a.kind === 'attack' && game.attacksOf(p.active)[a.index].name === 'Meteor Assault');
  const attack = findAttack();
  assert.ok(attack);
  await game.perform(p, attack);
  game.turn += 2;
  assert.equal(findAttack(), undefined);
  const bench = game.createMon(card('Wattrel'), 1);
  p.bench.push(bench);
  const oldActive = p.active;
  game.swapActive(p, bench);
  game.swapActive(p, oldActive);
  assert.ok(findAttack());
});

test('Escape Rope evaluates the opponent’s possible replacement instead of their current Active', async () => {
  await loadDeck('swv-lycanroc');
  const { game, p, foe } = fixture({ deck: 'swv-lycanroc' });
  p.bench = [game.createMon(card("Galarian Sirfetch'd"), 1)];
  p.bench[0].energy = [card('Basic Fighting Energy'), card('Double Turbo Energy')];
  foe.active = game.createMon(card('Wattrel'), 1);
  foe.bench = [game.createMon(card('Dragapult ex'), 1)];
  const rope = { kind: 'trainer', tkind: 'escapeRope' };
  const current = movementFor(game, p, rope);
  const corrected = movementFor(game, p, rope, undefined, true);
  assert.equal(current.defender, foe.active);
  assert.equal(corrected.defender, foe.bench[0]);
  const sturdy = foe.bench[0];
  p.bench[0] = targetingMon(game, { base: 70 });
  foe.bench.unshift(targetingMon(game, { hp: 20 }));
  assert.equal(movementFor(game, p, rope, undefined, true).defender, sturdy);
});

test('V3 accounts for the opponent’s worst replacement before using a forced switch', async () => {
  for (const [deck, name, kind] of [['swv-lycanroc', 'Escape Rope', 'escapeRope'],
    ['giovanni', 'Warp Point', 'warpPoint'], ['sv-kangaskhan', 'Ryme', 'ryme']]) {
    await loadDeck(deck);
    const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
    controller.version = () => 'v3';
    p.active = targetingMon(game, { hp: 100, base: 65, retreat: 2 });
    if (kind !== 'ryme') p.bench = [targetingMon(game, { hp: 100, base: 65 })];
    foe.active = targetingMon(game, { hp: 150 });
    const easy = targetingMon(game, { hp: 60 }), threat = targetingMon(game, { hp: 170, base: 140 });
    foe.bench = [easy, threat];
    p.hand = [card(name)];
    p.flags.energy = true;
    p.prizes.length = 1;
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    assert.equal((await choose()).kind, 'attack', kind);
    foe.bench = [easy];
    const move = await choose();
    assert.equal(move.tkind, kind);
    await game.perform(p, move);
    await game.perform(p, await choose());
    assert.equal(game.winner, p);
  }
});

test('Melmetal ex projected damage after an attachment matches the actual attack', async () => {
  const { game, p, foe } = fixture({ deck: 'sv-melmetal' });
  p.active = game.createMon(card('Melmetal ex'), 1);
  p.active.energy = Array.from({ length: 4 }, () => card('sve-8'));
  foe.active = game.createMon(card('Dragapult ex'), 1);
  const held = card('sve-8');
  p.hand = [held];
  const damage = readyDamage(game, p.active, foe.active);
  const next = readyDamage(game, p.active, foe.active, undefined, { attached: [...p.active.energy, held], certain: true });
  assert.equal(next, damage + 30);
  assert.equal(p.active.energy.length, 4);
  const attach = game.legalActions(p).find((a) => a.kind === 'energy' && a.target === p.active);
  assert.ok(attach);
  await game.perform(p, attach);
  const attack = game.legalActions(p).find((a) =>
    a.kind === 'attack' && game.attacksOf(p.active)[a.index].name === 'Full Metal Knuckle');
  assert.ok(attack);
  await game.perform(p, attack);
  assert.equal(foe.active.damage, next);
});

test('Projected prizes agree with damage knockouts under Shadowy Concealment and Altered Creation', async () => {
  for (const bonus of [false, true]) {
    const { game, p, foe } = fixture({ deck: 'mel-lucario', opposingDeck: 'me-gengar' });
    p.active = game.createMon(card('Mega Lucario ex'), 1);
    p.active.energy = [card('Basic Fighting Energy')];
    p.prizes.length = 1;
    if (bonus) p.until.alteredPrize = true;
    foe.active = game.createMon(card('me2-54'), 1);
    foe.bench = [game.createMon(card('Mega Gengar ex'), 1)];
    const value = attackPrizes(game, foe, foe.active, p.active);
    assert.equal(value, Number(bonus));
    if (bonus) assert.equal(attackPrizes(game, foe, foe.active, p.active, { active: false }), 0);
    const race = projectPrizeRace(game, p, p.hand, { attacks: 1, exactPrizes: true });
    assert.equal(race.steps[0].take, value);
    const attack = game.legalActions(p).find((a) => a.kind === 'attack');
    assert.equal(attackFinishChance(game, p, attack.index, true), value);
    await game.perform(p, attack);
    assert.equal(p.prizes.length, race.state.prizes[0]);
    assert.equal(game.winner === p, bonus);
  }
});

test('Gary keeps a ready attacker in play when the small damage gain is not worth a paid retreat', async () => {
  const { game, p, foe, controller } = fixture();
  const bench = game.createMon(card('sv4pt5-8'), 1);
  for (const m of [p.active, bench]) m.energy = [card('Basic Fire Energy'), card('Basic Fire Energy')];
  p.bench = [bench];
  foe.active = game.createMon(card('Mega Gengar ex'), 1);
  const legal = game.legalActions(p);
  assert.ok(legal.some((action) => action.kind === 'retreat'));
  assert.equal((await controller.chooseAction(game, p, legal)).kind, 'attack');
});

test("Gary uses Switch to put Brock's Lickitung in against Psychic even when Hitmonchan survives the next hit", async () => {
  const { game, p, foe, controller } = fixture({ deck: 'brock', opposingDeck: 'sabrina' });
  p.active = game.createMon(card('base1-7'), 1);
  p.active.energy = [card('Basic Fighting Energy')];
  const lickitung = game.createMon(card("Brock's Lickitung"), 1);
  p.bench = [lickitung];
  p.hand = [card('Switch')];
  foe.active = game.createMon(card("Sabrina's Haunter"), 1);
  foe.active.energy = [card('Basic Psychic Energy'), card('Basic Psychic Energy')];
  assert.equal(game.finalDamage(foe.active, p.active, 20).dmg, 40);
  assert.equal(game.finalDamage(foe.active, lickitung, 20).dmg, 0);
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(action.tkind, 'switch');
  await game.perform(p, action);
  assert.equal(p.active, lickitung);
});

test('Gary chooses the Psychic-resistant replacement after a Knock Out', async () => {
  const { game, p, foe } = fixture({ deck: 'brock', opposingDeck: 'sabrina' });
  p.active = null;
  game.current = foe;
  const hitmonchan = game.createMon(card('base1-7'), 1);
  hitmonchan.energy = [card('Basic Fighting Energy'), card('Basic Fighting Energy')];
  const lickitung = game.createMon(card("Brock's Lickitung"), 1);
  p.bench = [hitmonchan, lickitung];
  foe.active = game.createMon(card("Sabrina's Haunter"), 1);
  foe.active.energy = [card('Basic Psychic Energy'), card('Basic Psychic Energy')];
  await game.refillActive();
  assert.equal(p.active, lickitung);
});

test('Gary pays for retreat to save an exposed Hitmonchan', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'brock', opposingDeck: 'sabrina' });
  p.active = game.createMon(card('base1-7'), 1);
  p.active.damage = 30;
  p.active.energy = [card('Basic Fighting Energy'), card('Basic Fighting Energy')];
  const lickitung = game.createMon(card("Brock's Lickitung"), 1);
  p.bench = [lickitung];
  foe.active = game.createMon(card("Sabrina's Haunter"), 1);
  foe.active.energy = [card('Basic Psychic Energy'), card('Basic Psychic Energy')];
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(action.kind, 'retreat');
  assert.equal(action.target, lickitung);
});

test('Gary uses the cheap paralysis attack when the direct hit is stopped by resistance', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'brock', opposingDeck: 'sabrina' });
  p.active = game.createMon(card("Brock's Onix"), 1);
  p.active.energy = Array.from({ length: 3 }, () => card('Basic Fighting Energy'));
  foe.active = game.createMon(card("Sabrina's Haunter"), 1);
  foe.active.energy = [card('Basic Psychic Energy'), card('Basic Psychic Energy')];
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(action.kind, 'attack');
  assert.equal(game.attacksOf(p.active)[action.index].name, 'Bellow');
});

test('Gary chooses Aura Jab when either attack takes the same prizes and charges a backup', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'mel-lucario', opposingDeck: 'svl-dragapult' });
  p.active = game.createMon(card('Mega Lucario ex'), 1);
  p.active.energy = [card('Basic Fighting Energy'), card('Basic Fighting Energy')];
  p.discard.push(card('Basic Fighting Energy'));
  const backup = game.createMon(card('Solrock'), 1);
  p.bench = [backup];
  foe.active = game.createMon(card('Dragapult ex'), 1);
  foe.active.damage = foe.active.maxHp - 120;
  foe.bench = [game.createMon(card('Wattrel'), 1)];
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(action.kind, 'attack');
  assert.equal(game.attacksOf(p.active)[action.index].name, 'Aura Jab');
  await game.perform(p, action);
  assert.equal(backup.energy.length, 1);
  assert.equal(p.prizes.length, 4);
});

test('Gary chooses Mega Brave when its higher damage secures a Knock Out', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'mel-lucario', opposingDeck: 'svl-dragapult' });
  p.active = game.createMon(card('Mega Lucario ex'), 1);
  p.active.energy = [card('Basic Fighting Energy'), card('Basic Fighting Energy')];
  foe.active = game.createMon(card('Dragapult ex'), 1);
  foe.active.damage = foe.active.maxHp - 240;
  foe.bench = [game.createMon(card('Wattrel'), 1)];
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(action.kind, 'attack');
  assert.equal(game.attacksOf(p.active)[action.index].name, 'Mega Brave');
});

test('Gary splits Phantom Dive counters across two Bench Knock Outs to take its last three prizes', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'svl-dragapult', opposingDeck: 'sv-miraidon' });
  p.active = game.createMon(card('Dragapult ex'), 1);
  p.active.energy = [card('Basic Fire Energy'), card('Basic Psychic Energy')];
  foe.active = game.createMon(card('Charizard ex'), 1);
  const small = game.createMon(card('Wattrel'), 1);
  const reachable = game.createMon(card('Miraidon ex'), 1);
  const other = game.createMon(card('Dragapult ex'), 1);
  for (const [mon, hp] of [[small, 20], [reachable, 40], [other, 50]]) mon.damage = mon.maxHp - hp;
  foe.bench = [other, reachable, small];
  p.prizes.length = 3;
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(action.kind, 'attack');
  assert.equal(game.attacksOf(p.active)[action.index].name, 'Phantom Dive');
  await game.perform(p, action);
  assert.equal(game.winner, p);
  assert.deepEqual(foe.bench, [other]);
});

test('Gary targets a knockout on the Active when Wave Veil blocks Bench damage', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'sv-miraidon', opposingDeck: 'swl-palkia' });
  p.active = game.createMon(card('Kilowattrel'), 1);
  p.active.energy = [card('Basic Lightning Energy'), card('Basic Lightning Energy')];
  foe.active = game.createMon(card('swsh9-41'), 1);
  const vulnerable = game.createMon(card('Miraidon ex'), 1);
  vulnerable.damage = vulnerable.maxHp - 10;
  foe.bench = [vulnerable];
  p.prizes.length = 1;
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(game.attacksOf(p.active)[action.index].name, 'Skill Dive');
  await game.perform(p, action);
  assert.equal(game.winner, p);
  assert.equal(vulnerable.hpLeft, 10);
});

test('Gary gusts the reachable two-prize target to end the game', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'mel-lucario', opposingDeck: 'svl-dragapult' });
  p.active = game.createMon(card('Mega Lucario ex'), 1);
  p.active.energy = [card('Basic Fighting Energy')];
  p.hand = [card("Boss's Orders")];
  p.prizes.length = 2;
  foe.active = game.createMon(card('Dragapult ex'), 1);
  const small = game.createMon(card('Wattrel'), 1);
  const twoPrizes = game.createMon(card('Miraidon ex'), 1);
  twoPrizes.damage = 120;
  foe.bench = [small, twoPrizes];
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(action.tkind, 'bossOrders');
  assert.equal(action.target, twoPrizes);
});

function closingFixture() {
  const state = fixture({ deck: 'mel-lucario', opposingDeck: 'svl-dragapult' });
  const { game, p, foe } = state;
  p.active = game.createMon(card('Mega Lucario ex'), 1);
  p.active.energy = [card('Basic Fighting Energy')];
  const boss = card("Boss's Orders");
  p.hand = [boss];
  p.prizes.length = 3;
  foe.active = game.createMon(card('Wattrel'), 1);
  const wall = game.createMon(card('Dragapult ex'), 1);
  wall.energy = [card('Basic Fire Energy')];
  const closer = game.createMon(card('Miraidon ex'), 1);
  closer.damage = 150;
  foe.bench = [wall, closer];
  return { ...state, boss, closer };
}

test('Gary keeps its last gust for a one-then-two prize route', async () => {
  const { game, p, foe, controller, boss, closer } = closingFixture();
  const forecast = projectPrizeRace(game, p, p.hand);
  assert.deepEqual(forecast.steps.map((step) => step.take), [1, 2]);
  assert.equal(forecast.steps[1].target, closer);
  assert.equal(forecast.steps[1].gust, boss);
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(action.kind, 'attack');
  await game.perform(p, action);
  assert.ok(p.hand.includes(boss));
  assert.equal(p.prizes.length, 2);
  assert.ok(foe.active);
  game.turn += 2;
  p.flags = {};
  const finish = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(finish.tkind, 'bossOrders');
  assert.equal(finish.target, closer);
  await game.perform(p, finish);
  await game.perform(p, await controller.chooseAction(game, p, game.legalActions(p)));
  assert.equal(game.winner, p);
});

test('Prize route protects one copy of the planned finisher', () => {
  const { game, p, boss } = closingFixture();
  const extra = card("Boss's Orders");
  const plan = prizePlan(null, projectPrizeRace(game, p, p.hand), p);
  assert.ok(plan.reserveValue([boss]) > 0);
  assert.equal(plan.reserveValue([extra]), plan.reserveValue([boss]));
  assert.equal(plan.reserveValue([boss, extra]), plan.reserveValue([boss]));
});

test('Gary removes a ready attacker before it can take the final three prizes', async () => {
  const { game, p, foe, controller, closer } = closingFixture();
  p.active.damage = p.active.maxHp - 120;
  closer.energy = [card('Basic Lightning Energy'), card('Basic Lightning Energy'), card('Basic Lightning Energy')];
  foe.prizes.length = 3;
  const forecast = projectPrizeRace(game, p, p.hand);
  assert.equal(forecast.steps[0].target, closer);
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(action.tkind, 'bossOrders');
  assert.equal(action.target, closer);
});

test('Gary uses Quick Search for a known available gust that opens a prize win', async () => {
  const { game, p, foe, controller, decisions } = fixture({ deck: 'svl-charizard', opposingDeck: 'svl-dragapult' });
  p.deck.push(...p.prizes.splice(2));
  const take = (predicate) => {
    const index = p.deck.findIndex(predicate);
    if (index >= 0) return p.deck.splice(index, 1)[0];
    const prizeIndex = p.prizes.findIndex(predicate);
    assert.ok(prizeIndex >= 0);
    return p.prizes.splice(prizeIndex, 1, p.deck.pop())[0];
  };
  p.active = game.createMon(take((c) => c.name === 'Charizard ex'), 1);
  p.active.energy = [take((c) => c.energyType === 'Fire'), take((c) => c.energyType === 'Fire')];
  p.bench = [game.createMon(take((c) => c.name === 'Pidgeot ex'), 1)];
  const boss = take((c) => c.tkind === 'bossOrders');
  p.deck.splice(2, 0, boss);
  foe.active = game.createMon(card('Dragapult ex'), 1);
  const target = game.createMon(card('Miraidon ex'), 1);
  target.damage = 100;
  foe.bench = [target];
  game.viewDeck(p);
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(action.pkind, 'quickSearch');
  assert.equal(decisions.at(-1).reason, 'lethal');
  await game.perform(p, action);
  assert.ok(p.hand.includes(boss));
  const gust = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(gust.target, target);
  assert.equal(decisions.at(-1).reason, 'lethal');
  await game.perform(p, gust);
  await game.perform(p, await controller.chooseAction(game, p, game.legalActions(p)));
  assert.equal(game.winner, p);
});

test('Gary opens with a free retreat pivot and keeps an entry-only support card in hand', async () => {
  const { game, p, controller } = fixture({ deck: 'svl-gardevoir' });
  game.turn = 0;
  p.active = null;
  const pivot = card('Mew ex'), ralts = card('Ralts'), lumineon = card('Lumineon V');
  p.hand = [pivot, ralts, lumineon];
  const options = p.hand.map((c) => ({ card: c, id: String(c.uid) }));
  assert.equal(await controller.choose(game, p, { kind: 'setup-active', options }), String(pivot.uid));
  p.active = game.createMon(pivot, 0);
  p.hand = [ralts, lumineon];
  assert.deepEqual(await controller.setupBench(game, p, p.hand), [ralts.uid]);
});

test('Gary draws before Artazon when it wants Basics for two independent lines', async () => {
  const { game, p, controller } = fixture({ deck: 'svl-charizard' });
  game.turn = 3;
  p.active = game.createMon(card('Moltres'), 1);
  p.hand = [card('Iono'), card('Pidgeot ex')];
  game.stadium = { card: card('Artazon'), owner: p.idx };
  const artazon = { kind: 'stadium', stadium: 'artazon', key: 'artazon' };
  const redraw = { kind: 'trainer', tkind: 'iono', card: p.hand[0], key: 'iono' };
  const plan = planAttacker(game, p);
  assert.ok(plan.setupTargets.some(({ card }) => card.name === 'Charmander'));
  assert.ok(plan.setupTargets.some(({ card }) => card.name === 'Pidgey'));
  assert.equal(await controller.chooseAction(game, p, [artazon, redraw]), redraw);
  p.bench = [game.createMon(card('Pidgey'), 1)];
  assert.equal(await controller.chooseAction(game, p, [artazon, redraw]), artazon);
});

test('Reply evaluation sees a charged Benched attacker only once a public retreat is payable', () => {
  const { game, p, foe } = fixture();
  foe.active = game.createMon(card('Wattrel'), 1);
  const attacker = game.createMon(card('Mega Lucario ex'), 1);
  attacker.energy = [card('Basic Fighting Energy'), card('Basic Fighting Energy')];
  foe.bench = [attacker];
  assert.equal(replyThreat(game, foe, p.active, { includeSetup: false }), 0);
  foe.active.energy.push(card('Basic Lightning Energy'));
  assert.ok(replyThreat(game, foe, p.active, { includeSetup: false }) >= 35);
});

test('Gary counts a live Energy draw when the visible reply would otherwise win', () => {
  const { game, p, foe } = fixture({ deck: 'svl-charizard', opposingDeck: 'mel-lucario' });
  p.active = game.createMon(card('Charizard ex'), 1);
  p.active.damage = p.active.maxHp - 120;
  p.active.energy = [card('Basic Fire Energy')];
  foe.active = game.createMon(card('Mega Lucario ex'), 1);
  foe.active.damage = foe.active.maxHp - 150;
  foe.active.energy = [card('Basic Fighting Energy'), card('Basic Fighting Energy')];
  foe.bench = [game.createMon(card('Solrock'), 1)];
  p.prizes.length = foe.prizes.length = 2;
  const iono = card('Iono');
  p.hand = [iono];
  const action = { kind: 'trainer', card: iono, tkind: 'iono' };
  const rows = [{ action, redraw: redrawProfile(game, p, action), score: 10 }];
  const best = rankClosingRisk(game, p, rows, projectPrizeRace(game, p, p.hand));
  assert.equal(best.action, action);
  assert.ok(best.win > 0.15 && best.win < 1);
  assert.ok(rows[0].score > 10);
});

test('Gary ends the turn when the opponent is certain to deck out', async () => {
  const { game, p, foe, controller, decisions } = fixture();
  p.active = game.createMon(card('Mega Lucario ex'), 1);
  p.active.energy = [card('Basic Fighting Energy')];
  foe.deck.length = 0;
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(action.kind, 'end');
  assert.equal(decisions.at(-1).reason, 'lethal');
  await game.perform(p, action);
  await game.checkup(p);
  await game.startTurn(foe);
  assert.equal(game.winner, p);
});

test('Gary does not claim a deck-out win if Checkup knocks out its last Pokémon', async () => {
  const { game, p, foe, controller, decisions } = fixture();
  p.active = game.createMon(card('Mega Lucario ex'), 1);
  p.active.energy = [card('Basic Fighting Energy')];
  p.active.damage = p.active.maxHp - 10;
  p.active.status.poisoned = true;
  foe.active = game.createMon(card('Dragapult ex'), 1);
  foe.deck.length = 0;
  await controller.chooseAction(game, p, game.legalActions(p));
  assert.notEqual(decisions.at(-1).reason, 'lethal');
});

test('Gary avoids spending Energy to return to the previous Active in the same turn', async () => {
  const { game, p, foe, controller } = fixture();
  const original = game.createMon(card('Solrock'), 1);
  original.energy = [card('Basic Fighting Energy')];
  const pivot = p.active;
  pivot.energy = [card('Basic Fire Energy'), card('Basic Fire Energy')];
  p.active = original;
  p.bench = [pivot];
  foe.active = game.createMon(card('Mega Gengar ex'), 1);
  game.swapActive(p, pivot);
  const legal = game.legalActions(p);
  assert.ok(legal.some((action) => action.kind === 'retreat' && action.target === original));
  assert.equal((await controller.chooseAction(game, p, legal)).kind, 'attack');
  assert.equal(pivot.energy.length, 2);
});

test('Gary uses Switch instead of spending Energy when either route wins the game', async () => {
  const { game, p, foe, controller } = fixture();
  const pivot = p.active;
  pivot.energy = [card('Basic Fire Energy')];
  const attacker = game.createMon(card('Mega Lucario ex'), 1);
  attacker.energy = [card('Basic Fighting Energy')];
  p.bench = [attacker];
  foe.active = game.createMon(card('Wattrel'), 1);
  p.hand = [card('Switch')];
  assert.ok(game.legalActions(p).some((action) => action.kind === 'retreat'));
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(action.tkind, 'switch');
  await game.perform(p, action);
  assert.equal(p.active, attacker);
  assert.equal(pivot.energy.length, 1);
});

test('Gary gives the available Energy to a compatible backup instead of a fully charged Active', async () => {
  const { game, p, foe, controller } = fixture();
  p.active = game.createMon(card('sv4pt5-8'), 1);
  p.active.energy = [card('Basic Fire Energy'), card('Basic Fire Energy')];
  const backup = game.createMon(card('Riolu'), 1);
  p.bench = [game.createMon(card('Miraidon ex'), 1), backup];
  foe.active = game.createMon(card('Mega Gengar ex'), 1);
  foe.bench = [game.createMon(card('Wattrel'), 1)];
  p.hand = [card('Basic Fighting Energy')];
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(action.kind, 'energy');
  assert.equal(action.target.id, backup.id);
});

test('Psychic Embrace charges the bench instead of damaging a fully charged Gardevoir', async () => {
  const { game, p, foe } = fixture({ deck: 'svl-gardevoir' });
  const energy = () => card('Basic Psychic Energy');
  p.active = game.createMon(card('Gardevoir ex'), 1);
  p.active.energy = [energy(), energy(), energy()];
  const backup = game.createMon(card('Kirlia'), 1);
  backup.energy = [energy()];
  p.bench = [backup];
  p.discard = [energy()];
  foe.active = game.createMon(card('Mega Gengar ex'), 1);
  const ability = game.legalActions(p).find((action) => action.pkind === 'psychicEmbrace');
  assert.ok(ability);
  await game.perform(p, ability);
  assert.equal(backup.energy.length, 2);
  assert.equal(backup.damage, 20);
  assert.equal(p.active.damage, 0);
});

test('Gary holds a surplus Energy when there is no useful target', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'mel-lucario' });
  p.active = game.createMon(card('Mega Lucario ex'), 1);
  p.active.energy = [card('Basic Fighting Energy'), card('Basic Fighting Energy')];
  foe.active = game.createMon(card('Mega Gengar ex'), 1);
  p.hand = [card('Basic Fighting Energy')];
  assert.equal((await controller.chooseAction(game, p, game.legalActions(p))).kind, 'attack');
});

test('Gary can still add Energy to a ready attacker when it increases damage enough to win', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'sv-chien-pao' });
  p.active = game.createMon(card('Chien-Pao ex'), 1);
  p.active.energy = [card('Basic Water Energy'), card('Basic Water Energy')];
  foe.active = game.createMon(card('Mega Gengar ex'), 1);
  foe.active.damage = foe.active.maxHp - 170;
  p.hand = [card('Basic Water Energy')];
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(action.kind, 'energy');
  assert.equal(action.target, p.active);
  await game.perform(p, action);
  await game.perform(p, await controller.chooseAction(game, p, game.legalActions(p)));
  assert.equal(game.winner, p);
});

test('Quick Search gets the evolution needed by the deck plan and enables Rare Candy', async () => {
  const { game, p, controller } = fixture();
  p.bench.push(game.createMon(card('Pidgeot ex'), 1));
  const charizard = card('Charizard ex');
  p.deck = [charizard, card('Moltres'), card('Basic Fire Energy'), ...p.deck.filter((c) => c.name !== 'Charizard ex')];
  p.hand = [card('Rare Candy')];
  const search = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(search.pkind, 'quickSearch');
  await game.perform(p, search);
  assert.ok(p.hand.includes(charizard));
  const evolve = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(evolve.tkind, 'rareCandy');
  await game.perform(p, evolve);
  assert.equal(p.active.name, 'Charizard ex');
  assert.ok(p.active.energy.filter((c) => c.energyType === 'Fire').length >= 2);
});

test('A confirmed Ultra Ball target can be replayed through Rare Candy and a same-turn win', async () => {
  const { game, p, foe, controller, decisions } = fixture({ deck: 'svl-charizard' });
  controller.version = () => 'v3';
  controller.v3Policy.budget.milliseconds = Infinity;
  p.deck.push(...p.prizes);
  const take = (predicate) => {
    const i = p.deck.findIndex(predicate);
    assert.ok(i >= 0);
    return p.deck.splice(i, 1)[0];
  };
  p.active = game.createMon(take((c) => c.name === 'Charmander'), 1);
  const evolution = take((c) => c.name === 'Charizard ex');
  p.hand = [take((c) => c.tkind === 'ultraBall'), take((c) => c.tkind === 'rareCandy'),
    take((c) => c.kind === 'energy'), take((c) => c.kind === 'energy')];
  p.prizes = [take((c) => c.kind === 'trainer'), take((c) => c.kind === 'trainer')];
  p.deck.unshift(evolution);
  p.flags.energy = true;
  foe.active = game.createMon(card('Miraidon ex'), 1);
  foe.active.damage = 100;
  foe.bench = [game.createMon(card('Wattrel'), 1)];
  game.viewDeck(p);
  const next = async () => {
    const action = await controller.chooseAction(game, p, game.legalActions(p));
    assert.equal(decisions.at(-1).reason, 'lethal');
    return action;
  };
  const legal = game.legalActions(p), actualDeck = p.deck;
  p.deck = new Proxy(actualDeck, {
    get(target, key) {
      if (key === 'length') return target.length;
      assert.fail(`Read the real deck while planning: ${String(key)}`);
    },
  });
  let ball;
  try {
    ball = await controller.chooseAction(game, p, legal);
    assert.equal(decisions.at(-1).reason, 'lethal');
  } finally {
    p.deck = actualDeck;
  }
  assert.equal(ball.tkind, 'ultraBall');
  await game.perform(p, ball);
  assert.ok(p.hand.includes(evolution));
  const candy = await next();
  assert.equal(candy.evo, evolution);
  await game.perform(p, candy);
  const attack = await next();
  assert.equal(attack.kind, 'attack');
  await game.perform(p, attack);
  assert.equal(game.winner, p);
});

test('Current V3 uses first-turn-only bench search before drawing', async () => {
  const deck = 'swl-palkia';
  const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
  controller.version = () => 'v3';
  game.turn = 2;
  game.first = foe;
  p.active = targetingMon(game);
  foe.active = targetingMon(game, { hp: 150 });
  p.hand = [card('Battle VIP Pass'), card('Hop')];
  assert.ok(game.legalActions(p).some((action) => action.tkind === 'battleVipPass'), JSON.stringify(game.legalActions(p).map((a) => a.tkind ?? a.kind)));
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  const pass = await choose();
  assert.equal(pass.tkind, 'battleVipPass');
  await game.perform(p, pass);
  assert.ok(p.bench.length);
  assert.equal((await choose()).tkind, 'hop');
});

test('Shivery Chill uses the Pokémon ability to get Energy for the intended attacker', async () => {
  const { game, p, controller } = fixture({ deck: 'sv-chien-pao' });
  p.active = game.createMon(card('Chien-Pao ex'), 1);
  p.hand = [card('Basic Fire Energy')];
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(action.pkind, 'shiveryChill');
  await game.perform(p, action);
  assert.equal(p.hand.filter((c) => c.energyType === 'Water').length, 2);
});

test('The hand reset is deprioritized when the main evolution is already assembled', () => {
  const { game, p } = fixture();
  const reset = { kind: 'trainer', tkind: 'iono', card: card('Iono') };
  p.hand = [reset.card, card('Switch')];
  assert.ok(planAttacker(game, p).actionPriority(reset) > 0);
  p.hand.push(card('Rare Candy'), card('Charizard ex'));
  assert.ok(planAttacker(game, p).actionPriority(reset) < 0);
});

test('A hand reset can put enough cards back to prevent deck-out', async () => {
  const { game, p, controller } = fixture();
  p.deck = [];
  p.hand = [card('Iono'), ...Array.from({ length: 8 }, () => card('Basic Fire Energy'))];
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(action.tkind, 'iono');
  await game.perform(p, action);
  assert.equal(p.deck.length, 2);
});

test('Gary benches and attaches useful cards before discarding the hand for seven', async () => {
  const { game, p, controller } = fixture();
  const research = card("Professor's Research (Professor Sada)");
  const basic = card('sv4pt5-7'), energy = card('Basic Fire Energy');
  p.hand = [research, basic, energy];
  const actions = [];
  for (let i = 0; i < 3; i++) {
    const chosen = await controller.chooseAction(game, p, game.legalActions(p));
    actions.push(chosen);
    await game.perform(p, chosen);
  }
  assert.deepEqual(actions.slice(0, 2).map((a) => a.kind).sort(), ['bench', 'energy']);
  assert.equal(actions[2].tkind, 'professorsResearch');
  assert.equal(p.hand.length, 7);
  assert.ok(p.bench.some((m) => m.card === basic));
  assert.ok(game.allMons(p).some((m) => m.energy.includes(energy)));
});

test('Equal-size hand replacement keeps an assembled evolution and rerolls a weak hand', () => {
  const { game, p, foe } = fixture();
  const gaze = card("Sabrina's Gaze");
  const action = { kind: 'trainer', tkind: 'sabrinasGaze', card: gaze };
  foe.hand = Array.from({ length: 4 }, () => card('Basic Fighting Energy'));
  p.hand = [gaze, card('Charizard ex'), card('Rare Candy'), card('Basic Fire Energy'), card("Boss's Orders")];
  const strong = redrawProfile(game, p, action);
  assert.equal(strong.draw, 4);
  assert.equal(redrawScore(game, p, action, strong, planAttacker(game, p)), 1);
  p.hand = [gaze, ...Array.from({ length: 4 }, () => card('Basic Fire Energy'))];
  assert.ok(redrawScore(game, p, action, redrawProfile(game, p, action), planAttacker(game, p)) > 1);
});

test('A same-size Iono is worthwhile when it shrinks a large opposing hand', () => {
  const { game, p, foe } = fixture();
  const iono = card('Iono');
  const action = { kind: 'trainer', tkind: 'iono', card: iono };
  p.hand = [iono, card('Switch'), card('Switch')];
  p.prizes.length = 2;
  foe.prizes.length = 2;
  foe.hand = Array.from({ length: 7 }, () => card('Basic Fighting Energy'));
  const profile = redrawProfile(game, p, action);
  assert.equal(profile.draw, 2);
  assert.ok(redrawScore(game, p, action, profile, planAttacker(game, p)) > 1);
});

test('Secret Mission only exchanges cards whose replacement has positive value', async () => {
  const { game, p, controller } = fixture({ deck: 'lt-surge', opposingDeck: 'sabrina' });
  p.active = game.createMon(card("Lt. Surge's Pikachu"), 1);
  const mission = card('Secret Mission'), energy = card('Basic Lightning Energy');
  p.hand = [mission, energy, ...Array.from({ length: 4 }, () => card('Basic Fire Energy'))];
  p.flags.energy = true;
  const choice = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(choice.tkind, 'secretMission');
  await game.perform(p, choice);
  assert.equal(p.hand.length, 5);
  assert.ok(p.hand.includes(energy));
  assert.ok(p.discard.some((c) => c.energyType === 'Fire'));
  assert.ok(p.discard.every((c) => c === mission || c.energyType === 'Fire'));
});

test('Full-deck observation infers the remaining Prize multiset from known zones', () => {
  const game = new Game({ decks: ['svl-charizard', 'sv-miraidon'], controllers: [], random: () => 0.8 });
  const p = game.players[0];
  p.hand = p.deck.splice(0, 7);
  p.prizes = p.deck.splice(0, 6);
  const counts = (cards) => {
    const result = new Map();
    for (const c of cards) result.set(c.id, (result.get(c.id) || 0) + 1);
    return result;
  };
  const inferred = observePrizeCounts(game, p, counts(p.deck));
  assert.deepEqual(new Map([...inferred].filter(([, count]) => count > 0)), counts(p.prizes));
});

test('Gary versions can be selected on the same controller', async () => {
  const { game, p, controller, decisions } = fixture();
  let version = 'v1';
  controller.version = () => version;
  p.hand = [card('Basic Fire Energy')];
  const actions = game.legalActions(p);
  assert.ok(actions.includes(await controller.chooseAction(game, p, actions)));
  assert.ok(Number.isFinite(decisions.at(-1).confidence));
  version = 'v2';
  assert.ok(actions.includes(await controller.chooseAction(game, p, actions)));
  assert.equal(controller.lastPolicy, controller.hardPolicy);
  version = 'v3';
  assert.ok(actions.includes(await controller.chooseAction(game, p, actions)));
  assert.equal(controller.lastPolicy, controller.v3Policy);
});

test('V3 attacks with Iron Roar when V2 passes despite the one-Energy acceleration', async () => {
  const { game, p, foe, controller, decisions } = fixture({ deck: 'sv-melmetal', opposingDeck: 'svd-miraidon' });
  game.turn = 8;
  p.active = game.createMon(card('sv4-136'), 1);
  p.active.energy = [card('sve-8')];
  p.bench = ['sv3-145', 'sv1-142', 'sv1-142', 'sv2-151'].map((id) => game.createMon(card(id), 1));
  p.bench[0].energy = [card('sve-8')];
  p.flags = { energy: true, supporter: true, powers: Object.fromEntries(p.bench.map((m) => [m.id, true])) };
  p.hand = ['sv2-151', 'sv3-154', 'sv3-152', 'sve-8', 'sve-8'].map(card);
  p.discard = [card('sve-8'), card('sve-8')];
  foe.active = game.createMon(card('sv5-122'), 1);
  foe.active.damage = 30;
  foe.active.energy = ['sve-5', 'sve-5', 'sve-4'].map(card);
  foe.prizes.length = 4;
  assert.equal((await controller.chooseAction(game, p, game.legalActions(p))).kind, 'end');

  const original = new AIController({
    version: () => 'v3',
    garyPolicy: GaryV3Policy,
    policyLimits: { milliseconds: Infinity },
    onDecision: (_, decision) => decisions.push(decision),
  });
  const originalAttack = await original.chooseAction(game, p, game.legalActions(p));
  assert.equal(originalAttack.kind, 'attack');
  assert.equal(game.attacksOf(p.active)[originalAttack.index].name, 'Iron Roar');
  assert.equal(decisions.at(-1).reason, 'productive-attack');

  controller.version = () => 'v3';
  let attack = await controller.chooseAction(game, p, game.legalActions(p));
  if (attack.kind === 'bench') {
    assert.equal(await game.perform(p, attack), false);
    attack = await controller.chooseAction(game, p, game.legalActions(p));
  }
  assert.equal(attack.kind, 'attack');
  assert.equal(game.attacksOf(p.active)[attack.index].name, 'Iron Roar');
  await game.perform(p, attack);
  assert.equal(foe.active.damage, 60);
  assert.equal(p.bench.reduce((n, mon) => n + mon.energy.length, 0), 2);
});

test('V3 uses a setup search when V2 passes with its only Pokémon', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'sv-steven', opposingDeck: 'swsh-cinderace' });
  game.turn = 4;
  p.active = game.createMon(card('sv10-142'), 1);
  p.active.damage = 10;
  p.hand = ['sv10-145', 'sv1-191', 'sv10-145', 'sv2-172', 'sv8-174', 'sv1-194', 'sv10-144', 'sv1-190'].map(card);
  foe.active = game.createMon(card('swsh1-153'), 1);
  foe.active.energy = [card('sve-2')];
  foe.bench = [game.createMon(card('swsh1-31'), 1)];
  assert.equal((await controller.chooseAction(game, p, game.legalActions(p))).kind, 'end');
  controller.version = () => 'v3';
  assert.equal((await controller.chooseAction(game, p, game.legalActions(p))).tkind, 'drayton');

  const before = JSON.stringify(game.serialize());
  const actions = game.legalActions(p);
  const coach = new AIController({ version: () => aiConfig.coachVersion, policyLimits: { milliseconds: Infinity } });
  const recommend = () => rankActions(game, p, actions, { coach, withWinChance: true });
  const previous = aiConfig.coachVersion;
  try {
    aiConfig.coachVersion = 'v1';
    assert.deepEqual((await recommend()).action, cpuRank(game, p, actions));
    aiConfig.coachVersion = 'v2';
    assert.equal((await recommend()).action.choice, actions.find((action) => action.kind === 'end').key);
    aiConfig.coachVersion = 'v3';
    const result = await recommend();
    assert.equal(result.action.choice, actions.find((action) => action.tkind === 'drayton').key);
    assert.equal(result.action.probabilities, undefined);
    assert.deepEqual(result.win, cpuWin(game, p));
    assert.equal(JSON.stringify(game.serialize()), before);
  } finally {
    aiConfig.coachVersion = previous;
  }
});

test('Arena replays the Giovanni mirror with the recorded built-in V3 policy', async () => {
  const job = { decks: ['giovanni', 'giovanni'], seed: 705565377 };
  await loadDeck(job.decks[0]);
  const profiles = [0, 1].map(() => ({ version: 'v3', label: 'v3' }));
  const original = await play(job, profiles, true, true);
  const recorded = JSON.parse(JSON.stringify(original));
  assert.deepEqual(recorded.profiles.map((profile) => profile.policy), ['built-in', 'built-in']);
  assert.deepEqual([original.first, original.winner, original.turns, original.reason], [0, 0, 9, 'reason.noPokemon']);

  const oldRecord = { ...recorded, profiles: profiles.map((profile) => ({ ...profile, features: garyV3Profile })) };
  for (const restored of [replayProfiles(recorded), replayProfiles(oldRecord, profiles)]) {
    const replayed = await play(job, restored, true, true);
    assert.deepEqual([replayed.first, replayed.winner, replayed.turns, replayed.reason], [0, 0, 9, 'reason.noPokemon']);
    const turn = replayed.replay.find(({ turn }) => turn === 7);
    assert.deepEqual(turn.actions.map(([kind, name]) => [kind, name]),
      [['bench', undefined], ['energy', undefined], ['trainer', 'warpPoint'], ['attack', 'Horn Thrust']]);
    assert.equal(turn.events.find(([key]) => key === 'log.energy')[2].m.$card.id, 'gym2-75');
  }

  const experiment = { version: 'v3', label: 'candidate', features: garyV3Profile };
  const legacy = { versions: ['v3', 'v3'], challengerSeat: 1, profiles: [oldRecord.profiles[0], experiment] };
  assert.deepEqual(replayProfiles(legacy, [experiment, profiles[0]]).map((profile) => profile.policy), ['built-in', 'experiment']);
});

test('Current V3 draws with Hop before ending its turn with a non-KO Flame Charge', async () => {
  const decks = ['swv-victini', 'swl-urshifu-rapid'];
  await Promise.all(decks.map(loadDeck));
  const { game, p, foe } = fixture({ deck: decks[0], opposingDeck: decks[1] });
  game.turn = 4;
  game.first = foe;
  p.active = game.createMon(card('swsh1-30'), 0);
  p.active.stack.push(card('swsh1-32'));
  p.active.energy = [card('sve-2')];
  p.bench = [game.createMon(card('swsh1-30'), 0)];
  p.flags.energy = true;
  p.hand = ['swsh1-165', 'swsh2-158', 'swsh45-59', 'sve-2'].map(card);
  foe.active = game.createMon(card('swsh5-36'), 0);
  foe.active.damage = 30;
  foe.bench = [game.createMon(card('swsh5-87'), 1)];
  foe.bench[0].energy = [card('sve-6')];
  const controller = (garyPolicy) => new AIController({ version: () => 'v3', garyPolicy, policyLimits: { milliseconds: Infinity } });
  const previous = controller(GaryV3Policy), current = controller();
  const legal = game.legalActions(p);
  assert.equal((await previous.chooseAction(game, p, legal)).kind, 'attack');
  const hop = await current.chooseAction(game, p, legal);
  assert.equal(hop.tkind, 'hop');
  const count = p.hand.length;
  assert.equal(await game.perform(p, hop), false);
  assert.equal(p.hand.length, count + 2);
  assert.ok(game.legalActions(p).some((a) => a.kind === 'attack'));
});

test('V3 uses additive draws before committing its Energy or evolution, then decides from the new hand', async () => {
  await Promise.all(['swv-lycanroc', 'sm-blazing-volcano', 'sm-lightning-loop'].map(loadDeck));
  for (const [deck, draw] of [
    ['blackout', 'Bill'], ['swv-lycanroc', 'Gym Trainer'], ['sm-blazing-volcano', 'Kahili'],
    ['sm-lightning-loop', 'Looker'], ['sv-melmetal', 'Roark'], ['sv-melmetal', 'Rika'],
  ]) {
    const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
    controller.version = () => 'v3';
    game.turn = 12;
    p.active = game.createMon(card('Hitmonchan'), 1);
    p.bench = [game.createMon({ ...card('Squirtle'), attacks: [] }, 1)];
    p.hand = [card(draw), card('Fighting Energy'), card('Wartortle')];
    if (draw === 'Bill') p.hand = [p.hand[0], card('Water Energy'), p.hand[2]];
    foe.active = game.createMon({ ...card('Squirtle'), hp: 120, attacks: [] }, 1);
    foe.bench = [game.createMon(card('Squirtle'), 1)];
    const actions = game.legalActions(p);
    assert.ok(actions.some((a) => a.kind === 'energy') && actions.some((a) => a.kind === 'evolve'), draw);
    const before = game.serialize();
    const first = await controller.chooseAction(game, p, actions);
    assert.equal(first.card?.name, draw);
    assert.deepEqual(game.serialize(), before);
    if (draw === 'Bill') {
      const water = card('Water Energy'), fighting = card('Fighting Energy');
      p.deck.push(water, fighting);
      await game.perform(p, first);
      assert.ok(p.hand.includes(water) && p.hand.includes(fighting));
      assert.equal(p.active.energy.length, 0);
      let next = await controller.chooseAction(game, p, game.legalActions(p));
      if (next.kind === 'evolve') {
        await game.perform(p, next);
        next = await controller.chooseAction(game, p, game.legalActions(p));
      }
      assert.equal(next.kind, 'energy');
      assert.equal(next.card, fighting);
      assert.equal(next.target, p.active);
    }
  }
});

test('V3 prioritizes additive draw abilities while preserving hand-limit and deck-out decisions', async () => {
  await loadDeck('sm-roaring-heat');
  const { game, p, foe, controller } = fixture({ deck: 'svl-dragapult' });
  controller.version = () => 'v3';
  p.active = game.createMon(card('Hitmonchan'), 1);
  p.bench = [game.createMon(card('Fezandipiti ex'), 1)];
  p.koTurn = game.turn - 1;
  p.hand = [card('Fighting Energy')];
  foe.active = game.createMon({ ...card('Squirtle'), hp: 120, attacks: [] }, 1);
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  assert.equal((await choose()).pkind, 'flipTheScript');
  p.deck.length = 3;
  assert.equal((await choose()).kind, 'energy');

  const classic = fixture({ deck: 'blackout', opposingDeck: 'blackout' });
  classic.controller.version = () => 'v3';
  classic.p.active = classic.game.createMon(card('Hitmonchan'), 1);
  classic.p.active.energy = [card('Fighting Energy')];
  classic.foe.active = classic.game.createMon({ ...card('Squirtle'), hp: 90, attacks: [] }, 1);
  classic.p.hand = [card('Bill')];
  classic.p.deck.length = 2;
  assert.equal((await classic.controller.chooseAction(classic.game, classic.p, classic.game.legalActions(classic.p))).kind, 'attack');

  p.deck = [...foe.deck];
  p.bench = [];
  p.hand = [card('Lillie'), card('Fighting Energy')];
  assert.equal((await choose()).kind, 'energy');
});

test('V3 preserves an immediate win and can draw with an Item before choosing a Supporter', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'swl-palkia' });
  controller.version = () => 'v3';
  const attacker = card('Hitmonchan');
  p.active = game.createMon(attacker, 1);
  p.active.energy = [card('Fighting Energy')];
  p.hand = [card('Trekking Shoes'), card('Boss\'s Orders'), card('Nemona')];
  foe.active = game.createMon({ ...card('Squirtle'), hp: 20, attacks: [] }, 1);
  foe.bench = [];
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  assert.equal((await choose()).kind, 'attack');
  foe.active = game.createMon({ ...card('Squirtle'), hp: 120, attacks: [] }, 1);
  foe.bench = [game.createMon({ ...card('Squirtle'), hp: 120, attacks: [] }, 1)];
  assert.equal((await choose()).tkind, 'trekkingShoes');
});

test('V3 keeps the Energy that lets Rika or Explorer’s Guidance open an attack', async () => {
  await loadDeck('svd-koraidon');
  for (const [deck, trainer, shown] of [['sv-melmetal', 'Rika', 4], ['svd-koraidon', "Explorer's Guidance", 6]]) {
    const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
    controller.version = () => 'v3';
    p.active = targetingMon(game, { base: 60, cost: ['Water'] });
    foe.active = targetingMon(game, { hp: 150 });
    p.hand = [card(trainer)];
    const water = card('Water Energy');
    const fillers = Array.from({ length: shown - 2 }, (_, index) => ({ ...card('Squirtle'), name: `Filler${index}`, attacks: [] }));
    p.deck = [...p.deck.slice(0, 10), card('Fire Energy'), water, ...fillers];
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    await game.perform(p, await choose());
    assert.equal(p.hand.length, 2);
    assert.ok(p.hand.includes(water), trainer);
    for (let i = 0; i < 4 && !foe.active.damage; i++) await game.perform(p, await choose());
    assert.equal(foe.active.damage, 60);
  }
});

test('V3 keeps both parts of a Rare Candy attack setup with Rika', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'svl-charizard', opposingDeck: 'svl-charizard' });
  controller.version = () => 'v3';
  p.active = game.createMon({ ...card('Charmander'), attacks: [] }, 0);
  foe.active = targetingMon(game, { hp: 110 });
  foe.bench = [targetingMon(game, { hp: 140 })];
  const evo = { ...card('Charizard ex'), attacks: [{ name: 'Hit', base: 120, cost: [], fx: {} }], powerKind: undefined };
  const candy = card('Rare Candy');
  p.hand = [card('Rika')];
  p.deck = [...p.deck.slice(0, 10), evo, candy, card('Miraidon ex'), card('Fezandipiti ex')];
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  await game.perform(p, await choose());
  assert.deepEqual(new Set(p.hand.map((entry) => entry.id)), new Set([candy.id, evo.id]));
  const evolution = await choose();
  assert.equal(evolution.tkind, 'rareCandy');
  await game.perform(p, evolution);
  await game.perform(p, await choose());
  assert.equal(p.prizes.length, 5);
});

test('V3 arranges the deck before taking its top cards', async () => {
  for (const [deck, order, draw, kind] of [
    ['svd-miraidon', "Ciphermaniac's Codebreaking", null, 'ciphermaniac'],
    ['power-reserve', 'Pokédex', 'Bill', 'pokedex'],
  ]) {
    const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
    controller.version = () => 'v3';
    p.active = targetingMon(game, draw ? {} : { powerKind: 'reconDirective', power: { name: 'Recon Directive', kind: 'reconDirective' } });
    foe.active = targetingMon(game, { hp: 150 });
    p.flags.energy = true;
    p.hand = [card(order), ...(draw ? [card(draw)] : [])];
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    assert.equal((await choose()).tkind, kind);

    p.active = targetingMon(game, { base: 60, cost: ['Water'], ...(draw ? {} : {
      powerKind: 'reconDirective', power: { name: 'Recon Directive', kind: 'reconDirective' },
    }) });
    p.flags.energy = false;
    const water = card('Water Energy');
    p.deck = [water, ...Array.from({ length: 4 }, (_, index) => ({ ...card('Squirtle'), name: `Filler${index}` }))];
    const setup = await choose();
    assert.equal(setup.tkind, kind);
    await game.perform(p, setup);
    assert.equal(p.deck.at(-1), water);
    const take = await choose();
    assert.equal(take.pkind ?? take.tkind, draw ? 'bill' : 'reconDirective');
    await game.perform(p, take);
    assert.ok(p.hand.includes(water));
  }
});

test('V3 draws with Hop before attaching when Boss’s Orders has no useful target', async () => {
  for (const targetHP of [180, 70]) {
    const { game, p, foe, controller } = fixture({ deck: 'swl-palkia', opposingDeck: 'swl-palkia' });
    controller.version = () => 'v3';
    p.active = targetingMon(game, { base: 70, cost: ['Water'] });
    foe.active = targetingMon(game, { hp: 150 });
    foe.bench = [targetingMon(game, { hp: targetHP })];
    p.hand = [card('Hop'), card("Boss's Orders"), card('Water Energy')];
    p.prizes.length = 1;
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    if (targetHP === 180) {
      assert.equal((await choose()).tkind, 'hop');
      assert.equal(p.active.energy.length, 0);
    } else {
      for (let i = 0; i < 3; i++) {
        const choice = await choose();
        assert.notEqual(choice.tkind, 'hop');
        await game.perform(p, choice);
      }
      assert.equal(game.winner, p);
    }
  }
});

test('Draw preparation compares a plain draw with a completed nonlethal attack', async () => {
  await loadDeck('swv-victini');
  const { game, p, foe } = fixture({ deck: 'mel-lucario', opposingDeck: 'svl-dragapult' });
  game.turn = 4;
  p.active = game.createMon(card('Mega Lucario ex'), 1);
  p.active.energy = [card('Basic Fighting Energy')];
  p.hand = [card('Hop'), ...Array.from({ length: 3 }, () => card('Basic Fighting Energy'))];
  p.flags.energy = true;
  foe.active = game.createMon(card('Dragapult ex'), 1);
  const comparison = new GaryV3Policy(cpuScore, cpuPick, {
    milliseconds: Infinity,
    strategy: buildV3Strategy(['compare-preparation']),
  });
  const choice = await comparison.chooseAction(game, p, game.legalActions(p));
  assert.equal(choice.action.tkind, 'hop');
  assert.equal(choice.reason, 'planned-draw');
});

test('V3 develops an Inteleon attack rather than opening an off-type Ram on Snom', async () => {
  const decks = ['swl-inteleon', 'c30-umbreon'];
  await Promise.all(decks.map(loadDeck));
  const { game, p, foe } = fixture({ deck: decks[0], opposingDeck: decks[1] });
  game.turn = 9;
  p.deck.length = 12;
  p.active = game.createMon(card('swsh3-37'), 3);
  p.active.energy = [card('sve-3')];
  p.bench = ['swsh2-49', 'swsh2-49', 'swsh1-55', 'swsh1-63', 'swsh1-117']
    .map((id) => game.createMon(card(id), 3));
  const [inteleon, , evolved, snom] = p.bench;
  inteleon.energy = [card('sve-3')];
  evolved.stack.push(card('swsh1-56'), card('swsh1-58'));
  evolved.playedTurn = 9;
  evolved.effects.evolvedNow = { expires: 9 };
  p.active.effects.lastAtk = { atk: 'Wave Splash', expires: 9 };
  p.hand = ['swsh1-55', 'swsh1-169', 'sve-3', 'sve-3', 'swsh1-56', 'swsh1-163', 'swsh1-164'].map(card);
  p.discard = ['swsh1-178', 'swsh2-154', 'swsh2-50', 'swsh2-154', 'swsh1-178', 'swsh2-169', 'swsh2-156',
    'swsh1-164', 'swsh1-55', 'sve-3', 'sve-3', 'swsh1-179', 'swsh1-171', 'swsh1-169', 'swsh1-164', 'swsh1-163',
    'swsh1-117', 'swsh1-178', 'swsh1-58', 'swsh2-154', 'swsh1-156', 'swsh2-156', 'swsh1-164', 'swsh1-179', 'swsh1-63'].map(card);
  foe.active = game.createMon(card('me55-58'), 0);
  foe.active.stack.push(card('me55-60'));
  foe.active.damage = 60;
  foe.active.energy = ['sve-7', 'me5-84', 'sve-7'].map(card);
  foe.bench = ['me55-58', 'me55-58', 'me55-118', 'me55-116', 'me55-118']
    .map((id) => game.createMon(card(id), 1));
  foe.bench[0].energy = [card('sve-7')];
  foe.bench[2].stack.push(card('me55-92'));
  foe.prizes.length = 4;
  foe.deck.length = 36;
  foe.hand = ['sve-7', 'me4-30'].map(card);
  const controller = (garyPolicy) => new AIController({ version: () => 'v3', garyPolicy, policyLimits: { milliseconds: Infinity } });
  const legal = game.legalActions(p);
  const original = await controller(GaryV3Policy).chooseAction(game, p, legal);
  assert.equal(original.target?.id, snom.id);
  assert.equal(betterAttachment(game, p, legal, original)?.target, inteleon);
  const before = structuredClone(game.serialize());
  const choice = await controller().chooseAction(game, p, legal);
  assert.equal(choice.kind, 'energy');
  assert.ok([inteleon, evolved].includes(choice.target));
  assert.deepEqual(game.serialize(), before);
});

test('Prize projection spends the actual cards required by attack discards', async () => {
  await loadDeck('swl-urshifu-single');
  const rules = buildV3Strategy(garyV3Profile).prizeRules;
  for (const fx of [{ discardAllEnergy: true }, { discard: { type: 'Fire', n: 1 } }]) {
    const { game, p, foe } = fixture();
    const attacker = { ...card('Single Strike Urshifu VMAX'),
      attacks: [{ name: 'Discard attack', cost: ['Fighting'], base: 100, fx }] };
    p.active = game.createMon(attacker, 1);
    p.active.energy = [card('Single Strike Energy')];
    foe.active = game.createMon({ ...card('Wattrel'), resistance: null }, 1);
    foe.bench = [game.createMon(card('Miraidon ex'), 1)];
    p.prizes.length = 2;
    const race = projectPrizeRace(game, p, p.hand, rules);
    const attack = game.legalActions(p).find((a) => a.kind === 'attack');
    await game.perform(p, attack);
    assert.equal(race.steps[0].damage, fx.discard ? 100 : 120);
    assert.equal(race.steps[1], null);
    assert.equal(race.state.prizes[0], p.prizes.length);
    assert.deepEqual(race.state.attached[0][0], p.active.energy);
  }
});

test('Prize projection applies the opponent’s new Prize count to Burning Darkness', async () => {
  const { game, p, foe } = fixture();
  p.active.damage = p.active.maxHp - 10;
  const charizard = game.createMon(card('Charizard ex'), 1);
  charizard.energy = [card('Basic Fire Energy'), card('Basic Fire Energy')];
  p.bench = [charizard];
  foe.active = game.createMon({ ...card('Miraidon ex'), hp: 230, weakness: null, resistance: null, prizes: 1 }, 1);
  foe.active.energy = Array.from({ length: 3 }, () => card('Basic Lightning Energy'));
  foe.bench = [game.createMon(card('Dragapult ex'), 1)];
  p.prizes.length = 2;
  foe.prizes.length = 5;
  const race = projectPrizeRace(game, p, p.hand, {
    ...buildV3Strategy(garyV3Profile).prizeRules, afterTurn: true, attacks: 1,
  });
  game.current = foe;
  game.turn++;
  await game.perform(foe, game.legalActions(foe).find((a) => a.kind === 'attack'));
  assert.equal(foe.prizes.length, 4);
  assert.equal(p.active, charizard);
  game.current = p;
  game.turn++;
  await game.perform(p, game.legalActions(p).find((a) => a.kind === 'attack'));
  assert.equal(race.steps[0].damage, 240);
  assert.equal(race.state.prizes[0], p.prizes.length);
  assert.equal(p.prizes.length, 1);
});

test('Damage prediction agrees with Cosmic Beam’s named Bench requirement', async () => {
  for (const hasLunatone of [false, true]) {
    const { game, p, foe } = fixture({ deck: 'mel-lucario' });
    p.active = game.createMon(card('Solrock'), 1);
    p.active.energy = [card('Basic Fighting Energy')];
    if (hasLunatone) p.bench = [game.createMon(card('Lunatone'), 1)];
    const hit = readyDamage(game, p.active, foe.active, undefined, { certain: true });
    await game.perform(p, game.legalActions(p).find((a) => a.kind === 'attack'));
    assert.equal(hit, foe.active.damage);
    assert.equal(hit, hasLunatone ? 70 : 0);
  }
});

test('Thin opposing decks and first-turn Lillie use the engine’s draw counts', async () => {
  await loadDeck('sm-roaring-heat');
  const { game, p, foe } = fixture();
  p.hand = [card('Marnie')];
  foe.hand = [card('Basic Fighting Energy')];
  foe.deck = [];
  const marnie = game.legalActions(p).find((a) => a.tkind === 'marnie');
  const redraw = redrawProfile(game, p, marnie);
  await game.perform(p, marnie);
  assert.equal(redraw.opponentDraw, 1);
  assert.equal(redraw.opponentDraw, foe.hand.length);

  game.turn = 2;
  game.first = foe;
  p.flags.supporter = false;
  p.hand = [card('Lillie'), card('Hau'), card('Basic Fire Energy'), card('Basic Fire Energy')];
  const trainers = game.legalActions(p);
  const lillie = trainers.find((a) => a.tkind === 'lillie');
  const hau = trainers.find((a) => a.tkind === 'hau');
  assert.equal(drawBeforeAttack(game, p, [hau, lillie]), lillie);
  const count = lillieDrawCount(game, p, lillie);
  await game.perform(p, lillie);
  assert.equal(count, 5);
  assert.equal(count, p.hand.length - 3);
});

test('Double Jet can win by paying with known hand Energy without a coin flip', async () => {
  const { game, p, foe, randomCalls } = fixture({ deck: 'sm-bright-tide' });
  p.active = game.createMon(card('sm1-29'), 1);
  p.active.energy = [card('sm1-166')];
  p.hand = [card('sm1-166'), card('sm1-166')];
  p.prizes.length = 1;
  foe.active = game.createMon({ ...card('Wattrel'), hp: 100, weakness: null, resistance: null }, 1);
  foe.bench = [game.createMon(card('Miraidon ex'), 1)];
  const attack = game.legalActions(p).find((a) => a.kind === 'attack' && a.index === 1);
  game.controllers[0] = new AIController({ version: () => 'v3', policyLimits: { milliseconds: Infinity } });
  const coins = [];
  game.hooks.onCoin = (result) => coins.push(result);
  const before = randomCalls();
  assert.equal(attackFinishChance(game, p, attack.index, true), 1);
  assert.equal(randomCalls(), before);
  await game.perform(p, attack);
  assert.equal(game.winner, p);
  assert.equal(coins.length, 0);
});

test('V3 completes a two-step Bench knockout with the rule engine', async () => {
  const { game, p, foe, randomCalls } = fixture({ deck: 'swl-palkia' });
  const bot = new AIController({ version: () => 'v3', policyLimits: { milliseconds: Infinity } });
  game.controllers[0] = bot;
  p.active = game.createMon(card('swsh10-40'), 1);
  p.active.energy = [card('Basic Water Energy'), card('Basic Water Energy')];
  p.hand = [card('swsh9-120'), card('Echoing Horn')];
  const blank = (hp) => ({ ...card('Wattrel'), hp, weakness: null, resistance: null, attacks: [] });
  foe.active = game.createMon(blank(115), 1);
  foe.bench = [game.createMon(blank(80), 1)];
  foe.discard = [card('Wattrel')];
  p.prizes.length = 3;
  assert.equal(readyDamage(game, p.active, foe.active, undefined, { certain: true }), 80);
  const calls = randomCalls();
  const first = await bot.chooseAction(game, p, game.legalActions(p));
  assert.ok(first.kind === 'bench' || first.tkind === 'echoingHorn');
  assert.equal(randomCalls(), calls);
  await game.perform(p, first);
  const second = await bot.chooseAction(game, p, game.legalActions(p));
  assert.ok(first.kind === 'bench' ? second.tkind === 'echoingHorn' : second.kind === 'bench');
  await game.perform(p, second);
  const attack = await bot.chooseAction(game, p, game.legalActions(p));
  assert.equal(attack.kind, 'attack');
  await game.perform(p, attack);
  assert.equal(p.prizes.length, 2);
});

test('V3 keeps PlusPower when the turn has no attack that can use it', async () => {
  for (const blocked of ['first turn', 'no Energy', 'asleep', 'paralyzed', 'attack lock', 'no damage']) {
    const { game, p, foe, controller } = fixture({ deck: 'blackout', opposingDeck: 'blackout' });
    controller.version = () => 'v3';
    p.active = game.createMon(card('Hitmonchan'), 0);
    foe.active = game.createMon({ ...card('Squirtle'), hp: 30 }, 0);
    p.active.energy = blocked === 'no Energy' ? [] : [card('Fighting Energy')];
    if (blocked === 'first turn') game.turn = 1;
    if (blocked === 'asleep' || blocked === 'paralyzed') p.active.status[blocked] = true;
    if (blocked === 'attack lock') p.active.effects.noAttack = { target: foe.active.id, expires: game.turn };
    if (blocked === 'no damage') p.active = game.createMon({ ...card('Hitmonchan'),
      attacks: [{ name: 'No damage', cost: [], base: 0, fx: {} }],
    }, 0);
    const boost = card('PlusPower');
    p.hand = [boost];
    const actions = game.legalActions(p);
    assert.ok(actions.some((a) => a.card === boost), blocked);
    assert.equal((await controller.chooseAction(game, p, actions)).kind, blocked === 'no damage' ? 'attack' : 'end', blocked);
    assert.deepEqual(p.hand, [boost], blocked);
  }
});

test('V3 makes an attack available before using PlusPower for the knockout', async () => {
  for (const prep of ['energy', 'switch']) {
    const { game, p, foe, controller } = fixture({ deck: 'blackout', opposingDeck: 'blackout' });
    controller.version = () => 'v3';
    const hitmonchan = game.createMon(card('Hitmonchan'), 0);
    foe.active = game.createMon({ ...card('Squirtle'), hp: 30 }, 0);
    p.active = hitmonchan;
    if (prep === 'switch') {
      p.active = game.createMon(card('Squirtle'), 0);
      p.active.status.paralyzed = true;
      p.bench = [hitmonchan];
      hitmonchan.energy = [card('Fighting Energy')];
    }
    p.hand = [card('PlusPower'), card(prep === 'energy' ? 'Fighting Energy' : 'base1-95')];
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    assert.ok(game.legalActions(p).every((a) => a.kind !== 'attack'));
    const setup = await choose();
    assert.equal(setup.tkind ?? setup.kind, prep);
    await game.perform(p, setup);
    const boost = await choose();
    assert.equal(boost.tkind, 'plusPower');
    await game.perform(p, boost);
    const attack = await choose();
    assert.equal(attack.kind, 'attack');
    await game.perform(p, attack);
    assert.equal(game.winner, p);
  }
});

test('V3 spends PlusPower on a knockout threshold and ignores ordinary chip damage', async () => {
  for (const [hp, options, expected] of [
    [40, {}, 'attack'], // Two Jabs already suffice.
    [50, {}, 'plusPower'], // 30 now plus 20 next turn saves an attack.
    [60, {}, 'attack'], // PlusPower expires and the next Jab is still 20.
    [50, { reply: 120 }, 'attack'], // The attacker cannot survive the reply.
    [50, { cooldown: true }, 'attack'], // A second Jab is unavailable.
    [65, { stronger: true }, 'attack'], // A different unboosted first attack already sets up the knockout.
  ]) {
    const { game, p, foe, controller } = fixture({ deck: 'blackout', opposingDeck: 'blackout' });
    controller.version = () => 'v3';
    const attacker = card('Hitmonchan');
    const [jab] = attacker.attacks;
    attacker.attacks = [{ ...jab, fx: options.cooldown ? { cooldown: true } : {} }];
    if (options.stronger) attacker.attacks.push({ ...jab, name: 'Stronger hit', base: 35 });
    p.active = game.createMon(attacker, 0);
    p.active.energy = [card('Fighting Energy')];
    p.hand = [card('PlusPower')];
    foe.active = game.createMon({ ...card('Squirtle'), hp, attacks: options.reply ?
      [{ name: 'Reply', cost: [], base: options.reply, fx: {} }] : [],
    }, 0);
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    const first = await choose();
    assert.equal(first.tkind ?? first.kind, expected, JSON.stringify({ hp, options }));
    if (first.tkind === 'plusPower') {
      await game.perform(p, first);
      const hit = await choose();
      assert.equal(hit.kind, 'attack');
      await game.perform(p, hit);
      await game.checkup(p);
      assert.equal(foe.active.hpLeft, 20);
      assert.equal(p.active.toolCount('plusPower'), 0);
      game.turn += 2;
      await game.perform(p, await choose());
      assert.equal(game.winner, p);
    }
  }
});

test('V3 combines two PlusPower when both are needed to win before the reply', async () => {
  for (const hp of [30, 40, 50]) {
    const { game, p, foe, controller } = fixture({ deck: 'blackout', opposingDeck: 'blackout' });
    controller.version = () => 'v3';
    const attack = (base) => ({ name: 'Hit', base, cost: [], fx: {} });
    p.active = game.createMon({ ...card('Squirtle'), attacks: [attack(20)] }, 0);
    foe.active = game.createMon({ ...card('Squirtle'), hp, attacks: [attack(100)] }, 0);
    p.prizes.length = 1;
    p.hand = [card('PlusPower'), card('PlusPower')];
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    const count = hp === 30 ? 1 : hp === 40 ? 2 : 0;
    for (let i = 0; i < count; i++) {
      const boost = await choose();
      assert.equal(boost.tkind, 'plusPower', `${hp} HP, boost ${i + 1}`);
      await game.perform(p, boost);
    }
    const finish = await choose();
    assert.equal(finish.kind, 'attack');
    assert.equal(p.hand.filter((c) => c.tkind === 'plusPower').length, 2 - count);
    await game.perform(p, finish);
    assert.equal(game.winner, count ? p : null);
  }
});

test('V3 does not spend Premium Power Pro just to raise the simulated damage score', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'mel-lucario', opposingDeck: 'mel-lucario' });
  controller.version = () => 'v3';
  const lucario = card('Mega Lucario ex');
  p.active = game.createMon({ ...lucario, hp: 30, attacks: [{ name: 'Hit', base: 10, cost: [], fx: {} }] }, 0);
  foe.active = game.createMon({ ...lucario, attacks: [{ name: 'Reply', base: 120, cost: [], fx: {} }] }, 0);
  p.hand = [card('Premium Power Pro')];
  const actions = game.legalActions(p);
  assert.ok(actions.some((a) => a.tkind === 'premiumPowerPro'));
  assert.equal((await controller.chooseAction(game, p, actions)).kind, 'attack');
});

test('V3 keeps type-specific boosts for eligible attackers and retains other trainer benefits', async () => {
  await Promise.all(['swsh-charizard', 'lightning-bug'].map(loadDeck));
  for (const [deck, trainer, canAttack, expected] of [
    ['swl-mew', 'Power Tablet', true, 'attack'],
    ['mel-lucario', 'Premium Power Pro', false, 'end'],
    ['mel-lucario', 'Premium Power Pro', true, 'attack'],
    ['swsh-cinderace', 'Leon', false, 'end'],
    ['swsh-charizard', 'Leon', false, 'leon'], // Royal Blaze counts Leon in the discard pile.
    ['sm-bright-tide', 'Professor Kukui', false, 'professorKukui'],
    ['lightning-bug', 'Defender', false, 'defender'],
  ]) {
    const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
    controller.version = () => 'v3';
    p.active = game.createMon({ ...card('Squirtle'), attacks: canAttack ? [{ name: 'Hit', cost: [], base: 20, fx: {} }] : [] }, 0);
    if (trainer === 'Power Tablet') {
      p.bench = [game.createMon({ ...card('Mew V'), powerKind: null, attacks: [] }, 0)];
      p.flags.retreat = true;
    }
    foe.active = targetingMon(game, { hp: 50, base: trainer === 'Defender' ? 50 : undefined });
    p.hand = [card(trainer)];
    const actions = game.legalActions(p);
    assert.ok(actions.some((a) => a.card === p.hand[0]), trainer);
    const action = await controller.chooseAction(game, p, actions);
    assert.equal(action.tkind ?? action.kind, expected, trainer);
  }
});

test('V3 spends temporary attack resources only when they can affect the turn', async () => {
  await loadDeck('svd-ninetales');
  for (const blocked of ['no Fire attack', 'no Energy', 'immune defender', 'already a knockout', 'no Evolution target', 'no Devolution target', null]) {
    const { game, p, foe, controller } = fixture({ deck: 'svl-dragapult', opposingDeck: 'svl-dragapult' });
    controller.version = () => 'v3';
    p.active = game.createMon({ ...card('Wattrel'), type: blocked === 'no Fire attack' ? 'Water' : 'Fire',
      attacks: [{ name: 'Hit', cost: ['Colorless'], base: 30, fx: {} }],
    }, 0);
    p.active.energy = blocked === 'no Energy' ? [] : [card('Basic Fire Energy')];
    p.flags.energy = true;
    foe.active = game.createMon({ ...card('Squirtle'), hp: blocked === 'already a knockout' ? 30 : 60, attacks: [] }, 0);
    if (blocked === 'immune defender') foe.active.effects.shield = { kind: 'damage', expires: game.turn };
    if (blocked?.endsWith('target')) {
      p.bench = [game.createMon(card('Squirtle'), 0)];
      p.hand = [card(blocked === 'no Evolution target' ? 'sv4-178' : 'sv4-177')];
    } else {
      p.bench = [game.createMon(card('swsh12-22'), 0)];
      p.hand = [card('Basic Fire Energy')];
    }
    p.flags.retreat = true;
    const actions = game.legalActions(p);
    const spendsTemporaryEffect = (a) => a.pkind === 'heatBoost' || a.tkind === 'tool';
    assert.ok(actions.some(spendsTemporaryEffect), blocked);
    const action = await controller.chooseAction(game, p, actions);
    if (blocked) {
      assert.ok(!spendsTemporaryEffect(action), blocked);
    } else {
      assert.equal(action.pkind, 'heatBoost');
      await game.perform(p, action);
      assert.equal(p.hand.length, 0);
      const attack = await controller.chooseAction(game, p, game.legalActions(p));
      assert.equal(attack.kind, 'attack');
      await game.perform(p, attack);
      assert.equal(game.winner, p);
    }
  }
});

test('V3 charges before attaching a Technical Machine and uses its Evolution attack', async () => {
  const { game, p, foe, controller } = fixture({ deck: 'svl-dragapult', opposingDeck: 'svl-dragapult' });
  controller.version = () => 'v3';
  p.active = game.createMon({ ...card('Wattrel'), attacks: [{ name: 'Hit', cost: ['Colorless'], base: 20, fx: {} }] }, 0);
  p.bench = [game.createMon(card('Dreepy'), 0)];
  p.deck = Array.from({ length: 10 }, () => card('Drakloak'));
  p.hand = [card('sv4-178'), card('Basic Fire Energy')];
  foe.active = game.createMon({ ...card('Squirtle'), weakness: null, attacks: [] }, 0);
  p.active.energy = [card('Basic Fire Energy')];
  p.flags.energy = true;
  game.turn = 1;
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  assert.equal((await choose()).kind, 'end');
  game.turn = 2;
  p.active.energy = [];
  p.flags.energy = false;
  const energy = await choose();
  assert.equal(energy.kind, 'energy');
  assert.equal(energy.target, p.active);
  await game.perform(p, energy);
  const machine = await choose();
  assert.equal(machine.tkind, 'tool');
  assert.equal(machine.target, p.active);
  await game.perform(p, machine);
  const attack = await choose();
  assert.equal(attack.kind, 'attack');
  assert.equal(game.attacksOf(p.active)[attack.index].name, 'Evolution');
  await game.perform(p, attack);
  assert.equal(p.bench[0].name, 'Drakloak');
});

test('V3 uses temporary permission only to improve a real attachment or evolution', async () => {
  await Promise.all(['blaine', 'giovanni'].map(loadDeck));
  const blaine = fixture({ deck: 'blaine', opposingDeck: 'blaine' });
  const { game, p, foe, controller } = blaine;
  controller.version = () => 'v3';
  p.active = game.createMon(card("Blaine's Arcanine"), 0);
  p.active.energy = [card('Fire Energy')];
  foe.active = game.createMon({ ...card('Squirtle'), attacks: [] }, 0);
  p.hand = [card('Blaine'), card('Fire Energy'), card('Fire Energy')];
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  p.active.effects.noEnergy = { expires: game.turn };
  assert.equal((await choose()).kind, 'end');
  delete p.active.effects.noEnergy;
  const allowance = await choose();
  assert.equal(allowance.tkind, 'blaine');
  await game.perform(p, allowance);
  const energy = await choose();
  assert.equal(energy.kind, 'energy');
  assert.ok(energy.card2);

  const gio = fixture({ deck: 'giovanni', opposingDeck: 'giovanni' });
  gio.controller.version = () => 'v3';
  gio.p.active = gio.game.createMon(card("Giovanni's Machop"), 0);
  gio.p.hand = [card('Giovanni'), card("Giovanni's Machoke")];
  const pick = () => gio.controller.chooseAction(gio.game, gio.p, gio.game.legalActions(gio.p));
  assert.equal((await pick()).kind, 'evolve');
  gio.p.active.playedTurn = gio.game.turn;
  const permission = await pick();
  assert.equal(permission.tkind, 'giovanni');
  await gio.game.perform(gio.p, permission);
  assert.equal((await pick()).kind, 'evolve');
});

test('Hand payments protect a complete knockout route when a legal payment can preserve it', () => {
  const { game, p } = fixture({ deck: 'swl-palkia' });
  const bidoof = card('swsh9-120'), horn = card('Echoing Horn');
  const other = [card('Basic Water Energy'), card('Basic Fire Energy')];
  p.hand = [bidoof, horn, ...other];
  const cost = { zone: 'hand', remaining: p.hand, selected: [], count: 2 };
  const options = p.hand.map((c) => ({ id: String(c.uid), card: c }));
  const keepRoute = rankHardPrompt(game, p, { options, cost }, null, [[bidoof, horn]]);
  assert.deepEqual(new Set(keepRoute.map((o) => o.card)), new Set(other));
  const forced = rankHardPrompt(game, p, { options, cost: { ...cost, count: 3 } }, null, [[bidoof, horn]]);
  assert.ok(forced.length > 0);
  const duplicate = card('Echoing Horn');
  p.hand.push(duplicate);
  const withDuplicate = [...options, { id: String(duplicate.uid), card: duplicate }];
  const choices = rankHardPrompt(game, p, { options: withDuplicate, cost: { ...cost, remaining: p.hand } }, null, [[bidoof, horn]]);
  assert.ok(choices.some((o) => o.card === horn) && choices.some((o) => o.card === duplicate));
  assert.ok(choices.every((o) => o.card !== bidoof));
});

test('V3 takes the direct knockout before breaking a Bench-count damage bonus', async () => {
  await loadDeck('swv-deoxys');
  const { game, p, foe } = fixture({ deck: 'swv-deoxys' });
  const bot = new AIController({ version: () => 'v3', policyLimits: { milliseconds: Infinity } });
  game.controllers[0] = bot;
  p.active = game.createMon(card('swsh9-59'), 1);
  p.active.energy = Array.from({ length: 3 }, () => card('Basic Psychic Energy'));
  p.hand = [card('swsh9-58')];
  p.bench = [game.createMon(card('Wattrel'), 1)];
  foe.active = game.createMon({ ...card('Wattrel'), hp: 160, weakness: null, resistance: null, attacks: [] }, 1);
  foe.bench = [game.createMon(card('Wattrel'), 1)];
  p.prizes.length = 3;
  const attack = await bot.chooseAction(game, p, game.legalActions(p));
  assert.equal(attack.kind, 'attack');
  await game.perform(p, attack);
  assert.equal(p.prizes.length, 2);
});

test('V3 prefers the attack that preserves Energy and survives the reply for the same Prize', async () => {
  const { game, p, foe } = fixture({ deck: 'swl-palkia' });
  const bot = new AIController({ version: () => 'v3', policyLimits: { milliseconds: Infinity } });
  game.controllers[0] = bot;
  const palkia = card('swsh10-40');
  const [swell] = palkia.attacks;
  palkia.attacks = [
    { ...swell, name: 'Expensive Swell', fx: { ...swell.fx, selfDamage: 100, discard: { type: 'Water', n: 1 } } },
    swell,
  ];
  p.active = game.createMon(palkia, 1);
  p.active.energy = [card('Basic Water Energy'), card('Basic Water Energy')];
  p.active.damage = p.active.maxHp - 180;
  p.hand = [card('swsh9-120')];
  const blank = (hp, attacks = []) => ({ ...card('Wattrel'), hp, weakness: null, resistance: null, attacks });
  foe.active = game.createMon(blank(95), 1);
  foe.bench = [game.createMon(blank(200, [{ name: 'Counterattack', cost: [], base: 100, fx: {} }]), 1)];
  p.prizes.length = 5;
  foe.prizes.length = 5;
  const bench = await bot.chooseAction(game, p, game.legalActions(p));
  assert.equal(bench.kind, 'bench');
  await game.perform(p, bench);
  const attack = await bot.chooseAction(game, p, game.legalActions(p));
  assert.equal(attack.kind, 'attack');
  assert.equal(attack.index, 1);
  await game.perform(p, attack);
  assert.equal(p.prizes.length, 4);
  assert.equal(p.active.energy.length, 2);
  assert.equal(p.active.hpLeft, 180);
});

test('V3 preserves its last draw against a later opposing deckout, including deck searches', async () => {
  for (const [deck, name] of [['sv-miraidon', 'Nest Ball'], ['blackout', 'Energy Search']]) {
    const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
    controller.version = () => 'v3';
    p.active = targetingMon(game);
    foe.active = targetingMon(game);
    p.hand = [card(name)];
    p.deck = [card(name === 'Nest Ball' ? 'Squirtle' : 'Water Energy')];
    foe.deck = [card('Water Energy')];
    assert.ok(game.legalActions(p).some((a) => a.card === p.hand[0]));
    const end = await controller.chooseAction(game, p, game.legalActions(p));
    assert.equal(end.kind, 'end');
    await game.perform(p, end);
    await game.checkup(p);
    game.current = foe;
    await game.startTurn(foe);
    await game.checkup(foe);
    game.current = p;
    await game.startTurn(p);
    assert.equal(game.winner, null);
    await game.checkup(p);
    game.current = foe;
    await game.startTurn(foe);
    assert.equal(game.winner, p);
  }
});

test('V3 checks every opposing replacement and adapts its own promotion to the result', async () => {
  const cards = [['swv-lycanroc', 'Escape Rope', 'escapeRope'], ['giovanni', 'Warp Point', 'warpPoint'],
    ['sv-kangaskhan', 'Ryme', 'ryme']];
  for (const [deck, name, kind] of cards) {
    await loadDeck(deck);
    for (const replacement of [0, 1]) {
      const { game, p, foe, controller, randomCalls } = fixture({ deck, opposingDeck: deck });
      controller.version = () => 'v3';
      p.active = targetingMon(game, { base: 70, hp: 120, retreat: 5 });
      foe.active = targetingMon(game, { base: 120, hp: kind === 'warpPoint' ? 150 : 70, prizes: 1 });
      if (kind === 'ryme') foe.active.card.hp = 100;
      p.prizes.length = kind === 'escapeRope' ? 2 : 1;
      foe.bench = ['Fire', 'Water'].map((type, i) => targetingMon(game, {
        name: 'Opponent ' + i, hp: 60, weakness: kind === 'ryme' ? null : type,
        prizes: kind === 'escapeRope' ? 2 : 1,
      }));
      if (kind !== 'ryme') {
        p.bench = ['Fire', 'Water'].map((type, i) => targetingMon(game, { name: 'Own ' + i, type, base: 30, retreat: 4 }));
        if (!game.modern) p.active.card.attacks = [];
      } else p.deck.length = 3;
      p.hand = [card(name)];
      p.flags.energy = true;
      game.controllers[foe.idx] = { choose: (_g, _q, prompt) => prompt.options[replacement]?.id ?? prompt.options[0].id };
      const choose = () => controller.chooseAction(game, p, game.legalActions(p));
      const before = game.serialize(), calls = randomCalls();
      const action = await choose();
      assert.equal(action.tkind, kind);
      assert.deepEqual(game.serialize(), before);
      assert.equal(randomCalls(), calls);
      await game.perform(p, action);
      if (kind !== 'ryme') assert.equal(p.active.name, 'Own ' + replacement);
      await game.perform(p, await choose());
      assert.equal(game.winner, p);
    }
  }
});

test('V3 finishes with stacked Fusion Strike boosts or a Tool on a copied attack', async () => {
  for (const [trainer, targetHP, expected] of [['Power Tablet', 130, 'powerTablet'], ['Choice Belt', 240, 'tool']]) {
    const { game, p, foe, controller } = fixture({ deck: 'swl-mew', opposingDeck: 'swl-mew' });
    controller.version = () => 'v3';
    const tablet = expected === 'powerTablet';
    p.active = game.createMon(card(tablet ? 'Mew V' : 'Mew VMAX'), 0);
    p.active.energy = [card('Basic Psychic Energy'), card(tablet ? 'Basic Psychic Energy' : 'Basic Metal Energy')];
    if (!tablet) p.bench = [game.createMon(card('Genesect V'), 0)];
    foe.active = targetingMon(game, { hp: targetHP, tags: ['V'], base: 320 });
    p.prizes.length = 1;
    p.hand = Array.from({ length: tablet ? 2 : 1 }, () => card(trainer));
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    for (let i = 0; i < (tablet ? 2 : 1); i++) {
      const boost = await choose();
      assert.equal(boost.tkind, expected);
      if (!tablet) assert.equal(boost.target, p.active);
      await game.perform(p, boost);
    }
    await game.perform(p, await choose());
    assert.equal(game.winner, p);
  }
});

test('V3 can empty the deck with a discard attachment if the reserve can switch in and win', async () => {
  for (const [deck, trainer, kind, tag] of [['svd-koraidon', "Professor Sada's Vitality", 'sadaVitality', 'Ancient'],
    ['swl-calyrex-ice', 'Melony', 'melony', 'V']]) {
    await loadDeck(deck);
    const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
    controller.version = () => 'v3';
    p.active = targetingMon(game, { hp: 60, retreat: 4 });
    const finisher = targetingMon(game, { base: 90, cost: ['Water', 'Water'], tags: [tag] });
    finisher.energy = [card('Water Energy')];
    p.bench = [finisher];
    p.hand = [card(trainer), card('base1-95')];
    p.discard = [card('Water Energy')];
    p.deck = Array.from({ length: 3 }, () => card('Water Energy'));
    foe.active = targetingMon(game, { hp: 80, base: 120 });
    p.prizes.length = 1;
    p.flags.energy = true;
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    for (const expected of [kind, 'switch', 'attack']) {
      const action = await choose();
      assert.equal(action.tkind ?? action.kind, expected);
      await game.perform(p, action);
    }
    assert.equal(p.deck.length, 0);
    assert.equal(game.winner, p);
  }
});

test('V3 removes the Energy of a reachable attacker or one providing the last-Prize damage reduction', async () => {
  {
    const { game, p, foe, controller } = fixture({ deck: 'blackout', opposingDeck: 'blackout' });
    controller.version = () => 'v3';
    p.active = targetingMon(game, { hp: 60 });
    foe.active = targetingMon(game, { hp: 130, base: 70, cost: ['Water'], retreat: 4 });
    foe.bench = [targetingMon(game, { base: 200, cost: ['Water'] })];
    for (const mon of [foe.active, ...foe.bench]) mon.energy = [card('Water Energy')];
    foe.deck = [card('Squirtle')];
    p.hand = [card('Energy Removal')];
    const action = await controller.chooseAction(game, p, game.legalActions(p));
    assert.equal(action.target, foe.active);
    await game.perform(p, action);
    await game.checkup(p);
    game.current = foe;
    await game.startTurn(foe);
    assert.ok(game.legalActions(foe).every((a) => a.kind !== 'attack' && a.kind !== 'retreat'));
  }
  {
    await loadDeck('swl-urshifu-rapid');
    const { game, p, foe, controller } = fixture({ deck: 'swv-lycanroc', opposingDeck: 'swv-lycanroc' });
    controller.version = () => 'v3';
    p.active = targetingMon(game, { hp: 60, base: 100 });
    foe.active = targetingMon(game, { hp: 90, type: 'Fighting' });
    foe.active.energy = [card('Stone Fighting Energy')];
    p.hand = [card('Fan of Waves')];
    p.prizes.length = 1;
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    const fan = await choose();
    assert.equal(fan.tkind, 'fanOfWaves');
    await game.perform(p, fan);
    await game.perform(p, await choose());
    assert.equal(game.winner, p);
  }
});

test('V3 preserves a protective Stadium when replacing it would expose a winning reply', async () => {
  await loadDeck('svl-miraidon');
  const { game, p, foe, controller } = fixture({ deck: 'svl-miraidon', opposingDeck: 'svl-miraidon' });
  controller.version = () => 'v3';
  p.active = targetingMon(game, { hp: 90, retreat: 1 });
  p.active.energy = [card('Water Energy')];
  foe.active = targetingMon(game, { hp: 150, base: 100, stage: 1 });
  p.hand = [card('Beach Court')];
  game.stadium = { card: card('Lake Acuity'), owner: p.idx };
  p.flags.energy = true;
  const action = await controller.chooseAction(game, p, game.legalActions(p));
  assert.equal(action.kind, 'end');
  await game.perform(p, action);
  await game.checkup(p);
  game.current = foe;
  await game.startTurn(foe);
  await game.perform(foe, game.legalActions(foe).find((a) => a.kind === 'attack'));
  assert.equal(p.active.hpLeft, 10);
  assert.equal(game.winner, null);
});

test('V3 resolves lifesaving or winning Items before the opponent can deck out', async () => {
  await Promise.all(['swl-zacian', 'swl-urshifu-rapid'].map(loadDeck));
  for (const removeTool of [false, true]) {
    const deck = 'swv-lycanroc';
    const { game, p, foe, controller } = fixture({ deck, opposingDeck: deck });
    controller.version = () => 'v3';
    p.active = targetingMon(game, { hp: 10 });
    p.active.status.poisoned = true;
    foe.active = targetingMon(game, { hp: 150 });
    foe.deck = [];
    foe.prizes.length = 1;
    if (removeTool) {
      foe.active.tools = [{ card: card('Big Charm'), expires: Infinity }];
      foe.active.damage = 150;
    } else p.bench = [targetingMon(game, { hp: 80 })];
    p.hand = [card(removeTool ? 'Tool Scrapper' : 'Scoop Up Net')];
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    const action = await choose();
    assert.equal(action.tkind, removeTool ? 'toolScrapper' : 'scoopUpNet');
    await game.perform(p, action);
    if (!removeTool) {
      await game.perform(p, await choose());
      await game.checkup(p);
      game.current = foe;
      await game.startTurn(foe);
    }
    assert.equal(game.winner, p);
  }
});

test('V3 saves healing and damage reduction if the second poison check still takes the Active', async () => {
  for (const trainer of ['Potion', 'Defender']) {
    const { game, p, foe, controller } = fixture({ deck: 'blackout', opposingDeck: 'blackout' });
    controller.version = () => 'v3';
    const potion = trainer === 'Potion';
    p.active = targetingMon(game, { hp: potion ? 100 : 40 });
    p.active.damage = potion ? 10 : 0;
    p.active.status.poisoned = true;
    p.hand = [card(trainer)];
    foe.active = targetingMon(game, { hp: 150, base: potion ? 80 : 40 });
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    assert.equal((await choose()).kind, 'end');
    foe.active = targetingMon(game, { hp: 150, base: potion ? 70 : 30 });
    const protection = await choose();
    assert.equal(protection.tkind, potion ? 'potion' : 'defender');
    await game.perform(p, protection);
    await game.perform(p, await choose());
    await game.checkup(p);
    game.current = foe;
    await game.startTurn(foe);
    await game.perform(foe, game.legalActions(foe).find((a) => a.kind === 'attack'));
    await game.checkup(foe);
    assert.equal(p.active.hpLeft, 10);
  }
});

test('V3 chooses both Water Energy from a selective draw when the pair pays for a winning attack', async () => {
  await Promise.all(['swv-blastoise', 'svd-koraidon'].map(loadDeck));
  for (const name of ['Rika', "Explorer's Guidance"]) {
    const { game, p, foe, controller } = fixture({ deck: 'swv-blastoise', opposingDeck: 'swv-blastoise' });
    controller.version = () => 'v3';
    p.active = game.createMon(card('swsh2-53'), 0);
    p.active.energy = [card('Water Energy')];
    p.flags.energy = true;
    foe.active = targetingMon(game, { hp: 100, base: 150 });
    p.hand = [card(name)];
    p.deck.push(card('Water Energy'), card('Water Energy'), card('Squirtle'), card('Wartortle'));
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    const draw = await choose();
    assert.equal(draw.card?.name, name);
    await game.perform(p, draw);
    assert.equal(p.hand.filter((entry) => entry.energyType === 'Water').length, 2);
    const attack = await choose();
    assert.equal(game.attacksOf(p.active)[attack.index].name, 'Spiral Jet');
    await game.perform(p, attack);
    assert.equal(game.winner, p);
  }
});

test('Forest Seal Stone provides a legal VSTAR action under Path to the Peak', async () => {
  await Promise.all(['svl-miraidon', 'swl-calyrex-ice'].map(loadDeck));
  const { game, p, foe, controller } = fixture({ deck: 'swl-mew', opposingDeck: 'swl-mew' });
  controller.version = () => 'v3';
  p.active = game.createMon(card('Mew V'), 0);
  foe.active = targetingMon(game);
  p.hand = [card('Forest Seal Stone')];
  game.stadium = { card: card('Path to the Peak'), owner: foe.idx };
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  const stone = await choose();
  assert.equal(stone.card.name, 'Forest Seal Stone');
  await game.perform(p, stone);
  const power = await choose();
  assert.equal(power.pkind, 'starAlchemy');
  const hand = p.hand.length;
  await game.perform(p, power);
  assert.equal(p.hand.length, hand + 1);
  assert.equal(p.vstarUsed, true);
  assert.ok(game.legalActions(p).every((a) => a.pkind !== 'starAlchemy'));
});

test('V3 confirms a Computer Search into a winning attack without looking at deck order', async () => {
  await loadDeck('psych-out');
  const { game, p, foe, controller } = fixture({ deck: 'psych-out', opposingDeck: 'psych-out' });
  controller.version = () => 'v3';
  p.active = targetingMon(game, { base: 70, cost: ['Water'] });
  foe.active = targetingMon(game, { hp: 60 });
  const original = [...p.deck, ...p.prizes];
  const take = (name) => {
    const index = original.findIndex((entry) => entry.name === name);
    assert.ok(index >= 0, name);
    return original.splice(index, 1)[0];
  };
  p.active.stack = [take('Squirtle')];
  p.active.stack[0] = { ...p.active.stack[0], attacks: [{ name: 'Hit', base: 70, cost: ['Water'], fx: {} }] };
  p.hand = [take('Computer Search'), take('Psychic Energy'), take('Psychic Energy')];
  p.deck = [take('Water Energy')];
  p.prizes = original.splice(0, 6);
  p.discard = original;
  const deck = new Map([[p.deck[0].id, 1]]);
  controller.observeDeck(game, p, deck);
  assert.ok(controller.v3Policy.prizes.get(game));
  const choose = () => controller.chooseAction(game, p, game.legalActions(p));
  for (const expected of ['computerSearch', 'energy', 'attack']) {
    const action = await choose();
    assert.equal(action.tkind ?? action.kind, expected);
    await game.perform(p, action);
  }
  assert.equal(game.winner, p);
});

test('V3 guards against a copied attack that would take the last Prize', async () => {
  for (const canCopy of [true, false]) {
    const { game, p, foe, controller } = fixture({ deck: 'swl-mew', opposingDeck: 'swl-mew' });
    controller.version = () => 'v3';
    p.active = targetingMon(game, { hp: 180, attacks: [
      { name: 'Hit', base: 60, cost: [], fx: {} },
      { name: 'Guard', base: 20, cost: [], fx: { reduce: 50 } },
    ] });
    p.bench = [targetingMon(game, { hp: 190, base: 150 })];
    p.hand = [];
    foe.active = game.createMon(card('Mew VMAX'), 0);
    foe.active.energy = [card('Basic Psychic Energy'), card('Basic Metal Energy')];
    foe.bench = canCopy ? [game.createMon(card('Genesect V'), 0)] : [targetingMon(game, { hp: 180 })];
    foe.prizes.length = 1;
    const action = await controller.chooseAction(game, p, game.legalActions(p));
    assert.equal(action.index, canCopy ? 1 : 0);
    await game.perform(p, action);
    await game.checkup(p);
    game.current = foe;
    await game.startTurn(foe);
    if (canCopy) {
      await game.perform(foe, game.legalActions(foe).find((a) => a.kind === 'attack'));
      assert.equal(p.active.hpLeft, 20);
      assert.equal(game.winner, null);
    }
  }
});

test('V3 keeps a vulnerable two-Prize Basic in hand unless it completes a winning attack', async () => {
  for (const canWin of [false, true]) {
    const { game, p, foe, controller } = fixture({ deck: 'swl-mew', opposingDeck: 'swl-mew' });
    controller.version = () => 'v3';
    game.turn = 7;
    p.active = targetingMon(game, { hp: 250, attacks: [
      { name: 'Hit', base: 30, cost: [], fx: canWin ? { plusOwnBench: 60 } : {} },
    ] });
    p.bench = [targetingMon(game, { hp: 170 })];
    p.hand = [card('Mew V')];
    foe.active = targetingMon(game, { hp: canWin ? 150 : 210, base: 190, prizes: 1 });
    foe.bench = [targetingMon(game, { hp: 120 })];
    foe.prizes.length = 2;
    p.prizes.length = canWin ? 1 : 6;
    foe.hand = [card('swsh9-132')];
    foe.discard = [card('swsh9-132')];
    const choose = () => controller.chooseAction(game, p, game.legalActions(p));
    let action = await choose();
    if (canWin) {
      assert.equal(action.kind, 'bench');
      await game.perform(p, action);
      action = await choose();
    }
    assert.equal(action.kind, 'attack');
    await game.perform(p, action);
    if (canWin) assert.equal(game.winner, p);
    else {
      await game.checkup(p);
      game.current = foe;
      await game.startTurn(foe);
      assert.equal(p.hand[0].name, 'Mew V');
      const pull = game.legalActions(foe).find((a) => a.tkind === 'bossOrders');
      assert.ok(pull);
      await game.perform(foe, pull);
      await game.perform(foe, game.legalActions(foe).find((a) => a.kind === 'attack'));
      assert.equal(foe.prizes.length, 1);
      assert.equal(game.winner, null);
    }
  }
});

test('Prize projection pays hand costs after attaching and cannot see the opposing hand', async () => {
  await loadDeck('swv-blastoise');
  const { game, p, foe } = fixture({ deck: 'swv-blastoise', opposingDeck: 'swv-blastoise' });
  p.active = game.createMon(card('swsh2-53'), 0);
  p.bench = [targetingMon(game)];
  p.prizes.length = 1;
  foe.active = targetingMon(game, { hp: 100 });
  foe.bench = [targetingMon(game)];
  const options = { attacks: 1, exactPrizes: true };
  p.hand = [card('Water Energy'), card('Water Energy')];
  const cannotPay = projectPrizeRace(game, p, p.hand, options);
  assert.equal(cannotPay.state.prizes[0], 1);
  p.hand.push(card('Water Energy'));
  const canPay = projectPrizeRace(game, p, p.hand, options);
  assert.equal(canPay.state.prizes[0], 0);
  assert.equal(canPay.state.hand.length, 0);
  await game.perform(p, game.legalActions(p).find((a) => a.kind === 'energy' && a.target === p.active));
  await game.perform(p, game.legalActions(p).find((a) => a.kind === 'attack' && a.index === 1));
  assert.equal(game.winner, p);

  const fresh = fixture({ deck: 'swv-blastoise', opposingDeck: 'swv-blastoise' });
  fresh.p.active = targetingMon(fresh.game, { hp: 100 });
  fresh.p.bench = [targetingMon(fresh.game)];
  fresh.foe.active = fresh.game.createMon(card('swsh2-53'), 0);
  fresh.foe.active.energy = [card('Water Energy')];
  fresh.foe.prizes.length = 1;
  const project = () => projectPrizeRace(fresh.game, fresh.p, [], { ...options, afterTurn: true }).value;
  const risk = () => responseRisk(fresh.game, fresh.foe.active, fresh.p.active);
  fresh.foe.hand = [card('Water Energy'), card('Water Energy')];
  const first = [project(), risk()];
  fresh.foe.hand = [card('Fire Energy'), card('Fire Energy')];
  assert.deepEqual([project(), risk()], first);
});

test('Bench readiness values a payable retreat or known Switch above a blocked route', () => {
  const { game, p, foe } = fixture();
  game.turn = 7;
  p.active = targetingMon(game, { hp: 100, retreat: 4 });
  p.bench = [targetingMon(game, { base: 200 })];
  foe.active = targetingMon(game, { hp: 160 });
  const value = () => buildV3Strategy(['board-readiness']).position(game, p, false);
  const blocked = value();
  p.hand = [card('Switch')];
  const switched = value();
  p.hand = [];
  p.active.stack[0].retreat = 0;
  assert.ok(blocked > 0);
  assert.ok(switched > blocked);
  assert.ok(value() >= switched);
});

test('Response risk distinguishes three and four coins at the same knockout threshold', () => {
  const { game, p, foe } = fixture({ deck: 'blackout', opposingDeck: 'blackout' });
  p.active = targetingMon(game, { hp: 110 });
  p.bench = [targetingMon(game)];
  const risk = (attack) => {
    foe.active = targetingMon(game, { attacks: [attack] });
    return responseRisk(game, foe.active, p.active, { includeSetup: false });
  };
  const three = risk({ name: 'Three coins', base: 40, cost: [], fx: { flipMulti: 3 } });
  const four = risk({ name: 'Four coins', base: 40, cost: [], fx: { flipMulti: 4 } });
  const hit = risk({ name: 'Certain hit', base: 70, cost: [], fx: {} });
  assert.ok(three < hit && hit < four);
});
