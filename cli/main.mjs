#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync,openSync,closeSync,unlinkSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {CloudClient} from './cloud-client.mjs';
import {paths,loadProfile,saveProfile,listProfiles,writeJsonAtomic} from './profiles.mjs';

const ENTRY=fileURLToPath(import.meta.url),ROOT=fileURLToPath(new URL('../',import.meta.url));
const DEFAULT_SERVER='https://game.barron-ai.com';
const CLASS_NAMES={royal:'王族',mage:'法師',elf:'妖精',knight:'騎士',dark:'黑妖',illusion:'幻術士',dragon:'龍騎士',warrior:'戰士'};
const RILEY_MATERIALS=new Set(['mat_antharas_scale','mat_antharas_bone','mat_antharas_claw','mat_antharas_blood','mat_antharas_flesh','mat_antharas_fang','mat_antharas_eye']);
function readJson(file){try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}}
function alive(pid){if(!Number.isInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}
function seconds(value,label){const n=Number(value);if(!Number.isFinite(n)||n<=0)throw new Error(`${label} 必須為大於 0 的秒數`);return n;}
function required(value,label){if(!value)throw new Error(`請指定 ${label}`);return value;}
function output(value){console.log(JSON.stringify(value,null,2));}

export function getStatus(name){
  const meta=listProfiles().find(p=>p.name===name);if(!meta)throw new Error(`找不到 profile：${name}`);
  const files=paths(name),state=readJson(files.runtimeFile),lock=readJson(files.lockFile);
  const running=!!(lock&&alive(lock.pid));
  return {...meta,...state,running,status:running?(state?.status||'starting'):(state?.status==='error'?'error':'stopped'),online:running&&!!state?.online};
}

export async function sendCommand(name,command,{timeoutMs=30000}={}){
  const files=paths(name),lock=readJson(files.lockFile);
  if(!lock||!alive(lock.pid))throw new Error(`${name} 尚未啟動，請先執行 start`);
  const id=randomUUID(),file=`${id}.json`,resultFile=`${files.resultsDir}/${file}`;
  const deadline=Date.now()+timeoutMs;
  writeJsonAtomic(`${files.commandsDir}/${file}`,{...command,workerId:lock.workerId,expiresAt:deadline});
  while(Date.now()<deadline){
    const result=readJson(resultFile);
    if(result){unlinkSync(resultFile);if(!result.ok)throw new Error(result.error?.message||'命令失敗');return result.result;}
    if(!alive(lock.pid))throw new Error('遊玩程序已停止');
    await delay(100);
  }
  throw new Error('命令等候逾時；請先查看 status，避免重複購買或使用道具');
}

async function start(name,flags){
  if(!loadProfile(name))throw new Error(`找不到 profile：${name}`);
  const current=getStatus(name);if(current.running)return {profile:name,alreadyRunning:true,pid:current.pid,status:current.status};
  const files=paths(name);mkdirSync(files.directory,{recursive:true});
  const args=[ENTRY,'worker','--profile',name];
  for(const flag of ['duration','map'])if(flags[flag])args.push(`--${flag}`,flags[flag]);
  for(const flag of ['manual','takeover'])if(flags[flag])args.push(`--${flag}`);
  const out=openSync(files.logFile,'a',0o600),err=openSync(files.errorFile,'a',0o600);
  let child;
  try{child=spawn(process.execPath,args,{cwd:ROOT,detached:true,windowsHide:true,stdio:['ignore',out,err],env:process.env});}
  finally{closeSync(out);closeSync(err);}
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){
    const state=readJson(files.runtimeFile);
    if(state?.pid===child.pid&&state.status!=='starting'){
      if(state.status==='error')throw new Error(state.lastError?.message||'啟動失敗');
      return {profile:name,pid:child.pid,status:state.status,character:state.character?.name};
    }
    if(!alive(child.pid))throw new Error(`啟動失敗，請查看 ${files.errorFile}`);
    await delay(200);
  }
  return {profile:name,pid:child.pid,status:'starting'};
}

async function stop(name){
  const before=getStatus(name);if(!before.running)return {profile:name,status:before.status,alreadyStopped:true};
  await sendCommand(name,{type:'stop'});
  const deadline=Date.now()+25000;
  while(Date.now()<deadline){const s=getStatus(name);if(!s.running)return {profile:name,status:s.status,saved:s.lastError===null,lastSyncedAt:s.lastSyncedAt};await delay(200);}
  return {profile:name,status:'stopping',message:'仍在完成最後一次雲端存檔，稍後查看 status'};
}

function printStatuses(rows,json){
  if(json)return output(rows);
  const hp=n=>Number.isFinite(n)?Number(n.toFixed(1)):'-';
  console.table(rows.map(s=>({profile:s.name,帳號:s.username,職業:CLASS_NAMES[s.classId]||s.classId,狀態:s.status,等級:s.character?.level??'-',HP:s.character?`${hp(s.character.hp)}/${hp(s.character.maxHp)}`:'-',金幣:s.character?.gold??'-',地圖:s.character?.mapName??'-',PID:s.running?s.pid:'-'})));
}

const HELP=`黑貓天堂 CLI — 使用原版戰鬥與雲端存檔

  npm run cli -- create --profile knight --class knight [--name 代理騎士]
  npm run cli -- start --profile knight [--duration 600] [--map training]
  npm run cli -- status [--profile knight] [--json]
  npm run cli -- cloud --profile knight
  npm run cli -- watch [--interval 5] [--duration 60]
  npm run cli -- pause|resume|sync|stop --profile knight
  npm run cli -- stop --all
  npm run cli -- inspect inventory|skills|maps|effects|log --profile knight
  npm run cli -- target training --profile knight
  npm run cli -- travel training --profile knight
  npm run cli -- return-town|revive --profile knight
  npm run cli -- use|equip <物品uid> --profile knight
  npm run cli -- cast <技能id> --profile mage
  npm run cli -- buy <商人id> <物品id> <數量> --profile knight
  npm run cli -- riley status|exchange <素材id>|open --profile knight
  npm run cli -- setting set-hp-pot 70 --profile knight
  npm run cli -- credentials --profile knight

職業：royal 王族、mage 法師、elf 妖精、knight 騎士、dark 黑妖、illusion 幻術士、dragon 龍騎士、warrior 戰士。
create 自動產生帳號與密碼；可用 --username、--server 覆寫。
start 預設持續遊玩；--manual 暫停自動戰鬥；--takeover 明確接管同帳號。
先 pause 再手動操作可避免自動策略切換地圖。target 設定自動練功地圖。
  accounts status|start|stop [--map zone_04] [--json]
  diamonds --profile mage [--json]
  rename --profile mage --slot 1 --new-name 新名稱
  shop-buy --profile mage --product rename_card
  clan list|create <名稱>|join <血盟 id> --profile mage

  credentials 會顯示私密登入資訊，請勿分享輸出。詳細說明見 cli/README.md。
`;

export async function main(argv=process.argv.slice(2)){
  const {values:flags,positionals:args}=parseArgs({args:argv,allowPositionals:true,options:{
    profile:{type:'string'},class:{type:'string'},username:{type:'string'},name:{type:'string'},'new-name':{type:'string'},slot:{type:'string'},server:{type:'string'},duration:{type:'string'},map:{type:'string'},interval:{type:'string'},all:{type:'boolean'},json:{type:'boolean'},manual:{type:'boolean'},takeover:{type:'boolean'},help:{type:'boolean'},
  }});
  const [command='help',...rest]=args;
  if(flags.duration)seconds(flags.duration,'duration');
  if(flags.help||command==='help'){console.log(HELP);return;}
  if(command==='create'){
    const name=required(flags.profile,'--profile'),classId=required(flags.class,'--class');paths(name);
    if(loadProfile(name))throw new Error('Profile 已存在，未覆寫');
    if(!CLASS_NAMES[classId])throw new Error('職業須為 royal、mage、elf、knight、dark、illusion、dragon 或 warrior');
    const username=flags.username||`agent_${classId}_${randomBytes(3).toString('hex')}`,password=randomBytes(24).toString('base64url');
    const characterName=flags.name||`代理${CLASS_NAMES[classId]}`;
    if(characterName.length>20||/[\x00-\x1f<>]/.test(characterName))throw new Error('角色名稱格式不合法');
    const client=new CloudClient({baseUrl:flags.server||DEFAULT_SERVER});
    // Persist credentials before network registration so a lost response cannot orphan an account.
    const profile={name,username,password,classId,characterName,serverUrl:flags.server||DEFAULT_SERVER,slot:1,registration:'pending'};
    saveProfile(name,profile);
    try{const response=await client.register(username,password);if(response.user.role!=='player')throw new Error('自動遊玩帳號必須為一般玩家');profile.session=client.exportSession();profile.registration='complete';saveProfile(name,profile);}
    catch(error){profile.registration='uncertain';saveProfile(name,profile);throw new Error(`註冊未確認：${error.message}。登入資訊已保留，可用 start 嘗試登入或檢查設定檔。`);}
    output({profile:name,username,classId,role:'player',credentialsFile:paths(name).profileFile});return;
  }
  if(command==='status'||command==='watch'){
    const selected=()=>flags.profile?[getStatus(flags.profile)]:listProfiles().map(p=>getStatus(p.name));
    if(command==='status'){printStatuses(selected(),flags.json);return;}
    const interval=flags.interval?seconds(flags.interval,'interval'):5,deadline=flags.duration?Date.now()+Number(flags.duration)*1000:Infinity;
    do{printStatuses(selected(),flags.json);await delay(interval*1000);}while(Date.now()<deadline);return;
  }
  if(command==='accounts'){
    const mode=rest[0]||'status',profiles=listProfiles().map(p=>p.name);
    if(mode==='status'){printStatuses(profiles.map(getStatus),flags.json);return;}
    if(!['start','stop'].includes(mode))throw new Error('accounts 須為 status、start 或 stop');
    const rows=[];
    for(const profile of profiles){
      try{rows.push(mode==='start'?await start(profile,flags):await stop(profile));}
      catch(error){rows.push({profile,status:'error',error:error.message});}
    }
    output(rows);return;
  }
  if(command==='stop'&&flags.all){output(await Promise.all(listProfiles().map(p=>stop(p.name))));return;}
  const name=required(flags.profile,'--profile');paths(name);
  if(command==='start'){output(await start(name,flags));return;}
  if(command==='worker'){const {runWorker}=await import('./worker.mjs');await runWorker(name,{duration:flags.duration?Number(flags.duration):undefined,map:flags.map,manual:flags.manual,takeover:flags.takeover});return;}
  if(command==='stop'){output(await stop(name));return;}
  if(command==='credentials'){const p=loadProfile(name);if(!p)throw new Error('找不到 profile');output({username:p.username,password:p.password,url:`${p.serverUrl}/login`});return;}
  if(command==='diamonds'){
    const p=loadProfile(name);if(!p)throw new Error('找不到 profile');
    const client=new CloudClient({baseUrl:p.serverUrl,session:p.session||undefined});let ownSession=false;
    try{let info;try{info=await client.shop();}catch(error){if(error.status!==401)throw error;await client.login(p.username,p.password);ownSession=true;info=await client.shop();}
      output({profile:name,username:p.username,wallet:info.wallet,characters:info.characters,history:info.history});
    }finally{if(ownSession&&client.authenticated)await client.logout();}
    return;
  }
  if(command==='clan'){
    const {clans,createClan,joinClan}=await import('./clans.mjs');
    if(rest[0]==='list')output({clans:clans()});
    else if(rest[0]==='create')output(createClan(required(rest[1],'血盟名稱'),required(name,'--profile')));
    else if(rest[0]==='join')output(joinClan(required(rest[1],'血盟 id'),required(name,'--profile')));
    else throw new Error('用法：clan list|create <名稱>|join <血盟 id> --profile <角色>');
    return;
  }
  if(command==='shop-buy'){
    const product=required(rest[0]||flags.product,'商品 id');
    if(!['rename_card','password_card','full_status'].includes(product))throw new Error('不支援的藍鑽商品');
    const p=loadProfile(name);const client=new CloudClient({baseUrl:p.serverUrl,session:p.session||undefined});let ownSession=false;
    try{try{output(await client.shopBuy({productId:product,requestId:randomUUID()}));}
      catch(error){if(error.status!==401)throw error;await client.login(p.username,p.password);ownSession=true;output(await client.shopBuy({productId:product,requestId:randomUUID()}));}}
    finally{if(ownSession&&client.authenticated)await client.logout();}
    return;
  }
  if(command==='rename'){
    const slot=Number(required(flags.slot,'--slot')),newName=required(flags['new-name'],'--new-name');
    if(!Number.isInteger(slot)||slot<1||slot>8)throw new Error('--slot 須為 1 到 8');
    if(newName.length>12||/[\x00-\x1f<>]/.test(newName))throw new Error('--new-name 格式不合法（最多 12 字）');
    const current=getStatus(name);if(current.running)throw new Error('更名前請先 stop 該 profile，避免與遊戲程序同時寫入');
    const p=loadProfile(name);const client=new CloudClient({baseUrl:p.serverUrl,session:p.session||undefined});let ownSession=false;
    try{let info;try{info=await client.shop();}catch(error){if(error.status!==401)throw error;await client.login(p.username,p.password);ownSession=true;info=await client.shop();}
      const character=info.characters.find(c=>c.slot===slot);if(!character)throw new Error(`找不到角色欄位 ${slot}`);
      if(!info.wallet.renameCards)throw new Error('沒有可用更名卡，請先在商店購買更名卡');
      const result=await client.shopRename({slot,epoch:character.epoch,name:newName,requestId:randomUUID()});
      output({profile:name,slot,oldName:character.name,newName:result.name,wallet:result.wallet});
    }finally{if(ownSession&&client.authenticated)await client.logout();}
    return;
  }
  if(command==='cloud'){
    const p=loadProfile(name);if(!p)throw new Error('找不到 profile');
    const client=new CloudClient({baseUrl:p.serverUrl,session:p.session||undefined});let ownSession=false;
    try{
      let cloud;try{cloud=await client.bootstrap();}catch(error){if(error.status!==401)throw error;await client.login(p.username,p.password);ownSession=true;cloud=await client.bootstrap();}
      const {loadCatalog}=await import('../server/catalog.mjs'),catalog=loadCatalog(new URL('../',import.meta.url));
      const characters=Object.entries(cloud.values).filter(([key])=>/^lineage_idle_save_[1-8]$/.test(key)).map(([key,value])=>{
        const doc=catalog.unwrap(value);return {slot:Number(key.at(-1)),name:doc.p.name,classId:doc.p.cls,level:doc.p.lv,exp:doc.p.exp,gold:doc.p.gold,hp:doc.p.hp,map:doc.ms.current,ticks:doc.ticks};
      });
      const world=await client.world();
      output({username:cloud.user.username,role:cloud.user.role,revision:cloud.revision,serverTime:cloud.serverTime,characters,online:world.online});
    }finally{if(ownSession&&client.authenticated)await client.logout();}
    return;
  }
  if(['pause','resume','sync'].includes(command)){output(await sendCommand(name,{type:command}));return;}
  if(command==='inspect'){output(await sendCommand(name,{type:'inspect',view:required(rest[0],'查看項目')}));return;}
  if(command==='target'){output(await sendCommand(name,{type:'target',mapId:required(rest[0],'地圖 id')}));return;}
  if(command==='riley'){
    const operation=rest[0]||'status';
    if(operation==='status'){output(await sendCommand(name,{type:'inspect',view:'riley'}));return;}
    let method,params=[];
    if(operation==='exchange'){
      const itemId=required(rest[1],'安塔瑞斯素材 id');
      if(!RILEY_MATERIALS.has(itemId))throw new Error('素材須為 mat_antharas_scale、bone、claw、blood、flesh、fang 或 eye');
      method='antPointsExchange';params=[itemId];
    }else if(operation==='open')method='antHeirloomOpen';
    else throw new Error('riley 須為 status、exchange <素材id> 或 open');
    await sendCommand(name,{type:'action',name:'npc-command',args:{npcId:'npc_riley_aide',method,params,fields:{}}});
    output({profile:name,operation,...await sendCommand(name,{type:'inspect',view:'riley'})});return;
  }
  let actionArgs={};let action=command;
  if(command==='travel')actionArgs={mapId:required(rest[0],'地圖 id')};
  else if(['use','equip'].includes(command))actionArgs={uid:required(rest[0],'物品 uid')};
  else if(command==='cast')actionArgs={skillId:required(rest[0],'技能 id')};
  else if(command==='buy'){action='shop';actionArgs={npcId:required(rest[0],'商人 id'),itemId:required(rest[1],'物品 id'),qty:Number(required(rest[2],'數量'))};}
  else if(command==='setting'){action='settings';const key=required(rest[0],'設定 id'),value=required(rest[1],'設定值');actionArgs={[key]:value==='true'?true:value==='false'?false:value};}
  else if(!['return-town','revive'].includes(command))throw new Error(`未知指令：${command}，請執行 help`);
  const result=await sendCommand(name,{type:'action',name:action,args:actionArgs});
  output(flags.json?result:{profile:name,action,name:result.name,level:result.level,hp:result.hp,mp:result.mp,gold:result.gold,map:result.mapName});
}

if(process.argv[1]&&ENTRY===resolve(process.argv[1])){
  main().catch(error=>{console.error(`錯誤：${error.message}`);process.exitCode=1;});
}
