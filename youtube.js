const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const youtubedl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');

const VIDEO_ID = /^[\w-]{11}$/;
const PAGE_SIZE = 20;
const MAX_PAGES = 10;
const MAX_DURATION = 10 * 60; // longer videos are unlikely to be songs and strain the tonie.cloud encoding

// Run yt-dlp and turn failures into errors that carry yt-dlp's own output
async function ytdlp(url, flags) {
  try {
    return await youtubedl(url, flags);
  } catch (err) {
    throw new Error(`yt-dlp failed: ${(err.stderr || err.message).trim()}`);
  }
}

// 214 -> "3:34", 3725 -> "1:02:05"
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(Math.floor(seconds % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// Search YouTube without an API key (yt-dlp's "ytsearchN:" pseudo-URL), one page of results at a time.
// Videos longer than MAX_DURATION are filtered out, so a page can contain fewer than PAGE_SIZE videos.
async function search(query, page = 1) {
  page = Math.min(page, MAX_PAGES);
  const start = (page - 1) * PAGE_SIZE + 1;
  const end = page * PAGE_SIZE;
  const result = await ytdlp(`ytsearch${end}:${query}`, {
    flatPlaylist: true,
    dumpSingleJson: true,
    playlistItems: `${start}:${end}`,
  });
  const entries = result.entries || [];
  const videos = entries
    .filter((entry) => VIDEO_ID.test(entry.id) && entry.duration) // skip channels, playlists and live streams
    .filter((entry) => entry.duration <= MAX_DURATION)
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      description: entry.description || '',
      channel: entry.channel || entry.uploader || '',
      duration: entry.duration,
      durationString: formatDuration(entry.duration),
      viewCount: entry.view_count ?? null,
      thumbnail: entry.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${entry.id}/mqdefault.jpg`,
    }));
  return { videos, page, hasNext: entries.length === PAGE_SIZE && page < MAX_PAGES };
}

// Download a video's audio track as MP3 into a fresh temp directory.
// The caller is responsible for removing `dir` afterwards.
async function downloadMp3(videoId) {
  if (!VIDEO_ID.test(videoId)) throw new Error(`Invalid YouTube video id: "${videoId}"`);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tonie-'));
  try {
    const stdout = await ytdlp(`https://www.youtube.com/watch?v=${videoId}`, {
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      noPlaylist: true,
      ffmpegLocation: ffmpegPath,
      output: path.join(dir, '%(id)s.%(ext)s'),
      print: 'after_move:filepath',
      matchFilter: `duration <= ${MAX_DURATION}`,
    });
    const filePath = String(stdout).trim().split('\n').pop();
    if (!filePath) throw new Error(`Video is longer than ${MAX_DURATION / 60} minutes and can't be added.`);
    await fs.access(filePath);
    return { filePath, dir };
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }
}

module.exports = { search, downloadMp3 };
