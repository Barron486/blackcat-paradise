import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');

function combatLogHarness(){
  const code=source('js/01-drops-config.js');
  const start=code.indexOf('let _combatSrc = null;');
  const end=code.indexOf('// 🔒 系統與物品日誌',start);
  assert.ok(start>=0&&end>start,'combat log implementation must be extractable');
  const entries=[],classes=new Set(),buttons={};
  const classList={toggle(name,on){if(on)classes.add(name);else classes.delete(name);}};
  const log={children:[],scrollHeight:0,scrollTop:0,classList,insertAdjacentHTML(_,html){
    entries.push({html,src:html.match(/data-src="([^"]+)/)?.[1],message:html.match(/>([^<>]+)<\/div>$/)?.[1]});
    this.children.push({});
  },removeChild(){this.children.shift();},get firstChild(){return this.children[0];}};
  const context={state:{ff:false},localStorage:{getItem(){return null;},setItem(){}},_combatLogLocked:false,COMBAT_LOG_MAX:50,COMBAT_LOG_MAX_LOCKED:150,Set,console};
  context.document={getElementById(id){
    if(id==='combat-log')return log;
    if(!buttons[id])buttons[id]={classList:{toggle(){}}};
    return buttons[id];
  }};
  vm.runInNewContext(code.slice(start,end)+'\nglobalThis.combatApi={logCombat,withCombatSource,toggleCombatFilter,combatLogSource};',context);
  return {entries,classes,api:context.combatApi};
}

test('combat log separates presentation type from actor source',()=>{
  const h=combatLogHarness();
  h.api.logCombat('enemy','enemy');
  h.api.logCombat('enemy attack','enemy-attack');
  h.api.logCombat('pet heal','heal','pet');
  h.api.logCombat('summon miss','miss','summon');
  h.api.logCombat('ally dot','dot',{slot:'2',name:'傭兵'});
  h.api.logCombat('team kill','player-heavy','team');
  assert.deepEqual(h.entries.map(e=>e.src),['enemy','enemy','pet','summon','mercenary','team']);
  assert.match(h.entries[1].html,/log-cat-enemy/);
});

test('nested combat source scopes restore the outer actor',()=>{
  const h=combatLogHarness();
  h.api.withCombatSource('pet',()=>{
    h.api.logCombat('pet first','heal');
    h.api.withCombatSource('enemy',()=>h.api.logCombat('enemy middle','miss'));
    h.api.logCombat('pet last','magic');
  });
  h.api.logCombat('player after','heal');
  assert.deepEqual(h.entries.map(e=>e.src),['pet','enemy','pet','player']);
});

test('each combat filter toggles only its matching source class',()=>{
  const h=combatLogHarness();
  for(const src of ['enemy','player','mercenary','summon','pet']){
    h.api.toggleCombatFilter(src);
    assert.equal(h.classes.has('cf-hide-'+src),true,src+' should be hidden');
    h.api.toggleCombatFilter(src);
    assert.equal(h.classes.has('cf-hide-'+src),false,src+' should be visible again');
  }
});

test('combat producers keep actor attribution and team kills explicit',()=>{
  const core=source('js/03-combat-core.js'),kills=source('js/05-kill-progression.js'),pets=source('js/22-pets.js'),summons=source('js/23-summons.js'),dots=source('js/06-status-allies.js');
  assert.match(core,/withCombatSource\('summon'/);
  assert.match(core,/withCombatSource\('mercenary'/);
  assert.match(core,/withCombatSource\('pet'/);
  assert.match(kills,/logCombat\(`擊敗了[\s\S]*?'player-heavy', 'team'\)/);
  assert.match(kills,/目前 Lv\.\$\{a\.lv\}[\s\S]*?'player-special', 'mercenary'\)/);
  assert.match(pets,/目前 Lv\.\$\{p\.lv\}[\s\S]*?'player-special', 'pet'\)/);
  assert.match(summons,/造成 \$\{dmg\} 點傷害。[\s\S]*?'player', 'summon'\)/);
  assert.match(dots,/combatLogSource\(s\.poisonSrc\)/);
  assert.match(dots,/combatLogSource\(m\._bleedSrc\)/);
  assert.match(dots,/combatLogSource\(m\._burnDot\.src\)/);
});
