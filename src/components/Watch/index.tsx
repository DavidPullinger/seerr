// Home-theatre fork: the bits of the in-Seerr player that sit on Seerr's own pages.
import Button from '@app/components/Common/Button';
import Slider from '@app/components/Slider';
import { openPlayer } from '@app/components/Watch/openPlayer';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import { CheckCircleIcon, PlayIcon } from '@heroicons/react/24/solid';
import type {
  WatchEpisodeState,
  WatchHomeResponse,
  WatchItem,
  WatchNextResponse,
  WatchSeasonResponse,
  WatchStatesResponse,
} from '@server/interfaces/api/watchInterfaces';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';

/** Watching needs a Seerr account linked to a Jellyfin user. */
const useCanWatch = () => {
  const { user } = useUser();
  // /auth/me includes it; Seerr's client-side User type just doesn't list it.
  return !!(user as { jellyfinUserId?: string | null } | undefined)
    ?.jellyfinUserId;
};

export const useWatchStates = () => {
  const canWatch = useCanWatch();
  return useSWR<WatchStatesResponse>(canWatch ? '/api/v1/watch/states' : null, {
    revalidateOnFocus: true,
    dedupingInterval: 10_000,
  }).data;
};

const useJellyfinBase = () =>
  useSettings().currentSettings.jellyfinExternalHost || '/jellyfin';

async function playSeries(tmdbId: number) {
  const { data } = await axios.get<WatchNextResponse>(
    `/api/v1/watch/tv/${tmdbId}/next`
  );
  if (data.next) await openPlayer(data.next.jellyfinId);
}

const ProgressBar = ({ progress }: { progress: number }) =>
  progress > 0 && progress < 100 ? (
    <div className="absolute inset-x-0 bottom-0 h-1 bg-gray-900/70">
      <div className="h-full bg-indigo-500" style={{ width: `${progress}%` }} />
    </div>
  ) : null;

// --- Discover: Continue Watching ----------------------------------------------

const ContinueCard = ({ item }: { item: WatchItem }) => {
  const base = useJellyfinBase();
  const href = item.tmdbId
    ? `/${item.mediaType === 'movie' ? 'movie' : 'tv'}/${item.tmdbId}`
    : undefined;
  return (
    <div className="w-64 sm:w-80">
      <button
        type="button"
        onClick={() => openPlayer(item.jellyfinId)}
        className="group relative block aspect-video w-full overflow-hidden rounded-xl bg-gray-800 shadow ring-1 ring-gray-700 transition duration-300 hover:scale-105 hover:ring-gray-500"
      >
        {item.image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`${base}/Items/${item.image.itemId}/Images/${item.image.type}?fillWidth=640&quality=85`}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-gray-900/90 via-gray-900/20 to-transparent" />
        <div className="absolute inset-0 flex items-center justify-center opacity-0 transition group-hover:opacity-100">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600/90 text-white">
            <PlayIcon className="ml-0.5 h-7 w-7" />
          </div>
        </div>
        <div className="absolute inset-x-0 bottom-0 px-3 pb-3 text-left">
          <div className="truncate text-base font-bold text-white">
            {item.title}
          </div>
          {item.subtitle && (
            <div className="truncate text-xs text-gray-300">
              {item.subtitle}
            </div>
          )}
        </div>
        <ProgressBar progress={item.progress} />
      </button>
      {href && (
        <Link
          href={href}
          className="mt-1 block truncate px-1 text-xs text-gray-400 hover:text-white"
        >
          Details
        </Link>
      )}
    </div>
  );
};

export const ContinueWatchingSlider = () => {
  const canWatch = useCanWatch();
  const { data } = useSWR<WatchHomeResponse>(
    canWatch ? '/api/v1/watch/home' : null,
    { revalidateOnFocus: true }
  );
  if (!canWatch || (data && !data.continueWatching.length)) return null;
  return (
    <>
      <div className="slider-header">
        <div className="slider-title">
          <span>Continue Watching</span>
        </div>
      </div>
      <Slider
        sliderKey="continue-watching"
        isLoading={!data}
        placeholder={
          <div className="aspect-video w-64 animate-pulse rounded-xl bg-gray-800 sm:w-80" />
        }
        items={(data?.continueWatching ?? []).map((item) => (
          <ContinueCard key={item.jellyfinId} item={item} />
        ))}
      />
    </>
  );
};

// --- Title cards: progress, watched, Play ----------------------------------------

export const CardWatchBadge = ({
  tmdbId,
  mediaType,
}: {
  tmdbId: number;
  mediaType: string;
}) => {
  const states = useWatchStates();
  const state =
    mediaType === 'movie'
      ? states?.movie[tmdbId]
      : mediaType === 'tv'
        ? states?.tv[tmdbId]
        : undefined;
  if (!state) return null;
  return (
    <>
      {state.played && (
        <div className="pointer-events-none absolute bottom-2 right-2 z-30 rounded-full bg-gray-900/70 text-green-400">
          <CheckCircleIcon className="h-6 w-6" />
        </div>
      )}
      {!state.played && <ProgressBar progress={state.progress} />}
    </>
  );
};

export const CardPlayButton = ({
  tmdbId,
  mediaType,
  title,
}: {
  tmdbId: number;
  mediaType: string;
  title: string;
}) => {
  const canWatch = useCanWatch();
  const states = useWatchStates();
  const [busy, setBusy] = useState(false);
  if (!canWatch || !states || (mediaType !== 'movie' && mediaType !== 'tv'))
    return null;
  const state =
    mediaType === 'movie' ? states.movie[tmdbId] : states.tv[tmdbId];
  return (
    <Button
      buttonType="primary"
      buttonSize="sm"
      className="h-7 w-full"
      disabled={busy}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setBusy(true);
        try {
          if (!state)
            await openPlayer({
              prepare: { mediaType, tmdbId, title },
            });
          else if (mediaType === 'movie') await openPlayer(state.jellyfinId);
          else await playSeries(tmdbId);
        } finally {
          setBusy(false);
        }
      }}
    >
      <PlayIcon />
      <span>
        {mediaType === 'movie' && state && state.progress > 0 && !state.played
          ? 'Resume'
          : 'Play'}
      </span>
    </Button>
  );
};

// --- Film/series page: Play / Resume S1 E3 ------------------------------------

export const WatchPlayButton = ({
  mediaType,
  tmdbId,
  title,
  fallback,
}: {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  title: string;
  fallback?: React.ReactNode;
}) => {
  const canWatch = useCanWatch();
  const states = useWatchStates();
  const { data: next } = useSWR<WatchNextResponse>(
    canWatch && mediaType === 'tv' ? `/api/v1/watch/tv/${tmdbId}/next` : null
  );
  if (!canWatch) return <>{fallback}</>;

  let label: string | null = null;
  let play: (() => Promise<void>) | null = null;
  if (mediaType === 'movie') {
    const state = states?.movie[tmdbId];
    if (state) {
      label = state.progress > 0 && !state.played ? 'Resume' : 'Play';
      play = () => openPlayer(state.jellyfinId);
    }
  } else if (next?.next) {
    const n = next.next;
    label = `${n.resume ? 'Resume' : 'Play'} S${n.season ?? 0} E${n.episode ?? 0}`;
    play = () => openPlayer(n.jellyfinId);
  }
  if (!label || !play) {
    // Not in the library (yet): request it and play as soon as it's there.
    if (!states || (mediaType === 'tv' && !next)) return null;
    label = 'Play';
    play = () => openPlayer({ prepare: { mediaType, tmdbId, title } });
  }
  return (
    <Button buttonType="primary" onClick={() => play?.()}>
      <PlayIcon />
      <span>{label}</span>
    </Button>
  );
};

// --- Series page: per-episode play and watched state -----------------------------

export const useSeasonWatch = (tvId: number, seasonNumber: number) => {
  const canWatch = useCanWatch();
  const { data } = useSWR<WatchSeasonResponse>(
    canWatch ? `/api/v1/watch/tv/${tvId}/season/${seasonNumber}` : null
  );
  const byEpisode: Record<number, WatchEpisodeState> = {};
  for (const e of data?.episodes ?? []) byEpisode[e.episodeNumber] = e;
  return byEpisode;
};

export const EpisodePlay = ({ state }: { state?: WatchEpisodeState }) => {
  if (!state) return null;
  return (
    <div className="flex items-center gap-3">
      <Button
        buttonType="primary"
        buttonSize="sm"
        onClick={() => openPlayer(state.jellyfinId)}
      >
        <PlayIcon />
        <span>{state.progress > 0 && !state.played ? 'Resume' : 'Play'}</span>
      </Button>
      {state.played && (
        <span className="flex items-center gap-1 text-sm text-green-400">
          <CheckCircleIcon className="h-5 w-5" />
          Watched
        </span>
      )}
      {!state.played && state.progress > 0 && (
        <div className="h-1 w-24 overflow-hidden rounded-full bg-gray-700">
          <div
            className="h-full bg-indigo-500"
            style={{ width: `${state.progress}%` }}
          />
        </div>
      )}
    </div>
  );
};
