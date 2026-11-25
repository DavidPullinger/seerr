// Home-theatre fork: "Play" on something that isn't in the library yet.
//
// Requests it the normal Seerr way (a film, or one season to Sonarr), then hurries the
// pipeline along instead of waiting for timers: asks Radarr/Sonarr to check their download
// client every few seconds so the import happens as soon as Real-Debrid has it, has
// Jellyfin scan as soon as the file is there, and finds the item to play.
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  DuplicateMediaRequestError,
  MediaRequest,
  NoSeasonsAvailableError,
} from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import type { Json } from '@server/lib/watch/jellyfin';
import { jellyfin, qs } from '@server/lib/watch/jellyfin';
import logger from '@server/logger';

export type PrepareStage =
  | 'requesting'
  | 'searching'
  | 'downloading'
  | 'importing'
  | 'adding'
  | 'ready'
  | 'failed';

export interface PrepareStatus {
  id: string;
  stage: PrepareStage;
  message: string;
  /** 0–100 while downloading */
  progress?: number;
  /** What to play once ready (the film, or the season's first episode). */
  jellyfinId?: string;
}

interface Job extends PrepareStatus {
  userId: number;
  updated: number;
}

const jobs = new Map<string, Job>();
const TIMEOUT_MS = 15 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function prepareStatus(id: string, userId: number): PrepareStatus {
  const job = jobs.get(id);
  if (!job || job.userId !== userId) {
    return { id, stage: 'failed', message: 'Nothing is being prepared.' };
  }
  return {
    id: job.id,
    stage: job.stage,
    message: job.message,
    progress: job.progress,
    jellyfinId: job.jellyfinId,
  };
}

export function startPrepare(
  user: User,
  mediaType: MediaType,
  tmdbId: number,
  seasonNumber = 1,
  episodeNumber?: number
): PrepareStatus {
  const id = `${user.id}-${mediaType}-${tmdbId}-${mediaType === MediaType.TV ? `${seasonNumber}-${episodeNumber ?? 0}` : 0}`;
  const existing = jobs.get(id);
  if (existing && existing.stage !== 'failed' && existing.stage !== 'ready') {
    return prepareStatus(id, user.id);
  }
  const job: Job = {
    id,
    userId: user.id,
    stage: 'requesting',
    message: 'Requesting…',
    updated: Date.now(),
  };
  jobs.set(id, job);
  const set = (patch: Partial<PrepareStatus>) =>
    Object.assign(job, patch, { updated: Date.now() });
  run(user, mediaType, tmdbId, seasonNumber, episodeNumber, set).catch((e) => {
    logger.error('Preparing playback failed', {
      label: 'Watch',
      tmdbId,
      errorMessage: (e as Error).message,
    });
    set({ stage: 'failed', message: (e as Error).message });
  });
  // Forget old jobs.
  for (const [key, j] of jobs) {
    if (Date.now() - j.updated > 60 * 60 * 1000) jobs.delete(key);
  }
  return prepareStatus(id, user.id);
}

async function request(
  user: User,
  mediaType: MediaType,
  tmdbId: number,
  seasonNumber: number
): Promise<boolean> {
  try {
    const req = await MediaRequest.request(
      {
        mediaType,
        mediaId: tmdbId,
        ...(mediaType === MediaType.TV ? { seasons: [seasonNumber] } : {}),
      },
      user
    );
    if (req.status !== MediaRequestStatus.APPROVED) {
      throw new Error(
        'Requested. It needs approving before it can be fetched.'
      );
    }
    return true;
  } catch (e) {
    // Already requested (or already there): carry on and wait for it.
    if (
      e instanceof DuplicateMediaRequestError ||
      e instanceof NoSeasonsAvailableError
    ) {
      return false;
    }
    throw e;
  }
}

/**
 * Find the film or the season's first episode in Jellyfin by where Radarr/Sonarr put it
 * (every container sees the media at the same path). Works before Jellyfin has fetched
 * metadata, which can take a while after the scan.
 */
async function findInJellyfin(
  mediaType: MediaType,
  path: string,
  seasonNumber: number,
  episodeNumber?: number
): Promise<string | undefined> {
  const folder = path.replace(/\/+$/, '');
  const res = await jellyfin(
    'GET',
    `/Items?${qs({
      recursive: true,
      includeItemTypes: mediaType === MediaType.MOVIE ? 'Movie' : 'Series',
      fields: 'Path',
      sortBy: 'DateCreated',
      sortOrder: 'Descending',
      enableImages: false,
    })}`
  );
  const item = (res.Items as Json[]).find(
    (i) =>
      typeof i.Path === 'string' &&
      (i.Path === folder || i.Path.startsWith(`${folder}/`))
  );
  if (!item || mediaType === MediaType.MOVIE) return item?.Id;
  const eps = await jellyfin(
    'GET',
    `/Shows/${item.Id}/Episodes?${qs({ season: seasonNumber, enableImages: false })}`
  );
  const onDisk = (eps.Items as Json[])
    .filter((e) => e.LocationType !== 'Virtual')
    .sort((a, b) => (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0));
  if (episodeNumber !== undefined) {
    return onDisk.find((e) => e.IndexNumber === episodeNumber)?.Id;
  }
  return onDisk[0]?.Id;
}

function arrServer(mediaType: MediaType, serviceId?: number | null) {
  const settings = getSettings();
  const servers =
    mediaType === MediaType.MOVIE ? settings.radarr : settings.sonarr;
  const server =
    servers.find((s) => s.id === serviceId) ??
    servers.find((s) => s.isDefault && !s.is4k) ??
    servers[0];
  if (!server) throw new Error('No Radarr/Sonarr server is set up in Seerr.');
  return server;
}

function arr(mediaType: MediaType, serviceId?: number | null) {
  const server = arrServer(mediaType, serviceId);
  const Api = mediaType === MediaType.MOVIE ? RadarrAPI : SonarrAPI;
  return new Api({
    apiKey: server.apiKey,
    url: Api.buildUrl(server, '/api/v3'),
  });
}

/** Run a Radarr/Sonarr command (e.g. a search). */
async function command(
  mediaType: MediaType,
  serviceId: number | null | undefined,
  body: Record<string, unknown>
) {
  const server = arrServer(mediaType, serviceId);
  await fetch(RadarrAPI.buildUrl(server, '/api/v3/command'), {
    method: 'POST',
    headers: { 'X-Api-Key': server.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}

/** Is Radarr/Sonarr still running (or about to run) a search? */
async function searching(mediaType: MediaType, serviceId?: number | null) {
  const server = arrServer(mediaType, serviceId);
  try {
    const res = await fetch(RadarrAPI.buildUrl(server, '/api/v3/command'), {
      headers: { 'X-Api-Key': server.apiKey },
      signal: AbortSignal.timeout(10000),
    });
    const commands = (await res.json()) as Json[];
    return commands.some(
      (c) =>
        /Search/i.test(c.name) &&
        (c.status === 'queued' || c.status === 'started')
    );
  } catch {
    return true; // can't tell: keep waiting
  }
}

async function run(
  user: User,
  mediaType: MediaType,
  tmdbId: number,
  seasonNumber: number,
  episodeNumber: number | undefined,
  set: (patch: Partial<PrepareStatus>) => void
) {
  const media = () =>
    getRepository(Media).findOne({ where: { tmdbId, mediaType } });

  // Already in Jellyfin?
  const known = await media();
  if (known?.jellyfinMediaId && mediaType === MediaType.MOVIE) {
    return set({
      stage: 'ready',
      message: 'Ready',
      jellyfinId: known.jellyfinMediaId,
    });
  }

  set({ stage: 'requesting', message: 'Requesting…' });
  // Already requested (e.g. an episode that never arrived): nothing new will search,
  // so ask for a search ourselves, once.
  let needSearch = !(await request(user, mediaType, tmdbId, seasonNumber));

  const started = Date.now();
  let lastNudge = 0;
  let lastScan = 0;
  let idleSince = 0;
  while (Date.now() - started < TIMEOUT_MS) {
    const m = await media();
    const externalId = m?.externalServiceId;
    if (!m || !externalId) {
      // Seerr hasn't handed it to Radarr/Sonarr yet.
      await sleep(1500);
      continue;
    }

    let folder = '';
    let hasFile = false;
    let queued: Json[] = [];
    if (mediaType === MediaType.MOVIE) {
      const radarr = arr(mediaType, m.serviceId) as RadarrAPI;
      const movie = await radarr.getMovie({ id: externalId });
      folder = movie.path;
      hasFile = movie.hasFile;
      if (!hasFile) {
        queued = (await radarr.getQueue()).filter(
          (q) => q.movieId === movie.id
        );
      }
      if (!hasFile && !queued.length && needSearch) {
        needSearch = false;
        await command(mediaType, m.serviceId, {
          name: 'MoviesSearch',
          movieIds: [movie.id],
        });
      }
      if (!hasFile && queued.length && Date.now() - lastNudge > 5000) {
        lastNudge = Date.now();
        await radarr.refreshMonitoredDownloads();
      }
    } else {
      const sonarr = arr(mediaType, m.serviceId) as SonarrAPI;
      const series = await sonarr.getSeriesById(externalId);
      folder = series.path;
      const episodes = (await sonarr.getEpisodes(externalId)).filter(
        (e) => e.seasonNumber === seasonNumber && e.episodeNumber > 0
      );
      // A chosen episode: wait for that one; otherwise for any of the season.
      hasFile = episodes.some(
        (e) =>
          e.hasFile &&
          (episodeNumber === undefined || e.episodeNumber === episodeNumber)
      );
      if (!hasFile) {
        queued = (await sonarr.getQueue()).filter(
          (q) => (q as Json).seriesId === externalId
        );
      }
      if (!hasFile && !queued.length && needSearch) {
        needSearch = false;
        const wanted = episodes.filter(
          (e) =>
            !e.hasFile &&
            (episodeNumber === undefined || e.episodeNumber === episodeNumber)
        );
        if (wanted.length) {
          await sonarr.monitorEpisodes(wanted.map((e) => e.id));
          await command(mediaType, m.serviceId, {
            name: 'EpisodeSearch',
            episodeIds: wanted.map((e) => e.id),
          });
        }
      }
      if (!hasFile && queued.length && Date.now() - lastNudge > 5000) {
        lastNudge = Date.now();
        await sonarr.refreshMonitoredDownloads();
      }
    }

    if (hasFile) {
      const jellyfinId = await findInJellyfin(
        mediaType,
        folder,
        seasonNumber,
        episodeNumber
      );
      if (jellyfinId) {
        return set({ stage: 'ready', message: 'Ready', jellyfinId });
      }
      set({ stage: 'adding', message: 'Adding to the library…' });
      // One scan; a second only if it still isn't there a minute later. (Each refresh
      // cancels a scan in progress, so asking repeatedly would keep it from finishing.)
      if (!lastScan || Date.now() - lastScan > 60000) {
        lastScan = Date.now();
        await jellyfin('POST', '/Library/Refresh');
      }
    } else if (queued.length) {
      const q = queued[0];
      const progress =
        q.size > 0 ? Math.round(((q.size - q.sizeleft) / q.size) * 100) : 0;
      const done = q.size > 0 && q.sizeleft === 0;
      set(
        done
          ? { stage: 'importing', message: 'Importing…', progress: 100 }
          : {
              stage: 'downloading',
              message: `Fetching from Real-Debrid… ${progress}%`,
              progress,
            }
      );
    } else {
      const waited = Math.round((Date.now() - started) / 1000);
      // The search finished and nothing was grabbed (none found, or Real-Debrid refused
      // them): say so rather than spinning until the timeout.
      if (waited > 30 && !(await searching(mediaType, m.serviceId))) {
        idleSince ||= Date.now();
        if (Date.now() - idleSince > 20000) {
          return set({
            stage: 'failed',
            message: `No release could be fetched right now (none found, or Real-Debrid refused them). It's requested, so ${mediaType === MediaType.MOVIE ? 'Radarr' : 'Sonarr'} will keep looking and it'll show up in the library.`,
          });
        }
      } else {
        idleSince = 0;
      }
      set({
        stage: 'searching',
        message:
          waited > 90
            ? 'Still searching for a release…'
            : 'Searching for a release…',
      });
    }
    await sleep(2000);
  }
  set({
    stage: 'failed',
    message:
      "Couldn't get it in time. It's requested, so it'll show up in the library when a release turns up.",
  });
}
