const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const youtubedl = require('youtube-dl-exec');
const ffmpegStatic = require('ffmpeg-static');

/** Valid YouTube video ids are exactly 11 characters of letters, digits, `-` and `_`. */
const VIDEO_ID = /^[\w-]{11}$/;
/** Number of search results requested from YouTube per page (before filtering). */
const PAGE_SIZE = 20;
/** Highest page number that can be requested; later pages get slower to load. */
const MAX_PAGES = 10;
/** Longest allowed video in seconds. Longer videos are unlikely to be songs and strain the tonie.cloud encoding. */
const MAX_DURATION = 10 * 60;

/**
 * A YouTube video as returned by {@link YouTube#search}.
 * @typedef {object} Video
 * @property {string} id - 11-character YouTube video id
 * @property {string} title
 * @property {string} description - shortened description snippet, may be empty
 * @property {string} channel - channel or uploader name, may be empty
 * @property {number} duration - length in seconds
 * @property {string} durationString - length formatted as "m:ss" or "h:mm:ss"
 * @property {number|null} viewCount - null if YouTube doesn't report it
 * @property {string} thumbnail - URL of a preview image
 */

/**
 * One page of search results.
 * @typedef {object} SearchResult
 * @property {Video[]} videos - can be fewer than {@link PAGE_SIZE}, since long videos are filtered out
 * @property {number} page - the page number actually used (after clamping)
 * @property {boolean} hasNext - whether a next page is likely to exist
 */

/**
 * Formats a duration for display.
 * @example formatDuration(214) // "3:34"
 * @example formatDuration(3725) // "1:02:05"
 * @param {number} seconds
 * @returns {string} "m:ss", or "h:mm:ss" for an hour or longer
 */
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(Math.floor(seconds % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Searches YouTube and downloads audio via yt-dlp. No API key or Google account is needed.
 */
class YouTube {
  /**
   * @param {object} [options]
   * @param {(url: string, flags: object) => Promise<any>} [options.exec] - runs yt-dlp and resolves with its
   *   parsed output (the youtube-dl-exec signature); tests pass a fake here
   * @param {string} [options.ffmpegPath] - path to the ffmpeg binary used for the MP3 conversion
   */
  constructor({ exec = youtubedl, ffmpegPath = ffmpegStatic } = {}) {
    this.exec = exec;
    this.ffmpegPath = ffmpegPath;
  }

  /**
   * Runs yt-dlp and turns failures into errors that carry yt-dlp's own output.
   * @param {string} url - video URL or search pseudo-URL such as "ytsearch20:query"
   * @param {object} flags - yt-dlp options in camelCase, e.g. `{ dumpSingleJson: true }`
   * @returns {Promise<any>} parsed JSON for JSON output, otherwise stdout as a string
   * @throws {Error} "yt-dlp failed: …" with yt-dlp's error output
   */
  async ytdlp(url, flags) {
    try {
      return await this.exec(url, flags);
    } catch (err) {
      throw new Error(`yt-dlp failed: ${(err.stderr || err.message).trim()}`, { cause: err });
    }
  }

  /**
   * Searches YouTube one page at a time, using yt-dlp's "ytsearchN:" pseudo-URL.
   * Videos longer than {@link MAX_DURATION}, live streams and channels are filtered out,
   * so a page can contain fewer than {@link PAGE_SIZE} videos.
   * @param {string} query - search term
   * @param {number} [page=1] - 1-based page number, clamped to 1…{@link MAX_PAGES}
   * @returns {Promise<SearchResult>}
   * @throws {Error} if the query is empty or yt-dlp fails
   */
  async search(query, page = 1) {
    query = String(query ?? '').trim();
    if (!query) throw new Error('Search query must not be empty.');
    page = Math.min(Math.max(1, Math.floor(page) || 1), MAX_PAGES);

    const start = (page - 1) * PAGE_SIZE + 1;
    const end = page * PAGE_SIZE;
    const result = await this.ytdlp(`ytsearch${end}:${query}`, {
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

  /**
   * Downloads a video's audio track as MP3 into a new temp directory.
   * The caller must remove `dir` afterwards. On failure it is removed automatically.
   * @param {string} videoId - 11-character YouTube video id
   * @returns {Promise<{ filePath: string, dir: string }>} path of the MP3 file and of its temp directory
   * @throws {Error} for an invalid id, a video longer than {@link MAX_DURATION}, or a yt-dlp failure
   */
  async downloadMp3(videoId) {
    if (!VIDEO_ID.test(videoId)) throw new Error(`Invalid YouTube video id: "${videoId}"`);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tonie-'));
    try {
      const stdout = await this.ytdlp(`https://www.youtube.com/watch?v=${videoId}`, {
        extractAudio: true,
        audioFormat: 'mp3',
        audioQuality: 0,
        noPlaylist: true,
        ffmpegLocation: this.ffmpegPath,
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
}

module.exports = { YouTube, formatDuration, MAX_DURATION, PAGE_SIZE, MAX_PAGES };
