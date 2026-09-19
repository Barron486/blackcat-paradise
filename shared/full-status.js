export function fullStatusBuffIds(skills) {
  return ['haste','brave','blue','cautious','elfcookie','shield',...Object.entries(skills)
    .filter(([,s])=>s.type==='buff'&&!s.summon&&!s.illuSummon&&!s.cube&&!s.awaken&&!s.stormInterval).map(([id])=>id)];
}

// Both sources use server deadlines. Ending or clearing one must not remove the other.
export function refreshTimedBuffs(p,now=Date.now()) {
  if(!p?._gmBuffs&&!p?._shopBuffs)return;
  const grants=[p._gmBuffs,p._shopBuffs].filter(Boolean),ids=new Set(grants.flatMap(g=>g.ids));
  p.buffs||={};
  for(const id of ids)p.buffs[id]=Math.max(0,...grants.filter(g=>g.ids.includes(id)).map(g=>Math.ceil((g.expiresAt-now)/1000)));
  for(const field of ['_gmBuffs','_shopBuffs'])if(p[field]?.expiresAt<=now)delete p[field];
}

export function applyShopBuffEffect(doc,effect,now=Date.now()) {
  const p=doc?.p;
  if(!p?.cls||(p._roleEpoch||p.enSeed||'')!==effect.epoch||(p._shopBuffSeq||0)>=effect.purchaseSeq)return false;
  p._shopBuffSeq=effect.purchaseSeq;
  p._shopBuffs={expiresAt:effect.expiresAt,ids:[...effect.buffs]};
  refreshTimedBuffs(p,now);
  return true;
}
