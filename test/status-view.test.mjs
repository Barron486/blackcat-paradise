import test from 'node:test';
import assert from 'node:assert/strict';
import {collectStatuses, describeSkill, formatRemaining} from '../shared/status-view.js';
import {loadCatalog} from '../server/catalog.mjs';

test('buff seconds, abnormal status ticks and HoT pulses use their actual clocks', () => {
  const rows = collectStatuses({buffs:{brave:60},statuses:{stun:25,poison:90,poisonDmg:10,poisonTick:8,armorBreakPct:58},hots:{sk_regen:{ticksLeft:3,interval:30,cd:10}}});
  assert.equal(rows.find(r=>r.id==='buff:brave').seconds,60);
  assert.equal(rows.find(r=>r.id==='status:stun').seconds,2.5);
  assert.equal(rows.find(r=>r.id==='hot:sk_regen').seconds,7);
  assert.equal(rows.length,4);
  assert.equal(formatRemaining(2.5),'3 秒');
  assert.equal(formatRemaining(3661),'1 時 1 分 1 秒');
});
test('GM expiry follows server time, including while the game countdown is paused', () => {
  const p={buffs:{sk_shield:3600,brave:15},_gmBuffs:{ids:['sk_shield'],expiresAt:8000}};
  assert.equal(collectStatuses(p,{now:6500}).find(r=>r.id==='buff:sk_shield').seconds,1.5);
  assert.equal(collectStatuses(p,{now:8000}).length,1);
  assert.equal(p.buffs.sk_shield,3600, 'view must not mutate the game state');
});
test('all effects are included without requiring an icon, and permanent effects never count down', () => {
  const rows=collectStatuses({buffs:{unlisted:22,poly:0},statuses:{bind:10},_equipHaste:true,_setPoly:{n:'死亡騎士'},_sherineSetCnt:{紅獅:3}});
  assert.ok(rows.some(r=>r.id==='buff:unlisted'));
  assert.ok(rows.some(r=>r.id==='status:bind'));
  assert.equal(rows.filter(r=>r.seconds===null).length,3);
  assert.equal(formatRemaining(null),'常駐');
  assert.match(rows.find(r=>r.id==='set:紅獅').description,/傷害減免 \+10/);
});
test('aura duration ignores downed allies and avoids duplicating a personal buff', () => {
  const p={buffs:{},allies:[{buffs:{a:20}},{buffs:{a:40}},{_downed:true,buffs:{a:900}}]};
  assert.equal(collectStatuses(p,{auraIds:['a']})[0].seconds,40);
  p.buffs.a=10;
  assert.equal(collectStatuses(p,{auraIds:['a']}).length,1);
});
test('temporary equipment effects expire on the game tick clock; stale summons disappear', () => {
  const p={buffs:{summon:50},_summonV2Sk:'summon',summonsV2:[],_crushFuryUntil:120};
  assert.deepEqual(collectStatuses(p,{skills:{summon:{summon:{}}},ticks:100}).map(r=>[r.id,r.seconds]),[['trigger:_crushFuryUntil',2]]);
  assert.equal(collectStatuses(p,{skills:{summon:{summon:{}}},ticks:120}).length,0);
});
test('skill descriptions preserve AC direction and cover every catalog buff', () => {
  const {skills}=loadCatalog(new URL('../',import.meta.url));
  assert.match(describeSkill('sk_shield',skills.sk_shield),/AC 防禦 -2/);
  assert.match(describeSkill('sk_berserk',skills.sk_berserk),/AC 防禦 \+10/);
  assert.match(describeSkill('sk_reduction_armor',skills.sk_reduction_armor,{lv:56}),/傷害減免 \+5/);
  for (const [id,sk] of Object.entries(skills)) if(sk.dur && sk.type==='buff') assert.doesNotMatch(describeSkill(id,sk),/尚無詳細說明/,id);
});
