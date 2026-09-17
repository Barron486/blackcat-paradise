import test from 'node:test';
import assert from 'node:assert/strict';
import {HeadlessGame} from '../cli/engine.mjs';

test('level 36 advances to 37 through a real kill and survives stat recomputation, save and reload',t=>{
 const game=new HeadlessGame();t.after(()=>game.close());game.create({classId:'elf',name:'升級驗證',allocation:{dex:8}});
 game.run(`player.lv=36;player.exp=getExpReq(36)-1;calcStats();mapState.current='training';mapState.mobs[0]={...DB.mobs.goblin,curHp:0};killMob(0);`);
 assert.equal(game.status().level,37);assert.ok(game.status().exp>=0);assert.ok(game.status().exp<game.status().expRequired);
 assert.ok(game.logs.some(line=>JSON.stringify(line).includes('Lv.36 → Lv.37')));
 const remaining=game.status().exp;game.run('calcStats();sanitizeState();');game.save();
 const loaded=new HeadlessGame({values:game.values()});t.after(()=>loaded.close());loaded.load();
 assert.equal(loaded.status().level,37);assert.equal(loaded.status().exp,remaining);
});
