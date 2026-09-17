import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CLASS_PRESETS, chooseAction, createStrategy, skillRequiredLevel } from '../cli/strategy.mjs';
import { loadCatalog } from '../server/catalog.mjs';

const catalog = {
  ...loadCatalog(new URL('../', import.meta.url)),
  maps: { training: ['orc'], talking_island: ['orc', 'wolf'] },
  towns: {
    town_elf: { npcs: [{ id: 'npc_linda', type: 'shop' }, { id: 'npc_elpin', type: 'shop' }] },
    town_talking: { npcs: [{ id: 'npc_gilen', type: 'skill' }, { id: 'npc_basin', type: 'shop' }] },
    town_silver_knight: { npcs: [{ id: 'npc_glin', type: 'shop' }] },
    town_unstocked: { npcs: [{ id: 'npc_linda', type: 'shop' }] },
  },
};

function snapshot(overrides = {}, map = 'town_elf') {
  return { p: { cls: 'elf', lv: 1, hp: 40, mhp: 40, mp: 20, mmp: 20, gold: 1000,
    inv: [{ id: 'potion_heal', uid: 'red', cnt: 100 }, { id: 'wpn_5', uid: 'arrow', cnt: 1000 }],
    eq: { wpn: { id: 'wpn_shortbow' } }, skills: [], buffs: {}, statuses: {}, cds: {}, ...overrides },
  ms: { current: map, mobs: [{ id: 'orc', curHp: 6 }] }, ticks: 100 };
}

test('presets spend the original class allocation, including the mage 16 points', () => {
  const source = readFileSync(new URL('../js/01-drops-config.js', import.meta.url), 'utf8');
  const original = vm.runInNewContext(`(${source.match(/let createBase = (\{[\s\S]*?\n\});/)[1]})`);
  for (const [classId, preset] of Object.entries(CLASS_PRESETS)) {
    assert.equal(Object.values(preset.points).reduce((sum, n) => sum + n, 0), original[classId].pts);
    for (const [stat, added] of Object.entries(preset.points)) assert.ok(original[classId][stat] + added <= 20);
  }
});

test('learning requirements agree with upstream for every skill and the four classes', () => {
  const source = readFileSync(new URL('../js/01-drops-config.js', import.meta.url), 'utf8');
  const originalFunction = source.match(/function skillReqLv\(sk, skId\) \{[\s\S]*?\n\}/)[0];
  const context = vm.createContext({ MAGIC_MASTERY_SKILLS: ['sk_blizzard', 'sk_tornado', 'sk_quake', 'sk_fire_storm'] });
  vm.runInContext(originalFunction, context);
  for (const cls of Object.keys(CLASS_PRESETS)) {
    for (const mastery of [null, 'e_magic', 'k_royal_magic']) {
      context.player = { cls, mastery };
      for (const [id, skill] of Object.entries(catalog.skills)) {
        context.skill = skill; context.id = id;
        assert.equal(skillRequiredLevel(context.player, skill, id), vm.runInContext('skillReqLv(skill, id)', context), `${cls}/${mastery}/${id}`);
      }
    }
  }
});

test('new character leaves for training without buying buffs or changing the save', () => {
  const state = snapshot();
  const before = JSON.stringify(state);
  assert.deepEqual(chooseAction(state, catalog), { name: 'travel', args: { mapId: 'training' }, reason: '補給就緒，前往新兵修練場' });
  assert.equal(JSON.stringify(state), before);
  assert.equal(chooseAction(state, catalog, { targetMap: 'invalid-map' }), null);
  assert.equal(chooseAction(state, catalog, { targetMap: 'talking_island' }).args.mapId, 'talking_island');
  assert.equal(chooseAction(state, { ...catalog, maps: { special: [{ v: 'training', t: '新兵修練場' }] } }).args.mapId, 'training');
  assert.equal(chooseAction(state, { ...catalog, maps: { special: [{ v: 'training' }] } }, { targetMap: 'special' }), null);
});

test('GM death stays dead; ordinary death revives; living players are never revived', () => {
  assert.equal(chooseAction(snapshot({ dead: true, hp: 0, _gmDead: true }), catalog), null);
  assert.equal(chooseAction(snapshot({ dead: true, hp: 0 }), catalog).name, 'revive');
  assert.notEqual(chooseAction(snapshot(), catalog).name, 'revive');
});

test('critical HP returns to town; crowd control uses an available potion instead', () => {
  assert.equal(chooseAction(snapshot({ hp: 10 }, 'training'), catalog).name, 'return-town');
  assert.equal(chooseAction(snapshot({ hp: 10, statuses: { stun: 20 } }, 'training'), catalog).name, 'use');
  assert.equal(chooseAction(snapshot({ hp: 10, statuses: { stun: 20 }, cds: { pot: 1 } }, 'training'), catalog), null);
  assert.equal(chooseAction(snapshot({ hp: 10, buffs: { sk_abs_barrier: 1 } }, 'training'), catalog), null);
});

test('mage waits for level 4 and reads the existing light arrow book only once', () => {
  const inv = [...snapshot().p.inv, { id: 'bk_lightarrow', uid: 'book', cnt: 1 }];
  assert.equal(chooseAction(snapshot({ cls: 'mage', inv, lv: 3 }), catalog).name, 'travel');
  assert.deepEqual(chooseAction(snapshot({ cls: 'mage', inv, lv: 4 }), catalog).args, { uid: 'book' });
  assert.equal(chooseAction(snapshot({ cls: 'mage', inv, lv: 4, skills: ['sk_lightarrow'] }), catalog).name, 'travel');
});

test('books for a different profession or element do not cause failed-use loops', () => {
  const inv = [...snapshot().p.inv, { id: 'bk_elf_firewpn', uid: 'firebook', cnt: 1 }];
  assert.equal(chooseAction(snapshot({ cls: 'mage', lv: 60, inv }), catalog).name, 'travel');
  assert.equal(chooseAction(snapshot({ lv: 30, elfEle: 'wind', inv }), catalog).name, 'travel');
  assert.equal(chooseAction(snapshot({ lv: 30, elfEle: 'fire', inv }), catalog).args.uid, 'firebook');
});

test('town replenishment is affordable and uses an actual supply merchant', () => {
  const state = snapshot({ gold: 74, inv: [{ id: 'potion_heal', uid: 'red', cnt: 3 }], eq: {} });
  const proposal = chooseAction(state, catalog);
  assert.deepEqual(proposal.args, { npcId: 'npc_elpin', itemId: 'potion_heal', qty: 2 });
  assert.ok(proposal.args.qty * catalog.items.potion_heal.p <= state.p.gold);
  assert.notEqual(chooseAction(snapshot(state.p, 'town_unstocked'), catalog)?.name, 'shop');
  assert.equal(chooseAction(snapshot({ gold: 0, inv: [], eq: {} }), catalog), null);
  assert.equal(chooseAction(snapshot({ gold: 0, inv: [], eq: {}, lv: 8, skills: ['sk_heal1'] }), catalog), null);
});

test('empty quiver returns to town and one purchased arrow unit means 1000 arrows', () => {
  const state = snapshot({ inv: [{ id: 'potion_heal', uid: 'red', cnt: 100 }] }, 'training');
  assert.equal(chooseAction(state, catalog).name, 'return-town');
  state.ms.current = 'town_elf';
  assert.deepEqual(chooseAction(state, catalog).args, { npcId: 'npc_elpin', itemId: 'wpn_5', qty: 1 });
  state.p.gold = 99;
  assert.equal(chooseAction(state, catalog), null);
});

test('only learned, available spells are cast against a living target', () => {
  const state = snapshot({ cls: 'mage', lv: 4, skills: ['sk_lightarrow'] }, 'training');
  assert.equal(chooseAction(state, catalog).args.skillId, 'sk_lightarrow');
  state.p.statuses.silence = 1;
  assert.equal(chooseAction(state, catalog), null);
  state.p.statuses = {}; state.p.cds.atkSk = 3;
  assert.equal(chooseAction(state, catalog), null);
  state.p.cds = {}; state.ms.mobs = [];
  assert.equal(chooseAction(state, catalog), null);
});

test('a strategy instance backs off unchanged failed actions and remains account-isolated', () => {
  let time = 0;
  const strategy = createStrategy({ now: () => time });
  const other = createStrategy({ now: () => time });
  const state = snapshot();
  assert.equal(strategy.decide(state, catalog).name, 'travel');
  time = 5000;
  assert.equal(strategy.decide(state, catalog), null);
  assert.equal(other.decide(state, catalog).name, 'travel');
  time = 30000;
  assert.equal(strategy.decide(state, catalog).name, 'travel');
});

test('setTarget updates the next destination and rejects a town as hunting target', () => {
  const strategy = createStrategy();
  assert.equal(strategy.decide(snapshot(), catalog).args.mapId, 'training');
  assert.equal(strategy.setTarget('talking_island'), 'talking_island');
  assert.equal(strategy.decide(snapshot(), catalog).args.mapId, 'talking_island');
  assert.equal(strategy.decide(snapshot({}, 'training'), catalog).args.mapId, 'talking_island');
  assert.throws(() => strategy.setTarget('town_elf'), /狩獵地圖/);
  strategy.setTarget('unknown-map');
  assert.equal(strategy.decide(snapshot(), catalog), null);
});

test('recordResult throttles failed casts even as HP changes and releases successful actions', () => {
  let time = 0;
  const strategy = createStrategy({ now: () => time });
  const state = snapshot({ cls: 'mage', lv: 4, skills: ['sk_lightarrow'] }, 'training');
  const first = strategy.decide(state, catalog);
  strategy.recordResult(first, false);
  time = 5000; state.p.hp -= 1;
  assert.equal(strategy.decide(state, catalog), null);
  time = 30000;
  const retry = strategy.decide(state, catalog);
  assert.equal(retry.name, 'cast');
  strategy.recordResult(retry, true);
  time = 35000;
  assert.equal(strategy.decide(state, catalog).name, 'cast');
});
