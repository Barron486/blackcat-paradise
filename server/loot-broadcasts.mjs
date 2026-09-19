// Drop receipts travel with the character save, so reconnects and sync retries cannot double-broadcast.
import '../js/loot-rarity.js';
export class LootBroadcastService {
  constructor(service) {
    this.service=service;this.db=service.db;service.lootBroadcasts=this;
    this.maps=new Map((service.catalog.world?.maps||[]).map(m=>[m.id,m.name]));
    this.sources=new Map();
    for(const row of service.catalog.world?.drops||[]){const key=JSON.stringify([row.monster,row.itemId]);if(!this.sources.has(key))this.sources.set(key,[]);this.sources.get(key).push(row);}
    this.db.exec(`CREATE TABLE IF NOT EXISTS loot_broadcast_cursors(
      account_id TEXT NOT NULL,epoch TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(account_id,epoch));
      CREATE TABLE IF NOT EXISTS loot_broadcasts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,epoch TEXT NOT NULL,seq INTEGER NOT NULL,
      character_name TEXT NOT NULL,item_id TEXT NOT NULL,item_name TEXT NOT NULL,rarity TEXT NOT NULL,
      monster TEXT NOT NULL,map_name TEXT NOT NULL,quantity INTEGER NOT NULL,created_at INTEGER NOT NULL,
      UNIQUE(account_id,epoch,seq));`);
    if(!this.db.prepare('PRAGMA table_info(loot_broadcasts)').all().some(c=>c.name==='dropped_at'))this.db.exec('ALTER TABLE loot_broadcasts ADD COLUMN dropped_at INTEGER');
  }
  settings(){return this.service.world?.state().lootBroadcast||{enabled:true,rarities:GameLootRarity.types,generation:0,cursor:0,startedAt:0};}
  latestId(){return this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM loot_broadcasts').get().id;}
  history(){return this.db.prepare(`SELECT id,character_name AS name,item_name AS itemName,rarity,monster,map_name AS mapName,quantity,created_at AS at,COALESCE(dropped_at,created_at) AS droppedAt FROM loot_broadcasts ORDER BY id DESC LIMIT 80`).all().reverse();}
  list(after=0){
    const settings=this.settings(),cursor=Math.max(Number.isSafeInteger(after)&&after>=0?after:0,settings.cursor||0);
    if(!settings.enabled)return {enabled:false,generation:settings.generation,events:[],cursor:Math.max(cursor,this.latestId())};
    const rows=this.db.prepare(`SELECT id,character_name AS name,item_name AS itemName,rarity,
      monster,map_name AS mapName,quantity,created_at AS at,COALESCE(dropped_at,created_at) AS droppedAt FROM loot_broadcasts
      WHERE id>? AND created_at>? ORDER BY id LIMIT 100`).all(cursor,Date.now()-10*60*1000);
    return {enabled:true,generation:settings.generation,events:rows,cursor:rows.at(-1)?.id??Math.max(cursor,this.latestId())};
  }
  record(user,prior,doc){
    const p=doc.p,epoch=p._roleEpoch||p.enSeed,seq=p._rareLootSeq;
    if(typeof epoch!=='string'||!Number.isSafeInteger(seq)||seq<0)return;
    const saved=this.db.prepare('SELECT seq FROM loot_broadcast_cursors WHERE account_id=? AND epoch=?').get(user.id,epoch)?.seq||0;
    const previous=Number.isSafeInteger(prior?.p?._rareLootSeq)?prior.p._rareLootSeq:0;
    const floor=Math.max(saved,previous);
    if(seq<=floor)return;
    // New characters establish a baseline; imported or existing inventory never counts as a drop.
    const settings=this.settings(),world=this.service.world?.state(),now=Date.now();
    if(settings.enabled&&prior&&Array.isArray(p._rareLootEvents))for(const event of p._rareLootEvents.slice(-64)){
      if(!event||!Number.isSafeInteger(event.seq)||event.seq<=floor||event.seq>seq)continue;
      const item=this.service.catalog.items[event.itemId];
      const sources=this.sources.get(JSON.stringify([event.monster,event.itemId]));
      if(!sources||!this.maps.has(event.mapId))continue;
      const rarity=GameLootRarity.classify(item,Math.max(0,...sources.map(r=>world?.drops?.[r.key]??r.baseRate)));
      if(!rarity||!settings.rarities.includes(rarity))continue;
      if(!Number.isInteger(event.quantity)||event.quantity<1||event.quantity>1000)continue;
      // Old clients have no drop timestamp; invalid clocks fall back to server receipt time.
      const droppedAt=Number.isSafeInteger(event.at)&&event.at>=now-7*86400000&&event.at<=now?event.at:now;
      if(droppedAt<(settings.startedAt||0))continue;
      const prefix=(event.anc===true?'遠古 ': '')+(event.bless===true?'祝福的 ':event.bless==='cursed'?'詛咒的 ':'');
      this.db.prepare(`INSERT OR IGNORE INTO loot_broadcasts(account_id,epoch,seq,character_name,item_id,item_name,rarity,monster,map_name,quantity,created_at,dropped_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(user.id,epoch,event.seq,p.name||user.username,event.itemId,prefix+item.n,rarity,event.monster,this.maps.get(event.mapId),event.quantity,now,droppedAt);
    }
    this.db.prepare(`INSERT INTO loot_broadcast_cursors VALUES(?,?,?) ON CONFLICT(account_id,epoch) DO UPDATE SET seq=MAX(seq,excluded.seq)`).run(user.id,epoch,seq);
    this.db.prepare('DELETE FROM loot_broadcasts WHERE id<(SELECT COALESCE(MAX(id),0)-1000 FROM loot_broadcasts)').run();
  }
}
