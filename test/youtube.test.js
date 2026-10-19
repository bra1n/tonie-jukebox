const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { YouTube, formatDuration, MAX_DURATION, PAGE_SIZE, MAX_PAGES } = require('../youtube');

// A flat yt-dlp search entry as returned by `--flat-playlist --dump-single-json`
const entry = (id, duration, extra = {}) => ({
  id,
  title: `Video ${id}`,
  description: `About ${id}`,
  channel: 'Some Channel',
  duration,
  view_count: 1234,
  thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/small.jpg` }, { url: `https://i.ytimg.com/vi/${id}/big.jpg` }],
  ...extra,
});

// 11-character video ids: "video000001", "video000002", ...
const id = (n) => `video${String(n).padStart(6, '0')}`;

const fullPage = () => Array.from({ length: PAGE_SIZE }, (_, i) => entry(id(i + 1), 200));

describe('YouTube', () => {
  describe('search()', () => {
    it('maps yt-dlp entries to the video format', async () => {
      const exec = mock.fn(async () => ({ entries: [entry('dQw4w9WgXcQ', 214)] }));
      const { videos } = await new YouTube({ exec }).search('rick astley');

      assert.deepEqual(videos, [{
        id: 'dQw4w9WgXcQ',
        title: 'Video dQw4w9WgXcQ',
        description: 'About dQw4w9WgXcQ',
        channel: 'Some Channel',
        duration: 214,
        durationString: '3:34',
        viewCount: 1234,
        thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/small.jpg',
      }]);
    });

    it('filters out videos longer than 10 minutes, live streams and non-videos', async () => {
      const exec = async () => ({
        entries: [
          entry(id(1), MAX_DURATION), // exactly 10 minutes is allowed
          entry(id(2), MAX_DURATION + 1),
          entry(id(3), 3600),
          entry(id(4), null), // live stream
          entry('UCuAXFkgsw1L7xaCfnd5JJOw', 100), // channel
        ],
      });
      const { videos } = await new YouTube({ exec }).search('test');

      assert.deepEqual(videos.map((v) => v.id), [id(1)]);
    });

    it('fills in defaults for missing optional fields', async () => {
      const exec = async () => ({
        entries: [entry(id(1), 60, { description: null, channel: null, uploader: 'Uploader', view_count: undefined, thumbnails: [] })],
      });
      const [video] = (await new YouTube({ exec }).search('test')).videos;

      assert.equal(video.description, '');
      assert.equal(video.channel, 'Uploader');
      assert.equal(video.viewCount, null);
      assert.equal(video.thumbnail, `https://i.ytimg.com/vi/${id(1)}/mqdefault.jpg`);
    });

    it('requests the right slice of search results for a page', async () => {
      const exec = mock.fn(async () => ({ entries: [] }));
      await new YouTube({ exec }).search('  bluey  ', 3);

      const [url, flags] = exec.mock.calls[0].arguments;
      assert.equal(url, `ytsearch${3 * PAGE_SIZE}:bluey`);
      assert.equal(flags.playlistItems, `${2 * PAGE_SIZE + 1}:${3 * PAGE_SIZE}`);
      assert.equal(flags.flatPlaylist, true);
      assert.equal(flags.dumpSingleJson, true);
    });

    it('reports a next page only for full pages below the page limit', async () => {
      const youtube = new YouTube({ exec: async () => ({ entries: fullPage() }) });
      assert.equal((await youtube.search('test', 1)).hasNext, true);
      assert.equal((await youtube.search('test', MAX_PAGES)).hasNext, false);

      const partial = new YouTube({ exec: async () => ({ entries: fullPage().slice(1) }) });
      assert.equal((await partial.search('test', 1)).hasNext, false);
    });

    it('clamps invalid page numbers', async () => {
      const youtube = new YouTube({ exec: async () => ({}) });
      assert.equal((await youtube.search('test', 0)).page, 1);
      assert.equal((await youtube.search('test', 'abc')).page, 1);
      assert.equal((await youtube.search('test', 999)).page, MAX_PAGES);
    });

    it('rejects an empty query without calling yt-dlp', async () => {
      const exec = mock.fn();
      const youtube = new YouTube({ exec });
      await assert.rejects(youtube.search('   '), /must not be empty/);
      await assert.rejects(youtube.search(undefined), /must not be empty/);
      assert.equal(exec.mock.callCount(), 0);
    });

    it('wraps yt-dlp errors', async () => {
      const exec = async () => { throw Object.assign(new Error('exit code 1'), { stderr: 'ERROR: network down\n' }); };
      await assert.rejects(new YouTube({ exec }).search('test'), { message: 'yt-dlp failed: ERROR: network down' });
    });
  });

  describe('downloadMp3()', () => {
    // Fake yt-dlp download: writes an "mp3" into the requested output folder and prints its path
    const fakeDownload = mock.fn(async (url, flags) => {
      const filePath = flags.output.replace('%(id)s.%(ext)s', 'dQw4w9WgXcQ.mp3');
      await fs.writeFile(filePath, 'mp3 data');
      return `[download] some progress output\n${filePath}\n`;
    });

    it('downloads the audio as MP3 into a temp directory', async () => {
      const youtube = new YouTube({ exec: fakeDownload, ffmpegPath: '/opt/ffmpeg' });
      const { filePath, dir } = await youtube.downloadMp3('dQw4w9WgXcQ');

      try {
        assert.equal(path.dirname(filePath), dir);
        assert.equal(await fs.readFile(filePath, 'utf8'), 'mp3 data');

        const [url, flags] = fakeDownload.mock.calls.at(-1).arguments;
        assert.equal(url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
        assert.equal(flags.extractAudio, true);
        assert.equal(flags.audioFormat, 'mp3');
        assert.equal(flags.ffmpegLocation, '/opt/ffmpeg');
        assert.equal(flags.matchFilter, `duration <= ${MAX_DURATION}`);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects invalid video ids without calling yt-dlp', async () => {
      const exec = mock.fn();
      const youtube = new YouTube({ exec });
      for (const videoId of ['', 'short', 'dQw4w9WgXcQ --exec rm', '../../etc/pa', undefined]) {
        await assert.rejects(youtube.downloadMp3(videoId), /Invalid YouTube video id/);
      }
      assert.equal(exec.mock.callCount(), 0);
    });

    it('rejects videos longer than 10 minutes and cleans up the temp directory', async () => {
      let tempDir;
      const exec = async (url, flags) => {
        tempDir = path.dirname(flags.output);
        return ''; // yt-dlp prints nothing when --match-filter skips the video
      };
      await assert.rejects(new YouTube({ exec }).downloadMp3('dQw4w9WgXcQ'), /longer than 10 minutes/);
      await assert.rejects(fs.access(tempDir), { code: 'ENOENT' });
    });

    it('cleans up the temp directory when yt-dlp fails', async () => {
      let tempDir;
      const exec = async (url, flags) => {
        tempDir = path.dirname(flags.output);
        throw Object.assign(new Error('exit code 1'), { stderr: 'ERROR: Video unavailable' });
      };
      await assert.rejects(new YouTube({ exec }).downloadMp3('dQw4w9WgXcQ'), { message: 'yt-dlp failed: ERROR: Video unavailable' });
      await assert.rejects(fs.access(tempDir), { code: 'ENOENT' });
    });
  });

  describe('formatDuration()', () => {
    it('formats seconds as m:ss or h:mm:ss', () => {
      assert.equal(formatDuration(5), '0:05');
      assert.equal(formatDuration(214), '3:34');
      assert.equal(formatDuration(3725), '1:02:05');
    });
  });
});
