// Home-theatre fork: Jellyfin calls for /api/v1/watch, as the admin (Seerr's API key) unless
// another Authorization is given.
import { getSettings } from '@server/lib/settings';
import { getHostname } from '@server/utils/getHostname';

export class JellyfinError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

export const clientAuth = (device: string, deviceId: string, token?: string) =>
  `MediaBrowser Client="Seerr", Device="${device}", DeviceId="${deviceId}", Version="1.0"` +
  (token ? `, Token="${token}"` : '');

export async function jellyfin(
  method: string,
  path: string,
  { auth, body }: { auth?: string; body?: unknown } = {}
): Promise<Json> {
  const settings = getSettings();
  const res = await fetch(`${getHostname()}${path}`, {
    method,
    headers: {
      Authorization:
        auth ?? clientAuth('Seerr', 'seerr-watch', settings.jellyfin.apiKey),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new JellyfinError(
      res.status,
      `Jellyfin ${method} ${path.split('?')[0]}: ${res.status}`
    );
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const qs = (
  params: Record<string, string | number | boolean | undefined>
) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)])
  ).toString();
