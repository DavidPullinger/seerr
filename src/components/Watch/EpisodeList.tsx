// Home-theatre fork: a season's episodes on a series page, Netflix style.
// TMDB's list merged with what's in Jellyfin (they don't always number or count episodes the
// same way), each with a thumbnail and one of three states:
//   in the library  → click to play (progress bar, full when watched)
//   aired, not here → "Not on disk": click to request the season and play that episode
//   not aired yet   → disabled, "Not available yet"
import AirDateBadge from '@app/components/AirDateBadge';
import CachedImage from '@app/components/Common/CachedImage';
import { useJellyfinBase, useSeasonWatch } from '@app/components/Watch';
import { openPlayer } from '@app/components/Watch/openPlayer';
import { ArrowDownTrayIcon, ClockIcon } from '@heroicons/react/24/outline';
import { PlayIcon } from '@heroicons/react/24/solid';
import type { WatchEpisodeState } from '@server/interfaces/api/watchInterfaces';
import type { SeasonWithEpisodes } from '@server/models/Tv';
import { useSyncExternalStore } from 'react';
import useSWR from 'swr';

// --- "Blur unwatched" (spoilers), per browser ---------------------------------------
const BLUR_KEY = 'seerr.watch.blurUnwatched';
const blurListeners = new Set<() => void>();
const readBlur = () => {
  try {
    return localStorage.getItem(BLUR_KEY) === '1';
  } catch {
    return false;
  }
};
const useBlurUnwatched = (): [boolean, (on: boolean) => void] => {
  const on = useSyncExternalStore(
    (cb) => {
      blurListeners.add(cb);
      return () => blurListeners.delete(cb);
    },
    readBlur,
    () => false
  );
  const set = (value: boolean) => {
    try {
      localStorage.setItem(BLUR_KEY, value ? '1' : '0');
    } catch {
      // private mode
    }
    blurListeners.forEach((cb) => cb());
  };
  return [on, set];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const GENERIC_NAME = /^Episode \d+$/i;
// Jellyfin names episodes it has no metadata for after the file, e.g. "show.name.s01e29".
const FILE_NAME = /[._]s\d+e\d+/i;
const jellyfinName = (w: WatchEpisodeState) =>
  w.name && !FILE_NAME.test(w.name) ? w.name : `Episode ${w.episodeNumber}`;

type Row = {
  episodeNumber: number;
  name: string;
  overview?: string;
  airDate?: string;
  tmdbStill?: string;
  watch?: WatchEpisodeState;
  state: 'playable' | 'missing' | 'upcoming';
};

/** Aired at least a day ago (TMDB dates are the origin country's day, no time). */
const airedAWhileAgo = (airDate?: string) =>
  !!airDate && Date.now() - new Date(`${airDate}T00:00:00Z`).getTime() > DAY_MS;

function merge(
  tmdb: SeasonWithEpisodes['episodes'],
  watch: Record<number, WatchEpisodeState>
): Row[] {
  const rows = new Map<number, Row>();
  for (const e of tmdb) {
    const w = watch[e.episodeNumber];
    rows.set(e.episodeNumber, {
      episodeNumber: e.episodeNumber,
      name:
        w && GENERIC_NAME.test(e.name) && !GENERIC_NAME.test(jellyfinName(w))
          ? jellyfinName(w)
          : e.name,
      overview: e.overview || w?.overview,
      airDate: e.airDate ?? w?.airDate,
      tmdbStill: e.stillPath,
      watch: w,
      state: 'upcoming',
    });
  }
  // Episodes Jellyfin has but TMDB doesn't list.
  for (const w of Object.values(watch)) {
    if (!rows.has(w.episodeNumber)) {
      rows.set(w.episodeNumber, {
        episodeNumber: w.episodeNumber,
        name: jellyfinName(w),
        overview: w.overview,
        airDate: w.airDate,
        watch: w,
        state: 'upcoming',
      });
    }
  }
  return [...rows.values()]
    .map((r) => ({
      ...r,
      state: r.watch
        ? ('playable' as const)
        : airedAWhileAgo(r.airDate)
          ? ('missing' as const)
          : ('upcoming' as const),
    }))
    .sort((a, b) => a.episodeNumber - b.episodeNumber);
}

const EpisodeList = ({
  tvId,
  seasonNumber,
  episodes,
}: {
  tvId: number;
  seasonNumber: number;
  episodes: SeasonWithEpisodes['episodes'];
}) => {
  const watch = useSeasonWatch(tvId, seasonNumber);
  // Already loaded by the series page; only for the "Getting it ready" title.
  const { data: series } = useSWR<{ name?: string }>(`/api/v1/tv/${tvId}`);
  const title = series?.name;
  const base = useJellyfinBase();
  const [blur, setBlur] = useBlurUnwatched();
  const rows = merge(episodes, watch);

  const activate = (r: Row) => {
    if (r.state === 'playable' && r.watch) openPlayer(r.watch.jellyfinId);
    else if (r.state === 'missing')
      openPlayer({
        prepare: {
          mediaType: 'tv',
          tmdbId: tvId,
          seasonNumber,
          episodeNumber: r.episodeNumber,
          title,
        },
      });
  };

  if (!rows.length) {
    return <p className="py-4 text-gray-400">Episode list unavailable.</p>;
  }

  return (
    <div>
      <div className="flex justify-end pt-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-400 hover:text-gray-200">
          <input
            type="checkbox"
            checked={blur}
            onChange={(e) => setBlur(e.target.checked)}
            className="rounded border-gray-600 bg-gray-700 text-indigo-600 focus:ring-indigo-500"
          />
          Blur unwatched
        </label>
      </div>
      <ul className="divide-y divide-gray-700">
        {rows.map((r) => {
          const played = !!r.watch?.played;
          const progress = played ? 100 : (r.watch?.progress ?? 0);
          const hidden = blur && !played;
          const clickable = r.state !== 'upcoming';
          const hint =
            r.state === 'missing'
              ? 'Not on disk: click to get it and play'
              : r.state === 'upcoming'
                ? 'Not available yet'
                : undefined;
          const image = r.tmdbStill ? (
            <CachedImage
              type="tmdb"
              src={r.tmdbStill}
              alt=""
              fill
              className={`object-cover ${hidden ? 'scale-110 blur-md' : ''}`}
            />
          ) : r.watch?.hasImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`${base}/Items/${r.watch.jellyfinId}/Images/Primary?fillWidth=400&quality=85`}
              alt=""
              loading="lazy"
              className={`absolute inset-0 h-full w-full object-cover ${hidden ? 'scale-110 blur-md' : ''}`}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-gray-700 to-gray-800 text-3xl font-bold text-gray-500">
              {r.episodeNumber}
            </div>
          );
          return (
            <li
              key={r.episodeNumber}
              title={hint}
              {...(clickable
                ? {
                    role: 'button',
                    tabIndex: 0,
                    onClick: () => activate(r),
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        activate(r);
                      }
                    },
                  }
                : { 'aria-disabled': true })}
              className={`group -mx-2 flex gap-4 rounded-lg px-2 py-3 transition ${
                clickable
                  ? 'cursor-pointer hover:bg-gray-700/40'
                  : 'cursor-not-allowed'
              }`}
            >
              <div className="relative aspect-video w-36 flex-shrink-0 overflow-hidden rounded-lg bg-gray-700 sm:w-44">
                <div
                  className={`absolute inset-0 ${
                    r.state === 'playable'
                      ? ''
                      : r.state === 'missing'
                        ? 'opacity-50 grayscale transition group-hover:opacity-70'
                        : 'opacity-30 grayscale'
                  }`}
                >
                  {image}
                </div>
                {r.state === 'playable' ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-gray-900/50 opacity-0 transition group-hover:opacity-100">
                    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-gray-900">
                      <PlayIcon className="ml-0.5 h-6 w-6" />
                    </span>
                  </div>
                ) : (
                  // Always shown, so missing episodes stand out without hovering each one.
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-gray-900/40">
                    {r.state === 'missing' ? (
                      <>
                        <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-gray-300 bg-gray-900/60 text-white transition group-hover:h-11 group-hover:w-11 group-hover:border-white">
                          <ArrowDownTrayIcon className="h-4 w-4 group-hover:h-5 group-hover:w-5" />
                        </span>
                        <span className="text-xs font-medium text-white">
                          Not on disk
                        </span>
                      </>
                    ) : (
                      <>
                        <ClockIcon className="h-6 w-6 text-gray-300" />
                        <span className="text-xs font-medium text-gray-300">
                          Not available yet
                        </span>
                      </>
                    )}
                  </div>
                )}
                {progress > 0 && (
                  <div className="absolute inset-x-0 bottom-0 h-1 bg-gray-900/70">
                    <div
                      className="h-full bg-indigo-500"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3
                    className={`text-base font-semibold ${
                      r.state === 'upcoming' ? 'text-gray-400' : 'text-white'
                    }`}
                  >
                    {r.episodeNumber}. {r.name}
                  </h3>
                  {r.airDate && <AirDateBadge airDate={r.airDate} />}
                </div>
                {r.overview && (
                  <p
                    className={`mt-1 line-clamp-3 text-sm text-gray-400 ${
                      hidden ? 'select-none blur-sm' : ''
                    }`}
                  >
                    {r.overview}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default EpisodeList;
