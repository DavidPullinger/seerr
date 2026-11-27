// Sightseerr: player and episode-list options set on the server (WATCH_* env vars).
// The player has its own React root without Seerr's SWR setup, so this is fetched once
// with axios and shared by both.
import type { WatchConfigResponse } from '@server/interfaces/api/watchInterfaces';
import axios from 'axios';
import { useEffect, useState } from 'react';

export const DEFAULT_WATCH_CONFIG: WatchConfigResponse = {
  blurUnwatched: false,
  nextUpBeforeEnd: 0,
  nextUpCountdown: 10,
};

let cached: WatchConfigResponse | undefined;
let pending: Promise<WatchConfigResponse> | undefined;

export function loadWatchConfig(): Promise<WatchConfigResponse> {
  if (cached) return Promise.resolve(cached);
  pending ??= axios
    .get<WatchConfigResponse>('/api/v1/watch/config')
    .then(({ data }) => (cached = { ...DEFAULT_WATCH_CONFIG, ...data }))
    .catch(() => {
      pending = undefined;
      return DEFAULT_WATCH_CONFIG;
    });
  return pending;
}

export function useWatchConfig(): WatchConfigResponse {
  const [config, setConfig] = useState(cached ?? DEFAULT_WATCH_CONFIG);
  useEffect(() => {
    let live = true;
    loadWatchConfig().then((c) => live && setConfig(c));
    return () => {
      live = false;
    };
  }, []);
  return config;
}
