import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const PROFILE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const defaultRoot = fileURLToPath(new URL('../data/cli/', import.meta.url));
const home = () => process.env.BLACKCAT_CLI_HOME ? resolve(process.env.BLACKCAT_CLI_HOME) : defaultRoot;

/** Windows readers/scanners can briefly prevent replacement of an existing file. */
export function replaceWithRetry(source, destination, {rename = renameSync, wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { rename(source, destination); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 7) throw error;
      wait(Math.min(100, 10 * 2 ** attempt));
    }
  }
}

export function paths(name) {
  if (typeof name !== 'string' || !PROFILE_NAME.test(name)) {
    throw new TypeError('Profile 名稱須以小寫英文字母開頭，限 1～32 個小寫英文、數字、底線或連字號');
  }
  const root = home(), directory = join(root, 'runtime', name);
  return {
    root, directory,
    profileFile: join(root, 'profiles', `${name}.json`),
    runtimeFile: join(directory, 'state.json'),
    lockFile: join(directory, 'worker.lock.json'),
    logFile: join(directory, 'worker.log'),
    errorFile: join(directory, 'worker-error.log'),
    commandsDir: join(directory, 'commands'),
    resultsDir: join(directory, 'results'),
  };
}

/** Write sensitive JSON in the destination directory, then atomically replace it. */
export function writeJsonAtomic(filename, value) {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError('無法儲存空白 JSON');
  const destination = resolve(filename), folder = dirname(destination);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const temporary = join(folder, `.${basename(destination)}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, serialized + '\n', 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    replaceWithRetry(temporary, destination);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') { /* Keep the original failure. */ } }
    throw error;
  }
}

export function loadProfile(name) {
  const { profileFile } = paths(name);
  let text;
  try { text = readFileSync(profileFile, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error(`Profile ${name} 的 JSON 格式不正確`); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.name !== name) {
    throw new Error(`Profile ${name} 的資料格式不正確`);
  }
  return value;
}

export function saveProfile(name, value) {
  const { profileFile } = paths(name);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value.name !== undefined && value.name !== name)) throw new TypeError('Profile 資料格式不正確');
  writeJsonAtomic(profileFile, { ...value, name });
}

/** Public metadata only; password and session must never enter CLI list output. */
export function listProfiles() {
  let entries;
  try { entries = readdirSync(join(home(), 'profiles'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json') && PROFILE_NAME.test(entry.name.slice(0, -5)))
    .map(entry => entry.name.slice(0, -5)).sort().map(name => {
      let profile;
      try { profile = loadProfile(name); } catch { return { name, unavailable: true }; }
      if (!profile) return { name, unavailable: true };
      const metadata = { name };
      for (const field of ['username', 'serverUrl', 'classId', 'characterName']) {
        if (typeof profile[field] === 'string') metadata[field] = profile[field];
      }
      if (Number.isInteger(profile.slot)) metadata.slot = profile.slot;
      return metadata;
    });
}
