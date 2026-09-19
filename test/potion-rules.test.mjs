import test from 'node:test';
import assert from 'node:assert/strict';
import {HeadlessGame} from '../cli/engine.mjs';

const plain=value=>JSON.parse(JSON.stringify(value));
const ids=['potion_heal','potion_strong','potion_ult'];
const rules=[{enabled:true,potion:ids[0],hpPercent:70},{enabled:true,potion:ids[1],hpPercent:50},{enabled:true,potion:ids[2],hpPercent:30}];
function fixture(t){
 const game=new HeadlessGame();t.after(()=>game.close());game.create({classId:'elf',name:'三段喝水',allocation:{dex:8}});
 game.window.Math.random=()=>0.5;
 game.run('player.lv=40;calcStats();restoreAutoPotionRules({potionRules:__args});',rules);
 return game;
}
function prepare(game,hpPercent,stock=[10,10,10]){
 game.run(`player.dead=false;player.hp=player.mhp*__args.hpPercent/100;player.cds.pot=0;player.inv=__args.stock.map((cnt,index)=>({id:__args.ids[index],uid:'potion-'+index,cnt}));`,{hpPercent,stock,ids});
}
const counts=game=>ids.map(id=>game.snapshot().p.inv.filter(i=>i.id===id).reduce((n,i)=>n+i.cnt,0));

test('three HP bands use the matching healing strength and share one cooldown',t=>{
 const game=fixture(t),healed=[];
 for(const [hp,expected] of [[65,0],[45,1],[25,2]]){
  prepare(game,hp);const before=game.run('player.hp');game.run('autoActions()');
  assert.deepEqual(counts(game),[10,10,10].map((n,i)=>n-(i===expected?1:0)));healed.push(game.run('player.hp')-before);
  assert.equal(game.run('player.cds.pot'),1);game.run('autoActions()');assert.equal(counts(game).reduce((a,b)=>a+b),29);
 }
 assert.ok(healed[0]>0&&healed[0]<healed[1]&&healed[1]<healed[2]);
 for(const hp of [71,100]){prepare(game,hp);game.run('autoActions()');assert.deepEqual(counts(game),[10,10,10]);}
 // Use an exact HP ratio to check the inclusive boundary without rounding error.
 prepare(game,30);game.run('player.mhp=1000;player.hp=300;autoActions()');assert.deepEqual(counts(game),[10,10,9]);
});

test('lowest matching threshold wins regardless of row order; ties use the first rule',t=>{
 const game=fixture(t);
 game.run('restoreAutoPotionRules({potionRules:__args})',[rules[2],rules[0],rules[1]]);
 prepare(game,25);game.run('autoActions()');assert.deepEqual(counts(game),[10,10,9]);
 game.run('restoreAutoPotionRules({potionRules:__args})',[{...rules[2],hpPercent:50},{...rules[0],hpPercent:50},rules[1]]);
 prepare(game,25);game.run('autoActions()');assert.deepEqual(counts(game),[10,10,9]);
 game.run('document.getElementById("set-pot-on").checked=false');prepare(game,25);game.run('autoActions()');assert.deepEqual(counts(game),[9,10,10]);
});

test('missing potions fall back only to enabled matching rules and zero thresholds stay off',t=>{
 const game=fixture(t);prepare(game,25,[10,10,0]);game.run('autoActions()');assert.deepEqual(counts(game),[10,9,0]);
 game.run('document.getElementById("set-pot-2-on").checked=false');prepare(game,25,[10,10,0]);game.run('autoActions()');assert.deepEqual(counts(game),[9,10,0]);
 game.run('document.getElementById("set-hp-pot").value=0');prepare(game,25,[10,10,0]);game.run('autoActions()');assert.deepEqual(counts(game),[10,10,0]);
 // A potion assigned to a lower, unmatched HP band is never used as fallback.
 game.run('restoreAutoPotionRules({potionRules:__args})',rules);prepare(game,60,[0,10,10]);game.run('autoActions()');assert.deepEqual(counts(game),[0,10,10]);
});

test('auto-buy supplies the selected rule once; insufficient gold falls back without charging',t=>{
 const game=fixture(t);game.run('document.getElementById("set-auto-buy-pot").checked=true;player.gold=200000');
 const price=game.run('shopPrice(DB.items.potion_ult.p)');prepare(game,25,[10,10,0]);game.run('autoActions()');
 assert.deepEqual(counts(game),[10,10,99]);assert.equal(game.run('player.gold'),200000-price*100);
 game.run('autoActions()');assert.deepEqual(counts(game),[10,10,99]);assert.equal(game.run('player.gold'),200000-price*100);
 game.run('player.gold=100');prepare(game,25,[10,0,0]);game.run('autoActions()');assert.deepEqual(counts(game),[9,0,0]);assert.equal(game.run('player.gold'),100);
 prepare(game,25,[0,0,0]);game.run('autoActions()');assert.deepEqual(counts(game),[0,0,0]);assert.equal(game.run('player.gold'),100);
});

test('dead, arena-blocked and barrier-protected players never consume or buy healing potions',t=>{
 const game=fixture(t);game.run('document.getElementById("set-auto-buy-pot").checked=true;player.gold=200000');
 const arena=game.window.pvpArenaPotionBlocked;
 for(const kind of ['arena','barrier','dead']){
  prepare(game,25,[0,0,0]);game.window.pvpArenaPotionBlocked=kind==='arena'?()=>true:arena;
  game.run('player.dead=__args==="dead";player.buffs.sk_abs_barrier=__args==="barrier"?10:0',kind);
  game.run('autoActions()');assert.equal(game.run('player.gold'),200000);assert.deepEqual(counts(game),[0,0,0]);
 }
});

test('all three rules persist through CLI settings and reload; legacy and other characters keep independent defaults',t=>{
 const game=fixture(t);
 game.action('settings',{'set-pot':'potion_strong','set-hp-pot':82,'set-pot-on':false,'set-pot-2-on':true,'set-pot-2':'potion_heal','set-hp-pot-2':55,'set-pot-3-on':true,'set-pot-3':'potion_ult','set-hp-pot-3':22,'set-auto-buy-pot':true});
 const expected=[{enabled:false,potion:'potion_strong',hpPercent:82},{enabled:true,potion:'potion_heal',hpPercent:55},{enabled:true,potion:'potion_ult',hpPercent:22}],values=game.values();
 const loaded=new HeadlessGame({values});t.after(()=>loaded.close());loaded.load();
 assert.deepEqual(plain(loaded.run('readAutoPotionRules()')),expected);assert.deepEqual(loaded.snapshot().p.config.potionRules,expected);
 const legacy=game.snapshot();legacy.p.config={setPot:'potion_strong',setHpPot:0,setAutoBuyPot:true};
 loaded.setValues({...values,lineage_idle_save_2:loaded.encodeSave(legacy)});loaded.load(2);
 assert.deepEqual(plain(loaded.run('readAutoPotionRules()')),[{enabled:true,potion:'potion_strong',hpPercent:0},{...rules[1],enabled:false},{...rules[2],enabled:false}]);
 loaded.load(1);assert.deepEqual(plain(loaded.run('readAutoPotionRules()')),expected);
 loaded.run('resetConfigDomToDefaults()');assert.deepEqual(plain(loaded.run('readAutoPotionRules()')),[rules[0],{...rules[1],enabled:false},{...rules[2],enabled:false}]);
});

test('settings changes save immediately, normalize invalid values, and preserve zero and disabled rules',t=>{
 const game=fixture(t);game.run('document.getElementById("set-hp-pot").value=140;document.getElementById("set-hp-pot-2").value=-5;document.getElementById("set-pot-3-on").checked=false;updateAutoPotionSettings()');
 const saved=game.decodeSave(game.values().lineage_idle_save_1).p.config;
 assert.deepEqual(saved.potionRules,[{...rules[0],hpPercent:100},{...rules[1],hpPercent:0},{...rules[2],enabled:false}]);
 assert.equal(game.window.document.getElementById('set-hp-pot').value,'100');assert.equal(game.window.document.getElementById('set-hp-pot-2').value,'0');
 assert.throws(()=>game.action('settings',{'set-pot-2':'potion_blue'}),/設定選項不合法/);
 assert.throws(()=>game.action('settings',{'set-hp-pot-3':101}),/設定百分比/);
 const invalid=plain(game.run('normalizeAutoPotionRules(__args)',{potionRules:[{enabled:false,potion:'unknown',hpPercent:'invalid'},{enabled:true,potion:'potion_ult',hpPercent:40}]}));
 assert.equal(invalid.length,3);assert.deepEqual(invalid[0],{enabled:false,potion:'potion_heal',hpPercent:70});assert.deepEqual(invalid[2],{...rules[2],enabled:false});
});
