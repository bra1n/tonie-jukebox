const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { YouTube } = require('./youtube');
const { TonieCloud } = require('./tonie');

/**
 * Compares two strings in constant time, so response times don't reveal how much of a guess was right.
 * Both values are hashed first because `crypto.timingSafeEqual` needs inputs of equal length.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const hash = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

/**
 * Express middleware for HTTP Basic Auth. Requests without valid credentials get a 401,
 * which makes the browser show its login dialog.
 * @param {{ user: string, password: string }} credentials - the expected user name and password
 * @returns {import('express').RequestHandler}
 */
function basicAuth({ user, password }) {
  return (req, res, next) => {
    const [scheme, encoded = ''] = (req.headers.authorization || '').split(' ');
    const decoded = Buffer.from(encoded, 'base64').toString();
    const separator = decoded.indexOf(':');
    const valid =
      scheme === 'Basic' &&
      separator !== -1 &&
      // evaluate both comparisons so the response time doesn't reveal which one failed
      [safeEqual(decoded.slice(0, separator), user), safeEqual(decoded.slice(separator + 1), password)].every(Boolean);

    if (valid) return next();
    res.set('WWW-Authenticate', 'Basic realm="Tonie Jukebox", charset="UTF-8"');
    res.status(401).json({ error: 'Authentication required.' });
  };
}

/**
 * Creates the Express app: the web UI from `public/` plus the JSON API.
 * Errors from any route are logged and returned as `{ error: message }` with status 500.
 * @param {object} deps - the YouTube and TonieCloud instances to use; tests pass fakes here
 * @param {YouTube} deps.youtube
 * @param {TonieCloud} deps.tonieCloud
 * @param {{ user: string, password: string }} [deps.auth] - if set, the page and API require HTTP Basic Auth
 * @returns {import('express').Express}
 */
function createApp({ youtube, tonieCloud, auth }) {
  const app = express();
  if (auth) app.use(basicAuth(auth));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  /**
   * GET /api/account
   * Responds with the logged-in user and their creative tonies (see `Account` in tonie.js).
   */
  app.get('/api/account', async (req, res) => {
    res.json(await tonieCloud.getAccount());
  });

  /**
   * GET /api/search?q=<term>&page=<n>
   * Responds with one page of YouTube results (see `SearchResult` in youtube.js).
   * Invalid page numbers fall back to 1. Responds 400 if the search term is missing.
   */
  app.get('/api/search', async (req, res) => {
    const query = String(req.query.q || '').trim();
    if (!query) return res.status(400).json({ error: 'Please enter a search term.' });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    res.json(await youtube.search(query, page));
  });

  /**
   * POST /api/upload
   * JSON body: `{ videoId, title, householdId, tonieId, deleteOldest? }`
   * Downloads the video's audio as MP3, uploads it to the tonie and removes the temp files.
   * Responds with `{ message }` for the UI, or 400 if a required field is missing.
   */
  app.post('/api/upload', async (req, res) => {
    const { videoId, title, householdId, tonieId, deleteOldest } = req.body || {};
    if (!videoId || !title || !householdId || !tonieId) {
      return res.status(400).json({ error: 'videoId, title, householdId and tonieId are required.' });
    }

    console.log(`Downloading "${title}" (${videoId})…`);
    const { filePath, dir } = await youtube.downloadMp3(videoId);
    let result;
    try {
      console.log(`Uploading ${filePath} to tonie ${tonieId}…`);
      result = await tonieCloud.uploadSong({
        householdId,
        tonieId,
        filePath,
        title,
        deleteOldest: Boolean(deleteOldest),
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }

    const message =
      `“${title}” was added to ${result.tonieName} (${result.chapterCount} tracks).` +
      (result.deleted ? ` Deleted oldest track “${result.deleted}”.` : '');
    console.log(message);
    res.json({ message });
  });

  /** Error handler: logs the error and returns its message as JSON, so the UI can show it. */
  app.use((err, req, res, next) => {
    console.error(`${req.method} ${req.originalUrl} failed:`, err);
    res.status(500).json({ error: err.message });
  });

  return app;
}

/**
 * Starts the server: reads the configuration from `.env` or the environment,
 * checks the tonies.com login by loading the creative tonies, and then listens on `PORT` (default 3000).
 * If `AUTH_USER` and `AUTH_PASSWORD` are set, the page and API are protected with HTTP Basic Auth.
 * @returns {Promise<void>}
 * @throws {Error} if the tonies.com credentials are missing or wrong, the account has no creative tonies,
 *   or only one of `AUTH_USER` / `AUTH_PASSWORD` is set
 */
async function start() {
  // Load TONIE_EMAIL / TONIE_PASSWORD / PORT from .env (variables already set in the environment win)
  try {
    process.loadEnvFile(path.join(__dirname, '.env'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const { TONIE_EMAIL, TONIE_PASSWORD, AUTH_USER, AUTH_PASSWORD, PORT = 3000 } = process.env;
  if (!TONIE_EMAIL || !TONIE_PASSWORD) {
    throw new Error('TONIE_EMAIL and TONIE_PASSWORD environment variables are required.');
  }
  // refuse to start half-configured, so a typo can't leave the server unprotected
  if (Boolean(AUTH_USER) !== Boolean(AUTH_PASSWORD)) {
    throw new Error('Set both AUTH_USER and AUTH_PASSWORD to enable HTTP Basic Auth, or neither to disable it.');
  }
  const auth = AUTH_USER ? { user: AUTH_USER, password: AUTH_PASSWORD } : undefined;

  const tonieCloud = new TonieCloud({ email: TONIE_EMAIL, password: TONIE_PASSWORD });
  const { user, tonies } = await tonieCloud.getAccount();
  if (!tonies.length) throw new Error(`No creative tonies found for ${user.email}.`);

  console.log(`Logged in to tonie.cloud as ${user.email}. Creative tonies:`);
  for (const t of tonies) console.log(`  - ${t.name} (${t.chaptersPresent} tracks)`);

  console.log(auth ? `HTTP Basic Auth is enabled for user "${auth.user}".` : 'HTTP Basic Auth is disabled.');

  const app = createApp({ youtube: new YouTube(), tonieCloud, auth });
  app.listen(PORT, () => console.log(`Tonie Jukebox running at http://localhost:${PORT}`));
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Startup failed:', err.message);
    process.exit(1);
  });
}

module.exports = { createApp };
