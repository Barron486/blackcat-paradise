import {randomUUID} from 'node:crypto';
import {ApiError} from './service.mjs';
import {applyMarketEffect} from '../shared/market-effects.js';
const check=(ok,message,status=400)=>{if(!ok)throw new ApiError(status,message);};
const MAX=2_000_000_000;
export const marketFee=price=>Math.ceil(price/5);

export class MarketService {
  constructor(service,commerce){
    this.service=service;this.commerce=commerce;this.db=service.db;service.market=this;
    this.db.exec(`CREATE TABLE IF NOT EXISTS market_listings(
      id TEXT PRIMARY KEY,seller_id TEXT NOT NULL REFERENCES accounts(id),seller_name TEXT NOT NULL,
      item TEXT NOT NULL,currency TEXT NOT NULL CHECK(currency IN ('diamonds','gold')),price INTEGER NOT NULL CHECK(price>0),
      status TEXT NOT NULL CHECK(status IN ('active','sold','cancelled')),buyer_id TEXT REFERENCES accounts(id),created_at INTEGER NOT NULL,closed_at INTEGER);
      CREATE INDEX IF NOT EXISTS market_active ON market_listings(status,created_at);
      CREATE TABLE IF NOT EXISTS market_gold(account_id TEXT PRIMARY KEY REFERENCES accounts(id),balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0));
      CREATE TABLE IF NOT EXISTS market_events(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT NOT NULL REFERENCES accounts(id),
      listing_id TEXT,kind TEXT NOT NULL,currency TEXT,price INTEGER NOT NULL DEFAULT 0,fee INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);`);
  }
  character(user,body){
    this.service.checkLease(user,body.lease);
    const snapshot=this.service.bootstrap(user);
    if(body.revision!==snapshot.revision)throw new ApiError(409,'存檔已更新，請重新整理交易所',{snapshot,effects:this.service.effects(user,Number.isSafeInteger(body.revision)?body.revision:0)});
    check(Number.isInteger(body.slot)&&body.slot>=1&&body.slot<=8,'請先進入角色');
    const key='lineage_idle_save_'+body.slot,raw=snapshot.values[key];check(raw,'角色不存在',404);
    const doc=this.service.catalog.unwrap(raw);check((doc.p._roleEpoch||doc.p.enSeed)===body.epoch,'角色已變更，請重新開啟交易所',409);
    check(!doc.p.dead,'請先復活再交易',409);
    check(Number.isSafeInteger(doc.p.gold)&&doc.p.gold>=0,'角色金幣資料不正確',409);
    return {snapshot,key,doc};
  }
  tradable(p,item){
    const d=this.service.catalog.items[item?.id];
    return !!d && typeof item.uid==='string' && Number.isSafeInteger(item.cnt)&&item.cnt>0 &&
      !item.lock&&!item.bound&&!d.bound&&!d.noTrade&&!d.quest&&d.type!=='quest' &&
      !Object.values(p.eq||{}).some(i=>i?.uid===item.uid);
  }
  describe(item){
    const d=this.service.catalog.items[item.id]||{};
    return {item,name:d.n||item.id,description:d.d||'',type:d.type||'',icon:d.icon||''};
  }
  view(user,params=new URLSearchParams()){
    const q=(params.get('q')||'').trim().slice(0,80).toLowerCase(),currency=params.get('currency');
    const page=Math.max(1,Math.min(10000,Number(params.get('page'))||1));
    const rows=this.db.prepare("SELECT * FROM market_listings WHERE status='active' ORDER BY created_at DESC,id").all();
    const describe=row=>({id:row.id,...this.describe(JSON.parse(row.item)),seller:row.seller_name,own:row.seller_id===user.id,currency:row.currency,price:row.price,fee:marketFee(row.price),net:row.price-marketFee(row.price),status:row.status,at:row.created_at});
    const offers=rows.map(describe).filter(r=>(!q||(r.name+' '+r.seller).toLowerCase().includes(q))&&(!currency||r.currency===currency));
    const snapshot=this.service.bootstrap(user),characters=[];
    for(const [key,raw]of Object.entries(snapshot.values))if(/^lineage_idle_save_[1-8]$/.test(key)){
      const p=this.service.catalog.unwrap(raw).p;
      characters.push({slot:Number(key.slice(-1)),epoch:p._roleEpoch||p.enSeed,name:p.name||'未命名',gold:p.gold,
        items:p.inv.filter(i=>this.tradable(p,i)).map(i=>this.describe(i))});
    }
    return {offers:offers.slice((page-1)*30,page*30),total:offers.length,page,
      mine:this.db.prepare('SELECT * FROM market_listings WHERE seller_id=? ORDER BY created_at DESC LIMIT 100').all(user.id).map(describe),
      wallet:this.commerce.wallet(user.id),goldProceeds:this.gold(user.id),characters,feePercent:20};
  }
  gold(id){return this.db.prepare('SELECT balance FROM market_gold WHERE account_id=?').get(id)?.balance||0;}
  event(user,kind,row,fee=0){return Number(this.db.prepare('INSERT INTO market_events(actor_id,listing_id,kind,currency,price,fee,created_at) VALUES(?,?,?,?,?,?,?)').run(user.id,row?.id||null,kind,row?.currency||null,row?.price||0,fee,Date.now()).lastInsertRowid);}
  effect(user,ctx,seq,changes){
    const effect={action:'market',seq,epoch:ctx.doc.p._roleEpoch||ctx.doc.p.enSeed,...changes};
    check(applyMarketEffect(ctx.doc,effect),'角色交易序號不正確，已取消交易',409);
    const {snapshot,key}=ctx;snapshot.values[key]=this.service.catalog.wrap(ctx.doc);
    this.db.prepare('UPDATE saves SET data=?,revision=revision+1,updated_at=? WHERE account_id=?').run(JSON.stringify(snapshot.values),Date.now(),user.id);
    this.db.prepare('INSERT INTO gm_effects(account_id,revision,save_key,payload) VALUES(?,?,?,?)').run(user.id,snapshot.revision+1,key,JSON.stringify(effect));
  }
  capacity(p,item){
    check(p.inv.length<20000,'背包已滿，請整理後再交易',409);
    const max=this.service.catalog.items[item.id]?.maxHold;
    const held=p.inv.filter(i=>i.id===item.id).reduce((n,i)=>n+i.cnt,0)+Object.values(p.eq||{}).filter(i=>i?.id===item.id).reduce((n,i)=>n+(i.cnt||1),0);
    check(!max||held+item.cnt<=max,'此物品超過角色持有上限',409);
  }
  transact(user,action,body){
    check(['list','buy','cancel','claim-gold'].includes(action),'不支援的交易');
    const payload={kind:'market:'+action,slot:body.slot,epoch:body.epoch};
    if(action==='list')Object.assign(payload,{uid:body.uid,quantity:body.quantity,currency:body.currency,price:body.price});
    if(action==='buy'||action==='cancel')payload.listingId=body.listingId;
    const result=this.commerce.operation(user,body.requestId,payload,()=>{
      const ctx=this.character(user,body),p=ctx.doc.p;
      if(action==='list'){
        check(['diamonds','gold'].includes(body.currency),'請選擇藍鑽或金幣');
        check(Number.isSafeInteger(body.price)&&body.price>=1&&body.price<=MAX,'整組售價須為 1～2,000,000,000');
        check(Number.isSafeInteger(body.quantity)&&body.quantity>0,'數量須為正整數');
        const matches=p.inv.filter(i=>i.uid===body.uid),item=matches[0];
        check(matches.length===1&&this.tradable(p,item),'物品不存在、已裝備或已鎖定；請先卸下並解鎖',409);
        check(body.quantity<=item.cnt,'持有數量不足',409);
        check(this.db.prepare("SELECT COUNT(*) AS n FROM market_listings WHERE seller_id=? AND status='active'").get(user.id).n<100,'每個帳號最多同時上架 100 筆',409);
        const row={id:randomUUID(),currency:body.currency,price:body.price};
        const escrow={...structuredClone(item),uid:randomUUID(),cnt:body.quantity,lock:true,junk:false};
        this.db.prepare("INSERT INTO market_listings VALUES(?,?,?,?,?,?,'active',NULL,?,NULL)").run(row.id,user.id,p.name||user.username,JSON.stringify(escrow),row.currency,row.price,Date.now());
        this.effect(user,ctx,this.event(user,'list',row),{remove:{uid:item.uid,quantity:body.quantity}});
        return {ok:true,listingId:row.id,message:'已上架，物品由交易所保管'};
      }
      if(action==='claim-gold'){
        const amount=this.gold(user.id);check(amount>0,'沒有待領取金幣',409);
        check(Number.isSafeInteger(p.gold+amount),'金幣超過安全範圍',409);
        this.db.prepare('UPDATE market_gold SET balance=0 WHERE account_id=?').run(user.id);
        this.effect(user,ctx,this.event(user,'claim-gold',{currency:'gold',price:amount}),{gold:amount});
        return {ok:true,message:`已領取 ${amount.toLocaleString()} 金幣`};
      }
      check(typeof body.listingId==='string','請選擇商品');
      const row=this.db.prepare('SELECT * FROM market_listings WHERE id=?').get(body.listingId);
      check(row&&row.status==='active','商品已成交或已下架',409);
      const item=JSON.parse(row.item);this.capacity(p,item);
      if(action==='cancel'){
        check(row.seller_id===user.id,'只能下架自己的商品',403);
        this.db.prepare("UPDATE market_listings SET status='cancelled',closed_at=? WHERE id=?").run(Date.now(),row.id);
        this.effect(user,ctx,this.event(user,'cancel',row),{item});
        return {ok:true,message:'已下架，物品已退回目前角色背包並上鎖'};
      }
      check(row.seller_id!==user.id,'無法購買自己帳號的商品',409);
      const fee=marketFee(row.price),net=row.price-fee;
      if(row.currency==='diamonds'){
        check(this.commerce.wallet(user.id).diamonds>=row.price,'藍鑽不足，請聯絡 GM 儲值',409);
        check(this.commerce.wallet(row.seller_id).diamonds+net<=MAX,'賣家藍鑽餘額已達上限，暫時無法成交',409);
        this.db.prepare('UPDATE wallets SET diamonds=diamonds-? WHERE account_id=?').run(row.price,user.id);
        this.db.prepare('UPDATE wallets SET diamonds=diamonds+? WHERE account_id=?').run(net,row.seller_id);
        this.commerce.entry(user.id,user.id,'market_buy',-row.price,0,0,`交易所購入 ${this.describe(item).name}`);
        this.commerce.entry(row.seller_id,user.id,'market_sale',net,0,0,`交易所售出 ${this.describe(item).name}，系統手續費 ${fee} 藍鑽`);
      }else{
        check(p.gold>=row.price,'角色金幣不足',409);
        check(Number.isSafeInteger(this.gold(row.seller_id)+net),'賣家待領金幣已達上限',409);
        this.db.prepare('INSERT INTO market_gold VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET balance=balance+excluded.balance').run(row.seller_id,net);
      }
      this.db.prepare("UPDATE market_listings SET status='sold',buyer_id=?,closed_at=? WHERE id=? AND status='active'").run(user.id,Date.now(),row.id);
      this.effect(user,ctx,this.event(user,'buy',row,fee),{item,gold:row.currency==='gold'?-row.price:0});
      return {ok:true,message:'購買成功，物品已放入背包並上鎖',fee};
    });
    // Never replay an old snapshot with an idempotent receipt.
    return {...result,snapshot:this.service.bootstrap(user),effects:this.service.effects(user,Number.isSafeInteger(body.revision)?body.revision:0),wallet:this.commerce.wallet(user.id)};
  }
  guard(user,key,prior,incoming){
    if((prior.p._marketSeq||0)===(incoming.p._marketSeq||0))return;
    const effects=this.db.prepare('SELECT save_key,payload FROM gm_effects WHERE account_id=? AND save_key=? ORDER BY id').all(user.id,key)
      .map(r=>({key:r.save_key,...JSON.parse(r.payload)})).filter(e=>e.action==='market'&&e.seq>(incoming.p._marketSeq||0));
    throw new ApiError(409,'尚未套用交易結果，請重新同步',{snapshot:this.service.bootstrap(user),effects});
  }
}
