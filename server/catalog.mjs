import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Read the upstream catalog in an isolated data context. No network, filesystem,
// timers, process or module loader is exposed to the upstream browser script.
export function loadCatalog(root) {
  const storage = new Map();
  const empty = () => {};
  const context = vm.createContext({
    console: { log: empty, warn: empty, error: empty },
    window: {addEventListener:empty}, location: { hostname: 'localhost' },
    document: { readyState: 'loading', addEventListener: empty,
      getElementById: () => null, documentElement: { classList: { add: empty } } },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k), length: 0 },
    setTimeout: empty, setInterval: empty, clearTimeout: empty, clearInterval: empty,
  }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(readFileSync(new URL('js/00-data.js', root), 'utf8'), context, { timeout: 10000 });
  for(const file of ['01-drops-config','11-world-map','12-npc-quests','15-cards','world-rules']) vm.runInContext(readFileSync(new URL('js/'+file+'.js',root),'utf8'),context,{timeout:10000});
  const catalog = vm.runInContext('JSON.stringify({items: DB.items, skills: DB.skills, experience: EXP_REQ_CLASSIC, version: GAME_VERSION, world: gmBuildWorldCatalog()})', context);
  const data = JSON.parse(catalog);
  return {
    ...data,
    wrap(value) { context.payload = JSON.stringify(value); return vm.runInContext('_saveWrapPortable(payload)', context, { timeout: 3000 }); },
    unwrap(raw) {
      if (typeof raw !== 'string' || raw.length > 8_000_000) throw new Error('存檔大小或格式不正確');
      context.raw = raw;
      const result = vm.runInContext('_saveUnwrap(raw)', context, { timeout: 3000 });
      if (!result.ok) throw new Error('存檔校驗失敗');
      return JSON.parse(result.payload);
    },
  };
}
