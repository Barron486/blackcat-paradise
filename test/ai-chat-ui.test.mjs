import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { JSDOM } = createRequire(new URL('../cli/package.json', import.meta.url))('jsdom');

const fixture = { settings: { enabled: false, provider: 'codex', model: 'gpt-5.6-luna', topic: 'casual', customPrompt: '', intervalSeconds: 90, dailyMessageLimit: 120, respondToPlayers: true, speakers: ['a1'], revision: 7 }, runtime: { bridgeOnline: true, busy: false, todayCount: 2, lastError: '', lastMessageAt: null }, options: { providers: [{ id: 'codex', name: 'Codex', model: 'gpt-5.6-luna' }], topics: [{ id: 'casual', name: '日常' }, { id: 'custom', name: '自訂' }], speakers: [{ id: 'a1', username: 'cat', name: '黑貓', cls: '法師' }] }, recent: [{ id: 'r1', username: 'cat', text: '<b>安全文字</b>', at: null }] };
const activeDoms = [];
test.afterEach(() => { activeDoms.splice(0).forEach(dom => dom.window.close()); });

async function setup(data = fixture) {
  const dom = new JSDOM('<!doctype html><body><section id="view-ai-chat"></section><div id="notice"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/online/gm.html' });
  const calls = [];
  const api = async (path, body) => { calls.push({ path, body }); if (path.endsWith('/settings')) return { ...data, settings: { ...data.settings, ...body, revision: 8 } }; return structuredClone(data); };
  const code = await readFile(new URL('../online/ai-chat.js', import.meta.url), 'utf8');
  dom.window.eval(code); dom.window.initAiChat({ api, notify: () => {} });
  dom.window.document.dispatchEvent(new dom.window.CustomEvent('gm:view-change', { detail: { view: 'ai-chat' } }));
  await new Promise(resolve => setTimeout(resolve, 0));
  activeDoms.push(dom);
  return { dom, calls };
}

test('AI UI loads and renders AI text as textContent', async () => {
  const { dom, calls } = await setup();
  assert.equal(calls[0].path, '/api/gm/ai-chat');
  assert.equal(dom.window.document.querySelector('.ai-chat-main h2').textContent, 'AI 世界聊天');
  const message = dom.window.document.querySelector('.ai-recent-entry p');
  assert.equal(message.textContent, '<b>安全文字</b>');
  assert.equal(message.querySelector('b'), null);
});

test('dirty form is preserved, reload asks before discard, and request is blocked', async () => {
  const { dom, calls } = await setup();
  const interval = dom.window.document.getElementById('ai-interval'); interval.value = '120'; interval.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  let requested = false; dom.window.confirm = () => { requested = true; return false; };
  dom.window.document.getElementById('ai-reload').click(); dom.window.document.getElementById('ai-request').click();
  assert.equal(requested, true); assert.equal(interval.value, '120'); assert.equal(calls.some(c => c.path.endsWith('/request')), false);
});

test('save sends the current revision and clears dirty state', async () => {
  const { dom, calls } = await setup();
  const custom = dom.window.document.getElementById('ai-custom'); custom.value = '新的提示'; custom.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(dom.window.document.getElementById('ai-custom-count').textContent, '4 / 2000');
  dom.window.document.getElementById('ai-save').click(); await new Promise(resolve => setTimeout(resolve, 0));
  const save = calls.find(c => c.path.endsWith('/settings')); assert.equal(save.body.revision, 7); assert.equal(save.body.customPrompt, '新的提示'); assert.equal(dom.window.document.getElementById('ai-save-state').textContent, '');
});

test('unlimited daily generation renders clearly and round-trips zero', async () => {
  const {dom,calls}=await setup({...fixture,settings:{...fixture.settings,enabled:true,dailyMessageLimit:0},runtime:{...fixture.runtime,todayAttempts:2500,todayCount:2500}});
  const doc=dom.window.document;
  assert.equal(doc.getElementById('ai-limit').value,'0');
  assert.match(doc.getElementById('ai-today').textContent,/每日生成上限：不限/);
  assert.equal(doc.getElementById('ai-status').textContent,'AI 已啟用');
  doc.getElementById('ai-save').click();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(calls.find(c=>c.path.endsWith('/settings')).body.dailyMessageLimit,0);
});

test('GM Ollama settings show installed models and save edited endpoint and model',async()=>{
  const {dom,calls}=await setup({...fixture,settings:{...fixture.settings,provider:'ollama',ollamaUrl:'http://127.0.0.1:11434',ollamaModel:'qwen3:8b'},options:{...fixture.options,providers:[{id:'ollama',name:'本機 Ollama',model:'qwen3:8b'}]},local:{online:true,ready:true,models:['qwen3:8b','gemma3:4b']}});
  const doc=dom.window.document;
  assert.equal(doc.getElementById('ai-ollama-wrap').hidden,false);
  assert.match(doc.getElementById('ai-ollama-state').textContent,/指定模型已就緒/);
  assert.equal(doc.querySelectorAll('#ai-ollama-models option').length,2);
  doc.getElementById('ai-ollama-url').value='http://localhost:11435';doc.getElementById('ai-ollama-model').value='gemma3:4b';
  doc.getElementById('ai-save').click();await new Promise(r=>setTimeout(r,0));
  const save=calls.find(c=>c.path.endsWith('/settings')).body;
  assert.equal(save.ollamaUrl,'http://localhost:11435');assert.equal(save.ollamaModel,'gemma3:4b');assert.equal(save.provider,'ollama');
});

test('six selected speakers and individual personalities survive save and dirty refresh',async()=>{
  const speakers=Array.from({length:6},(_,i)=>({id:`s${i}`,name:`角色${i}`,username:`account${i}`,cls:'mage',defaultPersonality:'好奇、簡短、有點冷幽默。'}));
  const data={...fixture,settings:{...fixture.settings,speakers:speakers.slice(0,4).map(p=>p.id),personas:{s0:'原本個性'},ambientChat:false},options:{...fixture.options,speakers}};
  const {dom,calls}=await setup(data),doc=dom.window.document;
  for(const input of doc.querySelectorAll('#ai-speakers input')){if(!input.checked)input.click();}
  assert.equal(doc.querySelectorAll('#ai-speakers input:checked').length,6);
  assert.equal(doc.getElementById('ai-speaker-count').textContent,'已選 6 位角色');
  const persona=doc.querySelector('textarea[data-speaker="s4"]');assert.equal(persona.parentElement.hidden,false);
  persona.value='慢熟，喜歡聽人講故事';persona.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  doc.dispatchEvent(new dom.window.CustomEvent('gm:view-change',{detail:{view:'ai-chat'}}));await new Promise(r=>setTimeout(r,0));
  assert.equal(doc.querySelector('textarea[data-speaker="s4"]').value,'慢熟，喜歡聽人講故事');
  doc.getElementById('ai-save').click();await new Promise(r=>setTimeout(r,0));
  const saved=calls.find(c=>c.path.endsWith('/settings')).body;
  assert.deepEqual([...saved.speakers],speakers.map(p=>p.id));assert.equal(saved.personas.s4,'慢熟，喜歡聽人講故事');assert.equal(saved.personas.s0,'原本個性');assert.equal(saved.ambientChat,false);
  assert.equal(doc.querySelectorAll('#ai-speakers input:checked').length,6);
  assert.equal(doc.querySelector('textarea[data-speaker="s4"]').value,'慢熟，喜歡聽人講故事');
});
