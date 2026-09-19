import {normalizeOllamaUrl,validateOllamaModel} from '../shared/ollama-config.js';
const failure=code=>Object.assign(new Error('本機模型無法產生聊天'),{code});
const knownFailure=error=>['GENERATION_FAILED','OLLAMA_MODEL_MISSING','OLLAMA_UNAVAILABLE','TIMEOUT'].includes(error?.code);
function messagesForPrompt(prompt){
  const at=prompt.lastIndexOf('\n');
  if(at>0){
    const context=prompt.slice(at+1);
    try{
      const data=JSON.parse(context);
      if(data.character&&Array.isArray(data.recent)&&Object.hasOwn(data,'replyTo'))return [{role:'system',content:prompt.slice(0,at)},{role:'user',content:context}];
    }catch{}
  }
  return [{role:'user',content:prompt}];
}
async function readJson(response){
  if(!response.ok){await response.body?.cancel();throw failure(response.status===404?'OLLAMA_MODEL_MISSING':'OLLAMA_UNAVAILABLE');}
  const reader=response.body.getReader();let size=0;const parts=[];
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>512000)throw failure('GENERATION_FAILED');parts.push(value);}}finally{await reader.cancel().catch(()=>{});}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw failure('GENERATION_FAILED');}
}
export async function listOllamaModels({baseUrl,fetchImpl=fetch,signal}={}){
  const base=normalizeOllamaUrl(baseUrl);
  try{
    const data=await readJson(await fetchImpl(base+'/api/tags',{redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])])}));
    return (data.models||[]).filter(m=>!m.remote_host&&!m.remote_model).flatMap(m=>{try{return [{name:validateOllamaModel(m.name),size:Number(m.size)||0}];}catch{return [];}}).slice(0,100);
  }catch(error){throw knownFailure(error)?error:failure('OLLAMA_UNAVAILABLE');}
}
export async function generateOllamaChat({prompt,model,baseUrl,signal,fetchImpl=fetch,timeoutMs=150000}={}){
  const base=normalizeOllamaUrl(baseUrl);validateOllamaModel(model);
  if(typeof prompt!=='string'||!prompt.trim())throw failure('GENERATION_FAILED');
  try{
    const data=await readJson(await fetchImpl(base+'/api/chat',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},signal:AbortSignal.any([AbortSignal.timeout(Math.min(150000,Math.max(1,timeoutMs))),...(signal?[signal]:[])]),body:JSON.stringify({model,messages:messagesForPrompt(prompt),stream:false,think:false,format:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},options:{num_predict:256,temperature:0.65},keep_alive:'5m'})}));
    if(data.done!==true||data.message?.tool_calls?.length)throw failure('GENERATION_FAILED');
    let value;try{value=JSON.parse(data.message?.content||'');}catch{throw failure('GENERATION_FAILED');}
    if(typeof value?.text!=='string'||value.text.length>240||Object.keys(value).some(k=>k!=='text'))throw failure('GENERATION_FAILED');
    return {text:value.text.trim(),usage:{input_tokens:data.prompt_eval_count||0,output_tokens:data.eval_count||0}};
  }catch(error){throw knownFailure(error)?error:failure(signal?.aborted||error.name==='TimeoutError'||error.name==='AbortError'?'TIMEOUT':'OLLAMA_UNAVAILABLE');}
}
