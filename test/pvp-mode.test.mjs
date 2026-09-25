import test from 'node:test';
import assert from 'node:assert/strict';
import {HeadlessGame} from '../cli/engine.mjs';

function fixture(t){
  const game=new HeadlessGame();t.after(()=>game.close());
  game.create({classId:'knight',name:'PVP驗證',allocation:{str:4,con:4}});
  game.run("mapState.current=MAP_CATEGORIES.wild[0].v;mapState.mobs=[null,null,null];player.pvpOn=true;player.trollPlayers=[];");
  return game;
}

test('enabled PVP uses a five percent wild encounter threshold',t=>{
  const game=fixture(t);
  assert.equal(game.run('PVP_WILD_CHANCE'),0.05);
  game.window.Math.random=()=>0.049;
  game.run('spawnMob(0)');
  assert.equal(game.run('mapState.mobs[0]?.trollPlayer===true'),true);
});

test('the five percent threshold remains exclusive at exactly five percent',t=>{
  const game=fixture(t);
  game.window.Math.random=()=>0.05;
  game.run('spawnMob(0)');
  assert.equal(game.run('mapState.mobs[0]?.trollPlayer===true'),false);
});
