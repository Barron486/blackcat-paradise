import {randomUUID} from 'node:crypto';
import {HeadlessGame} from './engine.mjs';

/** Strategy/catalog live locally; all state changes and clocks live on the server. */
export class RemoteGame {
  constructor({client,lease,snapshot,slot=1}){
    this.remote=true;this.client=client;this.lease=lease;this.slot=slot;this.boot=snapshot;this.revision=snapshot.revision;this.logs=[];
    this.reader=new HeadlessGame({values:snapshot.values,slot});
  }
  async open(creation){
    const raw=this.boot.values['lineage_idle_save_'+this.slot];
    const epoch=raw?this.reader.decodeSave(raw).p:null;
    this.epoch=epoch?epoch._roleEpoch||epoch.enSeed:null;
    await this.request(raw?'select':'create',raw?{}:creation);return this;
  }
  adopt(result){
    this.boot=result.snapshot;this.revision=result.snapshot.revision;
    if(result.game){this.game=result.game;this.epoch=result.game.epoch;this.logs=result.game.logs||[];}
  }
  async request(op,args={}){
    const body={lease:this.lease,op,args,...(op==='state'?{}:{slot:this.slot,epoch:this.epoch||undefined,revision:this.revision,requestId:randomUUID()})};
    for(let attempt=0;attempt<3;attempt++)try{const result=await this.client.game(body);this.adopt(result);return result;}
    catch(error){
      if(error.status===409&&error.data?.snapshot){this.boot=error.data.snapshot;this.revision=this.boot.revision;body.revision=this.revision;continue;}
      if(!error.status&&attempt<2)continue;
      throw error;
    }
    throw new Error('伺服器狀態持續更新，稍後重試');
  }
  async refresh(){const result=await this.request('state');if(!result.game)await this.request('select');}
  action(name,params={}){return this.request('action',{name,params}).then(()=>this.status());}
  pause(paused){return this.request(paused?'pause':'resume');}
  leave(){return this.request('leave');}
  step(){return this.status();}
  status(){return this.game?.status||{};}
  snapshot(){return this.game?.view||{};}
  catalog(){return this.reader.catalog();}
  values(){return this.boot.values;}
  save(){return this.values();}
  close(){this.reader.close();}
}
