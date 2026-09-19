import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { createApp } from '../server/index.mjs';
import { CloudClient, CloudError } from '../cli/cloud-client.mjs';

const password = 'isolated-cli-test-password-2026!';
const catalog = { version: 'cli-test', items: {}, skills: {}, wrap: JSON.stringify, unwrap: JSON.parse };
async function fixture(t) {
  const app = createApp({ database: ':memory:', catalog, publicOrigin: '' });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, baseUrl, client: new CloudClient({ baseUrl }) };
}

test('CLI transport registers, persists private session, syncs and logs out through real HTTP', async t => {
  const { client, baseUrl } = await fixture(t);
  const registered = await client.register('cli_player', password);
  assert.equal(registered.user.role, 'player');
  assert.equal((await client.me()).user.username, 'cli_player');
  const session = client.exportSession();
  assert.match(session.cookie, /^idle_session=[\w-]+$/);
  for (const output of [JSON.stringify(client), inspect(client)]) {
    assert.ok(!output.includes(session.cookie));
    assert.ok(!output.includes(session.csrf));
    assert.ok(!output.includes(password));
  }
  const restored = new CloudClient({ baseUrl, session });
  const before = await restored.bootstrap();
  const lease = randomUUID();
  await restored.acquireLease(lease);
  const saved = await restored.sync({ lease, revision: before.revision, changes: { lineage_cli_note: '測試' },
    presence: { name: '王族代理', slot: 1, map: '說話之島' } });
  assert.equal(saved.revision, 1);
  assert.equal((await restored.bootstrap()).values.lineage_cli_note, '測試');
  assert.deepEqual((await restored.world()).online[0], {id:null,name:'角色選擇中',map:'角色選擇'},'presence cannot impersonate an unsaved character or expose a login account');
  await restored.chat('獨立測試訊息');
  assert.equal((await restored.world()).messages[0].text, '獨立測試訊息');
  await restored.logout();
  assert.equal(restored.exportSession(), null);
  await assert.rejects(client.me(), e => e instanceof CloudError && e.status === 401);
  assert.equal(client.authenticated, false);
});

test('CLI transport leaves lease takeovers and save conflicts under caller control', async t => {
  const { client, baseUrl, service } = await fixture(t);
  const { user } = await client.register('cli_conflict', password);
  const other = new CloudClient({ baseUrl });
  await other.login('cli_conflict', password);
  const firstLease = randomUUID(), secondLease = randomUUID();
  await client.acquireLease(firstLease);
  await assert.rejects(other.acquireLease(secondLease), e => e.status === 423 && e.code === 'LEASE_CONFLICT');
  await other.acquireLease(secondLease, { takeover: true });
  await assert.rejects(client.sync({ lease: firstLease, revision: 0, changes: {} }), e => e.status === 423);
  await other.sync({ lease: secondLease, revision: 0, changes: { lineage_cli_note: 'newer' } });
  const pendingEffect = { seq: 7, action: 'kill', at: Date.now() };
  service.db.prepare('INSERT INTO gm_effects(account_id,revision,save_key,payload) VALUES(?,?,?,?)')
    .run(user.id, 1, 'lineage_idle_save_1', JSON.stringify(pendingEffect));
  await assert.rejects(other.sync({ lease: secondLease, revision: 0, changes: { lineage_cli_note: 'stale' } }), e => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'SAVE_CONFLICT');
    assert.equal(e.data.snapshot.revision, 1);
    assert.equal(e.data.snapshot.values.lineage_cli_note, 'newer');
    assert.deepEqual(e.data.effects, [{ key: 'lineage_idle_save_1', ...pendingEffect }]);
    assert.ok(!inspect(e).includes(e.data.snapshot.csrf));
    assert.ok(!JSON.stringify(e).includes(e.data.snapshot.csrf));
    return true;
  });
  assert.equal((await other.bootstrap()).values.lineage_cli_note, 'newer');
});

test('CLI transport enforces timeout and refuses credential forwarding on redirects', async t => {
  let forwarded = false;
  const target = http.createServer((req, res) => { forwarded = true; res.end('{}'); });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const source = http.createServer((req, res) => {
    if (req.url === '/api/me') return; // Test a response that never arrives.
    res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/api/bootstrap` }); res.end();
  });
  source.listen(0, '127.0.0.1'); await once(source, 'listening');
  t.after(async () => {
    for (const server of [source, target]) {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  });
  const baseUrl = `http://127.0.0.1:${source.address().port}`;
  const client = new CloudClient({ baseUrl, timeoutMs: 70,
    session: { baseUrl, cookie: 'idle_session=private-cookie-value', csrf: 'private-csrf-value' } });
  await assert.rejects(client.me(), e => e.status === 0 && e.code === 'TIMEOUT');
  await assert.rejects(client.bootstrap(), e => e.status === 307 && e.code === 'REDIRECT_REFUSED');
  assert.equal(forwarded, false);
  assert.throws(() => new CloudClient({ baseUrl: `http://127.0.0.1:${target.address().port}`, session: client.exportSession() }), /不同伺服器/);
});
