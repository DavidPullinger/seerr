// Home-theatre fork: the browser's Jellyfin session for playing inside Seerr.
// Seerr's server hands out a token for the signed-in user's linked Jellyfin account
// (POST /api/v1/watch/session); it's kept per browser and refreshed when Jellyfin rejects it.
import type { WatchSessionResponse } from '@server/interfaces/api/watchInterfaces';
import axios from 'axios';

interface StoredSession extends WatchSessionResponse {
  seerrUserId: number;
}

const read = <T>(key: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(`seerr.watch.${key}`) ?? 'null');
  } catch {
    return null;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(`seerr.watch.${key}`, JSON.stringify(value));
  } catch {
    // private mode: the session just won't be remembered
  }
};

export const deviceId: string = (() => {
  if (typeof window === 'undefined') return '';
  let id = read<string>('deviceId');
  if (!id) {
    id = crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    write('deviceId', id);
  }
  return id;
})();

export const deviceName: string = (() => {
  if (typeof navigator === 'undefined') return 'Browser';
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Mac OS X/.test(ua)
    ? 'macOS'
    : /Windows/.test(ua)
      ? 'Windows'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
})();

let session: StoredSession | null = null;

async function fresh(seerrUserId: number): Promise<StoredSession> {
  const { data } = await axios.post<WatchSessionResponse>(
    '/api/v1/watch/session',
    { deviceId, device: deviceName }
  );
  session = { ...data, seerrUserId };
  write('session', session);
  return session;
}

async function current(): Promise<StoredSession> {
  if (session) return session; // checked against the Seerr user once per page load
  const { data: me } = await axios.get<{ id: number }>('/api/v1/auth/me');
  const stored = read<StoredSession>('session');
  if (stored?.seerrUserId === me.id && stored.token) return (session = stored);
  return fresh(me.id);
}

export class JellyfinHttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export const authHeader = (token?: string) =>
  `MediaBrowser Client="Seerr", Device="${deviceName}", DeviceId="${deviceId}", Version="1.0"` +
  (token ? `, Token="${token}"` : '');

/** Call Jellyfin as the signed-in user (retries once with a new token on 401). */
export async function jf<T = unknown>(
  path: string,
  {
    method = 'GET',
    body,
    keepalive = false,
    retry = true,
  }: {
    method?: string;
    body?: unknown;
    keepalive?: boolean;
    retry?: boolean;
  } = {}
): Promise<T> {
  const s = await current();
  const res = await fetch(s.baseUrl + path, {
    method,
    keepalive,
    headers: {
      Authorization: authHeader(s.token),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry) {
    await fresh(s.seerrUserId);
    return jf<T>(path, { method, body, keepalive, retry: false });
  }
  if (!res.ok) {
    throw new JellyfinHttpError(
      res.status,
      `Jellyfin: ${method} ${path.split('?')[0]} failed (${res.status})`
    );
  }
  return (res.status === 204 ? null : await res.json().catch(() => null)) as T;
}

/** The current session (after at least one jf() call it's cached). */
export const getSession = current;
