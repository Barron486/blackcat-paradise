import {randomUUID} from 'node:crypto';
import {openSync,closeSync,readFileSync,readdirSync,unlinkSync,mkdirSync,existsSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {CloudClient} from './cloud-client.mjs';
import {HeadlessGame} from './engine.mjs';
import {RemoteGame} from './remote-game.mjs';
import {loadProfile,saveProfile,paths,writeJsonAtomic} from './profiles.mjs';
import {CLASS_PRESETS,createStrategy} from './strategy.mjs';
import {GameSync} from './sync.mjs';
import {collectStatuses} from '../shared/status-view.js';

const RILEY_MATERIALS=Object.freeze({mat_antharas_scale:1,mat_antharas_bone:2,mat_antharas_claw:3,mat_antharas_blood:4,mat_antharas_flesh:5,mat_antharas_fang:6,mat_antharas_eye:7});

export const isProcessAlive = pid => {
  if(!Number.isInteger(pid)||pid<1)return false;
  try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}
};
function readJson(file) { try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;} }
const publicError = error => ({message:error.message,code:error.code||'ERROR',status:error.status||0});

export async function runWorker(profileName, options={}) {
  const profile=loadProfile(profileName);if(!profile)throw new Error(`找不到 profile：${profileName}`);
  const files=paths(profileName);mkdirSync(files.directory,{recursive:true});mkdirSync(files.commandsDir,{recursive:true});mkdirSync(files.resultsDir,{recursive:true});
  const previous=readJson(files.lockFile);
  if(previous&&isProcessAlive(previous.pid))throw new Error('此帳號已有 CLI 遊玩程序');
  if(existsSync(files.lockFile))unlinkSync(files.lockFile);
  const lock=openSync(files.lockFile,'wx',0o600);closeSync(lock);
  const workerId=randomUUID();writeJsonAtomic(files.lockFile,{pid:process.pid,workerId,startedAt:Date.now()});
  let engine, sync, client, stop=false, paused=options.manual===true, online=false, finalError=null, targetMap=options.map||'training';
  const startedAt=Date.now(),history=[],checkpointFile=path.join(files.directory,'checkpoint.json');
  const strategy=createStrategy({targetMap});
  let status='starting',lastDecision='',lastError=null,tickAnchor=performance.now(),nextSync=0,nextDecision=0,nextSave=0,lastRefresh=0;
  const deadline=options.duration?startedAt+options.duration*1000:Infinity;
  const onStop=()=>{stop=true;};process.on('SIGINT',onStop);process.on('SIGTERM',onStop);
  function log(event,data={}) {
    const entry={at:new Date().toISOString(),event,...data};history.push(entry);if(history.length>60)history.shift();
    console.log(JSON.stringify(entry));
  }
  function publish() {
    writeJsonAtomic(files.runtimeFile,{profile:profileName,username:profile.username,classId:profile.classId,pid:process.pid,workerId,status,paused,online,startedAt,updatedAt:Date.now(),targetMap,lastDecision,lastError,lastSyncedAt:sync?.lastSyncedAt||null,revision:sync?.revision??null,character:engine?.status()||null,history:history.slice(-12)});
  }
  function checkpoint() { if(sync)writeJsonAtomic(checkpointFile,sync.checkpoint()); }
  async function connect() {
    client=new CloudClient({baseUrl:profile.serverUrl,session:profile.session||undefined});
    let snapshot;
    try{snapshot=await client.bootstrap();}catch(error){if(error.status!==401)throw error;await client.login(profile.username,profile.password);profile.session=client.exportSession();saveProfile(profileName,profile);snapshot=await client.bootstrap();}
    if(snapshot.user.role!=='player')throw new Error('自動遊玩僅接受一般玩家帳號');
    profile.lease ||= randomUUID();saveProfile(profileName,profile);
    await client.acquireLease(profile.lease,{takeover:options.takeover===true});
    if(snapshot.authoritative){
      const preset=CLASS_PRESETS[profile.classId];
      engine=new RemoteGame({client,lease:profile.lease,snapshot,slot:profile.slot||1});
      await engine.open({classId:profile.classId,name:profile.characterName,allocation:preset?.points||preset?.allocation,gender:'m'});
      if(engine.snapshot().p.cls!==profile.classId)throw new Error('雲端角色職業與 profile 不符');
      if(paused)await engine.pause(true);
      sync=new GameSync({client,engine,snapshot:engine.boot,lease:profile.lease,slot:profile.slot||1});
      await sync.flush();online=true;checkpoint();log('connected',{username:profile.username,revision:sync.revision,serverOwned:true});return;
    }
    const prior=readJson(checkpointFile);
    const recover=prior&&!prior.synced&&prior.values;
    const values=recover?prior.values:snapshot.values;
    engine=new HeadlessGame({values,slot:profile.slot||1});
    engine.setWorldSettings(snapshot.worldSettings);
    if(values[`lineage_idle_save_${profile.slot||1}`])engine.load(profile.slot||1);
    else {
      const preset=CLASS_PRESETS[profile.classId];if(!preset)throw new Error('此職業沒有 CLI 創角配點');
      engine.create({classId:profile.classId,name:profile.characterName,allocation:preset.points||preset.allocation,gender:'m'});
      log('character-created',{classId:profile.classId,name:profile.characterName});
    }
    if(engine.snapshot().p.cls!==profile.classId)throw new Error('雲端角色職業與 profile 不符，停止以避免操作錯誤角色');
    sync=new GameSync({client,engine,snapshot:recover?{...snapshot,values:prior.baseline||snapshot.values,revision:prior.revision}:snapshot,lease:profile.lease,slot:profile.slot||1});
    await sync.flush();online=true;checkpoint();
    log('connected',{username:profile.username,revision:sync.revision,recovered:!!recover});
  }
  async function processCommands() {
    for(const file of readdirSync(files.commandsDir).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).slice(0,20)) {
      const commandPath=path.join(files.commandsDir,file),packet=readJson(commandPath);unlinkSync(commandPath);
      if(!packet||packet.workerId!==workerId){writeJsonAtomic(path.join(files.resultsDir,file),{ok:false,error:{message:'此命令屬於已停止的遊玩程序'}});continue;}
      try {
        if(!Number.isFinite(packet.expiresAt)||packet.expiresAt<Date.now())throw new Error('命令已逾時，未執行');
        let result;
        if(packet.type==='stop'){stop=true;result={stopping:true};}
        else if(packet.type==='pause'){if(engine.remote)await engine.pause(true);paused=true;result={paused:true};}
        else if(packet.type==='resume'){if(engine.remote)await engine.pause(false);paused=false;tickAnchor=performance.now();result={paused:false};}
        else if(packet.type==='status')result=engine.status();
        else if(packet.type==='inspect') {
          const doc=engine.snapshot(),catalog=engine.catalog();
          if(packet.view==='inventory')result=doc.p.inv.map(item=>({...item,name:catalog.items[item.id]?.n||item.id}));
          else if(packet.view==='skills')result=(doc.p.skills||[]).map(id=>({id,...catalog.skills[id]}));
          else if(packet.view==='maps')result=Object.entries(catalog.maps).flatMap(([category,maps])=>maps.map(map=>({id:map.v,name:map.t||map.n,category})));
          else if(packet.view==='effects')result=collectStatuses(doc.p,{skills:catalog.skills,now:sync.now(),ticks:doc.ticks});
          else if(packet.view==='log')result={decisions:history,combat:engine.logs.slice(-80)};
          else if(packet.view==='riley'){
            const key='lineage_idle_antharas_points'+(doc.p.classicMode?'_classic':''),points=Math.max(0,Number.parseInt(engine.values()[key]||'0',10)||0);
            result={points,heirlooms:Math.floor(points/10),mode:doc.p.classicMode?'classic':'normal',materials:Object.entries(RILEY_MATERIALS).map(([id,pointsEach])=>({id,name:catalog.items[id]?.n||id,pointsEach,quantity:(doc.p.inv||[]).filter(item=>item.id===id).reduce((sum,item)=>sum+(item.cnt||0),0)}))};
          }else throw new Error('可查看 inventory、skills、maps、effects、log、riley');
        } else if(packet.type==='sync'){await sync.flush();online=true;checkpoint();result={revision:sync.revision};}
        else if(packet.type==='target') {
          if(!Object.values(engine.catalog().maps).flat().some(map=>map.v===packet.mapId))throw new Error('找不到地圖');
          targetMap=packet.mapId;strategy.setTarget?.(targetMap);result={targetMap};
        } else if(packet.type==='action') {
          if(!online)throw new Error('雲端中斷中，暫停角色操作');
          result=await engine.action(packet.name,packet.args||{});checkpoint();
          log('manual-action',{action:packet.name});
        } else throw new Error('未知的 CLI 命令');
        status=stop?'stopping':!online?'reconnecting':engine.snapshot().p._gmDead?'gm-stopped':paused?'paused':'playing';
        publish();
        writeJsonAtomic(path.join(files.resultsDir,file),{ok:true,result:result??null});
        if(stop)break;
      }catch(error){writeJsonAtomic(path.join(files.resultsDir,file),{ok:false,error:publicError(error)});}
    }
  }
  publish();
  try {
    await connect();tickAnchor=performance.now();nextSync=Date.now()+3000;
    while(!stop&&Date.now()<deadline) {
      await processCommands();if(stop)break;
      const now=Date.now();
      if(now>=nextSync) {
        try {await sync.flush();online=true;lastError=null;nextSync=Date.now()+3000;}
        catch(error){online=false;lastError=publicError(error);log('sync-error',{error:lastError});nextSync=Date.now()+5000;if([401,403,423].includes(error.status))throw error;}
        // Account for elapsed time only while this worker holds the game lease.
        if(!online)tickAnchor=performance.now();
      }
      if(online&&now-lastRefresh>=1000){engine.refreshGm?.(sync.now());lastRefresh=now;}
      if(online&&!paused) {
        const current=performance.now(),ticks=Math.min(50,Math.floor((current-tickAnchor)/100));
        if(ticks>0){engine.step(ticks);tickAnchor+=ticks*100;}
        if(now>=nextDecision) {
          nextDecision=now+5000;
          const action=strategy.decide(engine.snapshot(),engine.catalog(),{targetMap});
          if(action)try{await engine.action(action.name,action.args||{});lastDecision=action.reason||action.name;log('decision',{action:action.name,reason:lastDecision});strategy.recordResult?.(action,true);}
          catch(error){lastDecision=error.message;log('decision-skipped',{action:action.name,message:error.message});strategy.recordResult?.(action,false);}
        }
      } else tickAnchor=performance.now();
      status=!online?'reconnecting':engine.snapshot().p._gmDead?'gm-stopped':paused?'paused':'playing';
      if(now>=nextSave){checkpoint();publish();nextSave=now+2000;}
      await delay(100);
    }
    status='stopping';publish();
    try{await sync.flush();if(engine.remote)await engine.leave();online=true;lastError=null;}catch(error){online=false;lastError=publicError(error);log('final-sync-pending',{error:lastError});}
    checkpoint();status='stopped';log('stopped',{saved:online});
  } catch(error) {
    finalError=error;lastError=publicError(error);status='error';log('worker-error',{error:lastError});
    try{checkpoint();}catch{}
  } finally {
    if(client?.authenticated)try{await client.logout();profile.session=null;saveProfile(profileName,profile);}catch{}
    online=false;
    try{publish();}catch{}
    if(readJson(files.lockFile)?.workerId===workerId)unlinkSync(files.lockFile);
    process.off('SIGINT',onStop);process.off('SIGTERM',onStop);engine?.close?.();
  }
  if(finalError)throw finalError;
}
