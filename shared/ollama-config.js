export const DEFAULT_OLLAMA_URL='http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_MODEL='qwen3:8b';
export function normalizeOllamaUrl(value=DEFAULT_OLLAMA_URL){
  let url;try{url=new URL(value);}catch{throw new Error('Ollama 網址格式不正確');}
  if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Ollama 請填本機網址，例如 http://127.0.0.1:11434');
  return url.origin;
}
export function validateOllamaModel(value){
  if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(value)||/(?:^|[-:])cloud(?:$|[:_-])/i.test(value))throw new Error('請指定已安裝的本機 Ollama 模型名稱');
  return value;
}
