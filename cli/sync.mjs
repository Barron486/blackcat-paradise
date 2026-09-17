import { applyEffect } from '../shared/gm-effects.js';

const supported = key => /^(lineage_|fb5_)[\w:-]{1,170}$/.test(key);
export function saveChanges(values, baseline) {
  const changes = {};
  for (const key of new Set([...Object.keys(values), ...Object.keys(baseline)])) {
    if (supported(key) && (values[key] ?? null) !== (baseline[key] ?? null)) changes[key] = values[key] ?? null;
  }
  return changes;
}

/** The same optimistic revision/GM reconciliation protocol used by the web client. */
export class GameSync {
  constructor({client, engine, snapshot, lease, slot = 1}) {
    this.client=client;this.engine=engine;this.lease=lease;this.slot=slot;
    this.baseline={...snapshot.values};this.revision=snapshot.revision;
    this.offset=snapshot.serverTime-Date.now();this.lastSyncedAt=null;
    this.engine.setWorldSettings?.(snapshot.worldSettings);
  }
  now() { return Date.now()+this.offset; }
  checkpoint() {
    this.engine.save();
    return {values:this.engine.values(),baseline:this.baseline,revision:this.revision,updatedAt:Date.now(),synced:Object.keys(saveChanges(this.engine.values(),this.baseline)).length===0};
  }
  async flush() {
    for(let attempt=0;attempt<3;attempt++) {
      this.engine.save();
      const values=this.engine.values(),changes=saveChanges(values,this.baseline),status=this.engine.status();
      try {
        const result=await this.client.sync({lease:this.lease,revision:this.revision,changes,presence:{name:status.name,slot:this.slot,map:status.mapName||status.map}});
        this.engine.setWorldSettings?.(result.worldSettings);
        this.revision=result.revision;this.offset=result.serverTime-Date.now();this.baseline={...values};this.lastSyncedAt=Date.now();
        return {revision:this.revision,lastSyncedAt:this.lastSyncedAt};
      } catch(error) {
        if(error.status!==409 || !error.data?.snapshot) throw error;
        const snapshot=error.data.snapshot, effects=error.data.effects||[];
        this.engine.setWorldSettings?.(snapshot.worldSettings);
        this.offset=snapshot.serverTime-Date.now();
        const merged={...snapshot.values};
        for(const [key,value] of Object.entries(changes)) { if(value===null)delete merged[key];else merged[key]=value; }
        const currentKey=`lineage_idle_save_${this.slot}`;
        for(const [key,raw]of Object.entries(snapshot.values))if(/^lineage_idle_save_[1-8]$/.test(key)&&merged[key]){
          const canonical=this.engine.decodeSave(raw),local=this.engine.decodeSave(merged[key]);
          if((canonical.p._roleEpoch||canonical.p.enSeed)===(local.p._roleEpoch||local.p.enSeed)){
            local.p.name=canonical.p.name;merged[key]=this.engine.encodeSave(local);
            if(key===currentKey)this.engine.run('player.name=__args;',canonical.p.name);
          }
        }
        this.engine.applyEffects(effects.filter(e=>e.key===currentKey),this.now());
        for(const effect of effects) {
          if(effect.key===currentKey || !merged[effect.key]) continue;
          const doc=this.engine.decodeSave(merged[effect.key]);
          if(applyEffect(doc,effect,this.now())) merged[effect.key]=this.engine.encodeSave(doc);
        }
        merged[currentKey]=this.engine.encodeSave(this.engine.snapshot());
        this.engine.setValues(merged);
        this.baseline={...snapshot.values};this.revision=snapshot.revision;
      }
    }
    throw new Error('連續出現存檔衝突，已保留本機進度，稍後重試');
  }
}
