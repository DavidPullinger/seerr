// Home-theatre fork: the full-screen player opened from Seerr's Play buttons.
import type { Json, Toast } from '@app/components/Watch/engine';
import { Engine, clock } from '@app/components/Watch/engine';
import type { PrepareTarget } from '@app/components/Watch/openPlayer';
import {
  ArrowLeftIcon,
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  ArrowsPointingInIcon,
  ArrowsPointingOutIcon,
  ChatBubbleBottomCenterTextIcon,
  CheckIcon,
  ExclamationTriangleIcon,
  ForwardIcon,
  LanguageIcon,
  PauseIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
} from '@heroicons/react/24/outline';
import { PlayIcon } from '@heroicons/react/24/solid';
import type { PrepareStatus } from '@server/lib/watch/prepare';
import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';

interface PlayerProps {
  jellyfinId?: string;
  prepare?: PrepareTarget;
  onClose: () => void;
}

const STEPS: [PrepareStatus['stage'], string][] = [
  ['requesting', 'Request'],
  ['searching', 'Find a release'],
  ['downloading', 'Fetch from Real-Debrid'],
  ['importing', 'Import'],
  ['adding', 'Add to the library'],
];

/** Shown while something not yet in the library is requested and fetched. */
const Preparing = ({
  target,
  onReady,
  onClose,
}: {
  target: PrepareTarget;
  onReady: (jellyfinId: string) => void;
  onClose: () => void;
}) => {
  const [status, setStatus] = useState<PrepareStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (id: string) => {
      try {
        const { data } = await axios.get<PrepareStatus>(
          `/api/v1/watch/prepare/${encodeURIComponent(id)}`
        );
        if (stopped) return;
        setStatus(data);
        if (data.stage === 'ready' && data.jellyfinId) onReady(data.jellyfinId);
        else if (data.stage !== 'failed')
          timer = setTimeout(() => poll(id), 1500);
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
    };
    axios
      .post<PrepareStatus>('/api/v1/watch/prepare', target)
      .then(({ data }) => {
        if (stopped) return;
        setStatus(data);
        if (data.stage === 'ready' && data.jellyfinId) onReady(data.jellyfinId);
        else poll(data.id);
      })
      .catch((e) =>
        setError(
          e?.response?.data?.error ?? e?.response?.data?.message ?? e.message
        )
      );
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [target, onReady]);

  const failed = error || status?.stage === 'failed';
  const current = STEPS.findIndex(([s]) => s === status?.stage);
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-900 p-4">
      <div className="w-full max-w-md rounded-lg border border-gray-700 bg-gray-800 p-6 shadow-2xl">
        <div className="text-xs font-semibold uppercase tracking-wider text-indigo-400">
          Getting it ready
        </div>
        <h2 className="mt-1 text-xl font-bold text-white">
          {target.title ?? 'Loading'}
          {target.mediaType === 'tv' && (
            <span className="ml-2 text-base font-normal text-gray-400">
              Season {target.seasonNumber ?? 1}
            </span>
          )}
        </h2>
        <ol className="mt-4 space-y-2">
          {STEPS.map(([stage, label], i) => {
            const done = current > i || status?.stage === 'ready';
            const active = current === i && !failed;
            return (
              <li
                key={stage}
                className={`flex items-center gap-3 text-sm ${done ? 'text-gray-300' : active ? 'text-white' : 'text-gray-500'}`}
              >
                <span className="flex h-5 w-5 items-center justify-center">
                  {done ? (
                    <CheckIcon className="h-5 w-5 text-green-400" />
                  ) : active ? (
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-indigo-500" />
                  ) : (
                    <span className="h-2 w-2 rounded-full bg-gray-600" />
                  )}
                </span>
                <span>{active ? status?.message : label}</span>
              </li>
            );
          })}
        </ol>
        {status?.stage === 'downloading' && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-700">
            <div
              className="h-full bg-indigo-500 transition-all"
              style={{ width: `${status.progress ?? 0}%` }}
            />
          </div>
        )}
        {failed && (
          <p className="mt-4 text-sm text-red-300">
            {error ?? status?.message}
          </p>
        )}
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-600 bg-gray-700 px-4 py-2 text-sm font-medium text-gray-200 hover:bg-gray-600"
          >
            {failed ? 'Close' : 'Cancel'}
          </button>
        </div>
        {!failed && (
          <p className="mt-3 text-xs text-gray-500">
            Cancelling keeps the request; it&apos;ll show up in the library when
            it&apos;s ready.
          </p>
        )}
      </div>
    </div>
  );
};

const Player = ({ jellyfinId, prepare, onClose }: PlayerProps) => {
  const [readyId, setReadyId] = useState<string | undefined>(jellyfinId);
  if (!readyId && prepare) {
    return (
      <Preparing target={prepare} onReady={setReadyId} onClose={onClose} />
    );
  }
  return <PlayerView jellyfinId={readyId ?? ''} onClose={onClose} />;
};

const store = {
  get<T>(key: string): T | null {
    try {
      return JSON.parse(localStorage.getItem(`seerr.watch.${key}`) ?? 'null');
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(`seerr.watch.${key}`, JSON.stringify(value));
    } catch {
      // ignore
    }
  },
};

const IconButton = ({
  label,
  onClick,
  children,
  className = '',
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    onClick={(e) => {
      e.stopPropagation();
      e.currentTarget.blur();
      onClick();
    }}
    className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-white transition hover:bg-white/10 ${className}`}
  >
    {children}
  </button>
);

const PlayerView = ({
  jellyfinId,
  onClose,
}: {
  jellyfinId: string;
  onClose: () => void;
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((t) => t + 1), []);
  const [itemId, setItemId] = useState(jellyfinId);
  const [paused, setPaused] = useState(true);
  const [waiting, setWaiting] = useState(true);
  const [time, setTime] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [idle, setIdle] = useState(false);
  const [menu, setMenu] = useState<'audio' | 'subs' | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [upNext, setUpNext] = useState<number | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const engine = engineRef.current;

  const toast = useCallback((t: Toast | null, id?: string) => {
    if (!t) {
      setToasts((list) => (id ? list.filter((x) => x.id !== id) : []));
      return;
    }
    const entry = { ...t, id: t.id ?? String(Math.random()) };
    setToasts((list) => [...list.filter((x) => x.id !== entry.id), entry]);
    if (t.timeout)
      setTimeout(
        () => setToasts((list) => list.filter((x) => x !== entry)),
        t.timeout
      );
  }, []);

  // One engine per player; a new item (next episode) reuses it.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const savedVolume = store.get<number>('volume');
    v.volume = typeof savedVolume === 'number' ? savedVolume : 1;
    v.muted = !!store.get<boolean>('muted');
    engineRef.current = new Engine(v, rerender, toast);
    rerender();
    const onHide = () => engineRef.current?.stop(true);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      engineRef.current?.destroy();
      engineRef.current = null;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => 0);
    };
  }, [rerender, toast]);

  useEffect(() => {
    setUpNext(null);
    engineRef.current?.open(itemId);
  }, [itemId, engine]);

  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) setIdle(true);
    }, 3000);
  }, []);

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) v.play().catch(() => 0);
    else v.pause();
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => 0);
    else rootRef.current?.requestFullscreen?.().catch(() => 0);
  }, []);

  const playNext = useCallback(() => {
    const next = engineRef.current?.next;
    if (next) setItemId(next.Id);
  }, []);

  const seekBy = useCallback((delta: number) => {
    const v = videoRef.current;
    if (v) engineRef.current?.seek(v.currentTime + delta);
  }, []);

  // Video element → UI state
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const update = () => {
      setPaused(v.paused);
      setTime(v.currentTime);
      let end = 0;
      for (let i = 0; i < v.buffered.length; i++)
        if (v.buffered.start(i) <= v.currentTime + 1)
          end = Math.max(end, v.buffered.end(i));
      setBuffered(end);
      setVolume(v.volume);
      setMuted(v.muted);
    };
    const events: [string, () => void][] = [
      ['timeupdate', update],
      ['progress', update],
      ['durationchange', update],
      ['play', update],
      [
        'pause',
        () => {
          update();
          setIdle(false);
        },
      ],
      [
        'volumechange',
        () => {
          update();
          store.set('volume', v.volume);
          store.set('muted', v.muted);
        },
      ],
      ['waiting', () => setWaiting(true)],
      ['playing', () => setWaiting(false)],
      ['canplay', () => setWaiting(false)],
      [
        'ended',
        () => {
          engineRef.current?.stop(false);
          if (engineRef.current?.next) setUpNext(10);
          else onClose();
        },
      ],
    ];
    for (const [ev, fn] of events) v.addEventListener(ev, fn);
    return () => {
      for (const [ev, fn] of events) v.removeEventListener(ev, fn);
    };
  }, [onClose]);

  // Up-next countdown
  useEffect(() => {
    if (upNext === null) return;
    if (upNext <= 0) {
      playNext();
      return;
    }
    const t = setTimeout(
      () => setUpNext((n) => (n === null ? n : n - 1)),
      1000
    );
    return () => clearTimeout(t);
  }, [upNext, playNext]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const v = videoRef.current;
      if (!v) return;
      const keys: Record<string, () => void> = {
        ' ': toggle,
        k: toggle,
        ArrowLeft: () => seekBy(-10),
        ArrowRight: () => seekBy(10),
        j: () => seekBy(-10),
        l: () => seekBy(10),
        ArrowUp: () => {
          v.volume = Math.min(1, v.volume + 0.1);
          v.muted = false;
        },
        ArrowDown: () => {
          v.volume = Math.max(0, v.volume - 0.1);
        },
        m: () => {
          v.muted = !v.muted;
        },
        f: toggleFullscreen,
        c: () => engineRef.current?.cycleSubtitles(),
        n: playNext,
        Escape: () => {
          if (menu) setMenu(null);
          else if (!document.fullscreenElement) onClose();
        },
      };
      const fn = keys[e.key];
      if (!fn) return;
      e.preventDefault();
      e.stopPropagation();
      fn();
      wake();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [toggle, seekBy, toggleFullscreen, playNext, onClose, menu, wake]);

  const total = engine?.duration || 0;
  const shownTime = drag !== null ? drag * total : time;
  const pct = total ? (shownTime / total) * 100 : 0;

  const fraction = (clientX: number) => {
    const r = seekRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  const item: Json = engine?.item;
  const title = item?.Type === 'Episode' ? item.SeriesName : item?.Name;
  const subtitle =
    item?.Type === 'Episode'
      ? `S${item.ParentIndexNumber ?? 0}:E${item.IndexNumber ?? 0} · ${item.Name}`
      : [item?.ProductionYear, item?.OfficialRating]
          .filter(Boolean)
          .join(' · ');
  const poster =
    item && engine
      ? engine.image(
          item.Id,
          item.Type === 'Episode' ? 'Primary' : 'Backdrop',
          1920
        )
      : undefined;
  const next: Json = engine?.next;

  const menuOptions =
    menu === 'audio'
      ? (engine?.streams('Audio') ?? []).map((s: Json) => ({
          value: s.Index as number,
          label: s.DisplayTitle || s.Language || `Track ${s.Index}`,
          selected: s.Index === engine?.audioIndex,
        }))
      : menu === 'subs'
        ? [
            {
              value: -1,
              label: 'Off',
              selected: (engine?.subIndex ?? -1) === -1,
            },
            ...(engine?.streams('Subtitle') ?? []).map((s: Json) => ({
              value: s.Index as number,
              label:
                (s.DisplayTitle || s.Language || `Track ${s.Index}`) +
                (s.DeliveryMethod !== 'External' ? ' (burned in)' : ''),
              selected: s.Index === engine?.subIndex,
            })),
          ]
        : [];

  const controlsHidden = idle && !menu && !paused;

  return (
    <div
      ref={rootRef}
      className={`fixed inset-0 z-[100] select-none overflow-hidden bg-black ${controlsHidden ? 'cursor-none' : ''}`}
      onPointerMove={wake}
      onClick={() => {
        if (menu) setMenu(null);
      }}
      role="presentation"
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        className="h-full w-full bg-black object-contain"
        playsInline
        preload="auto"
        poster={poster}
        onClick={(e) => {
          e.stopPropagation();
          if (menu) setMenu(null);
          else toggle();
        }}
        onDoubleClick={toggleFullscreen}
      />

      {(waiting || engine?.loading) && !engine?.error && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 -ml-6 -mt-6 h-12 w-12 animate-spin rounded-full border-[3px] border-white/15 border-t-indigo-500" />
      )}

      {paused && !waiting && !engine?.loading && !engine?.error && (
        <button
          type="button"
          aria-label="Play"
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          className={`absolute left-1/2 top-1/2 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-indigo-600/90 text-white transition hover:scale-105 hover:bg-indigo-500 ${controlsHidden ? 'opacity-0' : ''}`}
        >
          <PlayIcon className="ml-1 h-9 w-9" />
        </button>
      )}

      {/* Top bar */}
      <div
        className={`absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/75 to-transparent px-5 pb-8 pt-4 transition-opacity duration-300 ${controlsHidden ? 'pointer-events-none opacity-0' : ''}`}
      >
        <IconButton label="Back" onClick={onClose}>
          <ArrowLeftIcon className="h-6 w-6" />
        </IconButton>
        <div className="min-w-0">
          <div className="truncate text-lg font-bold text-white">{title}</div>
          <div className="truncate text-sm text-gray-300">{subtitle}</div>
        </div>
      </div>

      {/* Bottom controls */}
      <div
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-5 pb-4 pt-12 transition-opacity duration-300 ${controlsHidden ? 'pointer-events-none opacity-0' : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="presentation"
      >
        <div
          ref={seekRef}
          className="group relative flex h-5 cursor-pointer touch-none items-center"
          onPointerMove={(e) => {
            setHover(fraction(e.clientX));
            if (drag !== null) setDrag(fraction(e.clientX));
          }}
          onPointerLeave={() => setHover(null)}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setDrag(fraction(e.clientX));
          }}
          onPointerUp={(e) => {
            if (drag === null) return;
            const f = fraction(e.clientX);
            setDrag(null);
            engine?.seek(f * total);
          }}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(shownTime)}
          tabIndex={-1}
        >
          <div className="relative h-1 w-full rounded-full bg-white/20 transition-all group-hover:h-1.5">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-white/35"
              style={{
                width: `${total ? Math.min(100, (buffered / total) * 100) : 0}%`,
              }}
            />
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-indigo-500"
              style={{ width: `${pct}%` }}
            />
            <div
              className={`absolute top-1/2 -ml-[7px] -mt-[7px] h-3.5 w-3.5 rounded-full bg-white shadow ring-4 ring-indigo-500/35 transition-transform ${drag !== null ? 'scale-100' : 'scale-0 group-hover:scale-100'}`}
              style={{ left: `${pct}%` }}
            />
          </div>
          {hover !== null && (
            <div
              className="pointer-events-none absolute bottom-6 -translate-x-1/2 rounded border border-gray-600 bg-gray-800 px-2 py-0.5 text-xs text-white"
              style={{ left: `${hover * 100}%` }}
            >
              {clock(hover * total)}
            </div>
          )}
        </div>

        <div className="mt-1 flex items-center gap-1">
          <IconButton label={paused ? 'Play' : 'Pause'} onClick={toggle}>
            {paused ? (
              <PlayIcon className="h-6 w-6" />
            ) : (
              <PauseIcon className="h-6 w-6" />
            )}
          </IconButton>
          <IconButton
            label="Back 10 seconds"
            onClick={() => seekBy(-10)}
            className="hidden sm:flex"
          >
            <ArrowUturnLeftIcon className="h-6 w-6" />
          </IconButton>
          <IconButton
            label="Forward 10 seconds"
            onClick={() => seekBy(10)}
            className="hidden sm:flex"
          >
            <ArrowUturnRightIcon className="h-6 w-6" />
          </IconButton>
          <div className="group/vol hidden items-center sm:flex">
            <IconButton
              label={muted ? 'Unmute' : 'Mute'}
              onClick={() => {
                const v = videoRef.current;
                if (!v) return;
                v.muted = !v.muted;
                if (!v.muted && v.volume === 0) v.volume = 0.5;
              }}
            >
              {muted || volume === 0 ? (
                <SpeakerXMarkIcon className="h-6 w-6" />
              ) : (
                <SpeakerWaveIcon className="h-6 w-6" />
              )}
            </IconButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              aria-label="Volume"
              value={muted ? 0 : volume}
              onChange={(e) => {
                const v = videoRef.current;
                if (!v) return;
                v.volume = Number(e.target.value);
                v.muted = v.volume === 0;
              }}
              className="w-0 accent-indigo-500 opacity-0 transition-all group-hover/vol:mx-1 group-hover/vol:w-20 group-hover/vol:opacity-100"
            />
          </div>
          <span className="ml-2 whitespace-nowrap text-xs tabular-nums text-gray-200 sm:text-sm">
            {clock(shownTime)} / {clock(total)}
          </span>
          <span className="flex-1" />
          {next && (
            <IconButton label="Next episode" onClick={playNext}>
              <ForwardIcon className="h-6 w-6" />
            </IconButton>
          )}
          <IconButton
            label="Audio"
            onClick={() => setMenu(menu === 'audio' ? null : 'audio')}
          >
            <LanguageIcon className="h-6 w-6" />
          </IconButton>
          <IconButton
            label="Subtitles"
            onClick={() => setMenu(menu === 'subs' ? null : 'subs')}
          >
            <ChatBubbleBottomCenterTextIcon className="h-6 w-6" />
          </IconButton>
          <IconButton
            label={fullscreen ? 'Exit full screen' : 'Full screen'}
            onClick={toggleFullscreen}
          >
            {fullscreen ? (
              <ArrowsPointingInIcon className="h-6 w-6" />
            ) : (
              <ArrowsPointingOutIcon className="h-6 w-6" />
            )}
          </IconButton>
        </div>
      </div>

      {menu && (
        <div
          className="absolute bottom-24 right-5 z-10 max-h-[60vh] min-w-[14rem] max-w-[calc(100vw-2.5rem)] overflow-y-auto rounded-lg border border-gray-700 bg-gray-800/95 p-1.5 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          role="presentation"
        >
          <h4 className="mx-2 mb-1.5 mt-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
            {menu === 'audio' ? 'Audio' : 'Subtitles'}
          </h4>
          {menuOptions.length === 0 && (
            <div className="px-2 py-2 text-sm text-gray-400">
              No {menu === 'audio' ? 'audio' : 'subtitle'} tracks
            </div>
          )}
          {menuOptions.map((o) => (
            <button
              type="button"
              key={o.value}
              onClick={() => {
                setMenu(null);
                if (menu === 'audio') engine?.setAudio(o.value);
                else engine?.setSubtitle(o.value);
              }}
              className={`flex w-full items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-gray-700 hover:text-white ${o.selected ? 'text-white' : 'text-gray-200'}`}
            >
              <CheckIcon
                className={`h-4 w-4 flex-shrink-0 text-indigo-400 ${o.selected ? '' : 'invisible'}`}
              />
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      )}

      {toasts.length > 0 && (
        <div className="absolute left-1/2 top-20 z-10 flex -translate-x-1/2 flex-col items-center gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className="flex items-center gap-3 whitespace-nowrap rounded-lg border border-gray-700 bg-gray-800/95 py-2 pl-4 pr-2 text-sm text-gray-200 shadow-lg"
            >
              <span className={t.action ? '' : 'pr-2'}>{t.text}</span>
              {t.action && (
                <button
                  type="button"
                  className="rounded-md border border-gray-600 bg-gray-700 px-3 py-1 text-sm font-medium text-white hover:bg-gray-600"
                  onClick={(e) => {
                    e.stopPropagation();
                    toast(null, t.id);
                    t.onAction?.();
                  }}
                >
                  {t.action}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {upNext !== null && next && engine && (
        <div
          className="absolute bottom-24 right-5 z-10 w-80 max-w-[calc(100vw-2.5rem)] overflow-hidden rounded-lg border border-gray-700 bg-gray-800 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          role="presentation"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={engine.image(next.Id, 'Primary', 640)}
            alt=""
            className="aspect-video w-full bg-gray-700 object-cover"
          />
          <div className="p-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-indigo-400">
              Up next in {upNext}
            </div>
            <div className="mt-0.5 text-sm font-semibold text-white">
              S{next.ParentIndexNumber ?? 0}:E{next.IndexNumber ?? 0} ·{' '}
              {next.Name}
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={playNext}
                className="inline-flex items-center gap-1.5 rounded-md border border-indigo-500 bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
              >
                <PlayIcon className="h-4 w-4" />
                Play now
              </button>
              <button
                type="button"
                onClick={() => setUpNext(null)}
                className="rounded-md border border-gray-600 bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-200 hover:bg-gray-600"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {engine?.error && (
        <div
          className="absolute left-1/2 top-1/2 z-20 w-[32rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-700 bg-gray-800 p-6 text-center"
          onClick={(e) => e.stopPropagation()}
          role="presentation"
        >
          <ExclamationTriangleIcon className="mx-auto h-12 w-12 text-red-400" />
          <h2 className="mt-2 text-xl font-bold text-white">
            Can&apos;t play this
          </h2>
          <p className="mb-4 mt-2 text-sm text-gray-300">{engine.error}</p>
          <div className="flex justify-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-600 bg-gray-700 px-4 py-2 text-sm font-medium text-gray-200 hover:bg-gray-600"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => engine.open(itemId)}
              className="rounded-md border border-indigo-500 bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              Try again
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Player;
