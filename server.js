const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const youtube = require('./youtube');
const tonie = require('./tonie');

// Load TONIE_EMAIL / TONIE_PASSWORD / PORT from .env (variables already set in the environment win)
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const { TONIE_EMAIL, TONIE_PASSWORD, PORT = 3000 } = process.env;

// Logs in fresh for every request, so nothing needs to be kept server-side
const tonieLogin = () => tonie.login(TONIE_EMAIL, TONIE_PASSWORD);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/account', async (req, res) => {
  res.json(await tonie.getAccount(await tonieLogin()));
});

app.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Please enter a search term.' });
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  res.json(await youtube.search(query, page));
});

app.post('/api/upload', async (req, res) => {
  const { videoId, title, householdId, tonieId, deleteOldest } = req.body || {};
  if (!videoId || !title || !householdId || !tonieId) {
    return res.status(400).json({ error: 'videoId, title, householdId and tonieId are required.' });
  }

  console.log(`Downloading "${title}" (${videoId})…`);
  const { filePath, dir } = await youtube.downloadMp3(videoId);
  try {
    console.log(`Uploading ${filePath} to tonie ${tonieId}…`);
    const result = await tonie.uploadSong(await tonieLogin(), {
      householdId,
      tonieId,
      filePath,
      title,
      deleteOldest: Boolean(deleteOldest),
    });
    const message =
      `“${title}” was added to ${result.tonieName} (${result.chapterCount} tracks).` +
      (result.deleted ? ` Deleted oldest track “${result.deleted}”.` : '');
    console.log(message);
    res.json({ message });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

app.use((err, req, res, next) => {
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  res.status(500).json({ error: err.message });
});

async function start() {
  if (!TONIE_EMAIL || !TONIE_PASSWORD) {
    throw new Error('TONIE_EMAIL and TONIE_PASSWORD environment variables are required.');
  }
  const { user, tonies } = await tonie.getAccount(await tonieLogin());
  if (!tonies.length) throw new Error(`No creative tonies found for ${user.email}.`);

  console.log(`Logged in to tonie.cloud as ${user.email}. Creative tonies:`);
  for (const t of tonies) console.log(`  - ${t.name} (${t.chaptersPresent} tracks)`);

  app.listen(PORT, () => console.log(`Tonie Jukebox running at http://localhost:${PORT}`));
}

start().catch((err) => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});
