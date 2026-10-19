const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { YouTube } = require('./youtube');
const { TonieCloud } = require('./tonie');

/**
 * Creates the Express app: the web UI from `public/` plus the JSON API.
 * Errors from any route are logged and returned as `{ error: message }` with status 500.
 * @param {object} deps - the YouTube and TonieCloud instances to use; tests pass fakes here
 * @param {YouTube} deps.youtube
 * @param {TonieCloud} deps.tonieCloud
 * @returns {import('express').Express}
 */
function createApp({ youtube, tonieCloud }) {
  const app = express();
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
 * Starts the server: reads the tonies.com login from `.env` or the environment,
 * checks the login by loading the creative tonies, and then listens on `PORT` (default 3000).
 * @returns {Promise<void>}
 * @throws {Error} if the credentials are missing or wrong, or the account has no creative tonies
 */
async function start() {
  // Load TONIE_EMAIL / TONIE_PASSWORD / PORT from .env (variables already set in the environment win)
  try {
    process.loadEnvFile(path.join(__dirname, '.env'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const { TONIE_EMAIL, TONIE_PASSWORD, PORT = 3000 } = process.env;
  if (!TONIE_EMAIL || !TONIE_PASSWORD) {
    throw new Error('TONIE_EMAIL and TONIE_PASSWORD environment variables are required.');
  }

  const tonieCloud = new TonieCloud({ email: TONIE_EMAIL, password: TONIE_PASSWORD });
  const { user, tonies } = await tonieCloud.getAccount();
  if (!tonies.length) throw new Error(`No creative tonies found for ${user.email}.`);

  console.log(`Logged in to tonie.cloud as ${user.email}. Creative tonies:`);
  for (const t of tonies) console.log(`  - ${t.name} (${t.chaptersPresent} tracks)`);

  const app = createApp({ youtube: new YouTube(), tonieCloud });
  app.listen(PORT, () => console.log(`Tonie Jukebox running at http://localhost:${PORT}`));
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Startup failed:', err.message);
    process.exit(1);
  });
}

module.exports = { createApp };
