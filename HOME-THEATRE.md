# Home-theatre fork of Seerr

Seerr with playback built in, for a Jellyfin + Real-Debrid home server. Branch `home-theatre`,
based on an upstream release tag. GitHub Actions builds it into
`ghcr.io/davidpullinger/seerr:home-theatre` (`.github/workflows/home-theatre.yml`).

## What it adds

- **Continue Watching** row at the top of Discover: films and episodes in progress, then the
  next episode of series you're watching. Click to play.
- **Play inside Seerr**: a full-screen player over the current page (no new tab, no Jellyfin UI).
  Film and series pages get Play / Resume (series: "Resume S1 E3"); title cards get Play on hover;
  each episode in a season list gets Play, a progress bar and a Watched tick.
- **Watched state** on title cards: progress bar, or a tick when watched.

Video streams straight from Jellyfin as the signed-in user: Seerr's server checks the session
and signs the user's linked Jellyfin account in through Quick Connect, approved with Seerr's
Jellyfin API key (Quick Connect must be enabled in Jellyfin). The browser gets that user's token,
never the admin key. Jellyfin must be reachable from the browser at Seerr's "Jellyfin external
URL" (e.g. `/jellyfin` on the same host behind a reverse proxy).

## Where the code is

New files (no upstream conflicts):

- `server/routes/watch.ts`, `server/interfaces/api/watchInterfaces.ts`: `/api/v1/watch/*`
- `src/components/Watch/`: player (`Player.tsx`, `engine.ts`), session, page widgets

Small hooks into upstream files (keep these minimal):

- `server/index.ts`: mounts `/api/v1/watch` before the OpenAPI validator
- `src/components/Discover/index.tsx`: Continue Watching row
- `src/components/TitleCard/index.tsx`: badge + Play button
- `src/components/MovieDetails/index.tsx`, `src/components/TvDetails/index.tsx`: Play/Resume
- `src/components/TvDetails/Season/index.tsx`: per-episode Play
- `package.json`, `pnpm-lock.yaml`: `hls.js`

## Updating to a new Seerr release

```bash
git fetch upstream --tags
git rebase --onto vX.Y.Z <previous-base-tag> home-theatre
# lockfile conflict: take upstream's, then `pnpm add hls.js@<version>`
pnpm typecheck && git push --force-with-lease origin home-theatre
```
