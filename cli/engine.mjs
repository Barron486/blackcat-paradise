import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM, VirtualConsole} from 'jsdom';
import {applyEffect, refreshGmBuffs} from '../shared/gm-effects.js';

const ROOT = new URL('../', import.meta.url);
const HTML = readFileSync(new URL('index.html', ROOT), 'utf8');
const SCRIPTS = [...HTML.matchAll(/<script\b[^>]*\bsrc=["'](js\/[^"'?]+)(?:\?[^"']*)?["'][^>]*>/g)].map(m => ({name:m[1],code:readFileSync(new URL(m[1], ROOT),'utf8')}));
const plain = value => JSON.parse(JSON.stringify(value));
const settings = new Set(['set-pot','set-hp-pot','set-auto-buy-pot','set-mp-atk','sel-atk-skill','set-mp-heal','sel-heal-skill','set-hp-skill','set-hp-convert','sel-convert-skill','set-haste','set-brave','set-blue','set-cautious','set-elfcookie','set-poly','set-magicbarrier','set-teleport','set-auto-buy-arrow']);
const visualFunctions = ['updateUI','renderMobs','renderTabs','renderStatusEffects','renderTownNPCs','applyAreaBackground','applyElfBorder','applyDollCursor','applySherineTheme','renderLoadSelect','updateLoadInfo','updateCreateUI','updateCreationChoiceButtons','setCreationClassAnimation','stopCreationFrameSfx','playSelfFx','playHitFx','playMobFx','playSkillFx','playSfx','applyCombatFilter','initCombatLogLock','initSysLogLock','_initTabGuard','renderSummonPanel','renderPetPanel','renderMercPanel'];

/** Runs the unmodified browser rules in an isolated DOM, with explicit clock ownership. */
export class HeadlessGame {
  constructor({values = {}, slot = 1} = {}) {
    this.logs = [];
    this.slot = validateSlot(slot);
    this.dom = new JSDOM(HTML, {url:'http://localhost/', runScripts:'outside-only', pretendToBeVisual:true, virtualConsole:new VirtualConsole()});
    this.window = this.dom.window;
    this.context = this.dom.getInternalVMContext();
    const w = this.window;
    let timer = 0;
    w.setTimeout = w.setInterval = w.requestAnimationFrame = () => ++timer;
    w.clearTimeout = w.clearInterval = w.cancelAnimationFrame = () => {};
    w.matchMedia = query => ({matches:false,media:query,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
    w.scrollTo = () => {};
    w.alert = message => { throw new Error(String(message)); };
    w.confirm = () => false;
    w.prompt = () => null;
    w.ResizeObserver = w.IntersectionObserver = class {observe(){} unobserve(){} disconnect(){}};
    w.HTMLMediaElement.prototype.play = async () => {};
    w.HTMLMediaElement.prototype.pause = () => {};
    w.console = {log(){},warn(){},error:(...args) => { throw new Error(args.map(String).join(' ')); }};
    const originalAdd = w.document.addEventListener.bind(w.document);
    w.document.addEventListener = (type,...args) => { if(type !== 'DOMContentLoaded') originalAdd(type,...args); };
    const originalWindowAdd = w.addEventListener.bind(w);
    w.addEventListener = (type,...args) => { if(!['load','pageshow'].includes(type)) originalWindowAdd(type,...args); };
    for(const [key,value] of Object.entries(values)) if(/^(lineage_|fb5_)/.test(key) && typeof value === 'string') w.localStorage.setItem(key,value);
    for(const script of SCRIPTS) new vm.Script(script.code,{filename:script.name}).runInContext(this.context,{timeout:15000});
    w.__cliLog = (type,message) => {
      this.logs.push({tick:this.run('state.ticks'),type,message:String(message).replace(/<[^>]*>/g,'')});
      if(this.logs.length > 300) this.logs.splice(0,this.logs.length-300);
    };
    this.run(`for(const name of __args) { if(typeof window[name] === 'function') window[name] = function(){}; }
      startGameTimers = function(){};
      logSys = function(message){window.__cliLog('system',message);};
      logCombat = function(message,type){window.__cliLog(type || 'combat',message);};
      wireBuffEnders();
      currentSlot = ${this.slot};`, visualFunctions);
  }

  run(code,args) {
    const hadPrevious = Object.hasOwn(this.window,'__args');
    const previous = this.window.__args;
    this.window.__args = args;
    try { return new vm.Script(code,{filename:'cli/engine-adapter'}).runInContext(this.context,{timeout:15000}); }
    finally { if(hadPrevious) this.window.__args=previous; else delete this.window.__args; }
  }

  create({classId,name,allocation = {},gender = 'male'} = {}) {
    if(!['royal','mage','elf','knight'].includes(classId)) throw new Error('不支援的職業');
    if(!['male','female','m','f'].includes(gender)) throw new Error('不支援的性別');
    const roleName = String(name || '').trim();
    if(!roleName || roleName.length > 12 || /[\x00-\x1f\x7f<>&"']/.test(roleName)) throw new Error('角色名稱需為 1–12 個有效字元');
    const base = plain(this.run('createBase[__args]',classId));
    const given = {};
    for(const [key,value] of Object.entries(allocation)) {
      if(!['str','dex','con','int','wis','cha'].includes(key) || !Number.isInteger(value) || value < 0 || base[key]+value > 20) throw new Error('創角配點不合法');
      given[key] = value;
    }
    if(Object.values(given).reduce((a,b)=>a+b,0) !== base.pts) throw new Error(`必須分配全部 ${base.pts} 點創角點數`);
    const raw = `${['female','f'].includes(gender) ? 'f' : 'm'}_${classId}`;
    this.run('selectClass(__args.raw); document.getElementById("creation-name").value = __args.name; for(const [key,count] of Object.entries(__args.allocation)) for(let i=0;i<count;i++) adjStat(key,1); startGame();', {raw,allocation:given,name:roleName});
    this.save();
    return this.status();
  }

  load(slot = this.slot) {
    this.slot = validateSlot(slot);
    if(!this.window.localStorage.getItem(`lineage_idle_save_${this.slot}`)) throw new Error('這個欄位沒有角色');
    this.run('currentSlot = __args; loadGame();',this.slot);
    // The original loader revives ordinary deaths in town; GM death must remain enforced.
    this.run('gmApplyTeleport(); if(player._gmDead){ player.dead=true; player.hp=0; }');
    return this.status();
  }

  step(ticks = 1) {
    if(!Number.isInteger(ticks) || ticks < 0 || ticks > 36000) throw new Error('tick 數量須為 0–36000');
    if(!this.run('!!player.cls')) throw new Error('尚未載入角色');
    this.run('for(let i=0;i<__args;i++){if(player.dead || player._gmDead) break; state.inTick=true; try { tick(); } finally {state.inTick=false;settleDeadMobs();} }',ticks);
    return this.status();
  }

  status() {
    const result = plain(this.run(`({slot:currentSlot,classId:player.cls,cls:player.cls,name:player.name,level:player.lv,lv:player.lv,exp:player.exp,expRequired:getExpReq(player.lv),gold:player.gold,hp:player.hp,maxHp:player.mhp,mp:player.mp,maxMp:player.mmp,dead:player.dead,gmDead:!!player._gmDead,map:mapState.current,mapName:mapDisplayName(mapState.current),ticks:state.ticks,base:player.base,stats:player.d,skills:player.skills,config:player.config || {},equipment:player.eq,inventory:player.inv.map(i=>({...i,name:DB.items[i.id]?.n || i.id})),buffs:player.buffs,statuses:player.statuses,mobs:mapState.mobs.filter(Boolean).map(m=>({id:m.id,name:m.n,hp:m.curHp,maxHp:m.hp,level:m.lv}))})`));
    result.logs = this.logs.slice(-20);
    return result;
  }

  snapshot() { return JSON.parse(this.run('saveStateJson()')); }

  values() {
    const store = this.window.localStorage;
    return Object.fromEntries(Array.from({length:store.length},(_,i)=>store.key(i)).filter(key=>/^(lineage_|fb5_)/.test(key)).map(key=>[key,store.getItem(key)]));
  }

  setValues(values) {
    for(const key of Object.keys(this.values())) if(!Object.hasOwn(values,key)) this.window.localStorage.removeItem(key);
    for(const [key,value] of Object.entries(values)) {
      if(!/^(lineage_|fb5_)/.test(key)) continue;
      if(value === null) this.window.localStorage.removeItem(key);
      else if(typeof value === 'string') this.window.localStorage.setItem(key,value);
      else throw new Error('存檔值須為字串或 null');
    }
  }

  decodeSave(raw) {
    const decoded = this.run('_saveUnwrap(__args)',raw);
    if(!decoded.ok || !decoded.payload) throw new Error('存檔簽章不正確或內容為空');
    return JSON.parse(decoded.payload);
  }

  encodeSave(doc) { return this.run('_saveWrapPortable(__args)',JSON.stringify(doc)); }

  save() {
    if(!this.run('!!player.cls')) throw new Error('尚未載入角色');
    if(!this.run('player.dead') && !this.run('saveGame()')) throw new Error('遊戲存檔失敗');
    // GM deaths need their authoritative marker persisted although upstream skips dead saves.
    this.run(`if(!_lzSet('lineage_idle_save_'+currentSlot,_saveWrapPortable(saveStateJson()))) throw new Error('存檔寫入失敗');`);
    return this.values();
  }

  catalog() {
    return plain(this.run('({maps:MAP_CATEGORIES,towns:DB.towns,items:DB.items,skills:DB.skills,classes:createBase})'));
  }

  shopInventory(npcId) {
    return plain(this.run(`(()=>{const npc=DB.towns[mapState.current]?.npcs?.find(n=>n.id===__args); if(!npc || !['shop','skill'].includes(npc.type)) throw new Error('目前村莊沒有這位商人');return getShopItemsForNpc(__args).filter(id=>DB.items[id].type!=='skillbk' || skillReqLv(DB.skills[DB.items[id].sk],DB.items[id].sk)!==undefined).map(id=>({id,name:DB.items[id].n,price:shopPrice(id==='wpn_5'?100:id==='wpn_22'?200:DB.items[id].p || 0)}));})()`,npcId));
  }

  action(name,args = {}) {
    if(!this.run('!!player.cls')) throw new Error('尚未載入角色');
    if(this.run('player.dead') && name !== 'revive') throw new Error('角色已死亡');
    switch(name) {
      case 'travel': case 'map':
        this.run(`if(!Object.values(MAP_CATEGORIES).flat().some(m=>m.v===__args.mapId)) throw new Error('未知地圖');setMapSelectors(__args.mapId);changeMap(false);if(mapState.current!==__args.mapId) throw new Error('目前無法前往此地圖');`,args); break;
      case 'return-town': this.run('returnToTown();'); break;
      case 'revive':
        this.run(`if(!player.dead) throw new Error('角色仍活著');if(player._gmDead) throw new Error('GM 死亡必須由 GM 復活');revive();`); break;
      case 'equip':
        this.run(`{const item=player.inv.find(i=>i.uid===__args.uid);if(!item || !['wpn','arm','acc'].includes(DB.items[item.id]?.type) || !checkCanEquip(item)) throw new Error('沒有此物品或無法裝備');equipItem(item);}`,args); break;
      case 'use':
        this.run(`{const item=player.inv.find(i=>i.uid===__args.uid);if(!item) throw new Error('背包沒有此物品');useItem(item.uid);}`,args); break;
      case 'cast':
        this.run(`if(!player.skills.includes(__args.skillId) && !player.grantedSkills?.includes(__args.skillId)) throw new Error('尚未學會此技能');
          if(['stun','freeze','stone','paralyze','sleep'].some(id=>(player.statuses[id]||0)>0)) throw new Error('目前受到控制，無法施放技能');
          if(DB.skills[__args.skillId]?.type==='manual') { const before=player.manualCd[__args.skillId]||0;manualCast(__args.skillId);if((player.manualCd[__args.skillId]||0)<=before) throw new Error('目前無法施放此技能'); }
          else if(!castSkill(__args.skillId)) throw new Error('目前無法施放此技能');`,args); break;
      case 'settings': this.updateSettings(args.values || args); break;
      case 'shop': {
        if(!Number.isInteger(args.qty) || args.qty < 1 || args.qty > 10000) throw new Error('購買數量不合法');
        const offered = this.shopInventory(args.npcId).find(item=>item.id===args.itemId);
        if(!offered) throw new Error('這位商人沒有販售此物品');
        if(this.status().gold < offered.price * args.qty) throw new Error('金幣不足');
        this.run('buyItem(__args.itemId,__args.qty);',args); break;
      }
      default: throw new Error(`未知操作：${name}`);
    }
    this.save();
    return this.status();
  }

  updateSettings(values) {
    const changes=[];
    for(const [id,value] of Object.entries(values)) {
      const skillId = id.startsWith('auto-sk-') ? id.slice(8) : null;
      if(!settings.has(id) && !(skillId && this.run('player.skills.includes(__args)',skillId))) throw new Error(`不允許的設定：${id}`);
      const el = this.window.document.getElementById(id);
      if(!el) throw new Error(`找不到設定：${id}`);
      if(el.disabled && value) throw new Error('此設定目前不可用');
      if(el.type === 'checkbox') { if(typeof value !== 'boolean') throw new Error('勾選設定需為 boolean'); changes.push({id,value,checkbox:true,skillId}); }
      else if(el.tagName === 'SELECT') {
        if(![...el.options].some(option=>option.value===String(value) && !option.disabled)) throw new Error('設定選項不合法');
        if(id.startsWith('sel-') && value && !this.run('player.skills.includes(__args) || player.grantedSkills?.includes(__args)',value)) throw new Error('尚未學會此技能');
        changes.push({id,value:String(value)});
      } else {
        const n = Number(value);
        if(!Number.isFinite(n) || n < 0 || n > 100) throw new Error('設定百分比須為 0–100');
        changes.push({id,value:String(n)});
      }
    }
    for(const change of changes) {
      const el=this.window.document.getElementById(change.id);
      if(change.checkbox) el.checked=change.value; else el.value=change.value;
      if(change.skillId) this.run(`{const sk=DB.skills[__args];if(sk.summon) onSummonToggle(__args);else if(sk.awaken) onAwakenToggle(__args);else if(__args==='sk_cancel') renderSkillSelects();else onAutoBuffToggle(__args);}`,change.skillId);
      else el.dispatchEvent(new this.window.Event('change'));
    }
  }

  applyEffects(effects,now = Date.now()) {
    const player = this.run('player');
    let changed = false;
    for(const effect of effects) changed = applyEffect({p:player},effect,now) || changed;
    refreshGmBuffs(player,now);
    this.run('gmApplyTeleport(); calcStats();');
    if(changed) this.save();
    return this.status();
  }

  setWorldSettings(settings) { if(settings)this.run('gmSetWorld(__args);',settings); }

  refreshGm(now = Date.now()) {
    const player = this.run('player');
    if(player?._gmBuffs||player?._shopBuffs) { refreshGmBuffs(player,now); this.run('calcStats();'); }
  }

  close() { this.dom.window.close(); }
}

function validateSlot(slot) {
  if(!Number.isInteger(slot) || slot < 1 || slot > 4) throw new Error('存檔欄位須為 1–4');
  return slot;
}
