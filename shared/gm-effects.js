// Shared by the server and the live client so an offline grant and a live grant
// have the same result. Privilege checks always happen in server/service.mjs.
import {applyMarketEffect} from './market-effects.js';
import {applyShopBuffEffect,refreshTimedBuffs} from './full-status.js';
export function applyEffect(doc, effect, now = Date.now()) {
  if(effect.action==='market')return applyMarketEffect(doc,effect);
  if(effect.action==='shop_buff')return applyShopBuffEffect(doc,effect,now);
  const p = doc?.p;
  if (!p?.cls || (p._roleEpoch || p.enSeed || '') !== effect.epoch) return false;
  if ((p._gmSeq || 0) >= effect.seq) return false;
  p._gmSeq = effect.seq;
  if (effect.action === 'restore_progress') {
    p.lv=effect.level;p.exp=effect.experience;p.bonus=effect.bonus;
  }
  if (effect.action === 'grant_gold') p.gold=(p.gold??0)+effect.amount;
  if (effect.action === 'teleport') {
    p._gmTeleport = {seq:effect.seq,mapId:effect.mapId,mapName:effect.mapName};
    if(doc.ms){doc.ms.current=effect.mapId;doc.ms.mobs=[null,null,null,null,null];doc.ms.targetIdx=-1;}
  }
  if (effect.action === 'grant_item') {
    p.inv ||= [];
    for (const item of effect.items || [effect.item]) {
      const existing = !item.gw && p.inv.find(i => i.id === item.id && !i.gw && (i.en || 0) === item.en && !i.anc && !i.attr && !i.seteff && (i.bless || false) === item.bless);
      if (existing) { existing.cnt = (existing.cnt || 0) + item.cnt; existing.lock = true; existing.junk = false; }
      else p.inv.push({ ...item, ...(item.gw ? {gw:[...item.gw]} : {}) });
    }
  }
  if (effect.action === 'buff_all') {
    const seconds = Math.max(0, Math.ceil((effect.expiresAt - now) / 1000));
    p.buffs ||= {};
    p._gmBuffs = { expiresAt: effect.expiresAt, ids: effect.buffs };
    for (const id of effect.buffs) p.buffs[id] = Math.max(p.buffs[id] || 0, seconds);
    refreshTimedBuffs(p,now);
  }
  if (effect.action === 'kill') {
    p.hp = 0; p.dead = true; p._gmDead = true;
    p.summon = null; p.charmed = null; p.summonsV2 = []; p.guardsV2 = [];
  }
  if (effect.action === 'revive') {
    p.dead = false; p._gmDead = false;
    p.hp = Math.max(1, p.mhp || 1); p.mp = Math.max(0, p.mmp || 0);
    for (const key of Object.keys(p.statuses || {})) p.statuses[key] = 0;
  }
  if (effect.action === 'clear_buffs') {
    for (const id of p._gmBuffs?.ids || []) p.buffs[id] = 0;
    delete p._gmBuffs;
    refreshTimedBuffs(p,now);
  }
  return true;
}

export function refreshGmBuffs(p, now = Date.now()) {
  refreshTimedBuffs(p,now);
}
