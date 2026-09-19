import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const CHAT_MODEL='gpt-5.6-luna';
const schema=fileURLToPath(new URL('./chat-output.schema.json',import.meta.url));
const MAX_MS=90_000;
function failure(code){const e=new Error('聊天代理產生失敗');e.code=code;return e;}
function parseOutput(raw){let value;try{value=JSON.parse(raw);}catch{throw failure('GENERATION_FAILED');}if(!value||Array.isArray(value)||typeof value.text!=='string'||value.text.length>240||Object.keys(value).some(k=>k!=='text'))throw failure('GENERATION_FAILED');return {text:value.text.trim()};}
function childEnv(){const names=['PATH','USERPROFILE','APPDATA','LOCALAPPDATA','SYSTEMROOT','WINDIR','TEMP','TMP','CODEX_HOME','HOME','HOMEDRIVE','HOMEPATH'];return Object.fromEntries(names.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));}
export async function generateChat({prompt,model=CHAT_MODEL,signal,codexBin,spawnImpl=spawn,timeoutMs=MAX_MS}={}){
  if(model!==CHAT_MODEL)throw failure('MODEL_UNAVAILABLE');if(typeof prompt!=='string'||!prompt.trim())throw failure('GENERATION_FAILED');if(signal?.aborted)throw failure('TIMEOUT');
  const cwd=await mkdtemp(join(tmpdir(),'blackcat-chat-')),outputPath=join(cwd,'reply.json');
  const args=['exec','--model',CHAT_MODEL,'--ephemeral','--ignore-user-config','--skip-git-repo-check','--sandbox','read-only','--disable','shell_tool','--disable','multi_agent','--disable','plugins','--disable','apps','--disable','browser_use','--disable','computer_use','--config','web_search=disabled','--config','model_reasoning_effort=low','--output-schema',schema,'--output-last-message',outputPath,'--color','never','-'];
  let child,settled=false,timer,abortListener;
  try{return await new Promise((resolve,reject)=>{const finish=(error,value)=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);if(signal&&abortListener)signal.removeEventListener('abort',abortListener);error?reject(error):resolve(value);};try{child=spawnImpl(codexBin||'codex',args,{cwd,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:childEnv()});}catch{finish(failure('MODEL_UNAVAILABLE'));return;}child.stdout?.on('data',()=>{});child.stderr?.on('data',()=>{});child.once('error',error=>finish(error?.code==='ENOENT'?failure('MODEL_UNAVAILABLE'):failure('GENERATION_FAILED')));child.once('close',async code=>{if(child.__timedOut||signal?.aborted){finish(failure('TIMEOUT'));return;}if(code!==0){finish(failure('GENERATION_FAILED'));return;}try{finish(null,parseOutput((await readFile(outputPath,'utf8')).trim()));}catch(error){finish(error?.code==='ENOENT'?failure('GENERATION_FAILED'):error);}});const terminate=()=>{try{child.kill();}catch{}};abortListener=terminate;if(signal)signal.addEventListener('abort',terminate,{once:true});timer=setTimeout(()=>{child.__timedOut=true;terminate();},Math.min(MAX_MS,Math.max(1,Number(timeoutMs)||MAX_MS)));child.stdin?.on('error',()=>{});child.stdin?.end(prompt);});}finally{await rm(cwd,{recursive:true,force:true}).catch(()=>{});}
}
