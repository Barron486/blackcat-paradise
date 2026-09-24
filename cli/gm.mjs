#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
import {CloudClient} from './cloud-client.mjs';

const baseUrl=process.env.BLACKCAT_GM_SERVER||'https://game.barron-ai.com';
function credentials(){
  if(process.env.BLACKCAT_GM_USER&&process.env.BLACKCAT_GM_PASSWORD)return {username:process.env.BLACKCAT_GM_USER,password:process.env.BLACKCAT_GM_PASSWORD};
  const text=readFileSync(new URL('../data/gm-initial-login.txt',import.meta.url),'utf8');
  const username=text.match(/GM 已建立：([^\r\n]+)/)?.[1]?.trim(),password=text.match(/一次性顯示初始密碼：([^\r\n]+)/)?.[1]?.trim();
  if(!username||!password)throw new Error('找不到 GM 登入資料；請設定 BLACKCAT_GM_USER 與 BLACKCAT_GM_PASSWORD');
  return {username,password};
}
async function client(){const c=new CloudClient({baseUrl});const p=credentials();await c.login(p.username,p.password);return c;}
function need(v,label){if(!v)throw new Error(`請指定 ${label}`);return v;}
function out(v){console.log(JSON.stringify(v,null,2));}
const HELP=`GM CLI（僅限本機受保護的 GM 憑證）
  node cli/gm.mjs players
  node cli/gm.mjs diamonds --account-id <id>
  node cli/gm.mjs grant-diamonds --account-id <id> --amount 3000 --reason "原因"
  node cli/gm.mjs execute --action buff_all --scope account --account-id <id> --duration 3600 --reason "原因"
  node cli/gm.mjs execute --action teleport --scope account --account-id <id> --map-id zone_04 --reason "原因"
`;
const {values:flags,positionals}=parseArgs({args:process.argv.slice(2),allowPositionals:true,options:{'account-id':{type:'string'},amount:{type:'string'},reason:{type:'string'},action:{type:'string'},scope:{type:'string'},duration:{type:'string'},'map-id':{type:'string'},'item-id':{type:'string'},quantity:{type:'string'},enchant:{type:'string'},blessed:{type:'boolean'},slot:{type:'string'},experience:{type:'string'},help:{type:'boolean'}}});
const command=positionals[0]||'help';
if(flags.help||command==='help'){console.log(HELP);process.exit(0);}
try{
  const c=await client();
  if(command==='players'){out(await c.gmPlayers());}
  else if(command==='diamonds'){out(await c.gmDiamonds(need(flags['account-id'],'--account-id')));}
  else if(command==='grant-diamonds'){
    const amount=Number(need(flags.amount,'--amount'));if(!Number.isSafeInteger(amount)||amount<1)throw new Error('--amount 必須是正整數');
    out(await c.gmGrantDiamonds({accountId:need(flags['account-id'],'--account-id'),amount,reason:need(flags.reason,'--reason'),requestId:randomUUID()}));
  } else if(command==='execute'){
    const action=need(flags.action,'--action'),scope=flags.scope||'account',body={action,scope,accountId:scope==='account'?need(flags['account-id'],'--account-id'):null,reason:need(flags.reason,'--reason')};
    if(flags.duration)body.duration=Number(flags.duration);if(flags['map-id'])body.mapId=flags['map-id'];if(flags['item-id']){body.itemId=flags['item-id'];body.quantity=Number(flags.quantity||1);body.enchant=Number(flags.enchant||0);body.blessed=flags.blessed===true;}if(flags.slot)body.slot=Number(flags.slot);if(flags.experience)body.experienceDelta=Number(flags.experience);
    const preview=await c.gmPreview(body);const result=await c.gmExecute({...body,targetFingerprint:preview.targetFingerprint,requestId:randomUUID()});out({preview,result});
  } else throw new Error(`未知指令：${command}`);
}catch(error){console.error(`錯誤：${error.message}`);process.exitCode=1;}
