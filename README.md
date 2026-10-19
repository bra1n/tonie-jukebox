# Tonie Jukebox

[![Tests](https://github.com/bra1n/tonie-jukebox/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/bra1n/tonie-jukebox/actions/workflows/test.yml)

A small Node.js server with a plain web page: search YouTube, pick a video, and its audio is
uploaded as MP3 to one of your **creative tonies** via the (unofficial) tonie.cloud API.

## Requirements

- Node.js 22.9+
- Python 3.10+ on Linux/macOS (the default yt-dlp binary is a Python zipapp — see below to avoid this)

`npm install` downloads [yt-dlp](https://github.com/yt-dlp/yt-dlp) (via `youtube-dl-exec`) and a
static ffmpeg (via `ffmpeg-static`). No YouTube API key or Google account is needed.

## Setup

```sh
npm install
```

If your npm config has `ignore-scripts=true`, the binaries are not downloaded. Fetch them explicitly:

```sh
npm rebuild youtube-dl-exec ffmpeg-static --ignore-scripts=false
```

To use the standalone yt-dlp build (no Python needed), set the filename while installing, e.g.
`YOUTUBE_DL_FILENAME=yt-dlp_linux npm install` (or `yt-dlp_macos`).

## Run

Put your tonies.com login into the `.env` file in the project folder (copy `.env.example` if it
doesn't exist yet), then start the server:

```sh
npm start
```

Variables that are already set in the environment take precedence over `.env`.

| Variable         | Description                         |
| ---------------- | ----------------------------------- |
| `TONIE_EMAIL`    | tonies.com account email (required) |
| `TONIE_PASSWORD` | tonies.com password (required)      |
| `PORT`           | HTTP port, default `3000`           |

On startup the server logs in and lists your creative tonies; if that fails it exits.
Then open <http://localhost:3000>.

## Keeping yt-dlp up to date

YouTube changes regularly break older yt-dlp versions. If downloads or searches start failing:

```sh
npm run update-yt-dlp
```

## How it works

- `youtube.js`: searching (`ytsearchN:` via yt-dlp) and downloading audio as MP3 into a temp folder
- `tonie.js`: tonie.cloud login, listing creative tonies, uploading a file and placing it at the
  top of the playlist. "Delete oldest song" removes the **last** track. New songs always go on top,
  so the last track is the oldest.
- `server.js`: Express server with `/api/account`, `/api/search` and `/api/upload`. It is
  stateless: every request logs in to tonie.cloud again and the temp MP3 is deleted afterwards.
- `public/index.html`: the web UI (vanilla HTML/JS)

## Tests

Unit tests use Node's built-in test runner (`node:test`), so there are no extra dependencies.
All YouTube and tonie.cloud calls are replaced with fakes; the tests never touch the network.

```sh
npm test           # run all tests
npm run coverage   # run tests with a coverage report (fails below 80% lines / functions)
```

There is one test file per module in `test/`. GitHub Actions runs `npm run coverage` on every push
and pull request (`.github/workflows/test.yml`), and adds a coverage table per file to the
summary page of each run (Actions tab, then click on a run).
