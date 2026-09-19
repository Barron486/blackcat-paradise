import {ApiError} from './service.mjs';
import {itemGrantRules} from './item-rules.mjs';
import {refreshTimedBuffs} from '../shared/full-status.js';
import {isDeepStrictEqual} from 'node:util';

// These are invariants, not proof that a client actually played a battle.
// Economic provenance still requires authoritative server simulation.
const stats=['str','dex','con','int','wis','cha'];
const equal=(a,b)=>isDeepStrictEqual(a??null,b??null);
const starterItems=cls=>cls==='elf'?{wpn_shortbow:1,arm_74:1,wpn_5:1000,wpn_11:1,potion_heal:100}:
  {[['illusion','dragon'].includes(cls)?'wpn_10':cls==='warrior'?'wpn_1':'wpn_11']:1,amr_jacket:1,potion_heal:100,...(cls==='mage'?{bk_lightarrow:1}:{})};
export class SaveGuard {
  constructor(service){
    this.service=service;this.db=service.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS save_security_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL REFERENCES accounts(id),
      slot_key TEXT NOT NULL,code TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS save_security_account ON save_security_events(account_id,created_at);`);
  }
  reject(key,code){throw new ApiError(403,'存檔未通過伺服器驗證，雲端角色未被覆蓋。請重新載入雲端存檔。',{saveRejected:true,slotKey:key,code});}
  record(user,error){
    if(!error.details?.saveRejected)return;
    const {slotKey,code}=error.details,now=Date.now();
    // Retain no submitted payload, credentials or chat content; cap repeated attempts.
    if(this.db.prepare('SELECT 1 FROM save_security_events WHERE account_id=? AND slot_key=? AND code=? AND created_at>?').get(user.id,slotKey,code,now-60000))return;
    this.db.prepare('INSERT INTO save_security_events(account_id,slot_key,code,created_at) VALUES(?,?,?,?)').run(user.id,slotKey,code,now);
    this.db.exec('DELETE FROM save_security_events WHERE id < (SELECT COALESCE(MAX(id),0)-1999 FROM save_security_events)');
  }
  history(user){
    this.service.gm(user);
    return this.db.prepare(`SELECT s.id,a.username AS account,s.slot_key AS slotKey,s.code,s.created_at AS at
      FROM save_security_events s JOIN accounts a ON a.id=s.account_id ORDER BY s.id DESC LIMIT 100`).all();
  }
  validate(key,prior,doc){
    const p=doc.p,old=prior?.p,check=(ok,code)=>{if(!ok)this.reject(key,code);};
    const natural=value=>Number.isSafeInteger(value)&&value>=0;
    for(const field of ['eq','buffs','statuses'])if(p[field]!==undefined)check(p[field]&&typeof p[field]==='object'&&!Array.isArray(p[field]),'invalid_'+field);
    for(const field of ['gold','exp','bonus','panaceaUsed'])if(p[field]!==undefined)check(natural(p[field]),'invalid_'+field);
    if(doc.ticks!==undefined)check(natural(doc.ticks),'invalid_ticks');
    for(const field of ['hp','mhp','mp','mmp'])if(p[field]!==undefined)check(typeof p[field]==='number'&&Number.isFinite(p[field])&&p[field]>=0,'invalid_'+field);
    for(const field of ['base','alloc','panacea'])if(p[field]!==undefined){
      check(p[field]&&typeof p[field]==='object'&&!Array.isArray(p[field]),'invalid_'+field);
      for(const stat of stats)if(p[field][stat]!==undefined)check(natural(p[field][stat]),'invalid_'+field);
    }
    const used=stats.reduce((sum,s)=>sum+(p.panacea?.[s]||0),0);
    check(used<=60&&(p.panaceaUsed??used)<=60,'invalid_panacea');
    const ids=new Set();
    for(const item of [...p.inv,...Object.values(p.eq||{}).filter(Boolean)]){
      check(item&&typeof item==='object'&&!Array.isArray(item),'invalid_item');
      check(typeof item.id==='string'&&Object.hasOwn(this.service.catalog.items,item.id),'unknown_item');
      const definition=this.service.catalog.items[item.id];
      if(item.cnt!==undefined)check(natural(item.cnt)&&item.cnt>0,'invalid_quantity');
      if(item.en!==undefined)check(Number.isSafeInteger(item.en)&&item.en>=-1&&item.en<=itemGrantRules(definition).maxEnchant,'invalid_enchantment');
      if(item.uid!==undefined){check(typeof item.uid==='string'&&item.uid.length>0&&item.uid.length<=200&&!ids.has(item.uid),'duplicate_item');ids.add(item.uid);}
    }
    if(!old){
      check(!p._gmBuffs&&!p._gmTeleport&&!p._gmTeleportApplied,'forged_gm_state');
      const base=this.service.catalog.creation?.[p.cls];
      if(base){
        const allowed=starterItems(p.cls),counts={};
        for(const item of [...p.inv,...Object.values(p.eq||{}).filter(Boolean)]){
          counts[item.id]=(counts[item.id]||0)+(item.cnt??1);
          check(counts[item.id]<=(allowed[item.id]||0)&&!(item.en||item.bless||item.anc||item.attr||item.seteff||item.gw||item.attrMagic),'invalid_starting_items');
        }
        check(!(p.skills?.length||p.panaceaUsed||used||p.bonus||p.allies?.length||p.mastery),'invalid_starting_progress');
        check(stats.every(s=>!p.alloc?.[s]),'invalid_starting_stats');
        if(p.base){
          check(stats.every(s=>natural(p.base[s])&&p.base[s]>=base[s]&&p.base[s]<=20),'invalid_starting_stats');
          check(stats.reduce((n,s)=>n+p.base[s]-base[s],0)===base.pts,'invalid_starting_stats');
        }
      }
      return false;
    }
    check((p._gmSeq||0)<=(old._gmSeq||0),'forged_gm_sequence');
    check((p._marketSeq||0)<=(old._marketSeq||0),'forged_market_sequence');
    check(natural(p._gmTeleportApplied||0)&&(p._gmTeleportApplied||0)<=Math.max(old._gmTeleportApplied||0,old._gmTeleport?.seq||0),'forged_gm_teleport');
    check(!!p._gmDead===!!old._gmDead,'forged_gm_death');
    if(old._gmDead)check(p.dead===true&&p.hp===0,'forged_gm_death');
    // A timed grant can expire locally. Its duration and members can only originate on the server.
    const before=JSON.stringify(p);
    const canonical=old._gmBuffs;
    if(p._gmBuffs&&(!canonical||!equal(p._gmBuffs,canonical)))this.reject(key,'forged_gm_buff');
    if(canonical)p._gmBuffs=structuredClone(canonical);else delete p._gmBuffs;
    refreshTimedBuffs(p);
    return before!==JSON.stringify(p);
  }
}
