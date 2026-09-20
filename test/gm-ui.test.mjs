import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {GameService} from '../server/service.mjs';
import {loadCatalog} from '../server/catalog.mjs';
const {JSDOM}=createRequire(new URL('../cli/package.json',import.meta.url))('jsdom');
const catalog=loadCatalog(new URL('../',import.meta.url));
const source=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,{dropFirst=false}={}){
  const service=new GameService(':memory:',catalog);t.after(()=>service.close());
  const gm=await service.register('ui_gm','ui-test-password-2026!',{initialGm:true}),user=await service.register('recipient','ui-test-password-2026!');
  const values={};
  for(const slot of [1,2])values['lineage_idle_save_'+slot]=catalog.wrap({v:1,p:{cls:'elf',name:slot===1?'首位妖精':'第二妖精',lv:slot===1?10:20,inv:[],eq:{},buffs:{},hp:50,mhp:100,_roleEpoch:randomUUID()},ms:{current:'town_silver_knight',mobs:[]},ticks:0});
  service.db.prepare('UPDATE saves SET data=? WHERE account_id=?').run(JSON.stringify(values),user.id);
  const dom=new JSDOM(source('online/gm.html'),{url:'http://localhost/gm',runScripts:'outside-only'});t.after(()=>dom.window.close());
  const w=dom.window,$=id=>w.document.getElementById(id),requests=[];
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  w.fetch=async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):undefined;requests.push({url,body});
    try{
      let data;
      if(url==='/api/me')data={user:gm,csrf:'test'};
      else if(url==='/api/gm/players')data={players:service.players(gm)};
      else if(url.startsWith('/api/gm/catalog'))data={total:1,items:[{id:'potion_heal',name:'紅色藥水',maxEnchant:0,canBless:false}]};
      else if(url==='/api/gm/preview')data=service.preview(gm,body);
      else if(url==='/api/gm/execute'){
        data=service.execute(gm,body);
        if(dropFirst){dropFirst=false;throw new TypeError('測試連線中斷');}
      }else if(url==='/api/gm/audit')data={entries:service.audit(gm)};
      else if(url==='/api/gm/save-security')data={entries:[]};
      else throw new Error('Unexpected route: '+url);
      return {ok:true,json:async()=>data};
    }catch(error){if(!error.status)throw error;return {ok:false,status:error.status,json:async()=>({error:error.message})};}
  };
  w.eval(source('online/gm.js'));await settle();
  const change=(id,value)=>{$(id).value=value;$(id).dispatchEvent(new w.Event('change'));};
  w.document.querySelector('[data-action="grant_item"]').click();await settle();w.document.querySelector('.item-result').click();
  change('scope','character');change('target-account',user.id);$('reason').value='指定角色獎勵';
  return {service,user,gm,w,$,change,requests};
}

test('GM gold UI previews per-character and total amounts and records a single character grant after retry',async t=>{
  const {$,change,w,service,user,gm}=await fixture(t,{dropFirst:true});
  w.document.querySelector('[data-action="grant_gold"]').click();change('target-character','2');
  assert.equal($('gold-options').hidden,false);assert.equal($('item-options').hidden,true);assert.equal($('character-scope').disabled,false);
  $('gold-amount').value='12500';$('preview').click();await settle();
  assert.match($('confirm-detail').textContent,/每個角色金幣　12,500/);assert.match($('confirm-detail').textContent,/總發放金幣　12,500/);assert.match($('confirm-detail').textContent,/第二妖精/);
  $('execute').click();await settle();assert.match($('execute-error').textContent,/重試不會重複/);
  $('execute').click();await settle();assert.equal($('confirm-dialog').open,false);
  const values=service.bootstrap(user).values;assert.equal(catalog.unwrap(values.lineage_idle_save_1).p.gold,undefined);assert.equal(catalog.unwrap(values.lineage_idle_save_2).p.gold,12500);
  assert.equal(service.audit(gm).length,1);w.document.querySelector('[data-view="audit"]').click();await settle();assert.match($('audit-list').textContent,/發放金幣/);assert.match($('audit-list').textContent,/12,500 金幣/);
});

test('GM UI previews the exact account and role, cancels safely and retries delivery only once',async t=>{
  const c=await fixture(t,{dropFirst:true}),{$,change,w,service,user,requests}=c;
  assert.match($('target-character').textContent,/第 2 格 · 第二妖精 · Lv.20 妖精/);
  change('target-character','2');assert.equal($('target-count').textContent,'1');
  $('refresh').click();await settle();assert.equal($('target-character').value,'2');
  $('preview').click();await settle();assert.ok($('confirm-dialog').open);
  assert.match($('confirm-detail').textContent,/recipient/);assert.match($('confirm-detail').textContent,/第 2 格 · 第二妖精/);
  $('cancel-command').click();assert.equal(service.audit(c.gm).length,0);
  $('preview').click();await settle();$('execute').click();await settle();
  assert.match($('execute-error').textContent,/測試連線中斷/);assert.ok($('confirm-dialog').open);
  $('execute').click();await settle();assert.equal($('confirm-dialog').open,false);
  const executions=requests.filter(r=>r.url==='/api/gm/execute');assert.equal(executions.length,2);
  assert.equal(executions[0].body.requestId,executions[1].body.requestId);assert.equal(executions[0].body.slot,2);
  assert.equal(service.audit(c.gm).length,1);
  const saved=service.bootstrap(user).values;assert.equal(catalog.unwrap(saved.lineage_idle_save_1).p.inv.length,0);
  assert.equal(catalog.unwrap(saved.lineage_idle_save_2).p.inv[0].cnt,1);
  w.document.querySelector('[data-view="audit"]').click();await settle();
  assert.match($('audit-list').textContent,/recipient \/ 第 2 格 · 第二妖精/);
});

test('GM UI requires a role selection and clears it when changing accounts or removing a role',async t=>{
  const c=await fixture(t),{$,change,requests,service,user,gm,w}=c;
  $('preview').click();await settle();assert.match($('notice').textContent,/請先選擇帳號及收件角色/);
  assert.equal(requests.filter(r=>r.url==='/api/gm/preview').length,0);
  change('target-character','2');change('target-account',gm.id);
  assert.equal($('target-character').disabled,true);assert.equal($('target-count').textContent,'0');assert.match($('target-character').textContent,/尚未建立角色/);
  change('target-account',user.id);assert.equal($('target-character').value,'');
  change('target-character','2');
  const values=service.bootstrap(user).values;delete values.lineage_idle_save_2;
  service.db.prepare('UPDATE saves SET data=? WHERE account_id=?').run(JSON.stringify(values),user.id);
  $('refresh').click();await settle();assert.equal($('target-character').value,'');assert.equal($('target-count').textContent,'0');
  w.document.querySelector('[data-action="buff_all"]').click();assert.equal($('scope').value,'account');assert.equal($('character-wrap').hidden,true);
  $('preview').click();await settle();const last=requests.filter(r=>r.url==='/api/gm/preview').at(-1);
  assert.equal(last.body.scope,'account');assert.equal(Object.hasOwn(last.body,'slot'),false);
});
