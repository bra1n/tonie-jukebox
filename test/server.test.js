const { describe, it, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

// The routes are tested against an in-process server on a random local port,
// with fake YouTube / TonieCloud objects instead of the real modules.
describe('server API', () => {
  const youtube = {};
  const tonieCloud = {};
  let server;
  let baseUrl;

  const get = (urlPath) => fetch(baseUrl + urlPath);
  const post = (urlPath, body) =>
    fetch(baseUrl + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  before(async () => {
    server = createApp({ youtube, tonieCloud }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  beforeEach(() => {
    mock.restoreAll();
    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});
  });

  describe('GET /api/account', () => {
    it('returns the account data', async () => {
      const account = { user: { email: 'me@example.com', name: 'Sam' }, tonies: [{ id: 'T1' }] };
      tonieCloud.getAccount = mock.fn(async () => account);

      const res = await get('/api/account');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), account);
    });

    it('returns errors as JSON with status 500', async () => {
      tonieCloud.getAccount = async () => { throw new Error('tonie.cloud login failed (HTTP 401)'); };

      const res = await get('/api/account');
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: 'tonie.cloud login failed (HTTP 401)' });
      assert.equal(console.error.mock.callCount(), 1);
    });
  });

  describe('GET /api/search', () => {
    it('requires a search term', async () => {
      youtube.search = mock.fn();
      for (const query of ['', '?q=', '?q=%20%20']) {
        const res = await get(`/api/search${query}`);
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /search term/);
      }
      assert.equal(youtube.search.mock.callCount(), 0);
    });

    it('passes the query and page to the YouTube module', async () => {
      const result = { videos: [{ id: 'dQw4w9WgXcQ' }], page: 3, hasNext: true };
      youtube.search = mock.fn(async () => result);

      const res = await get('/api/search?q=%20bluey%20&page=3');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), result);
      assert.deepEqual(youtube.search.mock.calls[0].arguments, ['bluey', 3]);
    });

    it('falls back to page 1 for invalid page numbers', async () => {
      youtube.search = mock.fn(async () => ({ videos: [], page: 1, hasNext: false }));
      for (const page of ['abc', '0', '-2', '']) await get(`/api/search?q=bluey&page=${page}`);
      assert.deepEqual(youtube.search.mock.calls.map((c) => c.arguments[1]), [1, 1, 1, 1]);
    });
  });

  describe('POST /api/upload', () => {
    const body = { videoId: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', householdId: 'H1', tonieId: 'T1', deleteOldest: true };
    let dir;

    beforeEach(async () => {
      // the fake download creates a real temp dir so the cleanup can be checked
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tonie-test-'));
      youtube.downloadMp3 = mock.fn(async () => ({ filePath: path.join(dir, 'song.mp3'), dir }));
    });

    it('requires videoId, title, householdId and tonieId', async () => {
      tonieCloud.uploadSong = mock.fn();
      for (const missing of ['videoId', 'title', 'householdId', 'tonieId']) {
        const res = await post('/api/upload', { ...body, [missing]: undefined });
        assert.equal(res.status, 400);
      }
      assert.equal(youtube.downloadMp3.mock.callCount(), 0);
      assert.equal(tonieCloud.uploadSong.mock.callCount(), 0);
    });

    it('downloads the video, uploads it to the tonie and removes the temp files', async () => {
      tonieCloud.uploadSong = mock.fn(async () => ({ tonieName: 'Kids Mix', chapterCount: 5, deleted: 'Old Song' }));

      const res = await post('/api/upload', body);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        message: '“Never Gonna Give You Up” was added to Kids Mix (5 tracks). Deleted oldest track “Old Song”.',
      });
      assert.deepEqual(youtube.downloadMp3.mock.calls[0].arguments, ['dQw4w9WgXcQ']);
      assert.deepEqual(tonieCloud.uploadSong.mock.calls[0].arguments, [{
        householdId: 'H1',
        tonieId: 'T1',
        filePath: path.join(dir, 'song.mp3'),
        title: 'Never Gonna Give You Up',
        deleteOldest: true,
      }]);
      await assert.rejects(fs.access(dir), { code: 'ENOENT' });
    });

    it('omits the deletion note when nothing was deleted', async () => {
      tonieCloud.uploadSong = mock.fn(async () => ({ tonieName: 'Kids Mix', chapterCount: 5, deleted: null }));

      const res = await post('/api/upload', { ...body, deleteOldest: undefined });
      assert.deepEqual(await res.json(), { message: '“Never Gonna Give You Up” was added to Kids Mix (5 tracks).' });
      assert.equal(tonieCloud.uploadSong.mock.calls[0].arguments[0].deleteOldest, false);
    });

    it('returns upload errors as JSON and still removes the temp files', async () => {
      tonieCloud.uploadSong = async () => { throw new Error('tonie.cloud PATCH failed (HTTP 422)'); };

      const res = await post('/api/upload', body);
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: 'tonie.cloud PATCH failed (HTTP 422)' });
      await assert.rejects(fs.access(dir), { code: 'ENOENT' });
    });

    it('returns download errors as JSON', async () => {
      youtube.downloadMp3 = async () => { throw new Error('Video is longer than 10 minutes and can\'t be added.'); };
      tonieCloud.uploadSong = mock.fn();

      const res = await post('/api/upload', body);
      assert.equal(res.status, 500);
      assert.match((await res.json()).error, /longer than 10 minutes/);
      assert.equal(tonieCloud.uploadSong.mock.callCount(), 0);
      await fs.rm(dir, { recursive: true, force: true });
    });
  });
});
