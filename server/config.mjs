import path from 'node:path';
import { fileURLToPath } from 'node:url';

const localData = fileURLToPath(new URL('../data/', import.meta.url));
export function databasePath(env = process.env) {
  const directory = env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || localData;
  if (env.RAILWAY_ENVIRONMENT_ID) {
    if (!env.RAILWAY_VOLUME_MOUNT_PATH) throw new Error('請先在 Railway 掛載 Volume 至 /data，避免重新部署時遺失存檔');
    const relative = path.relative(path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH), path.resolve(directory));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('DATA_DIR 必須位於 Railway Volume 內');
  }
  return path.join(path.resolve(directory), 'game.sqlite');
}

export function publicOriginFromEnv(env = process.env) {
  const value = env.PUBLIC_ORIGIN || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '');
  if (!value) return '';
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('PUBLIC_ORIGIN 須為完整網站來源，例如 https://game.example.com，不可包含路徑');
  return url.origin;
}
