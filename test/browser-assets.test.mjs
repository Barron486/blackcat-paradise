import test from 'node:test';
import assert from 'node:assert/strict';
import {browserAssets} from '../server/browser-assets.mjs';

test('fresh HTML versions scripts/styles and maps cached parent imports to current modules',()=>{
  const sources={
    '/online/authoritative.js':"import {npcIntents} from '/shared/game-intents.js';import './world-chat.js?v=old';",
    '/shared/game-intents.js':"export const npcIntents=['startOblivion'];",
    '/online/world-chat.js':"import {helper} from './helper.js';",
    '/online/helper.js':'export const helper=1;',
    '/online/bootstrap.js':'const bootstrap=true;',
    '/js/rules.js':'const rules=true;',
    '/online/mobile.css':'body{color:white}'
  };
  const html='<head><link href="/online/mobile.css"><link href="https://cdn.example/online/mobile.css"></head><body><script src="js/rules.js?v=old"></script><script src="/online/bootstrap.js"></script><script type="module" src="/online/authoritative.js?v=old"></script></body>';
  const first=browserAssets(sources),rendered=first.html(html);
  assert.match(rendered,/src="\/online\/authoritative.js\?v=[a-f0-9]{16}"/);
  assert.match(rendered,/src="\/js\/rules.js\?v=[a-f0-9]{16}"/);
  assert.match(rendered,/href="\/online\/mobile.css\?v=[a-f0-9]{16}"/);
  assert.ok(rendered.includes('href="https://cdn.example/online/mobile.css"'));
  const importMap=JSON.parse(rendered.match(/<script type="importmap">(.*?)<\/script>/)[1]);
  assert.equal(importMap.imports['/online/world-chat.js?v=old'],first.imports['/online/world-chat.js']);
  assert.ok(rendered.indexOf('type="importmap"')<rendered.indexOf('type="module"'));
  const second=browserAssets({...sources,'/shared/game-intents.js':sources['/shared/game-intents.js']+'\n// updated'});
  assert.equal(first.imports['/online/authoritative.js'],second.imports['/online/authoritative.js'],'an unchanged cached parent is safe to reuse');
  assert.notEqual(first.imports['/shared/game-intents.js'],second.imports['/shared/game-intents.js'],'the import map must force the changed dependency to reload');
  assert.notEqual(first.html(html),second.html(html));
});

test('classic GM/login pages also change asset URLs without altering ordinary links or assets',()=>{
  const assets=browserAssets({'/online/gm.js':'const gm=true;','/online/admin.css':'body{}'});
  const html=assets.html('<head><link href="/online/admin.css"></head><a href="/gm">GM</a><script src="/online/gm.js?v=old"></script><img src="/assets/logo.png">');
  assert.match(html,/gm.js\?v=[a-f0-9]{16}/);assert.ok(!html.includes('importmap'));assert.ok(html.includes('<a href="/gm">'));assert.ok(html.includes('/assets/logo.png'));
});
