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
import { hiddenFor, hide, unhide } from '@server/lib/watch/hidden';
import type { Json } from '@server/lib/watch/jellyfin';
import {
  JellyfinError,
  clientAuth,
  jellyfin,
  qs,
} from '@server/lib/watch/jellyfin';
import { prepareStatus, startPrepare } from '@server/lib/watch/prepare';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';

const watchRoutes = Router();

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
    // Leave out what was removed with ✕, unless something of it was played since.
    const hidden = hiddenFor(req.user.id);
    const candidates = [...resume.Items, ...nextUp.Items] as Json[];
    const keyOf = (i: Json): string => i.SeriesId ?? i.Id;
    const stillHidden = new Set<string>();
    await Promise.all(
      [...new Set(candidates.map(keyOf))]
        .filter((key) => hidden[key])
        .map(async (key) => {
          const film = candidates.find((i) => i.Id === key);
          const latest: Json | undefined = film
            ? film
            : (
                await jellyfin(
                  'GET',
                  `/Items?${qs({ userId, parentId: key, recursive: true, includeItemTypes: 'Episode', sortBy: 'DatePlayed', sortOrder: 'Descending', limit: 1, enableImages: false })}`
                )
              ).Items[0];
          const played = Date.parse(latest?.UserData?.LastPlayedDate ?? '');
          if (played > Date.parse(hidden[key])) unhide(req.user.id, key);
          else stillHidden.add(key);
        })
    );
    const shown = (list: Json[]) =>
      list.filter((i) => !stillHidden.has(keyOf(i)));

    const items: Json[] = shown(resume.Items);
    const seenSeries = new Set(
      items.filter((i) => i.SeriesId).map((i) => i.SeriesId)
    );
    for (const ep of shown(nextUp.Items)) {
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

// ✕ on a Continue Watching card: hide the film or series there until it's played again.
// Something only just started (under 5 minutes in) also has its position cleared, as if it
// was never started; otherwise the position is kept for resuming from its page.
const JUST_STARTED_TICKS = 5 * 60 * 10_000_000;
watchRoutes.post(
  '/hide',
  handle(async (req) => {
    const userId = req.user.jellyfinUserId;
    const id = String(req.body?.jellyfinId ?? '');
    if (!/^[0-9a-f]{32}$/i.test(id)) throw new Error('bad jellyfinId');
    const item: Json | undefined = (
      await jellyfin('GET', `/Items?${qs({ ids: id, userId })}`)
    ).Items[0];
    if (!item) throw new Error('Not in the library.');
    const position = item.UserData?.PlaybackPositionTicks ?? 0;
    if (position > 0 && position < JUST_STARTED_TICKS) {
      await jellyfin('POST', `/UserItems/${id}/UserData?${qs({ userId })}`, {
        body: { PlaybackPositionTicks: 0 },
      });
    }
    hide(req.user.id, item.SeriesId ?? item.Id);
    return { hidden: true };
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
      `/Shows/${id}/Episodes?${qs({ userId: req.user.jellyfinUserId, season: Number(req.params.seasonNumber), fields: 'Overview' })}`
    );
    return {
      episodes: (res.Items as Json[])
        .filter((e) => e.LocationType !== 'Virtual')
        .map((e) => ({
          episodeNumber: e.IndexNumber,
          jellyfinId: e.Id,
          played: !!e.UserData?.Played,
          progress: progressOf(e),
          name: e.Name,
          overview: e.Overview,
          airDate: e.PremiereDate?.slice(0, 10),
          hasImage: !!e.ImageTags?.Primary,
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

// "Play" on something not in the library yet: request it and hurry it along.
watchRoutes.post(
  '/prepare',
  handle(async (req) => {
    const mediaType =
      req.body?.mediaType === 'tv' ? MediaType.TV : MediaType.MOVIE;
    const tmdbId = Number(req.body?.tmdbId);
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) throw new Error('bad tmdbId');
    const season = Number(req.body?.seasonNumber ?? 1) || 1;
    const episode = Number(req.body?.episodeNumber) || undefined;
    return startPrepare(req.user, mediaType, tmdbId, season, episode);
  })
);

watchRoutes.get(
  '/prepare/:id',
  handle(async (req) => prepareStatus(String(req.params.id), req.user.id))
);

export default watchRoutes;
