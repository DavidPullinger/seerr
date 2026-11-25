// Home-theatre fork: types for /api/v1/watch (playing from Jellyfin inside Seerr).

export interface WatchSessionResponse {
  token: string;
  userId: string;
  serverId: string;
  /** Jellyfin's address as the browser should use it (e.g. "/jellyfin"). */
  baseUrl: string;
}

/** Something to play: a film, or an episode of a series. */
export interface WatchItem {
  jellyfinId: string;
  mediaType: 'movie' | 'tv';
  /** TMDB id of the film or the series, for linking to Seerr's page. */
  tmdbId?: number;
  title: string;
  /** "S1:E3 · Episode name" for episodes. */
  subtitle?: string;
  /** 0–100; 0 for an episode that hasn't been started. */
  progress: number;
  /** Jellyfin item + image type for a landscape picture. */
  image?: { itemId: string; type: 'Primary' | 'Backdrop' | 'Thumb' };
}

export interface WatchHomeResponse {
  continueWatching: WatchItem[];
}

export interface WatchState {
  jellyfinId: string;
  played: boolean;
  /** Films: 0–100. Series: share of episodes watched. */
  progress: number;
}

export interface WatchStatesResponse {
  movie: Record<number, WatchState>;
  tv: Record<number, WatchState>;
}

export interface WatchEpisodeState extends WatchState {
  episodeNumber: number;
  name?: string;
  overview?: string;
  /** YYYY-MM-DD */
  airDate?: string;
  /** Jellyfin has a still for it (Items/{jellyfinId}/Images/Primary). */
  hasImage: boolean;
}

export interface WatchSeasonResponse {
  episodes: WatchEpisodeState[];
}

export interface WatchNextResponse {
  next?: WatchItem & { resume: boolean; season?: number; episode?: number };
}
