import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from '../cli/ai-chat.mjs';

test('Ollama bridge discovers local models, publishes usage and never invokes Codex',async t=>{
  const home=mkdtempSync(join(tmpdir(),'blackcat-ollama-bridge-')),old=process.env.BLACKCAT_CLI_HOME;
  process.env.BLACKCAT_CLI_HOME=home;t.after(()=>{if(old===undefined)delete process.env.BLACKCAT_CLI_HOME;else process.env.BLACKCAT_CLI_HOME=old;rmSync(home,{recursive:true,force:true});});
  mkdirSync(join(home,'ai-chat'));writeFileSync(join(home,'ai-chat/bridge.json'),JSON.stringify({serverUrl:'http://127.0.0.1:8799',token:'test-token'}));
  const calls=[],job={id:'ollama-1',provider:'ollama',model:'qwen3:8b',ollamaUrl:'http://127.0.0.1:11434',prompt:'你好',leaseToken:'lease'};
  const fetchImpl=async(url,options)=>{const body=JSON.parse(options.body);calls.push({url:String(url),body});return new Response(JSON.stringify(String(url).endsWith('/claim')?{job,configuration:{revision:1,ollamaUrl:job.ollamaUrl}}:{ok:true}));};
  const result=await once({fetchImpl,ollamaFetchImpl:async(url,options)=>{assert.equal(String(url),job.ollamaUrl+'/api/tags');assert.equal(options.headers,undefined);return new Response(JSON.stringify({models:[{name:'qwen3:8b'}]}));},generateImpl:async()=>assert.fail('Codex must not run'),generateOllamaImpl:async args=>{assert.equal(args.model,job.model);assert.equal(args.baseUrl,job.ollamaUrl);return {text:'晚安！',usage:{input_tokens:5,output_tokens:2}};}});
  assert.equal(result.completed,true);assert.equal(result.provider,'ollama');
  assert.deepEqual(calls.map(c=>new URL(c.url).pathname),['/api/ai-chat/claim','/api/ai-chat/runtime','/api/ai-chat/complete']);
  assert.equal(calls[1].body.ready,true);assert.equal(calls[2].body.usage.output_tokens,2);
  const stopped=new AbortController();calls.length=0;
  const cancelled=await once({fetchImpl,signal:stopped.signal,generateOllamaImpl:async()=>{stopped.abort();return {text:'不應發出'};}});
  assert.equal(cancelled.aborted,true);assert.ok(!calls.some(c=>c.url.endsWith('/complete')));
});

test('HTTP non-200 claim fails before generation',async t=>{const home=mkdtempSync(join(tmpdir(),'blackcat-ai-bridge-'));const old=process.env.BLACKCAT_CLI_HOME;process.env.BLACKCAT_CLI_HOME=home;t.after(()=>{if(old===undefined)delete process.env.BLACKCAT_CLI_HOME;else process.env.BLACKCAT_CLI_HOME=old;rmSync(home,{recursive:true,force:true});});const dir=join(home,'ai-chat');mkdirSync(dir);writeFileSync(join(dir,'bridge.json'),JSON.stringify({serverUrl:'http://127.0.0.1',token:'test-token'}));let generated=false;await assert.rejects(once({fetchImpl:async()=>new Response('denied',{status:401}),generateImpl:async()=>{generated=true;return {text:'late'};}}));assert.equal(generated,false);});

test('abort after generation does not complete the claimed job',async t=>{const home=mkdtempSync(join(tmpdir(),'blackcat-ai-bridge-'));const old=process.env.BLACKCAT_CLI_HOME;process.env.BLACKCAT_CLI_HOME=home;t.after(()=>{if(old===undefined)delete process.env.BLACKCAT_CLI_HOME;else process.env.BLACKCAT_CLI_HOME=old;rmSync(home,{recursive:true,force:true});});const dir=join(home,'ai-chat');mkdirSync(dir);writeFileSync(join(dir,'bridge.json'),JSON.stringify({serverUrl:'http://127.0.0.1',token:'test-token'}));const controller=new AbortController();const calls=[];const fetchImpl=async(url,options)=>{calls.push(String(url));return new Response(JSON.stringify({job:{id:'j1',leaseToken:'l1',model:'gpt-5.6-luna',prompt:'x'}}),{status:200,headers:{'content-type':'application/json'}});};const result=await once({signal:controller.signal,fetchImpl,generateImpl:async()=>{controller.abort();return {text:'late'};}});assert.equal(result.aborted,true);assert.deepEqual(calls,['http://127.0.0.1/api/ai-chat/claim']);});
