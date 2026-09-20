import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {GameService} from '../server/service.mjs';
import {AuthoritativeGame} from '../server/authoritative-game.mjs';
import {loadCatalog} from '../server/catalog.mjs';
const catalog=loadCatalog(new URL('../',import.meta.url));
async function fixture(t){
 const service=new GameService(':memory:',catalog),authority=new AuthoritativeGame(service,{clock:()=>0,autoTick:false});
 t.after(()=>{authority.close();service.close();});
 const user=await service.register('merc_progress','merc-progress-test-2026!'),lease=randomUUID();service.acquireLease(user,lease);
 const read=slot=>catalog.unwrap(service.bootstrap(user).values['lineage_idle_save_'+slot]).p;
 const send=(op,args={},slot=1)=>authority.handle(user,{lease,op,slot,args,revision:service.bootstrap(user).revision,requestId:randomUUID(),epoch:service.bootstrap(user).values['lineage_idle_save_'+slot]?read(slot)._roleEpoch:undefined});
 send('create',{classId:'knight',name:'隊員',allocation:{str:2,con:6}},2);
 const companion=authority.runtimes.get(user.id);companion.engine.run('player.lv=40;player.exp=123;calcStats();');authority.commit(user,companion);
 send('create',{classId:'mage',name:'隊長',allocation:{int:6,wis:6,con:4}});
 send('action',{name:'mercenary',params:{operation:'toggle',slot:2}});
 return {service,authority,user,read,send,r:()=>authority.runtimes.get(user.id),commit:()=>service.transaction(()=>authority.commit(user,authority.runtimes.get(user.id)))};
}
test('combat earnings reach the source character in the field and survive town, dismissal, rehire and selection once',async t=>{
 const f=await fixture(t);f.send('action',{name:'travel',params:{mapId:'training'}});
 const before=f.read(2),r=f.r();
 r.engine.run("mapState.mobs[0]={...DB.mobs[DB.maps.training[0]],uid:'xp-test',curHp:0,st:newMobStatus(),exp:1000};killMob(0);settleDeadMobs();");
 const ally=JSON.parse(r.engine.run('JSON.stringify(player.allies[0])'));assert.ok(ally._expGained>0);
 f.commit();const earned=f.read(2);assert.ok(earned.lv>before.lv||earned.exp>before.exp);assert.equal(earned.exp,ally.exp);assert.equal(earned.lv,ally.lv);assert.equal(f.read(1).allies[0]._expGained,0);
 const expected=[earned.lv,earned.exp,earned.bonus,earned.alignmentValue],check=()=>assert.deepEqual([f.read(2).lv,f.read(2).exp,f.read(2).bonus,f.read(2).alignmentValue],expected);
 f.commit();check();f.authority.drop(f.user.id);f.send('state');check();
 f.send('action',{name:'return-town',params:{}});check();assert.equal(f.read(1).allies[0].exp,earned.exp);
 f.send('action',{name:'mercenary',params:{operation:'dismiss',slot:2}});check();
 f.send('action',{name:'mercenary',params:{operation:'toggle',slot:2}});check();assert.equal(f.read(1).allies[0].exp,earned.exp);
 f.send('select',{},2);check();
});
test('level overflow and bonus points persist exactly once, including legacy ledger records',async t=>{
 const f=await fixture(t),r=f.r();
 r.engine.run(`{const d=JSON.parse(_saveUnwrap(_lzGet('lineage_idle_save_2')).payload);d.p.lv=49;d.p.exp=getExpReq(49)-5;d.p.bonus=0;_lzSet('lineage_idle_save_2',_saveWrap(JSON.stringify(d)));refreshAllyOnce(2);const a=player.allies[0];a.exp=5;a.lv=50;a.bonus=1;a._expGained=10;
 _lzSet(MERC_LEDGER_KEY,JSON.stringify([{uid:'legacy',slot:'2',cls:a.cls,name:a.name,enSeed:a.enSeed,exp:7,alignmentDelta:3,claimed:false,questLoot:[['potion_heal',1]]}]));}`);
 f.commit();assert.equal(f.read(2).lv,50);assert.equal(f.read(2).exp,12);assert.equal(f.read(2).bonus,1);assert.equal(f.read(1).allies[0].exp,12);
 f.commit();assert.equal(f.read(2).exp,12);assert.equal(f.read(2).bonus,1);
 f.send('select',{},2);assert.equal(f.read(2).exp,12);assert.equal(f.read(2).bonus,1);
});
test('failed account commit rolls back both characters and reconnect credits pending experience only once',async t=>{
 const f=await fixture(t),before=f.read(2);f.r().engine.run('player.allies[0]._expGained=17;player.allies[0].exp+=17;saveGame();');
 // Persist a legacy leader snapshot carrying unsettled progress, then inject a database failure.
 const values=f.r().engine.values();f.service.db.prepare('UPDATE saves SET data=? WHERE account_id=?').run(JSON.stringify(values),f.user.id);
 f.service.db.exec("CREATE TRIGGER fail_merc_save BEFORE UPDATE ON saves BEGIN SELECT RAISE(ABORT,'injected failure');END;");
 assert.throws(f.commit,/injected failure/);assert.equal(f.read(2).exp,before.exp);
 f.service.db.exec('DROP TRIGGER fail_merc_save');f.authority.drop(f.user.id);f.send('state');assert.equal(f.read(2).exp,before.exp+17);f.commit();assert.equal(f.read(2).exp,before.exp+17);
});
test('a recreated role in the same slot cannot inherit another character’s pending earnings',async t=>{
 const f=await fixture(t),before=f.read(2);f.r().engine.run(`{player.allies[0]._expGained=999;const d=JSON.parse(_saveUnwrap(_lzGet('lineage_idle_save_2')).payload);d.p.enSeed='new-character';_lzSet('lineage_idle_save_2',_saveWrap(JSON.stringify(d)));}`);f.commit();assert.equal(f.read(2).exp,before.exp);assert.equal(f.read(2).lv,before.lv);
});
