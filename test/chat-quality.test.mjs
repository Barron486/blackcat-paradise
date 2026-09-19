import test from 'node:test';
import assert from 'node:assert/strict';
import {repeatedChat,echoedChat,mentionedItems} from '../server/chat-quality.mjs';

test('chat repetition catches punctuation, changed greetings and recycled questions across characters',()=>{
 const recent=[{text:'哈？你這招是從哪學的？'}];
 for(const text of ['哈？你這招是從哪學的？','哈 你這招是從哪學的！🙂','隱身斗篷？你這招是從哪學的？'])assert.equal(repeatedChat(text,recent),true,text);
 assert.equal(repeatedChat('最近在艾爾摩激戰地練功，發現一些裝備掉落率確實有變化，大家有什麼新發現嗎？',[{text:'最近在艾爾摩激戰地刷怪，發現一些裝備掉落率確實有變化，大家有什麼新發現嗎？'}]),true);
 assert.equal(repeatedChat('你這件隱身斗篷怎麼拿到？你這件隱身斗篷怎麼拿到？',[]),true);
});

test('deduplication preserves new information, changed numbers and corrections',()=>{
 for(const [text,old]of [
  ['喔，是裝備，我剛剛當成招式了。','哈？你這招是從哪學的？'],
  ['這次需要 300 藍鑽才能買到卡片','這次需要 500 藍鑽才能買到卡片'],
  ['我不認為這個方法適合目前的情況','我認為這個方法適合目前的情況'],
  ['哈哈真的','哈哈對啊'],
 ])assert.equal(repeatedChat(text,[{text:old}]),false,text);
 assert.equal(repeatedChat('',[{text:''}]),false);
});

test('item context contains only bounded public definitions of mentioned objects',()=>{
 const catalog={items:{cloak:{n:'隱身斗篷',type:'arm',d:'這是公開的披風說明。',secret:'not copied'},other:{n:'短劍',type:'wpn',d:'不可加入'},unnamed:{type:'arm'}}};
 assert.deepEqual(mentionedItems(catalog,[{text:'隱身斗篷？'}],{text:'裝備是要學什麼'}),[{name:'隱身斗篷',type:'防具',description:'這是公開的披風說明。'}]);
});

test('verbatim player echoes are suppressed without rejecting a related response',()=>{
 const recent=[{ai:false,text:'打了一整晚都沒掉，真的快沒耐心了'}];
 assert.equal(echoedChat('打了一整晚都沒掉，真的快沒耐心了',recent),true);
 assert.equal(echoedChat('欸，打了一整晚都沒掉，真的快沒耐心了。',recent),true);
 assert.equal(echoedChat('整晚都空手，真的有夠磨人。',recent),false);
 assert.equal(echoedChat('你好',[{ai:false,text:'你好'}]),false);
});
