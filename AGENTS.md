# Agent notes for Tonie Jukebox

Context for coding agents working on this repo. The README covers setup and usage for humans; this
file covers how the code fits together, the constraints that aren't obvious from reading it, and how
to check changes.

## What it is

A small Node.js (CommonJS, Node 22.9+) Express server plus a plain web page: search YouTube, pick a
video, and its audio is converted to MP3 and uploaded to a creative tonie via the unofficial
tonie.cloud API. No build step, no frontend framework, three runtime dependencies (`express`,
`youtube-dl-exec`, `ffmpeg-static`).

- `server.js`: `createApp({ youtube, tonieCloud, auth })` builds the app (static `public/` + JSON API:
  `GET /api/account`, `GET /api/search?q=&page=`, `POST /api/upload`); `start()` reads `.env`, validates
  config and refuses to start half-configured (e.g. only one of `AUTH_USER`/`AUTH_PASSWORD`, or an
  unreadable/unwritable `YTDLP_COOKIES` file). Errors are returned as `{ error }` so the UI can show them.
- `youtube.js`: `YouTube` class wrapping yt-dlp. All calls go through `ytdlp()`, which adds the common
  flags: `jsRuntimes: node:<process.execPath>` (yt-dlp only looks for deno by default) and `cookies`
  when a cookies file is configured. Videos over 10 minutes are shown but can't be added.
- `tonie.js`: `TonieCloud` class. Stateless: every public method logs in again. New songs go on top
  of the playlist, so "delete oldest" removes the **last** track.
- `public/index.html` (markup), `public/style.css`, `public/app.js` (vanilla browser JS, classic script).

Dependencies are injected (`exec`, `fetch`, `ffmpegPath`, `youtube`, `tonieCloud`) so tests can pass fakes.

## Commands

```sh
npm test           # node:test, all network calls faked
npm run coverage   # what CI runs; fails below 80% lines/functions, 70% branches
npm run lint       # ESLint, --max-warnings=0
npm start          # needs TONIE_EMAIL / TONIE_PASSWORD in .env
```

CI (`.github/workflows/test.yml`) runs lint and coverage on Node 24 with `npm ci --ignore-scripts`,
so the yt-dlp and ffmpeg binaries are not available there. Tests must never need them.

## Constraints that are easy to break

- **Reverse-proxy sub-directory support.** The app must keep working behind a proxy that strips a
  path prefix (e.g. `https://example.com/jukebox/` → `http://localhost:3000/`). Therefore:
  - All URLs in `public/` (stylesheet, script, `api/...` fetches) are **relative**, never `/...`.
  - The small inline `<script>` at the top of `<head>` in `index.html` adds the missing trailing
    slash (`/jukebox` → `/jukebox/`). It must stay inline and come **before** `style.css` and
    `app.js`; moving it into `app.js` breaks it, because `app.js` itself would then load from `/app.js`.
  - Without the slash, the browser's preload scanner may still request `/style.css` and `/app.js`
    once before the fix runs. That's harmless and expected.
- **Result list scrolling.** Only `#results` scrolls; the page body must not. The hidden radio inside
  each `.video` card is `position: absolute`, so `.video` must stay `position: relative`. Otherwise
  focusing a radio scrolls the whole page past the list.
- **Thumbnail preview link.** Each card is a `<label>` for its radio; the thumbnail is an `<a>` that
  opens the video on YouTube in a new tab. A link inside a label doesn't select the radio, so it
  must stay a real link (don't turn it into a `<span>` with a click handler).
- **ESLint has two scopes**: Node/CommonJS for the server code, browser globals + `sourceType: script`
  for `public/**/*.js`.
- **Secrets**: `.env` and `cookies.txt` are gitignored. Never print cookie values or credentials;
  when inspecting a cookies file, list only domains, names and expiry dates.

## Code style

Match the existing code: JSDoc on every function and class (with `@param`/`@returns`/`@throws`),
short comments that explain *why*, plain modern JS, no TypeScript, no new dependencies without a good
reason. Keep the UI dependency-free. Tests: one file per module in `test/`, using `node:test`,
`node:assert/strict` and `mock.fn` fakes.

## Checking UI changes in a real browser

Unit tests don't cover `public/`. To check the page (including the sub-directory case), run
`createApp` with fake `youtube`/`tonieCloud` objects on one port, put a tiny Node `http` proxy in
front that strips `/jukebox`, and screenshot with headless Firefox:

```sh
firefox --headless --profile "$(mktemp -d)" --window-size 500,800 --screenshot shot.png http://localhost:<proxy-port>/jukebox
```

Log the proxied request paths to confirm `style.css`, `app.js` and `api/...` resolve under `/jukebox/`.
For CSS behaviour (e.g. scrolling), a standalone test page that links `public/style.css`, builds the
markup, and writes measurements such as `window.scrollY` into the page before the screenshot works well.

## Deployment and YouTube blocking

The production instance runs on a VPS, where yt-dlp is kept up to date by a regular
`npm run update-yt-dlp` job. YouTube blocks many datacenter IPs: there, downloads fail with
`HTTP Error 429` and "Sign in to confirm you're not a bot" even on the first request, while search
keeps working. The fix in use is `YTDLP_COOKIES` pointing to a Netscape cookies file from a logged-in
(throwaway) Google account. If that error returns, the cookies have most likely expired or been
invalidated; regenerate them (below) rather than suspecting yt-dlp first.

Regenerating `cookies.txt`, which the user does themselves. **Never ask for Google credentials in the
chat**, and don't script the Google login (Google blocks automated browsers):

1. `firefox --no-remote --profile "$(mktemp -d)" https://accounts.google.com/ServiceLogin?continue=https://www.youtube.com`,
   log in, then quit Firefox completely.
2. `node_modules/youtube-dl-exec/bin/yt-dlp --cookies-from-browser "firefox:<that profile dir>" --cookies cookies.txt --skip-download -q "https://www.youtube.com/watch?v=jNQXAC9IVRw"`,
   then `chmod 600 cookies.txt` and delete the profile so no browser rotates the session.
3. Check that `LOGIN_INFO`, `SID`, `SAPISID` and `__Secure-1PSID`/`__Secure-3PSID` exist for
   `.youtube.com`, copy the file to the server, and don't use it from another IP in the meantime.

If fresh cookies stop helping, the next step would be a proxy option for yt-dlp (`--proxy`, e.g. a
`YTDLP_PROXY` setting). It has been discussed but not built.

## Working with the maintainer

Make changes when asked, run lint and tests, and verify in a real browser or with the real yt-dlp
when the change touches those. Commit and push only when explicitly asked; commit messages are short,
lowercase summaries with an explanatory body for non-trivial changes.
