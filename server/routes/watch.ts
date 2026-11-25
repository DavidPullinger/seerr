// Home-theatre fork: play from Jellyfin inside Seerr.
//
// Everything here reads Jellyfin with the admin API key on behalf of the signed-in Seerr
// user (their linked Jellyfin account), except /session, which hands the browser a token
// for that Jellyfin account so it can stream directly. The admin key never leaves the server.
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type {
  WatchHomeResponse,
  WatchItem,
  WatchNextResponse,
  WatchSeasonResponse,
  WatchSessionResponse,
  WatchStatesResponse,
} from '@server/interfaces/api/watchInterfaces';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { getHostname } from '@server/utils/getHostname';
import { Router } from 'express';

const watchRoutes = Router();

class JellyfinError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const clientAuth = (device: string, deviceId: string, token?: string) =>
  `MediaBrowser Client="Seerr", Device="${device}", DeviceId="${deviceId}", Version="1.0"` +
  (token ? `, Token="${token}"` : '');

async function jellyfin(
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

const qs = (params: Record<string, string | number | boolean | undefined>) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)])
  ).toString();

const tmdbOf = (item: Json): number | undefined => {
  const id = Number(item?.ProviderIds?.Tmdb);
  return Number.isFinite(id) && id > 0 ? id : undefined;
};

const progressOf = (item: Json): number =>
  Math.round(item?.UserData?.PlayedPercentage ?? 0);

const episodeLabel = (item: Json) =>
  `S${item.ParentIndexNumber ?? 0}:E${item.IndexNumber ?? 0} · ${item.Name}`;

function toWatchItem(item: Json, series?: Json): WatchItem {
  if (item.Type === 'Episode') {
    return {
      jellyfinId: item.Id,
      mediaType: 'tv',
      tmdbId: tmdbOf(series),
      title: item.SeriesName ?? series?.Name ?? '',
      subtitle: episodeLabel(item),
      progress: progressOf(item),
      image: item.ImageTags?.Primary
        ? { itemId: item.Id, type: 'Primary' }
        : item.SeriesId
          ? { itemId: item.SeriesId, type: 'Backdrop' }
          : undefined,
    };
  }
  return {
    jellyfinId: item.Id,
    mediaType: 'movie',
    tmdbId: tmdbOf(item),
    title: item.Name,
    subtitle: item.ProductionYear ? String(item.ProductionYear) : undefined,
    progress: progressOf(item),
    image: item.BackdropImageTags?.length
      ? { itemId: item.Id, type: 'Backdrop' }
      : { itemId: item.Id, type: 'Primary' },
  };
}

/** The Jellyfin series behind a TMDB id, from Seerr's own media table. */
async function seriesId(tmdbId: number): Promise<string | undefined> {
  const media = await getRepository(Media).findOne({
    where: { tmdbId, mediaType: MediaType.TV },
  });
  return media?.jellyfinMediaId ?? undefined;
}

async function seriesById(ids: string[], userId: string) {
  if (!ids.length) return new Map<string, Json>();
  const res = await jellyfin(
    'GET',
    `/Items?${qs({ ids: ids.join(','), userId, fields: 'ProviderIds' })}`
  );
  return new Map<string, Json>(res.Items.map((s: Json) => [s.Id, s]));
}

watchRoutes.use(isAuthenticated());

// Every handler needs the user's linked Jellyfin account.
watchRoutes.use((req, res, next) => {
  if (!req.user?.jellyfinUserId) {
    return res.status(403).json({
      status: 403,
      error: "This Seerr account isn't linked to a Jellyfin user.",
    });
  }
  next();
});

const handle =
  (fn: (req: Json, res: Json) => Promise<unknown>) =>
  async (req: Json, res: Json) => {
    try {
      return res.status(200).json(await fn(req, res));
    } catch (e) {
      const status = e instanceof JellyfinError ? 502 : 500;
      logger.error('Watch request failed', {
        label: 'Watch',
        path: req.path,
        errorMessage: (e as Error).message,
      });
      return res.status(status).json({ status, error: (e as Error).message });
    }
  };

// A Jellyfin token for the browser: Quick Connect, approved with the admin key.
watchRoutes.post(
  '/session',
  handle(async (req): Promise<WatchSessionResponse> => {
    const deviceId = String(req.body?.deviceId ?? '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) {
      throw new Error('bad deviceId');
    }
    const device =
      String(req.body?.device ?? '')
        .replace(/[^\w .()-]/g, '')
        .slice(0, 40) || 'Browser';
    const auth = clientAuth(device, deviceId);
    const pending = await jellyfin('POST', '/QuickConnect/Initiate', { auth });
    await jellyfin(
      'POST',
      `/QuickConnect/Authorize?${qs({ code: pending.Code, userId: req.user.jellyfinUserId })}`
    );
    const login = await jellyfin(
      'POST',
      '/Users/AuthenticateWithQuickConnect',
      {
        auth,
        body: { Secret: pending.Secret },
      }
    );
    const settings = getSettings();
    return {
      token: login.AccessToken,
      userId: login.User.Id,
      serverId: login.ServerId,
      baseUrl: settings.jellyfin.externalHostname || '/jellyfin',
    };
  })
);

// Continue watching: films and episodes in progress, then the next episode of series
// you're part-way through. Newest first, like Jellyfin's home screen.
watchRoutes.get(
  '/home',
  handle(async (req): Promise<WatchHomeResponse> => {
    const userId = req.user.jellyfinUserId;
    const fields = 'ProviderIds';
    const [resume, nextUp] = await Promise.all([
      jellyfin(
        'GET',
        `/UserItems/Resume?${qs({ userId, limit: 20, mediaTypes: 'Video', fields })}`
      ),
      jellyfin(
        'GET',
        `/Shows/NextUp?${qs({ userId, limit: 20, fields, enableResumable: false, enableRewatching: false })}`
      ),
    ]);
    const items: Json[] = [...resume.Items];
    const seenSeries = new Set(
      items.filter((i) => i.SeriesId).map((i) => i.SeriesId)
    );
    for (const ep of nextUp.Items) {
      if (!seenSeries.has(ep.SeriesId)) {
        seenSeries.add(ep.SeriesId);
        items.push(ep);
      }
    }
    const series = await seriesById([...seenSeries] as string[], userId);
    return {
      continueWatching: items.map((i) =>
        toWatchItem(i, i.SeriesId ? series.get(i.SeriesId) : undefined)
      ),
    };
  })
);

// Watched/progress for everything in the library, keyed by TMDB id, for title cards.
watchRoutes.get(
  '/states',
  handle(async (req): Promise<WatchStatesResponse> => {
    const res = await jellyfin(
      'GET',
      `/Items?${qs({
        userId: req.user.jellyfinUserId,
        recursive: true,
        includeItemTypes: 'Movie,Series',
        fields: 'ProviderIds',
        enableImages: false,
      })}`
    );
    const out: WatchStatesResponse = { movie: {}, tv: {} };
    for (const item of res.Items as Json[]) {
      const tmdbId = tmdbOf(item);
      if (!tmdbId) continue;
      const kind = item.Type === 'Series' ? 'tv' : 'movie';
      out[kind][tmdbId] = {
        jellyfinId: item.Id,
        played: !!item.UserData?.Played,
        progress: progressOf(item),
      };
    }
    return out;
  })
);

// Which episodes of a season are in the library, with watched state.
watchRoutes.get(
  '/tv/:tmdbId/season/:seasonNumber',
  handle(async (req): Promise<WatchSeasonResponse> => {
    const id = await seriesId(Number(req.params.tmdbId));
    if (!id) return { episodes: [] };
    const res = await jellyfin(
      'GET',
      `/Shows/${id}/Episodes?${qs({ userId: req.user.jellyfinUserId, season: Number(req.params.seasonNumber), enableImages: false })}`
    );
    return {
      episodes: (res.Items as Json[])
        .filter((e) => e.LocationType !== 'Virtual')
        .map((e) => ({
          episodeNumber: e.IndexNumber,
          jellyfinId: e.Id,
          played: !!e.UserData?.Played,
          progress: progressOf(e),
        })),
    };
  })
);

// What "Play" on a series starts: the episode in progress or the next one up,
// else the first episode in the library.
watchRoutes.get(
  '/tv/:tmdbId/next',
  handle(async (req): Promise<WatchNextResponse> => {
    const userId = req.user.jellyfinUserId;
    const id = await seriesId(Number(req.params.tmdbId));
    if (!id) return {};
    const fields = 'ProviderIds';
    const nextUp = await jellyfin(
      'GET',
      `/Shows/NextUp?${qs({ seriesId: id, userId, limit: 1, fields, enableResumable: true, enableRewatching: true })}`
    );
    let ep: Json = nextUp.Items[0];
    if (!ep) {
      const all = await jellyfin(
        'GET',
        `/Shows/${id}/Episodes?${qs({ userId, fields })}`
      );
      ep =
        (all.Items as Json[]).find(
          (e) => (e.ParentIndexNumber ?? 0) > 0 && e.LocationType !== 'Virtual'
        ) ?? all.Items[0];
    }
    if (!ep) return {};
    const series = await seriesById([id], userId);
    return {
      next: {
        ...toWatchItem(ep, series.get(id)),
        resume: (ep.UserData?.PlaybackPositionTicks ?? 0) > 0,
        season: ep.ParentIndexNumber,
        episode: ep.IndexNumber,
      },
    };
  })
);

export default watchRoutes;
