// Home-theatre fork: the bits of the in-Seerr player that sit on Seerr's own pages.
import Button from '@app/components/Common/Button';
import Slider from '@app/components/Slider';
import { openPlayer } from '@app/components/Watch/openPlayer';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import { ArrowDownIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import { PlayIcon } from '@heroicons/react/24/solid';
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
export const useCanWatch = () => {
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

export const useJellyfinBase = () =>
  useSettings().currentSettings.jellyfinExternalHost || '/jellyfin';

async function playSeries(tmdbId: number) {
  const { data } = await axios.get<WatchNextResponse>(
    `/api/v1/watch/tv/${tmdbId}/next`
  );
  if (data.next) await openPlayer(data.next.jellyfinId);
}

/** Thin progress bar along the bottom of a picture; full when watched. */
const ProgressBar = ({ progress }: { progress: number }) =>
  progress > 0 ? (
    <div className="absolute inset-x-0 bottom-0 h-1 bg-gray-900/70">
      <div
        className="h-full bg-indigo-500"
        style={{ width: `${Math.min(100, progress)}%` }}
      />
    </div>
  ) : null;

// --- Discover: Continue Watching ----------------------------------------------

const ContinueCard = ({ item }: { item: WatchItem }) => {
  const base = useJellyfinBase();
  const href = item.tmdbId
    ? `/${item.mediaType === 'movie' ? 'movie' : 'tv'}/${item.tmdbId}`
    : undefined;
  return (
    <div className="group relative aspect-video w-64 overflow-hidden rounded-xl bg-gray-800 shadow ring-1 ring-gray-700 transition duration-300 hover:scale-105 hover:ring-gray-500 sm:w-80">
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
      <button
        type="button"
        aria-label={`Play ${item.title}`}
        onClick={() => openPlayer(item.jellyfinId)}
        className="absolute inset-0 flex items-center justify-center"
      >
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600/90 text-white opacity-0 transition group-hover:opacity-100">
          <PlayIcon className="ml-0.5 h-7 w-7" />
        </span>
      </button>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 pb-3 pl-3 pr-14 text-left">
        <div className="truncate text-base font-bold text-white">
          {item.title}
        </div>
        {item.subtitle && (
          <div className="truncate text-xs text-gray-300">{item.subtitle}</div>
        )}
      </div>
      {href && (
        <Link
          href={href}
          title="Details"
          aria-label={`${item.title} details`}
          className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-full border-2 border-gray-300 bg-gray-900/60 text-white opacity-0 transition hover:scale-110 hover:border-white group-hover:opacity-100"
        >
          <ChevronDownIcon className="h-5 w-5" />
        </Link>
      )}
      <ProgressBar progress={item.progress} />
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
  return <ProgressBar progress={state.played ? 100 : state.progress} />;
};

/** Whether a title card gets the round action buttons (Play, Request). */
export const useCardActions = (mediaType: string) => {
  const canWatch = useCanWatch();
  return canWatch && (mediaType === 'movie' || mediaType === 'tv');
};

const RoundButton = ({
  label,
  onClick,
  primary = false,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    title={label}
    aria-label={label}
    disabled={disabled}
    onClick={(e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    }}
    className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full transition hover:scale-110 disabled:opacity-60 ${
      primary
        ? 'bg-white text-gray-900 hover:bg-gray-200'
        : 'border-2 border-gray-300 bg-gray-900/60 text-white hover:border-white'
    }`}
  >
    {children}
  </button>
);

/**
 * Bottom of a title card on hover: ▶ (play/resume, or request-and-play when it isn't in
 * the library) and ↓ (Seerr's request dialog) as round icons, Netflix style. Accounts not
 * linked to Jellyfin keep Seerr's own Request button (`fallback`).
 */
export const CardActions = ({
  tmdbId,
  mediaType,
  title,
  canRequest,
  onRequest,
  fallback,
}: {
  tmdbId: number;
  mediaType: string;
  title: string;
  canRequest: boolean;
  onRequest: () => void;
  fallback: React.ReactNode;
}) => {
  const enabled = useCardActions(mediaType);
  const states = useWatchStates();
  const [busy, setBusy] = useState(false);
  if (!enabled) return <>{fallback}</>;
  const state =
    mediaType === 'movie' ? states?.movie[tmdbId] : states?.tv[tmdbId];
  const resume =
    mediaType === 'movie' && state && state.progress > 0 && !state.played;
  const play = async () => {
    setBusy(true);
    try {
      if (!state)
        await openPlayer({
          prepare: { mediaType: mediaType as 'movie' | 'tv', tmdbId, title },
        });
      else if (mediaType === 'movie') await openPlayer(state.jellyfinId);
      else await playSeries(tmdbId);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-2">
      <RoundButton
        label={resume ? 'Resume' : 'Play'}
        onClick={play}
        primary
        disabled={busy || !states}
      >
        <PlayIcon className="ml-0.5 h-5 w-5" />
      </RoundButton>
      {canRequest && (
        <RoundButton label="Request" onClick={onRequest}>
          <ArrowDownIcon className="h-5 w-5" />
        </RoundButton>
      )}
    </div>
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
