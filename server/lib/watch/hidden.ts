// Home-theatre fork: titles removed from Continue Watching (the ✕ on a card).
//
// Jellyfin has no "hide from Continue Watching / Next Up", so the fork keeps its own list:
// per Seerr user, the film or series and when it was removed. A title comes back on its own
// once something of it is played after that. Kept in config/watch-hidden.json.
import logger from '@server/logger';
import fs from 'fs';
import path from 'path';

const FILE = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/watch-hidden.json`
  : path.join(__dirname, '../../../config/watch-hidden.json');
const KEEP_MS = 365 * 24 * 60 * 60 * 1000;

/** Seerr user id → Jellyfin film/series id → when it was removed (ISO). */
type Store = Record<string, Record<string, string>>;
let store: Store | undefined;

function load(): Store {
  if (!store) {
    try {
      store = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Store;
    } catch {
      store = {};
    }
  }
  return store;
}

function save() {
  try {
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(store));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (e) {
    logger.error('Could not save the Continue Watching hidden list', {
      label: 'Watch',
      errorMessage: (e as Error).message,
    });
  }
}

export function hiddenFor(userId: number): Record<string, string> {
  return load()[userId] ?? {};
}

export function hide(userId: number, key: string) {
  const all = load();
  const mine = (all[userId] ??= {});
  mine[key] = new Date().toISOString();
  for (const [k, at] of Object.entries(mine)) {
    if (Date.now() - Date.parse(at) > KEEP_MS) delete mine[k];
  }
  save();
}

export function unhide(userId: number, key: string) {
  const mine = load()[userId];
  if (mine?.[key]) {
    delete mine[key];
    save();
  }
}
