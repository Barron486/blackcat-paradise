// Only authoritative combat commits call record; client saves cannot publish kills.
export class KillBroadcastService {
  constructor(service){
    this.service=service;this.db=service.db;service.killBroadcasts=this;
    this.monsters=new Map((service.catalog.world?.creatures||[]).map(m=>[m.id,m]));
    this.maps=new Map((service.catalog.world?.maps||[]).map(m=>[m.id,m.name]));
    this.db.exec(`CREATE TABLE IF NOT EXISTS kill_broadcast_cursors(account_id TEXT NOT NULL,epoch TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(account_id,epoch));
      CREATE TABLE IF NOT EXISTS kill_broadcasts(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,epoch TEXT NOT NULL,seq INTEGER NOT NULL,character_name TEXT NOT NULL,monster_id TEXT NOT NULL,monster TEXT NOT NULL,map_name TEXT NOT NULL,killed_at INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(account_id,epoch,seq));`);
  }
  settings(){return this.service.world.state().killBroadcast;}
  latestId(){return this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM kill_broadcasts').get().id;}
  rows(where,params=[]){return this.db.prepare(`SELECT id,'kill' AS kind,character_name AS name,monster_id AS monsterId,monster,map_name AS mapName,killed_at AS killedAt,created_at AS at FROM kill_broadcasts ${where}`).all(...params);}
  history(){return this.rows('ORDER BY id DESC LIMIT 80').reverse();}
  list(after=0){
    const settings=this.settings(),cursor=Math.max(Number.isSafeInteger(after)&&after>=0?after:0,settings.cursor||0);
    const events=settings.enabled?this.rows('WHERE id>? AND created_at>? ORDER BY id LIMIT 100',[cursor,Date.now()-600000]):[];
    return {enabled:settings.enabled,generation:settings.generation,events,cursor:events.at(-1)?.id??Math.max(cursor,this.latestId())};
  }
  record(user,prior,doc){
    const p=doc.p,epoch=p._roleEpoch||p.enSeed,seq=p._monsterKillSeq;
    if(typeof epoch!=='string'||!Number.isSafeInteger(seq)||seq<0)return;
    const saved=this.db.prepare('SELECT seq FROM kill_broadcast_cursors WHERE account_id=? AND epoch=?').get(user.id,epoch)?.seq||0;
    const floor=Math.max(saved,Number.isSafeInteger(prior?.p?._monsterKillSeq)?prior.p._monsterKillSeq:0);if(seq<=floor)return;
    const settings=this.settings(),now=Date.now();
    if(settings.enabled&&prior)for(const event of (p._monsterKillEvents||[]).slice(-64)){
      if(!event||!Number.isSafeInteger(event.seq)||event.seq<=floor||event.seq>seq||!settings.monsters.includes(event.monsterId))continue;
      const monster=this.monsters.get(event.monsterId),map=this.maps.get(event.mapId);if(!monster||!map)continue;
      const at=Number.isSafeInteger(event.at)&&event.at>=now-7*86400000&&event.at<=now?event.at:now;if(at<settings.startedAt)continue;
      this.db.prepare('INSERT OR IGNORE INTO kill_broadcasts(account_id,epoch,seq,character_name,monster_id,monster,map_name,killed_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(user.id,epoch,event.seq,p.name||'冒險者',monster.id,monster.name,map,at,now);
    }
    this.db.prepare('INSERT INTO kill_broadcast_cursors VALUES(?,?,?) ON CONFLICT(account_id,epoch) DO UPDATE SET seq=MAX(seq,excluded.seq)').run(user.id,epoch,seq);
    this.db.prepare('DELETE FROM kill_broadcasts WHERE id<(SELECT COALESCE(MAX(id),0)-1000 FROM kill_broadcasts)').run();
  }
}
