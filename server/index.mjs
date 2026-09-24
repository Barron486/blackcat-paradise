import http from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GameService, ApiError } from './service.mjs';
import { loadCatalog } from './catalog.mjs';
import { databasePath, publicOriginFromEnv } from './config.mjs';
import { itemGrantRules } from './item-rules.mjs';
import { AiChatService } from './ai-chat.mjs';
import { CommerceService } from './commerce.mjs';
import { MarketService } from './market.mjs';
import { WorldSettingsService } from './world-settings.mjs';
import { LootBroadcastService } from './loot-broadcasts.mjs';
import { KillBroadcastService } from './kill-broadcasts.mjs';
import { AuthoritativeGame } from './authoritative-game.mjs';
import { BattleFeed } from './battle-feed.mjs';
import { loadBrowserAssets } from './browser-assets.mjs';
import {gmCharacterReport} from './gm-character.mjs';
import {ServerControl} from './server-control.mjs';

const ROOT = new URL('../', import.meta.url);
const rootPath = path.resolve(fileURLToPath(ROOT));
const browserAssets=loadBrowserAssets(rootPath);
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp',
  '.gif':'image/gif','.svg':'image/svg+xml','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.woff2':'font/woff2'};
const loopback = request => ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress) && !request.headers['x-forwarded-for'] && !request.headers.forwarded;
const escapedJson = value => JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');

export function createApp({ database = databasePath(), catalog = loadCatalog(ROOT), publicOrigin = publicOriginFromEnv(), aiOptions = {}, restartOptions = {}, publicAliases = process.env.RAILWAY_PUBLIC_DOMAIN ? ['https://'+process.env.RAILWAY_PUBLIC_DOMAIN] : [] } = {}) {
  const service = new GameService(database,catalog);
  const aiChat = new AiChatService(service,aiOptions);
  const commerce = new CommerceService(service);
  const market = new MarketService(service,commerce);
  const worldSettings = new WorldSettingsService(service);
  const lootBroadcasts = new LootBroadcastService(service);
  const killBroadcasts = new KillBroadcastService(service);
  const authority = new AuthoritativeGame(service);
  const battleFeed = new BattleFeed(authority,service);
  const serverControl = new ServerControl(service,{...restartOptions,authority,battleFeed});
  let draining=false,shutdownPromise;
  const origins=new Set([publicOrigin,...publicAliases].filter(Boolean).map(value=>{
    const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('公開網址必須是有效的 HTTP(S) origin');return u.origin;
  }));
  const rates = new Map();
  function limit(key,max,period=60000) {
    const now=Date.now(), rate=rates.get(key);
    if(!rate||now-rate.at>period) { rates.set(key,{at:now,n:1}); return; }
    if(++rate.n>max) throw new ApiError(429,'請求過於頻繁，請稍後再試');
  }
  const json=(res,status,value,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value));};
  const cookie=(value,expire=false)=>`idle_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expire?0:604800}${publicOrigin.startsWith('https:')?'; Secure':''}`;
  async function readBody(req) {
    if(!String(req.headers['content-type']||'').startsWith('application/json')) throw new ApiError(415,'需要 JSON 請求');
    const chunks=[]; let size=0;
    for await(const chunk of req) { size+=chunk.length; if(size>36_000_000) throw new ApiError(413,'請求內容過大'); chunks.push(chunk); }
    if(draining)throw new ApiError(503,'伺服器正在保存並重啟，請稍後再試');
    try { const body=JSON.parse(Buffer.concat(chunks).toString()); if(!body||typeof body!=='object'||Array.isArray(body)) throw new Error(); return body; }
    catch { throw new ApiError(400,'JSON 格式不正確'); }
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('X-Frame-Options','SAMEORIGIN');
    let route;
    try {
      if(draining)return json(res,503,{error:'伺服器正在保存並重啟，請稍後再試'},{'Retry-After':'5'});
      // Railway probes use a different Host. This endpoint exposes no account data.
      if (req.url === '/healthz' && ['GET','HEAD'].includes(req.method)) {
        service.db.prepare('SELECT 1').get();
        return json(res,200,{ok:true});
      }
      // Restrict Host as well as Origin to prevent DNS rebinding of the local setup UI.
      const localPort=server.address()?.port;
      const allowed=publicOrigin?[...origins].map(origin=>new URL(origin).host):[`localhost:${localPort}`,`127.0.0.1:${localPort}`,`[::1]:${localPort}`];
      if(!allowed.includes(req.headers.host)) throw new ApiError(403,'不允許的主機名稱，請設定 PUBLIC_ORIGIN');
      const base=publicOrigin?[...origins].find(origin=>new URL(origin).host===req.headers.host):`http://${req.headers.host}`;
      route=new URL(req.url,base).pathname;
      if(!['GET','HEAD','POST'].includes(req.method)) throw new ApiError(405,'不支援的請求方法');
      if(req.method==='POST' && req.headers.origin!==new URL(base).origin) throw new ApiError(403,'跨網站請求已拒絕');
      const session=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('idle_session='))?.slice(13);
      const isSetup=!publicOrigin&&loopback(req)&&!service.hasGm();
      if(route==='/api/auth/config') return json(res,200,{setupAvailable:isSetup,version:catalog.version});
      if(['/api/auth/login','/api/auth/register','/api/auth/setup'].includes(route) && req.method==='POST') {
        limit(`auth:${req.socket.remoteAddress}`,30);
        const body=await readBody(req);
        if(route.endsWith('/setup')) { if(!isSetup) throw new ApiError(403,'首次 GM 設定僅限伺服器本機，且只能執行一次'); await service.register(body.username,body.password,{initialGm:true}); }
        if(route.endsWith('/register')) await service.register(body.username,body.password);
        const result=await service.login(body.username,body.password);
        return json(res,200,{user:result.user,csrf:result.csrf},{'Set-Cookie':cookie(result.session)});
      }
      if(['/api/ai-chat/claim','/api/ai-chat/complete','/api/ai-chat/fail','/api/ai-chat/runtime'].includes(route)&&req.method==='POST'){
        limit(`ai-bridge:${req.socket.remoteAddress}`,120);
        const token=String(req.headers.authorization||'').replace(/^Bearer /,''),body=await readBody(req);
        if(route.endsWith('/claim'))return json(res,200,aiChat.claim(token,body));
        if(route.endsWith('/runtime'))return json(res,200,aiChat.reportLocal(token,body));
        if(route.endsWith('/complete'))return json(res,200,aiChat.complete(token,body));
        return json(res,200,aiChat.fail(token,body));
      }
      let user;
      if(route.startsWith('/api/')||['/','/index.html','/gm'].includes(route)) {
        try { user=service.authenticate(session); }
        catch(error) { if(!route.startsWith('/api/')){res.writeHead(302,{Location:'/login'});return res.end();}throw error; }
      }
      if(route.startsWith('/api/')) {
        if(req.method==='POST' && req.headers['x-csrf-token']!==user.csrf &&
          !(['/api/sync','/api/lease','/api/game'].includes(route)&&service.gameSessionCsrf(user,req.headers['x-csrf-token'])))
          throw new ApiError(403,'請求驗證失敗，請重新整理頁面');
        if(route==='/api/me') return json(res,200,{user:{id:user.id,username:user.username,role:user.role},csrf:user.csrf});
        if(route==='/api/bootstrap') return json(res,200,service.bootstrap(user));
        if(route==='/api/world-settings'&&req.method==='GET') return json(res,200,worldSettings.state());
        if(route==='/api/loot-broadcasts'&&req.method==='GET') {const params=new URL(req.url,base).searchParams,announcement=serverControl.announcement()||worldSettings.state().announcement;return json(res,200,{...lootBroadcasts.list(Number(params.get('after'))),kills:killBroadcasts.list(Number(params.get('afterKills'))),announcement:announcement?.expiresAt>Date.now()?announcement:null});}
        if(route==='/api/auth/logout'&&req.method==='POST') {service.logout(session);return json(res,200,{ok:true},{'Set-Cookie':cookie('',true)});}
        if(route==='/api/lease'&&req.method==='POST') {const b=await readBody(req);return json(res,200,service.acquireLease(user,b.lease,b.takeover===true));}
        if(route==='/api/sync'&&req.method==='POST') {
          const error=new ApiError(403,'遊戲已改由伺服器結算，請重新整理或更新 CLI；不再接受本機存檔上傳',{saveRejected:true,slotKey:'all',code:'SERVER_AUTHORITY_REQUIRED'});
          service.saveGuard.record(user,error);throw error;
        }
        if(route==='/api/game'&&req.method==='POST') {limit(`game:${user.id}`,180);const body=await readBody(req);if(body.op&&body.op!=='state')limit(`game-action:${user.id}`,60);return json(res,200,authority.handle(user,body));}
        if(route==='/api/game/battle'&&req.method==='GET') {
          limit(`battle-feed:${user.id}`,30);
          if(req.headers.origin&&req.headers.origin!==new URL(base).origin)throw new ApiError(403,'跨網站請求已拒絕');
          const query=new URL(req.url,base).searchParams;
          return battleFeed.open({user,session,lease:query.get('lease'),after:query.get('after'),req,res});
        }
        if(route==='/api/world') return json(res,200,{online:service.onlineSummary(user).list,messages:service.publicMessages(user),lootBroadcasts:lootBroadcasts.history(),killBroadcasts:killBroadcasts.history()});
        if(route==='/api/online'&&req.method==='GET') return json(res,200,service.onlineSummary(user));
        if(route==='/api/gm/location-clans'&&req.method==='POST') {const b=await readBody(req);return json(res,200,service.presence.assign(user,b));}
        if(route==='/api/clans'&&req.method==='GET') return json(res,200,{clans:service.clans(user)});
        if(route==='/api/clans'&&req.method==='POST') {const b=await readBody(req);return json(res,201,service.createClan(user,b.name));}
        if(route==='/api/clans/join'&&req.method==='POST') {const b=await readBody(req);return json(res,200,service.joinClan(user,b.clanId));}
        if(route==='/api/chat'&&req.method==='POST') {const b=await readBody(req);return json(res,200,service.chat(user,b.text));}
        if(route==='/api/shop'&&req.method==='GET')return json(res,200,commerce.state(user));
        if(route==='/api/character-report'&&req.method==='GET'){
          const slot=Number(new URL(req.url,base).searchParams.get('slot'));
          if(!Number.isInteger(slot)||slot<1||slot>8)throw new ApiError(400,'角色欄位不正確');
          const raw=service.bootstrap(user).values['lineage_idle_save_'+slot];
          if(!raw)throw new ApiError(404,'此欄位沒有角色');
          const p=catalog.unwrap(raw).p;
          return json(res,200,{format:'black-cat-character-report',readOnly:true,exportedAt:new Date().toISOString(),account:user.username,character:{slot,name:p.name||'未命名',classId:p.cls,level:p.lv,exp:p.exp,gold:p.gold,stats:p.base,equipment:p.eq,inventory:p.inv},notice:'此檔案僅供檢視角色資訊，無法匯入遊戲。'});
        }
        if(route==='/api/market'&&req.method==='GET')return json(res,200,market.view(user,new URL(req.url,base).searchParams));
        if(['/api/market/list','/api/market/buy','/api/market/cancel','/api/market/claim-gold'].includes(route)&&req.method==='POST'){
          limit(`market:${user.id}`,30);return json(res,200,market.transact(user,route.split('/').at(-1),await readBody(req)));
        }
        if(['/api/shop/buy','/api/shop/rename','/api/shop/password'].includes(route)&&req.method==='POST'){
          limit(`shop:${user.id}`,30);const b=await readBody(req);
          if(route.endsWith('/buy'))return json(res,200,commerce.buy(user,b));
          if(route.endsWith('/rename'))return json(res,200,commerce.rename(user,b));
          const result=await commerce.password(user,b);return json(res,200,result,{'Set-Cookie':cookie('',true)});
        }
        if(route.startsWith('/api/gm/')) {
          service.gm(user);
          if(route==='/api/gm/server'&&req.method==='GET')return json(res,200,serverControl.status(user));
          if(route==='/api/gm/character'&&req.method==='GET'){
            limit(`gm-inspect:${user.id}`,60);const params=new URL(req.url,base).searchParams;
            return json(res,200,gmCharacterReport(service,user,params.get('accountId'),Number(params.get('slot'))));
          }
          if(route==='/api/gm/world-settings'&&req.method==='GET')return json(res,200,worldSettings.admin(user));
          if(route==='/api/gm/drops'&&req.method==='GET')return json(res,200,worldSettings.listDrops(user,new URL(req.url,base).searchParams));
          if(route==='/api/gm/monsters'&&req.method==='GET')return json(res,200,worldSettings.monsters.list(user,new URL(req.url,base).searchParams));
          if(route==='/api/gm/diamonds'&&req.method==='GET')return json(res,200,commerce.admin(user,new URL(req.url,base).searchParams.get('accountId')));
          if(route==='/api/gm/ai-chat'&&req.method==='GET')return json(res,200,aiChat.status(user));
          if(route==='/api/gm/players') return json(res,200,{players:service.players(user)});
          if(route==='/api/gm/audit') return json(res,200,{entries:service.audit(user)});
          if(route==='/api/gm/save-security') return json(res,200,{entries:service.saveGuard.history(user)});
          if(route==='/api/gm/catalog') {
            const params=new URL(req.url,base).searchParams,q=(params.get('q')||'').toLowerCase().slice(0,80),type=params.get('type');
            const items=Object.entries(catalog.items).filter(([id,item])=>(!q||(id+' '+item.n).toLowerCase().includes(q))&&(!type||item.type===type));
            return json(res,200,{total:items.length,items:items.slice(0,100).map(([id,i])=>({id,name:i.n,type:i.type,description:i.d||'',maxHold:i.maxHold||null,...itemGrantRules(i),legend:!!i.legend}))});
          }
          if(req.method==='POST') {
            limit(`gm:${user.id}`,60);
            const b=await readBody(req);
            if(route==='/api/gm/server/restart')return json(res,202,serverControl.request(user,b));
            if(route==='/api/gm/world-settings')return json(res,200,worldSettings.update(user,b));
            if(route==='/api/gm/diamonds')return json(res,200,commerce.grant(user,b));
            if(route==='/api/gm/ai-chat/settings')return json(res,200,aiChat.update(user,b));
            if(route==='/api/gm/ai-chat/request')return json(res,200,aiChat.request(user));
            if(route==='/api/gm/ai-chat/bridge-token')return json(res,200,aiChat.rotateToken(user));
            if(route==='/api/gm/preview') return json(res,200,service.preview(user,b));
            if(route==='/api/gm/execute') return json(res,200,service.execute(user,b));
            if(route==='/api/gm/role') return json(res,200,service.setRole(user,b.accountId,b.role));
          }
        }
        throw new ApiError(404,'找不到 API');
      }
      if(req.method==='POST') throw new ApiError(405,'不支援的請求方法');
      if(route==='/'||route==='/index.html') {
        const boot=service.bootstrap(user);
        const html=readFileSync(new URL('index.html',ROOT),'utf8').replace('</head>',
          `<script id="cloud-boot" type="application/json">${escapedJson(boot)}</script><script src="/online/bootstrap.js"></script><link rel="stylesheet" href="/online/cloud.css"><link rel="stylesheet" href="/online/mobile.css"><link rel="stylesheet" href="/online/squad-window.css"><link rel="stylesheet" href="/online/loot-ticker.css"></head>`)
          .replace('</body>','<script type="module" src="/online/authoritative.js?v=battle-feed-20260919"></script><script type="module" src="/online/mobile.js"></script><script type="module" src="/online/shop.js"></script><script type="module" src="/online/market.js"></script><script type="module" src="/online/pandora-market.js"></script></body>');
        res.writeHead(200,{'Content-Type':MIME['.html'],'Cache-Control':'no-store'});return res.end(req.method==='HEAD'?undefined:browserAssets.html(html));
      }
      if(route==='/gm') service.gm(user);
      if(route==='/login'||route==='/setup') route='/online/login.html';
      if(route==='/gm') route='/online/gm.html';
      let decoded;try{decoded=decodeURIComponent(route);}catch{throw new ApiError(400,'網址格式不正確');}
      if(!/^\/(assets|public\/assets|css|js|online|shared)\//.test(decoded)||decoded.includes('..')||decoded.includes('\\')||decoded.includes('\0')) throw new ApiError(404,'找不到檔案');
      const filename=path.resolve(rootPath,'.'+decoded);
      if(!filename.startsWith(rootPath+path.sep)) throw new ApiError(404,'找不到檔案');
      let stat;try{stat=statSync(filename);}catch{throw new ApiError(404,'找不到檔案');}
      if(!stat.isFile())throw new ApiError(404,'找不到檔案');
      if(filename.endsWith('.html')){
        const html=browserAssets.html(readFileSync(filename,'utf8'));
        res.writeHead(200,{'Content-Type':MIME['.html'],'Cache-Control':'no-store'});return res.end(req.method==='HEAD'?undefined:html);
      }
      const headers={'Content-Type':MIME[path.extname(filename).toLowerCase()]||'application/octet-stream','Cache-Control':/\.(js|css|html)$/.test(filename)?'no-cache':'public, max-age=86400','Accept-Ranges':'bytes'};
      let start=0,end=stat.size-1,status=200;
      if(req.headers.range) {
        const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if(!match)throw new ApiError(416,'範圍不正確');
        start=Number(match[1]);end=match[2]?Number(match[2]):end;
        if(start>end||end>=stat.size)throw new ApiError(416,'範圍不正確');
        status=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
      }
      headers['Content-Length']=end-start+1;res.writeHead(status,headers);
      if(req.method==='HEAD')return res.end();
      createReadStream(filename,{start,end}).on('error',()=>res.destroy()).pipe(res);
    } catch(error) {
      const status=error instanceof ApiError?error.status:500;
      if(status===500)console.error('[request]',route,error);
      if(!res.headersSent) json(res,status,{error:status===500?'伺服器暫時無法完成請求':error.message,...(error.details||{})});
      else res.destroy();
    }
  });
  const cleanup=setInterval(()=>{const now=Date.now();for(const [key,rate]of rates)if(now-rate.at>120000)rates.delete(key);},60000);cleanup.unref();
  server.on('listening',()=>aiChat.start());
  const closeServer=server.close.bind(server);
  server.close=(...args)=>{battleFeed.close();return closeServer(...args);};
  server.on('close',()=>{serverControl.close();battleFeed.close();aiChat.stop();clearInterval(cleanup);authority.close();service.close();});
  function shutdown(){
    if(shutdownPromise)return shutdownPromise;
    draining=true;
    let saved;
    try{saved=authority.checkpointAll();}
    catch(error){draining=false;return Promise.reject(error);}
    aiChat.stop();
    shutdownPromise=new Promise(resolve=>{
      const deadline=setTimeout(()=>server.closeAllConnections(),5000);deadline.unref();
      server.close(()=>{clearTimeout(deadline);resolve({saved});});
    });
    return shutdownPromise;
  }
  return {server,service,aiChat,commerce,market,worldSettings,authority,serverControl,shutdown};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const host=process.env.HOST||(process.env.RAILWAY_ENVIRONMENT_ID?'0.0.0.0':'127.0.0.1'),port=Number(process.env.PORT||8787);
  const origin=publicOriginFromEnv();
  if(!['127.0.0.1','localhost','::1'].includes(host)&&!origin)throw new Error('對外監聽必須設定 PUBLIC_ORIGIN，或先產生 Railway 公開網址');
  const supervised=process.env.BLACKCAT_SUPERVISED==='1'&&typeof process.send==='function';
  const app=createApp({restartOptions:{restart:supervised?async()=>{await app.shutdown();process.exit(75);}:undefined}});
  const {server,service}=app;
  server.listen(port,host,()=>{const url=origin||`http://localhost:${port}`;console.log(`黑貓天堂 ${service.catalog.version} + GM\n遊戲：${url}\nGM 管理台：${url}/gm`);if(!service.hasGm())console.log(origin?'尚未建立 GM：註冊帳號後，在伺服器終端執行 node server/promote-gm.mjs 帳號':`首次 GM 設定：${url}/setup`);});
  const stop=()=>app.shutdown().then(()=>process.exit(0)).catch(error=>{console.error('[shutdown]',error.message);server.close(()=>process.exit(1));});
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  if(supervised)process.on('message',message=>{if(message==='shutdown')void stop();});
}
