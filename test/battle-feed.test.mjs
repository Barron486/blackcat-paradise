import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {createApp} from '../server/index.mjs';
import {CloudClient} from '../cli/cloud-client.mjs';
import {HeadlessGame as BrowserGame} from '../cli/engine.mjs';
import {BattleTimeline} from '../online/battle-timeline.js';

const source=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8').replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');
test('authenticated compressed frames continue during a slow save response and stop when the session is revoked',async t=>{
  const app=createApp({database:':memory:',publicOrigin:'',publicAliases:[]});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const abort=new AbortController();t.after(async()=>{abort.abort();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
  const url=`http://127.0.0.1:${app.server.address().port}`,client=new CloudClient({baseUrl:url});
  await client.register('feed_test','local-battle-feed-test!');const lease=randomUUID();await client.acquireLease(lease);
  const initial=await client.game({op:'create',slot:1,lease,revision:0,requestId:randomUUID(),args:{classId:'knight',name:'連線測試',allocation:{str:2,con:6}}});
  const headers={Cookie:client.exportSession().cookie,'Accept-Encoding':'gzip'};
  assert.equal((await fetch(url+'/api/game/battle?lease='+lease)).status,401);
  assert.equal((await fetch(url+'/api/game/battle?lease='+randomUUID(),{headers})).status,423);
  assert.equal((await fetch(url+'/api/game/battle?lease='+lease,{headers:{...headers,Origin:'https://untrusted.example'}})).status,403);
  const response=await fetch(url+'/api/game/battle?lease='+lease,{headers,signal:abort.signal});
  assert.equal(response.status,200);assert.equal(response.headers.get('content-encoding'),'gzip');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  async function next(type){
    while(true){
      const index=buffer.indexOf('\n\n');
      if(index>=0){const block=buffer.slice(0,index);buffer=buffer.slice(index+2);if(block.includes('event: '+type))return JSON.parse(block.split('\n').find(l=>l.startsWith('data: ')).slice(6));continue;}
      const chunk=await reader.read();if(chunk.done)throw new Error('Stream ended early');buffer+=decoder.decode(chunk.value,{stream:true});
    }
  }
  const seed=await next('battle');assert.equal(seed.epoch,initial.game.epoch);assert.equal(seed.slot,1);assert.ok(!seed.snapshot);
  // Reproduce a slow, large account snapshot without slowing the separate battle stream.
  app.server.prependListener('request',(req,res)=>{if(req.url==='/api/game'){const end=res.end.bind(res);res.end=(...args)=>{setTimeout(()=>end(...args),4000);return res;};}});
  let saveFinished=false;const slow=client.game({op:'state',lease,args:{}}).then(r=>{saveFinished=true;return r;});
  const a=await next('battle'),b=await next('battle');assert.ok(b.battle.seq>a.battle.seq);assert.equal(saveFinished,false);
  assert.ok(b.battle.frames.every(f=>!f.player.inv));await slow;
  await client.logout();assert.equal((await next('denied')).status,401);
});

test('browser stream ignores stale characters and reports health only after a valid frame',()=>{
  const dom=new JSDOM('',{runScripts:'outside-only'}),w=dom.window,streams=[];let time=0;
  w.EventSource=class {constructor(url){this.url=url;this.events={};streams.push(this);}addEventListener(name,fn){this.events[name]=fn;}close(){this.closed=true;}};
  w.eval(source('online/battle-feed.js'));
  const received=[],denied=[],feed=w.startBattleFeed({lease:'test-lease'},{now:()=>time,cursor:()=>({stream:'s1',seq:8}),receive:p=>received.push(p),onDenied:e=>denied.push(e.status)});
  feed.open({slot:1,epoch:'role-1'});feed.open({slot:1,epoch:'role-1'});assert.equal(streams.length,1);assert.equal(feed.healthy(),false);
  streams[0].events.battle({data:JSON.stringify({slot:1,epoch:'old-role',battle:{seq:9}})});assert.equal(received.length,0);
  streams[0].events.battle({data:JSON.stringify({slot:1,epoch:'role-1',battle:{seq:9}})});assert.equal(feed.healthy(),true);
  time=4000;assert.equal(feed.healthy(),false);
  feed.open({slot:2,epoch:'role-2'});assert.equal(streams[0].closed,true);
  streams[1].events.denied({data:JSON.stringify({status:423,error:'接管'})});assert.deepEqual(denied,[423]);assert.equal(streams[1].closed,true);dom.window.close();
});

test('real damage renderer shows the first hit on a newly spawned monster exactly once',()=>{
  const game=new BrowserGame();try{
    game.create({classId:'knight',name:'飄字測試',allocation:{str:2,con:6}});game.action('travel',{mapId:'training'});game.run('spawnMob(0);');
    const mob=JSON.parse(game.run('JSON.stringify(mapState.mobs[0])')),w=game.window;let time=0;
    w.BattleTimeline=BattleTimeline;
    w.HTMLElement.prototype.getBoundingClientRect=()=>({left:20,top:20,width:100,height:100,right:120,bottom:120});
    game.run('renderMobs=()=>_renderMobsImpl();window.__vfxOff=true;window.__vfxNumOff=false;');
    w.eval(source('online/battle-playback.js'));const playback=w.startBattlePlayback({now:()=>time});
    const frame=(seq,mobs)=>({seq,tick:seq,map:'training',player:{hp:100,allies:[]},mobs,events:[]});
    playback.receive({stream:'damage',frames:[frame(0,[null])]});
    time=100;playback.receive({stream:'damage',frames:[frame(1,[{...mob,hp:100,curHp:75,justHit:true}])]});
    assert.deepEqual([...w.document.querySelectorAll('.vfx-dmg')].map(e=>e.textContent),['25']);
    time=200;playback.receive({stream:'damage',frames:[frame(2,[{...mob,hp:100,curHp:75}])]});
    assert.equal(w.document.querySelectorAll('.vfx-dmg').length,1);
  }finally{game.close();}
});
