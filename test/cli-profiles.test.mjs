import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { paths, loadProfile, saveProfile, listProfiles, writeJsonAtomic, replaceWithRetry } from '../cli/profiles.mjs';

test('transient Windows replacement locks preserve the old file until a complete replacement succeeds', t => {
  const root=fixture(t),source=join(root,'new.json'),destination=join(root,'state.json');
  writeFileSync(source,'{"revision":2}');writeFileSync(destination,'{"revision":1}');
  let calls=0;const waits=[];
  replaceWithRetry(source,destination,{wait:ms=>waits.push(ms),rename:(a,b)=>{
    if(calls++<2){assert.equal(JSON.parse(readFileSync(b)).revision,1);throw Object.assign(new Error('temporary lock'),{code:'EPERM'});}
    renameSync(a,b);
  }});
  assert.equal(JSON.parse(readFileSync(destination)).revision,2);assert.equal(calls,3);assert.deepEqual(waits,[10,20]);
  const permanent=Object.assign(new Error('permission denied'),{code:'EACCES'});calls=0;
  assert.throws(()=>replaceWithRetry(source,destination,{wait:()=>{},rename:()=>{calls++;throw permanent;}}),e=>e===permanent);
  assert.equal(calls,8);assert.equal(JSON.parse(readFileSync(destination)).revision,2);
  calls=0;assert.throws(()=>replaceWithRetry(source,destination,{wait:()=>{},rename:()=>{calls++;throw Object.assign(new Error('full disk'),{code:'ENOSPC'});}}),e=>e.code==='ENOSPC');assert.equal(calls,1);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'blackcat-cli-profile-'));
  const prior = process.env.BLACKCAT_CLI_HOME;
  process.env.BLACKCAT_CLI_HOME = root;
  t.after(() => {
    if (prior === undefined) delete process.env.BLACKCAT_CLI_HOME;
    else process.env.BLACKCAT_CLI_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('CLI profiles keep private credentials out of public account listings', t => {
  const root = fixture(t);
  assert.deepEqual(listProfiles(), []);
  assert.equal(loadProfile('royal'), null);
  const profile = { name: 'royal', username: 'agent_royal', password: 'private-password',
    serverUrl: 'https://game.example.com', classId: 'royal', characterName: '黑貓王族', slot: 1,
    session: { cookie: 'idle_session=private-cookie', csrf: 'private-csrf' } };
  saveProfile('royal', profile);
  assert.deepEqual(loadProfile('royal'), profile);
  assert.deepEqual(listProfiles(), [{ name: 'royal', username: 'agent_royal', serverUrl: 'https://game.example.com',
    classId: 'royal', characterName: '黑貓王族', slot: 1 }]);
  assert.ok(!JSON.stringify(listProfiles()).includes('private-'));
  for (const target of Object.values(paths('royal'))) {
    const rel = relative(root, target);
    assert.ok(!rel.startsWith('..') && !isAbsolute(rel));
  }
  if (process.platform !== 'win32') assert.equal(statSync(paths('royal').profileFile).mode & 0o777, 0o600);
});

test('CLI profiles reject path traversal before touching the filesystem', t => {
  const root = fixture(t);
  for (const name of ['../royal', '..\\royal', '/tmp/account', 'C:\\account', 'Royal', 'x'.repeat(33), '', 'a/b', 'a.json']) {
    assert.throws(() => paths(name), TypeError);
    assert.throws(() => saveProfile(name, {}), TypeError);
    assert.throws(() => loadProfile(name), TypeError);
  }
  assert.deepEqual(readdirSync(root), []);
  assert.throws(() => saveProfile('royal', { name: 'mage' }), TypeError);
});

test('CLI atomic JSON updates preserve the last complete file on serialization failure', t => {
  fixture(t);
  const location = paths('royal').runtimeFile;
  writeJsonAtomic(location, { revision: 1, message: 'first' });
  writeJsonAtomic(location, { revision: 2, message: '完整資料' });
  assert.deepEqual(JSON.parse(readFileSync(location, 'utf8')), { revision: 2, message: '完整資料' });
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => writeJsonAtomic(location, cyclic));
  assert.equal(JSON.parse(readFileSync(location, 'utf8')).revision, 2);
  assert.deepEqual(readdirSync(dirname(location)), ['state.json']);
});

test('CLI listing reports a corrupt profile without exposing malformed file contents', t => {
  fixture(t);
  const { profileFile } = paths('royal');
  mkdirSync(dirname(profileFile), { recursive: true });
  writeFileSync(profileFile, '{"password":"private-secret"');
  assert.throws(() => loadProfile('royal'), error => !error.message.includes('private-secret'));
  assert.deepEqual(listProfiles(), [{ name: 'royal', unavailable: true }]);
  writeJsonAtomic(profileFile, { name: 'mage', password: 'private-secret' });
  assert.throws(() => loadProfile('royal'), /資料格式不正確/);
});
