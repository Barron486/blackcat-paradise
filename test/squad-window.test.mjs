import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const source=readFileSync(new URL('../online/squad-window.js',import.meta.url),'utf8').replace('export function','function');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{prefs,account='one',playing=true,members=true,width=390,height=844}={}){
 const dom=new JSDOM(`<div id="game-screen" class="${playing?'':'hidden'}"><div id="col-left"><div id="squad-panel" style="${members?'':'display:none'}"><header class="panel-header">隊伍與夥伴</header><div id="squad-body"><div><button id="squad-tab-btn-team">隊伍</button><button id="squad-tab-btn-skill">技能設定</button></div><div id="squad-tab-team"><div class="ally-compact-card"><span id="squad-hp-txt-2">100/200</span></div></div><div id="squad-tab-skill" class="hidden"><input id="potion" value="65"></div></div></div></div></div>`,{url:'http://localhost/',runScripts:'outside-only'});
 const w=dom.window;t.after(()=>w.close());w.innerWidth=width;w.innerHeight=height;w.CloudStore={boot:{user:{id:account}}};
 w.ResizeObserver=class{observe(){}};
 w.HTMLElement.prototype.getBoundingClientRect=function(){const width=parseFloat(this.style.width)||380,height=Math.min(this.dataset.collapsed==='true'?54:430,parseFloat(this.style.maxHeight)||430);return {left:parseFloat(this.style.left)||0,top:parseFloat(this.style.top)||0,width,height};};
 w.switchSquadTab=tab=>{for(const id of ['team','skill'])w.document.getElementById('squad-tab-'+id).classList.toggle('hidden',id!==tab);};
 const key='blackcat.squad-window.'+account;if(prefs)w.localStorage.setItem(key,JSON.stringify(prefs));
 w.eval(source);
 const game=w.document.getElementById('game-screen'),panel=w.document.getElementById('squad-panel'),input=w.document.getElementById('potion');
 const api=w.startSquadWindow(game),$=q=>w.document.querySelector(q);
 return {w,game,panel,input,key,...api,$};
}

test('floating squad reuses the live panel, keeps skill edits and never duplicates its controls',async t=>{
 const f=fixture(t);assert.equal(f.panel.parentElement,f.shell);assert.equal(f.shell.parentElement,f.game);
 assert.equal(f.shell.getAttribute('aria-modal'),'false');assert.equal(f.shell.hidden,false);
 f.w.switchSquadTab('skill');f.input.value='73';f.input.focus();let edits=0;f.input.oninput=()=>edits++;
 f.$('[data-squad-mode]').click();assert.equal(f.shell.dataset.mode,'simple');assert.equal(f.$('#squad-tab-team').classList.contains('hidden'),false);
 f.$('#squad-hp-txt-2').textContent='42/200';
 f.$('[data-squad-mode]').click();assert.equal(f.$('#squad-tab-skill').classList.contains('hidden'),false);
 assert.equal(f.$('#potion'),f.input);assert.equal(f.input.value,'73');f.input.dispatchEvent(new f.w.Event('input'));assert.equal(edits,1);
 assert.equal(f.$('#squad-hp-txt-2').textContent,'42/200');f.w.startSquadWindow(f.game);assert.equal(f.w.document.querySelectorAll('#squad-window').length,1);
});

test('collapse and display mode survive reconnect and Escape collapses only the focused squad window',async t=>{
 const f=fixture(t);f.$('[data-squad-mode]').click();f.$('[data-squad-collapse]').click();
 assert.equal(f.panel.hidden,true);assert.equal(f.$('[data-squad-collapse]').getAttribute('aria-expanded'),'false');
 const saved=JSON.parse(f.w.localStorage.getItem(f.key)),next=fixture(t,{prefs:saved});
 assert.equal(next.shell.dataset.mode,'simple');assert.equal(next.panel.hidden,true);
 next.$('[data-squad-collapse]').click();assert.equal(next.panel.hidden,false);
 next.$('[data-squad-drag]').dispatchEvent(new next.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
 assert.equal(next.panel.hidden,true);assert.equal(next.w.document.activeElement,next.$('[data-squad-collapse]'));
});

test('empty parties and character select hide the window without losing the chosen presentation',async t=>{
 const f=fixture(t,{members:false,prefs:{simple:true,collapsed:true}});assert.equal(f.shell.hidden,true);
 f.panel.style.display='';await settle();assert.equal(f.shell.hidden,false);assert.equal(f.panel.hidden,true);
 f.game.classList.add('hidden');await settle();assert.equal(f.shell.hidden,true);
 f.game.classList.remove('hidden');await settle();assert.equal(f.shell.hidden,false);assert.equal(f.shell.dataset.mode,'simple');
 f.panel.style.display='none';await settle();assert.equal(f.shell.hidden,true);
});

test('pointer dragging, keyboard moves and a smaller viewport keep the title controls reachable',t=>{
 const f=fixture(t,{width:1366,height:900}),handle=f.$('[data-squad-drag]');
 const pointer=(type,x,y)=>handle.dispatchEvent(Object.assign(new f.w.Event(type,{bubbles:true,cancelable:true}),{button:0,pointerId:1,clientX:x,clientY:y}));
 pointer('pointerdown',100,100);pointer('pointermove',9999,9999);pointer('pointerup',9999,9999);
 let box=f.shell.getBoundingClientRect();assert.ok(box.left+box.width<=1358);assert.ok(box.top+box.height<=892);
 f.w.innerWidth=320;f.w.innerHeight=400;f.w.dispatchEvent(new f.w.Event('resize'));
 box=f.shell.getBoundingClientRect();assert.ok(box.left>=8&&box.left+box.width<=312);assert.ok(box.top>=8&&box.top+box.height<=392);
 handle.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));
 assert.equal(JSON.parse(f.w.localStorage.getItem(f.key)).x,null);
 const before=parseFloat(f.shell.style.left);handle.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));
 assert.ok(parseFloat(f.shell.style.left)<=before);assert.equal(f.shell.classList.contains('is-dragging'),false);
});

test('corrupt or unavailable preference storage does not prevent opening and using the squad',t=>{
 const f=fixture(t,{prefs:{x:'NaN',y:1e100,simple:'yes',collapsed:'yes'}});
 assert.equal(f.shell.dataset.mode,'full');assert.equal(f.panel.hidden,false);assert.ok(parseFloat(f.shell.style.top)<844);
 f.w.Storage.prototype.setItem=()=>{throw new Error('storage disabled');};
 assert.doesNotThrow(()=>f.$('[data-squad-collapse]').click());assert.equal(f.panel.hidden,true);
});
