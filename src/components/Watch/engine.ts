// Home-theatre fork: playback against Jellyfin for the in-Seerr player.
// Asks Jellyfin how to stream to this browser (PlaybackInfo with a device profile), plays it
// directly or as HLS via hls.js, reports progress so resume/watched state stay in Jellyfin,
// and falls back to a full H.264 transcode if the browser can't decode what it was sent.
import { deviceId, getSession, jf } from '@app/components/Watch/session';
import type HlsType from 'hls.js';
import type { ErrorData } from 'hls.js';

export const TICKS = 10_000_000;

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

export interface Toast {
  text: string;
  action?: string;
  onAction?: () => void;
  /** ms before it goes away; 0 = until replaced */
  timeout?: number;
  id?: string;
}

export function deviceProfile({ h264Only = false } = {}) {
  const mse = (type: string) =>
    typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type);
  const video = ['h264'];
  if (!h264Only) {
    if (
      mse('video/mp4; codecs="hvc1.1.6.L120.90"') ||
      mse('video/mp4; codecs="hev1.1.6.L120.90"')
    )
      video.push('hevc');
    if (mse('video/mp4; codecs="av01.0.08M.08"')) video.push('av1');
    if (mse('video/mp4; codecs="vp09.00.10.08"')) video.push('vp9');
  }
  const audio = ['aac', 'mp3'];
  if (mse('audio/mp4; codecs="ec-3"')) audio.push('eac3');
  if (mse('audio/mp4; codecs="ac-3"')) audio.push('ac3');
  if (mse('audio/mp4; codecs="opus"')) audio.push('opus');
  if (mse('audio/mp4; codecs="flac"')) audio.push('flac');
  const webm = video.filter((c) => c === 'vp9' || c === 'av1');
  return {
    MaxStreamingBitrate: 120_000_000,
    MaxStaticBitrate: 120_000_000,
    DirectPlayProfiles: h264Only
      ? []
      : [
          {
            Container: 'mp4,m4v',
            Type: 'Video',
            VideoCodec: video.join(','),
            AudioCodec: audio.join(','),
          },
          ...(webm.length
            ? [
                {
                  Container: 'webm',
                  Type: 'Video',
                  VideoCodec: webm.join(','),
                  AudioCodec: 'opus,vorbis',
                },
              ]
            : []),
        ],
    // mkv and friends: Jellyfin repackages into HLS, copying the video when the browser decodes it.
    TranscodingProfiles: [
      {
        Container: 'mp4',
        Type: 'Video',
        Protocol: 'hls',
        Context: 'Streaming',
        VideoCodec: video.join(','),
        AudioCodec: audio.join(','),
        MaxAudioChannels: '6',
        MinSegments: 1,
        BreakOnNonKeyFrames: true,
      },
    ],
    ContainerProfiles: [],
    CodecProfiles: [],
    SubtitleProfiles: [
      { Format: 'vtt', Method: 'External' },
      // Picture-based subtitles get burned in when picked.
      { Format: 'pgssub', Method: 'Encode' },
      { Format: 'dvdsub', Method: 'Encode' },
      { Format: 'dvbsub', Method: 'Encode' },
    ],
  };
}

// Files often flag a dub as the default track. With no audio language set in Jellyfin,
// prefer the browser's language when the file has it (null = let Jellyfin pick).
const LANGS: Record<string, string[]> = {
  en: ['eng'],
  fr: ['fra', 'fre'],
  de: ['deu', 'ger'],
  es: ['spa'],
  it: ['ita'],
  pt: ['por'],
  nl: ['nld', 'dut'],
  sv: ['swe'],
  da: ['dan'],
  no: ['nor', 'nob'],
  nb: ['nob', 'nor'],
  fi: ['fin'],
  pl: ['pol'],
  ja: ['jpn'],
  ko: ['kor'],
  zh: ['zho', 'chi'],
  af: ['afr'],
  ru: ['rus'],
  tr: ['tur'],
  el: ['ell', 'gre'],
  cs: ['ces', 'cze'],
  hu: ['hun'],
  ro: ['ron', 'rum'],
};
async function preferredAudio(item: Json): Promise<number | null> {
  const audio = (item.MediaStreams || []).filter(
    (s: Json) => s.Type === 'Audio'
  );
  if (audio.length < 2) return null;
  try {
    const me = await jf<Json>('/Users/Me');
    if (me.Configuration?.AudioLanguagePreference) return null;
  } catch {
    return null;
  }
  for (const lang of navigator.languages || [navigator.language]) {
    const codes = LANGS[String(lang).slice(0, 2).toLowerCase()] || [];
    const match =
      audio.find((s: Json) => s.IsDefault && codes.includes(s.Language)) ||
      audio.find((s: Json) => codes.includes(s.Language));
    if (match) return match.IsDefault ? null : match.Index;
  }
  return null;
}

export const clock = (seconds: number) => {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60),
    m = Math.floor(seconds / 60) % 60,
    h = Math.floor(seconds / 3600);
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
};

export class Engine {
  item: Json = null;
  next: Json = null;
  source: Json = null;
  baseUrl = '/jellyfin';
  userId = '';
  playSessionId: string | null = null;
  playMethod = 'Transcode';
  audioIndex: number | null = null;
  subIndex: number | null = null; // null = default, -1 = off
  error: string | null = null;
  loading = true;
  private h264Only = false;
  private forceTranscode = false;
  private fallbacks = 0;
  private hls: HlsType | null = null;
  private hlsRecovered = false;
  private reported = false;
  private progressTimer: ReturnType<typeof setInterval> | undefined;
  private destroyed = false;
  private listeners: [string, EventListener][] = [];

  constructor(
    private video: HTMLVideoElement,
    private emit: () => void,
    private toast: (t: Toast | null, id?: string) => void
  ) {
    const on = (ev: string, fn: EventListener) => {
      video.addEventListener(ev, fn);
      this.listeners.push([ev, fn]);
    };
    on('playing', () => {
      if (!this.reported) {
        this.reported = true;
        this.report('/Sessions/Playing');
      }
    });
    on('pause', () => this.progress('Pause'));
    on('play', () => this.progress('Unpause'));
    on('seeked', () => this.progress('TimeUpdate'));
    on('error', () => {
      if (!this.hls && video.error && video.getAttribute('src')) {
        this.fallback();
      }
    });
  }

  get duration(): number {
    const d = this.video.duration;
    if (isFinite(d) && d > 0) return d;
    return (this.item?.RunTimeTicks || this.source?.RunTimeTicks || 0) / TICKS;
  }

  image(itemId: string, type = 'Primary', width = 1280) {
    return `${this.baseUrl}/Items/${itemId}/Images/${type}?fillWidth=${width}&quality=90`;
  }

  streams(type: string): Json[] {
    return (this.source?.MediaStreams || []).filter(
      (s: Json) => s.Type === type
    );
  }

  get burnIn(): boolean {
    if (this.subIndex === null || this.subIndex < 0 || !this.source)
      return false;
    const s = this.streams('Subtitle').find(
      (x: Json) => x.Index === this.subIndex
    );
    return !!s && s.DeliveryMethod !== 'External';
  }

  async open(itemId: string) {
    await this.stop(false);
    Object.assign(this, {
      item: null,
      next: null,
      source: null,
      audioIndex: null,
      subIndex: null,
      error: null,
      loading: true,
      h264Only: false,
      forceTranscode: false,
      fallbacks: 0,
    });
    this.toast(null);
    this.emit();
    try {
      const s = await getSession();
      this.baseUrl = s.baseUrl;
      this.userId = s.userId;
      const it = await jf<Json>(
        `/Items/${itemId}?userId=${this.userId}&fields=MediaStreams,ProviderIds`
      );
      this.item = it;
      this.emit();
      if (it.Type === 'Episode') {
        jf<Json>(
          `/Shows/${it.SeriesId}/Episodes?userId=${this.userId}&startItemId=${it.Id}&limit=2`
        )
          .then((r) => {
            this.next = r.Items.find((e: Json) => e.Id !== it.Id) || null;
            this.emit();
          })
          .catch(() => undefined);
      }
      this.audioIndex = await preferredAudio(it);
      const pos = it.UserData?.PlaybackPositionTicks || 0;
      const resumeAt = pos && !it.UserData?.Played ? pos / TICKS : 0;
      await this.load(resumeAt);
      if (resumeAt > 30) {
        this.toast({
          text: `Resumed at ${clock(resumeAt)}`,
          action: 'Start over',
          onAction: () => this.seek(0),
          timeout: 8000,
        });
      }
    } catch (e) {
      this.fail(e);
    }
  }

  async load(startAt = 0, { keepPaused = false } = {}) {
    await this.stop(false);
    this.teardownMedia();
    this.loading = true;
    this.emit();
    const it = this.item;
    const burnRequested = this.burnIn;
    const info = await jf<Json>(
      `/Items/${it.Id}/PlaybackInfo?userId=${this.userId}`,
      {
        method: 'POST',
        body: {
          UserId: this.userId,
          DeviceProfile: deviceProfile({ h264Only: this.h264Only }),
          MaxStreamingBitrate: 120_000_000,
          AudioStreamIndex: this.audioIndex ?? undefined,
          SubtitleStreamIndex: this.burnIn ? this.subIndex : undefined,
          EnableDirectPlay:
            !this.forceTranscode && !this.burnIn && this.audioIndex === null,
          EnableDirectStream: true,
          EnableTranscoding: true,
          AllowVideoStreamCopy: !this.h264Only,
          AllowAudioStreamCopy: true,
          AutoOpenLiveStream: true,
        },
      }
    );
    if (this.destroyed) return;
    if (info.ErrorCode)
      throw new Error(`Jellyfin can't play this file (${info.ErrorCode}).`);
    const source = info.MediaSources[0];
    this.source = source;
    this.playSessionId = info.PlaySessionId;
    if (this.audioIndex === null)
      this.audioIndex = source.DefaultAudioStreamIndex ?? null;
    if (this.subIndex === null)
      this.subIndex = source.DefaultSubtitleStreamIndex ?? -1;
    if (this.burnIn && !burnRequested) this.subIndex = -1;

    let url: string;
    const s = await getSession();
    if (source.SupportsDirectPlay && !source.TranscodingUrl) {
      this.playMethod = 'DirectPlay';
      const q = new URLSearchParams({
        static: 'true',
        mediaSourceId: source.Id,
        deviceId,
        playSessionId: info.PlaySessionId,
        ApiKey: s.token,
      });
      if (source.ETag) q.set('Tag', source.ETag);
      url = `${this.baseUrl}/Videos/${it.Id}/stream.${source.Container.split(',')[0]}?${q}`;
    } else if (source.TranscodingUrl) {
      this.playMethod = source.TranscodeReasons?.length
        ? 'Transcode'
        : 'DirectStream';
      url = this.baseUrl + source.TranscodingUrl;
    } else {
      throw new Error(
        'Jellyfin found no way to stream this file to this browser.'
      );
    }

    const v = this.video;
    if (url.includes('.m3u8')) {
      const Hls = (await import('hls.js')).default;
      if (Hls.isSupported()) {
        const hls = new Hls({
          startPosition: startAt,
          maxBufferLength: 30,
          maxMaxBufferLength: 120,
          backBufferLength: 60,
          // Subtitles come as a <track>, not from the stream.
          subtitleTrackController: undefined,
          subtitleStreamController: undefined,
          timelineController: undefined,
        });
        hls.on(Hls.Events.ERROR, (_e, data) => this.onHlsError(Hls, data));
        hls.loadSource(url);
        hls.attachMedia(v);
        this.hls = hls;
      } else {
        this.nativeSource(url, startAt);
      }
    } else {
      this.nativeSource(url, startAt);
    }
    this.showSubtitle();
    this.hlsRecovered = false;
    this.loading = false;
    this.emit();
    if (!keepPaused) v.play().catch(() => this.emit());
    this.startReporting();
  }

  private nativeSource(url: string, startAt: number) {
    const v = this.video;
    v.src = url;
    if (startAt)
      v.addEventListener(
        'loadedmetadata',
        () => {
          v.currentTime = startAt;
        },
        { once: true }
      );
  }

  // Only the chosen subtitle is a <track>: browsers with a captions preference switch the
  // first track on by themselves, so there must be nothing else to pick.
  private showSubtitle() {
    const v = this.video;
    for (const t of Array.from(v.querySelectorAll('track'))) t.remove();
    this.toast(null, 'subs');
    const s = this.streams('Subtitle').find(
      (x: Json) => x.Index === this.subIndex
    );
    if (!s || s.DeliveryMethod !== 'External' || !s.DeliveryUrl) return;
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = s.DisplayTitle || s.Language || `Track ${s.Index}`;
    if (s.Language) track.srclang = s.Language;
    track.src = (s.IsExternalUrl ? '' : this.baseUrl) + s.DeliveryUrl;
    v.appendChild(track);
    track.track.mode = 'showing';
    // Embedded subtitles: Jellyfin reads the whole file from Real-Debrid once to extract
    // them (then caches them), so the first time can take a minute or two.
    const slow = setTimeout(
      () =>
        this.toast({
          id: 'subs',
          text: 'Loading subtitles… the first time takes a minute or two.',
          timeout: 0,
        }),
      800
    );
    const done = (msg?: string) => {
      clearTimeout(slow);
      this.toast(null, 'subs');
      if (msg) this.toast({ text: msg, timeout: 6000 });
    };
    track.addEventListener('load', () => done(), { once: true });
    track.addEventListener(
      'error',
      () => done("Couldn't load those subtitles."),
      { once: true }
    );
  }

  private onHlsError(Hls: typeof HlsType, data: ErrorData) {
    if (!data.fatal || !this.hls) return;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !this.hlsRecovered) {
      this.hlsRecovered = true;
      this.hls.recoverMediaError();
    } else if (
      data.type === Hls.ErrorTypes.NETWORK_ERROR &&
      !this.hlsRecovered
    ) {
      this.hlsRecovered = true;
      this.hls.startLoad();
    } else {
      this.fallback();
    }
  }

  // The browser choked on what Jellyfin sent: ask for a full H.264 transcode instead.
  private fallback() {
    const at = this.video.currentTime || 0;
    if (this.fallbacks >= 2) {
      this.fail(
        new Error(
          "This browser couldn't play the stream, even after converting it."
        )
      );
      return;
    }
    this.forceTranscode = true;
    if (this.fallbacks === 1) this.h264Only = true;
    this.fallbacks += 1;
    this.load(at).catch((e) => this.fail(e));
  }

  fail(e: unknown) {
    this.teardownMedia();
    this.loading = false;
    this.error = (e as Error)?.message || String(e);
    this.emit();
  }

  setAudio(index: number) {
    if (index === this.audioIndex) return;
    this.audioIndex = index;
    this.load(this.video.currentTime, { keepPaused: this.video.paused }).catch(
      (e) => this.fail(e)
    );
  }

  setSubtitle(index: number) {
    if (index === this.subIndex) return;
    const wasBurned = this.burnIn;
    this.subIndex = index;
    if (wasBurned || this.burnIn) {
      this.load(this.video.currentTime, {
        keepPaused: this.video.paused,
      }).catch((e) => this.fail(e));
    } else {
      this.showSubtitle();
      this.progress('SubtitleTrackChange');
    }
    this.emit();
  }

  cycleSubtitles() {
    const order = [
      -1,
      ...this.streams('Subtitle')
        .filter((s: Json) => s.DeliveryMethod === 'External')
        .map((s: Json) => s.Index as number),
    ];
    this.setSubtitle(
      order[(order.indexOf(this.subIndex ?? -1) + 1) % order.length]
    );
  }

  seek(t: number) {
    const v = this.video;
    v.currentTime = Math.max(0, Math.min(t, (this.duration || t) - 0.5));
  }

  // --- Reporting to Jellyfin (resume points, watched state, "now playing") ---
  private report(path: string, extra: Json = {}, keepalive = false) {
    if (!this.playSessionId) return Promise.resolve();
    const v = this.video;
    return jf(path, {
      method: 'POST',
      keepalive,
      retry: !keepalive,
      body: {
        ItemId: this.item?.Id,
        MediaSourceId: this.source?.Id,
        PlaySessionId: this.playSessionId,
        PositionTicks: Math.round((v.currentTime || 0) * TICKS),
        IsPaused: v.paused,
        IsMuted: v.muted,
        VolumeLevel: Math.round(v.volume * 100),
        PlayMethod: this.playMethod,
        CanSeek: true,
        AudioStreamIndex: this.audioIndex ?? undefined,
        SubtitleStreamIndex: this.subIndex ?? -1,
        ...extra,
      },
    }).catch(() => undefined);
  }

  private progress(event: string) {
    if (this.reported)
      this.report('/Sessions/Playing/Progress', { EventName: event });
  }

  private startReporting() {
    this.reported = false;
    clearInterval(this.progressTimer);
    this.progressTimer = setInterval(() => {
      if (!this.video.paused) this.progress('TimeUpdate');
    }, 10_000);
  }

  async stop(keepalive: boolean) {
    clearInterval(this.progressTimer);
    if (!this.reported || !this.playSessionId) return;
    this.reported = false;
    // Both at once: when the page is going away there's no time to wait for the first.
    await Promise.all([
      this.report('/Sessions/Playing/Stopped', {}, keepalive),
      jf(
        `/Videos/ActiveEncodings?deviceId=${encodeURIComponent(deviceId)}&playSessionId=${this.playSessionId}`,
        { method: 'DELETE', keepalive, retry: false }
      ).catch(() => undefined),
    ]);
  }

  private teardownMedia() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    const v = this.video;
    v.removeAttribute('src');
    v.load();
  }

  destroy() {
    this.destroyed = true;
    this.stop(true);
    this.teardownMedia();
    for (const [ev, fn] of this.listeners)
      this.video.removeEventListener(ev, fn);
  }
}
