# Sightseerr

**[Seerr](https://github.com/seerr-team/seerr) with playback built in.** Browse, request and
watch in one place: press Play on anything, in your Jellyfin library or not, and it plays
right there in Seerr's UI.

Sightseerr is an unofficial fork of Seerr. It is not affiliated with or endorsed by the Seerr
team, so please report problems [here](https://github.com/DavidPullinger/sightseerr/issues),
not upstream.

## What it adds

- **Continue Watching** row at the top of Discover: films and episodes in progress, then the
  next episode of series you're watching. The ✕ on a card hides the title until you next play
  something from it (anything under 5 minutes in also has its position cleared).
- **Play inside Seerr**: a full-screen player over the current page, with no new tab and no
  Jellyfin UI. Film and series pages get Play / Resume ("Resume S1 E3"), and title cards get Play
  on hover plus a progress bar or a Watched tick.
- **Play before it's in the library**: Play on a title you don't have yet requests it the
  normal way (the film, or that season), then hurries Radarr/Sonarr and Jellyfin along and starts
  playing as soon as the file is there. This is built for a download client that is near
  instant, such as Real-Debrid through [Decypharr](https://github.com/sirrobot01/decypharr).
- **Episode lists, Netflix style**: every episode of a season with its still and state. Episodes
  you have play, "Not on disk" fetches that episode and plays it, and "Not available yet" means
  it hasn't aired. You can also blur unwatched episodes to avoid spoilers.

Everything else is Seerr as you know it.

## Requirements

- **Jellyfin** as the media server, with **Quick Connect** enabled. Seerr's server signs each user's
  linked Jellyfin account in through Quick Connect, approved with Seerr's Jellyfin API key, so
  the browser only ever gets that user's own token, never the admin key.
- Jellyfin must be **reachable from the browser** at Seerr's "Jellyfin external URL", for example
  `/jellyfin` on the same host behind a reverse proxy, because video streams straight from Jellyfin.
- Radarr and Sonarr connected in Seerr, if you want Play to work on titles you don't have yet.

## Install

It's a drop-in replacement for the Seerr image, with the same config volume and port:

```yaml
services:
  sightseerr:
    image: ghcr.io/davidpullinger/sightseerr:latest
    environment:
      TZ: Etc/UTC
    volumes:
      - ./config:/app/config
    ports:
      - 5055:5055
    restart: unless-stopped
```

Each push to `main` is also published as `ghcr.io/davidpullinger/sightseerr:main-<commit sha>`.
For a complete Jellyfin + Real-Debrid stack that uses Sightseerr, see
[home-theatre](https://github.com/DavidPullinger/home-theatre).

To switch an existing Seerr install, point it at this image and keep its config folder. To go
back, use the Seerr image again; Sightseerr adds no database tables or migrations.

## Where the code is

New files (no upstream conflicts):

- `server/routes/watch.ts`, `server/interfaces/api/watchInterfaces.ts`: `/api/v1/watch/*`
- `server/lib/watch/`: Jellyfin calls, the "play before it's in the library" pipeline
  (`prepare.ts`), and the Continue Watching hide list (`hidden.ts`, in `config/watch-hidden.json`)
- `src/components/Watch/`: the player (`Player.tsx`, `engine.ts`), session, episode list and page
  widgets
- `.github/workflows/sightseerr.yml`: builds and publishes the image

Small hooks into upstream files (keep these minimal):

- `server/index.ts`: mounts `/api/v1/watch` before the OpenAPI validator
- `src/components/Discover/index.tsx`: Continue Watching row
- `src/components/TitleCard/index.tsx`: progress badge and Play button
- `src/components/MovieDetails/index.tsx`, `src/components/TvDetails/index.tsx`: Play / Resume
- `src/components/TvDetails/Season/index.tsx`: episode list
- `server/api/github.ts`, `src/components/Settings/SettingsAbout/`: update checks and release
  links point here; `server/lib/settings/index.ts`: default app title
- `package.json`, `pnpm-lock.yaml`: `hls.js`

## Updating to a new Seerr release

`main` is based on Seerr's release tags. Merge each new release in; don't rebase, because the
history is public:

```bash
git remote add upstream https://github.com/seerr-team/seerr.git   # once
git fetch upstream --tags
git merge vX.Y.Z
# lockfile conflict: take upstream's, then `pnpm add hls.js@<version>`
pnpm typecheck && git push origin main
```

## Credits and licence

Sightseerr is built on [Seerr](https://github.com/seerr-team/seerr) (and before it Overseerr
and Jellyseerr) by its contributors. It is MIT licensed like Seerr; see [LICENSE](LICENSE).
