#!/usr/bin/env node
import {existsSync,readFileSync,unlinkSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {generateChat,CHAT_MODEL} from './chat-generator.mjs';
import {generateOllamaChat,listOllamaModels} from './ollama-generator.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const home=()=>resolve(process.env.BLACKCAT_CLI_HOME||join(ROOT,'data','cli'));
export const paths=()=>{const d=join(home(),'ai-chat');return {root:d,config:join(d,'bridge.json'),lock:join(d,'bridge.lock'),stop:join(d,'stop')};};
function json(file){try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}}
function normalizeOrigin(input){let u;try{u=new URL(input);}catch{throw new Error('serverUrl 不合法');}if((u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('serverUrl 必須是無帳密、無路徑的 HTTPS origin');return u.origin;}
function config(){const c=json(paths().config);if(!c||typeof c.token!=='string'||!c.token)throw new Error('請設定 data/cli/ai-chat/bridge.json');return {...c,serverUrl:normalizeOrigin(c.serverUrl)};}
function alive(pid){if(!Number.isInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}
export async function request(base,token,path,body,fetchImpl=fetch){const payload=JSON.stringify(body);const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);try{const response=await fetchImpl(new URL(path,base),{method:'POST',headers:{Authorization:`Bearer ${token}`,Origin:base,'Content-Type':'application/json'},body:payload,signal:controller.signal,redirect:'error'});if(!response?.ok)throw new Error('bridge request failed');try{return await response.json();}catch{throw new Error('bridge response invalid');}}finally{clearTimeout(timer);}}
function safeError(error){return ['MODEL_UNAVAILABLE','TIMEOUT','GENERATION_FAILED','OLLAMA_UNAVAILABLE','OLLAMA_MODEL_MISSING'].includes(error?.code)?error.code:'GENERATION_FAILED';}
let probeCache;
export async function once({codexBin,fetchImpl=fetch,ollamaFetchImpl=fetch,signal,generateImpl=generateChat,generateOllamaImpl=generateOllamaChat}={}){
  const c=config(),claim=await request(c.serverUrl,c.token,'/api/ai-chat/claim',{providers:['codex','ollama']},fetchImpl);
  const setup=claim.configuration;
  if(setup){
    const cacheKey=JSON.stringify([c.serverUrl,setup.revision,setup.ollamaUrl]);
    if(!probeCache||probeCache.key!==cacheKey||Date.now()-probeCache.at>30000){
      try{probeCache={key:cacheKey,at:Date.now(),ready:true,models:(await listOllamaModels({baseUrl:setup.ollamaUrl,fetchImpl:ollamaFetchImpl,signal})).map(m=>m.name)};}
      catch{probeCache={key:cacheKey,at:Date.now(),ready:false,models:[]};}
    }
    await request(c.serverUrl,c.token,'/api/ai-chat/runtime',{revision:setup.revision,ollamaUrl:setup.ollamaUrl,ready:probeCache.ready,models:probeCache.models},fetchImpl).catch(()=>{});
  }
  if(!claim?.job)return {job:null,retryAfterSeconds:Number(claim?.retryAfterSeconds)||10};
  const job=claim.job,provider=job.provider||'codex';
  if(!['codex','ollama'].includes(provider)||(provider==='codex'&&job.model!==CHAT_MODEL)||typeof job.id!=='string'||typeof job.leaseToken!=='string')return {job:null,retryAfterSeconds:10};
  try{
    if(provider==='ollama'&&setup){
      if(!probeCache.ready)throw Object.assign(new Error(),{code:'OLLAMA_UNAVAILABLE'});
      if(!probeCache.models.includes(job.model)&&!probeCache.models.includes(job.model+':latest'))throw Object.assign(new Error(),{code:'OLLAMA_MODEL_MISSING'});
    }
    const result=provider==='ollama'?await generateOllamaImpl({prompt:job.prompt,model:job.model,baseUrl:job.ollamaUrl,signal,fetchImpl:ollamaFetchImpl}):await generateImpl({prompt:job.prompt,model:CHAT_MODEL,codexBin:codexBin||c.codexBin,signal});
    if(signal?.aborted)return {jobId:job.id,aborted:true};
    await request(c.serverUrl,c.token,'/api/ai-chat/complete',{jobId:job.id,leaseToken:job.leaseToken,text:result.text,usage:result.usage},fetchImpl);return {jobId:job.id,completed:true,provider};
  }catch(error){if(signal?.aborted)return {jobId:job.id,aborted:true};const code=safeError(error);await request(c.serverUrl,c.token,'/api/ai-chat/fail',{jobId:job.id,leaseToken:job.leaseToken,error:code},fetchImpl);return {jobId:job.id,failed:code};}
}
export async function worker({onceImpl=once,codexBin}={}){const p=paths();mkdirSync(p.root,{recursive:true});if(existsSync(p.lock)){const old=json(p.lock);if(alive(old?.pid))throw new Error('聊天 bridge 已在執行');try{unlinkSync(p.lock);}catch{}}try{unlinkSync(p.stop);}catch{};writeFileSync(p.lock,JSON.stringify({pid:process.pid,startedAt:Date.now()}),{flag:'wx',mode:0o600});try{while(!existsSync(p.stop)){const controller=new AbortController(),watch=setInterval(()=>{if(existsSync(p.stop))controller.abort();},200);let stopPoll;const stopPromise=new Promise(resolve=>{stopPoll=setInterval(()=>{if(existsSync(p.stop)){controller.abort();resolve();}},100);});let result;try{result=await onceImpl({codexBin,signal:controller.signal});}catch{result={retryAfterSeconds:10};}clearInterval(watch);clearInterval(stopPoll);if(existsSync(p.stop))break;const waitMs=Math.max(1,Math.min(300,Number(result?.retryAfterSeconds)||10))*1000;await new Promise(resolve=>{let poll;const timer=setTimeout(()=>{clearInterval(poll);resolve();},waitMs);poll=setInterval(()=>{if(existsSync(p.stop)){clearTimeout(timer);clearInterval(poll);resolve();}},100);});}}finally{try{unlinkSync(p.lock);}catch{}}}
export function status(){const c=json(paths().lock);return {running:alive(c?.pid),pid:alive(c?.pid)?c.pid:null};}
export function stop(){mkdirSync(paths().root,{recursive:true});writeFileSync(paths().stop,'stop\n',{flag:'w'});}
export function start(){const c=config(),p=paths();mkdirSync(p.root,{recursive:true});const current=json(p.lock);if(alive(current?.pid))return {started:false,pid:current.pid};try{unlinkSync(p.stop);}catch{}let child;try{child=spawn(process.execPath,[fileURLToPath(import.meta.url),'worker'],{detached:true,windowsHide:true,stdio:'ignore'});}catch{throw new Error('聊天 bridge 啟動失敗');}child.once?.('error',()=>{});child.unref();return {started:true,pid:child.pid};}
if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))){const command=process.argv[2]||'status';(async()=>{if(command==='once')console.log(JSON.stringify(await once()));else if(command==='worker'||command==='internal')await worker();else if(command==='stop')stop();else if(command==='status')console.log(JSON.stringify(status()));else if(command==='start')console.log(JSON.stringify(start()));else throw new Error('用法：start|stop|status|once');})().catch(()=>{process.exitCode=1;});}
