// Transactions have their own sequence; they must never acknowledge a GM command.
export function applyMarketEffect(doc, effect) {
  const p=doc?.p;
  if(!p || (p._roleEpoch||p.enSeed)!==effect.epoch || (p._marketSeq||0)>=effect.seq)return false;
  const inv=p.inv||[];
  if(effect.remove){
    const item=inv.find(i=>i.uid===effect.remove.uid);
    if(!item || item.cnt<effect.remove.quantity)throw new Error('交易物品尚未同步，請保留頁面並重新同步');
    item.cnt-=effect.remove.quantity;
    if(!item.cnt)p.inv=inv.filter(i=>i!==item);
  }
  if(effect.item){p.inv||=[];p.inv.push(structuredClone(effect.item));}
  if(effect.gold)p.gold=(p.gold||0)+effect.gold;
  p._marketSeq=effect.seq;
  return true;
}
