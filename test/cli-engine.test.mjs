import test from 'node:test';
import assert from 'node:assert/strict';
import {HeadlessGame} from '../cli/engine.mjs';

function game(t, options) {
  const result = new HeadlessGame(options);
  let seed = 81371;
  result.window.Math.random = () => { seed = (Math.imul(seed,1664525)+1013904223) >>> 0; return seed / 4294967296; };
  t.after(()=>result.close());
  return result;
}

for(const [classId,allocation] of Object.entries({royal:{str:7,con:1},mage:{con:4,int:8,wis:4},elf:{dex:8},knight:{str:4,con:4}})) {
  test(`headless creates an ordinary ${classId} using upstream starting rules`,t=>{
    const g=game(t);
    const s=g.create({classId,name:`測試${classId}`,allocation});
    assert.equal(s.name,`測試${classId}`);
    assert.equal(s.classId,classId);
    assert.equal(s.level,1);
    assert.equal(s.exp,0);
    assert.equal(s.gold,1000);
    assert.equal(s.hp,s.maxHp);
    assert.equal(s.inventory.find(i=>i.id==='potion_heal').cnt,100);
    assert.ok(s.equipment.wpn);
    assert.equal(s.gmDead,false);
    assert.ok(!g.snapshot().p.grantedSkills?.length);
    assert.throws(()=>g.create({classId,name:'不可覆寫',allocation}),/已有角色/);
  });
}

test('creation saves the entered name immediately and preserves it through class and gender changes',t=>{
  const g=game(t);
  g.run('showCreation(); document.getElementById("creation-name").value = "  黑貓Hero88  "; selectClass("m_mage"); selectClass("f_knight"); for(let i=0;i<4;i++){adjStat("str",1);adjStat("con",1);} startGame();');
  assert.equal(g.status().name,'黑貓Hero88');
  assert.equal(g.snapshot().p.avatar,'女騎士');
  // Read the automatic first save, without calling the CLI save helper.
  const h=game(t,{values:g.values()});
  assert.equal(h.load().name,'黑貓Hero88');
});

test('creation rejects empty and unsafe names, and resets the field for a fresh creation',t=>{
  const g=game(t);
  g.run('showCreation(); for(let i=0;i<4;i++){adjStat("str",1);adjStat("con",1);}');
  for(const name of ['', '   ', '<黑貓>', 'a'.repeat(13)]) {
    g.run('document.getElementById("creation-name").value=__args; startGame();',name);
    assert.equal(g.window.localStorage.getItem('lineage_idle_save_1'),null);
    assert.equal(g.window.document.getElementById('creation-name').getAttribute('aria-invalid'),'true');
    assert.ok(g.window.document.getElementById('creation-name-error').textContent);
  }
  g.run('showCreation();');
  assert.equal(g.window.document.getElementById('creation-name').value,'');
  assert.equal(g.window.document.getElementById('creation-name-error').textContent,'');
});

test('original combat kills, respawns and levels, then learned magic consumes MP',t=>{
  const g=game(t);
  g.create({classId:'mage',name:'實際戰鬥',allocation:{con:4,int:8,wis:4}});
  const book=g.status().inventory.find(i=>i.id==='bk_lightarrow');
  g.action('use',{uid:book.uid});
  assert.deepEqual(g.status().skills,[],'the book cannot be learned before level 4');
  g.action('travel',{mapId:'training'});
  let kills=0;
  for(let i=0;i<100;i++) {
    if(g.status().dead) {g.action('revive');g.action('travel',{mapId:'training'});}
    g.step(20);
    kills += g.status().logs.filter(l=>l.message.includes('擊敗了')).length;
    if(g.status().level >= 4 && g.status().ticks > 800) break;
  }
  assert.ok(kills > 5,'monsters continue respawning after the first wave');
  assert.ok(g.status().level >= 4);
  assert.ok(g.status().gold > 1000,'gold comes from original kills');
  g.action('use',{uid:book.uid});
  assert.ok(g.status().skills.includes('sk_lightarrow'));
  g.action('settings',{'sel-atk-skill':'sk_lightarrow','set-mp-atk':0});
  const beforeMp=g.status().mp;
  for(let i=0;i<10 && !g.status().dead;i++) g.step(10);
  assert.ok(g.logs.some(l=>l.message.includes('光箭')),'original spell is cast');
  assert.ok(g.status().mp < beforeMp);
});

test('portable saves preserve earned progression, equipment and configuration across load',t=>{
  const g=game(t);
  g.create({classId:'knight',name:'保存騎士',allocation:{str:4,con:4}});
  g.action('settings',{'set-hp-pot':80,'set-auto-buy-pot':true});
  g.action('travel',{mapId:'training'});
  g.step(800);
  if(g.status().dead) g.action('revive');
  const before=g.snapshot();
  const values=g.save();
  const h=game(t,{values});
  h.load();
  const after=h.snapshot();
  assert.equal(after.p.name,before.p.name);
  assert.equal(after.p.lv,before.p.lv);
  assert.equal(after.p.exp,before.p.exp);
  assert.equal(after.p.gold,before.p.gold);
  assert.deepEqual(Object.entries(after.p.eq).filter(([,item])=>item),Object.entries(before.p.eq).filter(([,item])=>item));
  assert.deepEqual(after.p.inv,before.p.inv);
  assert.equal(after.p.config.setHpPot,'80');
  assert.equal(after.p.config.setAutoBuyPot,true);
  assert.equal(after.ticks,before.ticks);
  assert.ok(after.ms.current.startsWith('town_'),'upstream load returns to the home town');
  assert.equal(after.p.hp,after.p.mhp);
  const signed=h.encodeSave(after);
  assert.deepEqual(h.decodeSave(signed),after);
  assert.throws(()=>h.decodeSave(signed.replace('保存騎士','竄改角色')),/簽章/);
});

test('ordinary CLI actions reject privileged shortcuts and invalid shop purchases',t=>{
  const g=game(t);
  g.create({classId:'royal',name:'合法操作',allocation:{str:7,con:1}});
  const before=g.snapshot();
  assert.throws(()=>g.action('cast',{skillId:'sk_lightarrow'}),/尚未學會/);
  assert.throws(()=>g.action('revive'),/仍活著/);
  assert.throws(()=>g.action('travel',{mapId:'not_a_map'}),/未知地圖/);
  assert.throws(()=>g.action('shop',{npcId:'npc_basin',itemId:'relic_lightbeam_wand',qty:1}),/沒有販售/);
  assert.throws(()=>g.action('shop',{npcId:'npc_wh_talking',itemId:'potion_heal',qty:1}),/沒有這位商人/);
  assert.throws(()=>g.action('settings',{'player.lv':100}),/不允許/);
  assert.equal(g.snapshot().p.gold,before.p.gold);
  assert.deepEqual(g.snapshot().p.inv,before.p.inv);
  const potion=g.shopInventory('npc_basin').find(i=>i.id==='potion_heal');
  assert.ok(g.shopInventory('npc_gilen').some(i=>i.id==='bk_lightarrow'),'the real skill merchant sells books');
  g.action('shop',{npcId:'npc_basin',itemId:'potion_heal',qty:2});
  assert.equal(g.status().gold,1000-potion.price*2);
  assert.equal(g.status().inventory.find(i=>i.id==='potion_heal').cnt,102);
});

test('GM effects are epoch-bound and idempotent, and death remains locked after save/load',t=>{
  const g=game(t);
  g.create({classId:'elf',name:'GM相容',allocation:{dex:8}});
  const epoch=g.snapshot().p._roleEpoch;
  const kill={seq:1,epoch,action:'kill'};
  const ticks=g.status().ticks;
  g.applyEffects([{...kill,epoch:'other-character'}]);
  assert.equal(g.status().dead,false);
  g.applyEffects([kill]);
  assert.equal(g.status().gmDead,true);
  assert.throws(()=>g.action('revive'),/GM/);
  g.step(50);
  assert.equal(g.status().ticks,ticks);
  const h=game(t,{values:g.save()});
  h.load();
  assert.equal(h.status().gmDead,true);
  assert.equal(h.status().dead,true);
  assert.equal(h.status().hp,0);
  h.applyEffects([{seq:2,epoch,action:'revive'}]);
  h.applyEffects([kill]);
  assert.equal(h.status().dead,false,'replayed kill cannot override newer GM revive');
  h.applyEffects([{seq:3,epoch,action:'buff_all',buffs:['sk_shield'],expiresAt:12000}],10000);
  assert.equal(h.status().buffs.sk_shield,2);
  h.refreshGm(12001);
  assert.equal(h.status().buffs.sk_shield,0);
});
