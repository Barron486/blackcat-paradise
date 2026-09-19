import {randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {ApiError} from './service.mjs';
import {applyShopBuffEffect,fullStatusBuffIds,refreshTimedBuffs} from '../shared/full-status.js';
const scrypt=promisify(scryptCallback);
const check=(value,message,status=400)=>{if(!value)throw new ApiError(status,message);};
const products={rename_card:{id:'rename_card',name:'更名卡',price:3000,column:'rename_cards'},password_card:{id:'password_card',name:'更改密碼卡',price:500,column:'password_cards'},full_status:{id:'full_status',name:'全狀態',price:300,durationSeconds:3600}};
const MAX_BALANCE=2_000_000_000;
export class CommerceService {
  constructor(service){
    this.service=service;this.db=service.db;service.commerce=this;
    this.db.exec(`CREATE TABLE IF NOT EXISTS wallets(account_id TEXT PRIMARY KEY REFERENCES accounts(id),diamonds INTEGER NOT NULL DEFAULT 0 CHECK(diamonds>=0),rename_cards INTEGER NOT NULL DEFAULT 0 CHECK(rename_cards>=0),password_cards INTEGER NOT NULL DEFAULT 0 CHECK(password_cards>=0));
      CREATE TABLE IF NOT EXISTS commerce_operations(actor_id TEXT NOT NULL REFERENCES accounts(id),request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(actor_id,request_id));
      CREATE TABLE IF NOT EXISTS wallet_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL REFERENCES accounts(id),actor_id TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL,diamonds INTEGER NOT NULL,rename_cards INTEGER NOT NULL,password_cards INTEGER NOT NULL,balance INTEGER NOT NULL,note TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  }
  wallet(accountId){
    this.db.prepare('INSERT OR IGNORE INTO wallets(account_id) VALUES(?)').run(accountId);
    const row=this.db.prepare('SELECT * FROM wallets WHERE account_id=?').get(accountId);
    return {diamonds:row.diamonds,renameCards:row.rename_cards,passwordCards:row.password_cards};
  }
  state(user){
    const save=this.service.bootstrap(user);
    const characters=[];
    for(const [key,raw]of Object.entries(save.values))if(/^lineage_idle_save_[1-8]$/.test(key)){
      const p=this.service.catalog.unwrap(raw).p;
      characters.push({slot:Number(key.slice(-1)),name:p.name||'未命名',epoch:p._roleEpoch||p.enSeed,cls:p.cls,level:p.lv,fullStatusExpiresAt:p._shopBuffs?.expiresAt||0});
    }
    return {wallet:this.wallet(user.id),products:Object.values(products).map(({column,...p})=>p),characters,history:this.history(user.id),serverTime:Date.now()};
  }
  history(accountId){
    return this.db.prepare('SELECT l.id,l.kind,l.diamonds,l.rename_cards AS renameCards,l.password_cards AS passwordCards,l.balance,l.note,l.created_at AS at,a.username AS actor FROM wallet_ledger l JOIN accounts a ON a.id=l.actor_id WHERE l.account_id=? ORDER BY l.id DESC LIMIT 30').all(accountId);
  }
  operation(user,requestId,payload,run){
    check(typeof requestId==='string'&&/^[\w-]{20,80}$/.test(requestId),'交易識別碼不正確');
    const fingerprint=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return this.service.transaction(()=>{
      const previous=this.db.prepare('SELECT fingerprint,result FROM commerce_operations WHERE actor_id=? AND request_id=?').get(user.id,requestId);
      if(previous){check(previous.fingerprint===fingerprint,'這個交易識別碼已用於其他操作',409);return {...JSON.parse(previous.result),replayed:true};}
      const result=run();
      this.db.prepare('INSERT INTO commerce_operations VALUES(?,?,?,?,?)').run(user.id,requestId,fingerprint,JSON.stringify(result),Date.now());
      return result;
    });
  }
  entry(accountId,actorId,kind,diamonds,renameCards,passwordCards,note){
    const wallet=this.wallet(accountId);
    this.db.prepare('INSERT INTO wallet_ledger(account_id,actor_id,kind,diamonds,rename_cards,password_cards,balance,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(accountId,actorId,kind,diamonds,renameCards,passwordCards,wallet.diamonds,note,Date.now());
    return wallet;
  }
  grant(user,body){
    this.service.gm(user);
    check(typeof body.accountId==='string','請選擇指定帳號');
    check(Number.isSafeInteger(body.amount)&&body.amount>0&&body.amount<=MAX_BALANCE,'藍鑽數量須為 1～2,000,000,000 的整數');
    check(typeof body.reason==='string'&&body.reason.trim().length>=2&&body.reason.length<=200,'請填寫 2～200 字的發放原因');
    const account=this.db.prepare('SELECT id,username FROM accounts WHERE id=?').get(body.accountId);
    check(account,'找不到指定帳號',404);
    return this.operation(user,body.requestId,{kind:'grant',accountId:account.id,amount:body.amount,reason:body.reason.trim()},()=>{
      this.service.gm(user);
      check(this.wallet(account.id).diamonds+body.amount<=MAX_BALANCE,'發放後餘額超過上限');
      this.db.prepare('UPDATE wallets SET diamonds=diamonds+? WHERE account_id=?').run(body.amount,account.id);
      return {ok:true,username:account.username,wallet:this.entry(account.id,user.id,'gm_grant',body.amount,0,0,body.reason.trim())};
    });
  }
  buy(user,body){
    const product=Object.hasOwn(products,body.productId)?products[body.productId]:null;
    check(product,'找不到商品');
    if(product.id==='full_status')return this.buyFullStatus(user,body,product);
    return this.operation(user,body.requestId,{kind:'buy',productId:product.id},()=>{
      check(this.wallet(user.id).diamonds>=product.price,'藍鑽不足，請聯絡 GM 儲值',409);
      this.db.prepare(`UPDATE wallets SET diamonds=diamonds-?,${product.column}=${product.column}+1 WHERE account_id=?`).run(product.price,user.id);
      return {ok:true,wallet:this.entry(user.id,user.id,'purchase',-product.price,product.id==='rename_card'?1:0,product.id==='password_card'?1:0,`購買${product.name}`)};
    });
  }
  buyFullStatus(user,body,product){
    check(Number.isInteger(body.slot)&&body.slot>=1&&body.slot<=8,'請選擇自己的角色');
    check(typeof body.epoch==='string'&&body.epoch.length>0,'角色識別碼不正確');
    const result=this.operation(user,body.requestId,{kind:'buy',productId:product.id,slot:body.slot,epoch:body.epoch},()=>{
      this.service.checkLease(user,body.lease);
      const snapshot=this.service.bootstrap(user),key='lineage_idle_save_'+body.slot;
      check(snapshot.values[key],'此欄位沒有角色',404);
      const doc=this.service.catalog.unwrap(snapshot.values[key]);
      check((doc.p._roleEpoch||doc.p.enSeed)===body.epoch,'角色已更換，請重新開啟商店',409);
      check(this.wallet(user.id).diamonds>=product.price,'藍鑽不足，請聯絡 GM 儲值',409);
      const now=Date.now(),expiresAt=Math.max(now,doc.p._shopBuffs?.expiresAt||0)+product.durationSeconds*1000;
      check(Number.isSafeInteger(expiresAt),'效果時間已超過上限',409);
      this.db.prepare('UPDATE wallets SET diamonds=diamonds-? WHERE account_id=?').run(product.price,user.id);
      this.entry(user.id,user.id,'purchase',-product.price,0,0,`購買${product.name}（${doc.p.name||'未命名'}，1 小時）`);
      const purchaseSeq=this.db.prepare('SELECT MAX(id) AS id FROM wallet_ledger WHERE account_id=?').get(user.id).id;
      // seq=0 keeps pre-upgrade clients from treating a shop receipt as a GM command.
      const effect={action:'shop_buff',seq:0,purchaseSeq,epoch:body.epoch,expiresAt,buffs:fullStatusBuffIds(this.service.catalog.skills)};
      check(applyShopBuffEffect(doc,effect,now),'角色狀態序號不正確',409);
      snapshot.values[key]=this.service.catalog.wrap(doc);
      this.db.prepare('UPDATE saves SET data=?,revision=revision+1,updated_at=? WHERE account_id=?').run(JSON.stringify(snapshot.values),now,user.id);
      this.db.prepare('INSERT INTO gm_effects(account_id,revision,save_key,payload) VALUES(?,?,?,?)').run(user.id,snapshot.revision+1,key,JSON.stringify(effect));
      return {ok:true,slot:body.slot,expiresAt,fromRevision:snapshot.revision};
    });
    // A retry can follow other purchases or GM commands; never return an old snapshot.
    return {...result,wallet:this.wallet(user.id),snapshot:this.service.bootstrap(user),effects:this.service.effects(user,result.fromRevision)};
  }
  restoreBuffs(prior,doc){
    const p=doc.p,old=prior.p;
    if(!old._shopBuffSeq&&!p._shopBuffSeq&&!old._shopBuffs&&!p._shopBuffs)return false;
    if(old._shopBuffSeq)p._shopBuffSeq=old._shopBuffSeq;else delete p._shopBuffSeq;
    if(old._shopBuffs)p._shopBuffs=structuredClone(old._shopBuffs);else delete p._shopBuffs;
    refreshTimedBuffs(p);
    return true;
  }
  rename(user,body){
    check(Number.isInteger(body.slot)&&body.slot>=1&&body.slot<=8,'角色欄位不正確');
    const name=typeof body.name==='string'?body.name.trim():'';
    check(name.length>=1&&name.length<=12&&!/[<>&"'\x00-\x1f\x7f]/.test(name),'角色名稱須為 1～12 字，且不可包含 HTML 符號、引號或控制字元');
    check(typeof body.epoch==='string'&&body.epoch.length>0,'角色識別碼不正確');
    return this.operation(user,body.requestId,{kind:'rename',slot:body.slot,epoch:body.epoch,name},()=>{
      check(this.wallet(user.id).renameCards>=1,'尚未持有更名卡',409);
      const row=this.db.prepare('SELECT data,revision FROM saves WHERE account_id=?').get(user.id);
      const values=JSON.parse(row.data),key='lineage_idle_save_'+body.slot;
      check(values[key],'此欄位沒有角色',404);
      const doc=this.service.catalog.unwrap(values[key]);
      check((doc.p._roleEpoch||doc.p.enSeed)===body.epoch,'角色已更換，請重新整理',409);
      check((doc.p.name||'')!==name,'新名稱與原名稱相同');
      const old=doc.p.name||'未命名';doc.p.name=name;
      values[key]=this.service.catalog.wrap(doc);
      this.db.prepare('UPDATE saves SET data=?,revision=revision+1,updated_at=? WHERE account_id=?').run(JSON.stringify(values),Date.now(),user.id);
      this.db.prepare('UPDATE leases SET display_name=? WHERE account_id=? AND slot=?').run(name,user.id,body.slot);
      this.db.prepare('UPDATE wallets SET rename_cards=rename_cards-1 WHERE account_id=?').run(user.id);
      return {ok:true,slot:body.slot,name,wallet:this.entry(user.id,user.id,'rename',0,-1,0,`${old} → ${name}`)};
    });
  }
  async password(user,body){
    check(typeof body.currentPassword==='string'&&body.currentPassword.length<=128,'請輸入目前密碼');
    check(typeof body.newPassword==='string'&&body.newPassword.length>=12&&body.newPassword.length<=128,'新密碼長度須為 12～128 字');
    check(body.newPassword!==body.currentPassword,'新密碼不能與目前密碼相同');
    check(this.wallet(user.id).passwordCards>=1,'尚未持有更改密碼卡',409);
    const row=this.db.prepare('SELECT salt,password_hash FROM accounts WHERE id=?').get(user.id);
    const candidate=await scrypt(body.currentPassword,row.salt,64);
    check(timingSafeEqual(candidate,Buffer.from(row.password_hash,'hex')),'目前密碼不正確',403);
    const salt=randomBytes(32).toString('base64url'),digest=(await scrypt(body.newPassword,salt,64)).toString('hex');
    return this.operation(user,body.requestId,{kind:'password'},()=>{
      check(this.db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(user.id).password_hash===row.password_hash,'密碼已變更，請重新登入',409);
      check(this.wallet(user.id).passwordCards>=1,'尚未持有更改密碼卡',409);
      this.db.prepare('UPDATE accounts SET password_hash=?,salt=? WHERE id=?').run(digest,salt,user.id);
      this.db.prepare('UPDATE wallets SET password_cards=password_cards-1 WHERE account_id=?').run(user.id);
      this.db.prepare('DELETE FROM sessions WHERE account_id=?').run(user.id);
      this.db.prepare('DELETE FROM leases WHERE account_id=?').run(user.id);
      return {ok:true,loginRequired:true,wallet:this.entry(user.id,user.id,'password',0,0,-1,'使用更改密碼卡')};
    });
  }
  admin(user,accountId){
    this.service.gm(user);
    check(typeof accountId==='string'&&this.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(accountId),'找不到帳號',404);
    return {wallet:this.wallet(accountId),history:this.history(accountId)};
  }
}
