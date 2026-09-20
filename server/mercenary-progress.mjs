// Account saves are committed in one SQLite transaction. Do not use cross-tab
// deferred experience banks in the authoritative runtime.
export function installMercenaryProgress(game){
  game.run(`window.serverSyncMercenaryProgress=function(){
    if(!player?.cls)return;
    _mercLedgerFlush();
    const ledger=_mercLedgerRead();let ledgerChanged=false;
    const party=player.allies||[];
    for(let slot=1;slot<=8;slot++){
      if(slot===currentSlot)continue;
      const ally=party.find(a=>a&&String(a._slot)===String(slot));
      const pending=ledger.filter(r=>r&&!r.claimed&&String(r.slot)===String(slot));
      const earned=Math.max(0,Math.floor(Number(ally?._expGained)||0));
      const alignment=Math.trunc(Number(ally?._alignmentDelta)||0);
      if(!earned&&!alignment&&!pending.length)continue;
      const raw=_lzGet('lineage_idle_save_'+slot);if(!raw)continue;
      const unwrapped=_saveUnwrap(raw);if(!unwrapped.ok)throw new Error('隊員進度存檔校驗失敗');
      const doc=JSON.parse(unwrapped.payload),source=doc.p;if(!source?.cls)continue;
      const matching=!!(ally&&ally.enSeed&&ally.enSeed===source.enSeed);
      const records=pending.filter(r=>r.cls===source.cls&&(r.enSeed?r.enSeed===source.enSeed:r.name===source.name));
      const total=(matching?earned:0)+records.reduce((n,r)=>n+Math.max(0,Math.floor(Number(r.exp)||0)),0);
      const align=(matching?alignment:0)+records.reduce((n,r)=>n+Math.trunc(Number(r.alignmentDelta)||0),0);
      if(!total&&!align)continue;
      _withAllyEquipmentContext(source,()=>{
        const oldLevel=source.lv;
        source.exp=Math.max(0,Number(source.exp)||0)+total;
        while(source.lv<100&&source.exp>=getExpReq(source.lv)){source.exp-=getExpReq(source.lv);source.lv++;if(source.lv>=50)source.bonus=(source.bonus||0)+1;}
        if(source.lv>=100)source.exp=0;
        source.alignmentValue=pvpClampAlignment((Number(source.alignmentValue)||0)+align);
        if(source.lv!==oldLevel)calcStats();
      });
      if(!_lzSet('lineage_idle_save_'+slot,_saveWrap(JSON.stringify(doc))))throw new Error('隊員進度寫入失敗');
      if(matching){
        ally._expGained=0;ally._alignmentDelta=0;
        const changed=ally.lv!==source.lv;
        ally.lv=source.lv;ally.exp=source.exp;ally.bonus=source.bonus;ally.alignmentValue=source.alignmentValue;
        if(changed)_allyLevelRecompute(ally);
      }
      for(const rec of records){rec.exp=0;rec.alignmentDelta=0;if(!rec.questLoot?.length){rec.claimed=true;rec.claimedAt=Date.now();}ledgerChanged=true;}
    }
    if(ledgerChanged&&!_lzSet(MERC_LEDGER_KEY,JSON.stringify(ledger)))throw new Error('隊員進度紀錄寫入失敗');
  };`);
}
