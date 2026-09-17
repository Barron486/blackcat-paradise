import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOllamaUrl,validateOllamaModel} from '../shared/ollama-config.js';
import {generateOllamaChat,listOllamaModels} from '../cli/ollama-generator.mjs';
const response = value => new Response(JSON.stringify(value));
const args = {baseUrl:'http://127.0.0.1:11434',model:'qwen3:8b',prompt:'請用繁體中文回覆玩家'};
test('local Ollama accepts loopback ports and rejects external endpoints and cloud models',()=>{
  assert.equal(normalizeOllamaUrl('http://localhost:12345/'),'http://localhost:12345');
  assert.equal(normalizeOllamaUrl('http://[::1]:11434'),'http://[::1]:11434');
  for(const url of ['https://example.com','http://localhost@evil.test','http://127.0.0.1:11434/api/chat','http://localhost/?x=1','file:///tmp/a'])assert.throws(()=>normalizeOllamaUrl(url));
  for(const model of ['qwen-cloud','qwen:cloud','bad model',''])assert.throws(()=>validateOllamaModel(model));
});
test('Ollama lists installed local models and sends a single tool-free JSON chat without credentials',async()=>{
  const models=await listOllamaModels({baseUrl:args.baseUrl,fetchImpl:async(url)=>{assert.equal(url,args.baseUrl+'/api/tags');return response({models:[{name:'qwen3:8b',size:123},{name:'qwen:cloud'},{name:'remote',remote_host:'https://ollama.com'}]});}});
  assert.deepEqual(models,[{name:'qwen3:8b',size:123}]);
  const result=await generateOllamaChat({...args,fetchImpl:async(url,options)=>{
    assert.equal(url,args.baseUrl+'/api/chat');assert.equal(options.redirect,'error');
    assert.deepEqual(options.headers,{'Content-Type':'application/json'});
    const body=JSON.parse(options.body);assert.equal(body.model,args.model);assert.equal(body.think,false);assert.equal(body.stream,false);assert.equal(body.tools,undefined);assert.equal(body.format.required[0],'text');
    return response({done:true,message:{content:'{"text":" 歡迎冒險者！ "}'},prompt_eval_count:88,eval_count:9});
  }});
  assert.deepEqual(result,{text:'歡迎冒險者！',usage:{input_tokens:88,output_tokens:9}});
});
test('Ollama rejects unfinished, malformed, tool, and overlong replies and surfaces missing models',async()=>{
  for(const data of [{done:false},{done:true,message:{content:'not JSON'}},{done:true,message:{content:'{"text":"hi"}',tool_calls:[{}]}},{done:true,message:{content:JSON.stringify({text:'字'.repeat(241)})}},{done:true,message:{content:'{"text":"hi","extra":"x"}'}}]) {
    await assert.rejects(generateOllamaChat({...args,fetchImpl:async()=>response(data)}),e=>e.code==='GENERATION_FAILED');
  }
  await assert.rejects(generateOllamaChat({...args,fetchImpl:async()=>new Response('missing',{status:404})}),e=>e.code==='OLLAMA_MODEL_MISSING');
  await assert.rejects(generateOllamaChat({...args,fetchImpl:async()=>{throw new DOMException('timeout','TimeoutError');}}),e=>e.code==='TIMEOUT');
});
