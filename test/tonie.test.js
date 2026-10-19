const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TonieCloud, LOGIN_URL, API_URL } = require('../tonie');

const S3_URL = 'https://bucket.s3.amazonaws.com/';
const TONIE_PATH = '/households/H1/creativetonies/T1';

const chapter = (n, seconds = 100) => ({ id: `c${n}`, title: `Track ${n}`, file: `opaque${n}`, seconds, transcoding: false });

// Fake fetch: answers requests from a "METHOD url" -> response map and records all calls.
// A response is a JSON-able value, a function (call) => value, or an object with { status, body }.
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    const key = `${options.method || 'GET'} ${url}`;
    const call = { key, url, options, json: typeof options.body === 'string' ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (!(key in routes)) throw new Error(`Unexpected request: ${key}`);
    let response = routes[key];
    if (typeof response === 'function') response = response(call);
    const { status = 200, body = response } = response?.status ? response : {};
    return new Response(body === null || typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

const loginRoute = { [`POST ${LOGIN_URL}`]: { access_token: 'TOKEN' } };

describe('TonieCloud', () => {
  describe('login()', () => {
    it('sends the credentials as an OpenID password grant and returns the token', async () => {
      const { fetch, calls } = fakeFetch(loginRoute);
      const token = await new TonieCloud({ email: 'me@example.com', password: 'secret', fetch }).login();

      assert.equal(token, 'TOKEN');
      const body = calls[0].options.body;
      assert.ok(body instanceof URLSearchParams);
      assert.deepEqual(Object.fromEntries(body), {
        grant_type: 'password',
        client_id: 'my-tonies',
        scope: 'openid',
        username: 'me@example.com',
        password: 'secret',
      });
    });

    it('throws with the server response on invalid credentials', async () => {
      const { fetch } = fakeFetch({ [`POST ${LOGIN_URL}`]: { status: 401, body: '{"error":"invalid_grant"}' } });
      await assert.rejects(
        new TonieCloud({ email: 'me@example.com', password: 'wrong', fetch }).login(),
        { message: 'tonie.cloud login failed (HTTP 401): {"error":"invalid_grant"}' },
      );
    });
  });

  describe('getAccount()', () => {
    it('returns the user and the creative tonies of all households', async () => {
      const { fetch, calls } = fakeFetch({
        ...loginRoute,
        [`GET ${API_URL}/me`]: { email: 'me@example.com', firstName: 'Sam', lastName: 'Doe' },
        [`GET ${API_URL}/households`]: [{ id: 'H1' }, { id: 'H2' }],
        [`GET ${API_URL}/households/H1/creativetonies`]: [{
          id: 'T1', householdId: 'H1', name: 'Kids Mix', imageUrl: 'img1',
          chaptersPresent: 2, chaptersRemaining: 97, secondsRemaining: 5000,
          chapters: [chapter(1), chapter(2, 321.5)],
        }],
        [`GET ${API_URL}/households/H2/creativetonies`]: [{
          id: 'T2', householdId: 'H2', name: 'Empty', imageUrl: 'img2',
          chaptersPresent: 0, chaptersRemaining: 99, secondsRemaining: 5400,
          chapters: [],
        }],
      });
      const account = await new TonieCloud({ email: 'me@example.com', password: 'secret', fetch }).getAccount();

      assert.deepEqual(account, {
        user: { email: 'me@example.com', name: 'Sam Doe' },
        tonies: [
          {
            id: 'T1', householdId: 'H1', name: 'Kids Mix', imageUrl: 'img1',
            chaptersPresent: 2, chaptersRemaining: 97, secondsRemaining: 5000,
            oldestTrack: { title: 'Track 2', seconds: 321.5 },
          },
          {
            id: 'T2', householdId: 'H2', name: 'Empty', imageUrl: 'img2',
            chaptersPresent: 0, chaptersRemaining: 99, secondsRemaining: 5400,
            oldestTrack: null,
          },
        ],
      });
      // all API calls are authenticated with the token from the login
      for (const call of calls.slice(1)) assert.equal(call.options.headers.Authorization, 'Bearer TOKEN');
    });

    it('throws with method, path, status and body when an API call fails', async () => {
      const { fetch } = fakeFetch({
        ...loginRoute,
        [`GET ${API_URL}/me`]: { status: 500, body: 'Internal Server Error' },
        [`GET ${API_URL}/households`]: [],
      });
      await assert.rejects(
        new TonieCloud({ email: 'me@example.com', password: 'secret', fetch }).getAccount(),
        { message: 'tonie.cloud GET /me failed (HTTP 500): Internal Server Error' },
      );
    });
  });

  describe('uploadSong()', () => {
    let dir;
    let filePath;

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tonie-test-'));
      filePath = path.join(dir, 'song.mp3');
      await fs.writeFile(filePath, 'mp3 data');
    });

    afterEach(() => fs.rm(dir, { recursive: true, force: true }));

    // Simulates a creative tonie with existing chapters that receives the new file
    function tonieRoutes({ chapters = [chapter(1), chapter(2), chapter(3)], s3Status = 204 } = {}) {
      let current = [...chapters];
      return {
        ...loginRoute,
        [`POST ${API_URL}/file`]: { fileId: 'FILE', request: { url: S3_URL, fields: { key: 'FILE', policy: 'P', 'x-amz-signature': 'SIG' } } },
        [`POST ${S3_URL}`]: { status: s3Status, body: s3Status === 204 ? null : 'AccessDenied' },
        [`GET ${API_URL}${TONIE_PATH}`]: () => ({ name: 'Kids Mix', chapters: current }),
        [`POST ${API_URL}${TONIE_PATH}/chapters`]: ({ json }) => {
          current = [...current, { id: 'cNew', title: json.title, file: json.file, seconds: 0, transcoding: true }];
          return { name: 'Kids Mix', chapters: current };
        },
        [`PATCH ${API_URL}${TONIE_PATH}`]: ({ json }) => {
          current = json.chapters;
          return { name: 'Kids Mix', chapters: current };
        },
      };
    }

    it('uploads the file and puts the new track at the top of the playlist', async () => {
      const { fetch, calls } = fakeFetch(tonieRoutes());
      const tonieCloud = new TonieCloud({ email: 'me@example.com', password: 'secret', fetch });
      const result = await tonieCloud.uploadSong({ householdId: 'H1', tonieId: 'T1', filePath, title: 'New Song' });

      assert.deepEqual(result, { tonieName: 'Kids Mix', chapterCount: 4, deleted: null });
      assert.deepEqual(calls.map((c) => c.key), [
        `POST ${LOGIN_URL}`,
        `POST ${API_URL}/file`,
        `POST ${S3_URL}`,
        `POST ${API_URL}${TONIE_PATH}/chapters`,
        `GET ${API_URL}${TONIE_PATH}`,
        `PATCH ${API_URL}${TONIE_PATH}`,
      ]);

      // S3 form: presigned fields first, the file last
      const form = calls[2].options.body;
      assert.deepEqual([...form.keys()], ['key', 'policy', 'x-amz-signature', 'file']);
      assert.equal(form.get('file').name, 'FILE');
      assert.equal(await form.get('file').text(), 'mp3 data');

      assert.deepEqual(calls[3].json, { title: 'New Song', file: 'FILE' });
      assert.deepEqual(calls[5].json.chapters.map((c) => c.id), ['cNew', 'c1', 'c2', 'c3']);
    });

    it('deletes the oldest (last) track first when requested', async () => {
      const { fetch, calls } = fakeFetch(tonieRoutes());
      const tonieCloud = new TonieCloud({ email: 'me@example.com', password: 'secret', fetch });
      const result = await tonieCloud.uploadSong({ householdId: 'H1', tonieId: 'T1', filePath, title: 'New Song', deleteOldest: true });

      assert.deepEqual(result, { tonieName: 'Kids Mix', chapterCount: 3, deleted: 'Track 3' });
      const patches = calls.filter((c) => c.key.startsWith('PATCH'));
      assert.deepEqual(patches[0].json.chapters.map((c) => c.id), ['c1', 'c2']);
      assert.deepEqual(patches[1].json.chapters.map((c) => c.id), ['cNew', 'c1', 'c2']);
      // the deletion happens before the new chapter is added
      assert.ok(calls.indexOf(patches[0]) < calls.findIndex((c) => c.key.endsWith('/chapters')));
    });

    it('skips the deletion on an empty tonie', async () => {
      const { fetch, calls } = fakeFetch(tonieRoutes({ chapters: [] }));
      const tonieCloud = new TonieCloud({ email: 'me@example.com', password: 'secret', fetch });
      const result = await tonieCloud.uploadSong({ householdId: 'H1', tonieId: 'T1', filePath, title: 'New Song', deleteOldest: true });

      assert.deepEqual(result, { tonieName: 'Kids Mix', chapterCount: 1, deleted: null });
      assert.equal(calls.filter((c) => c.key.startsWith('PATCH')).length, 1);
    });

    it('limits the track title to 100 characters', async () => {
      const { fetch, calls } = fakeFetch(tonieRoutes());
      const tonieCloud = new TonieCloud({ email: 'me@example.com', password: 'secret', fetch });
      await tonieCloud.uploadSong({ householdId: 'H1', tonieId: 'T1', filePath, title: 'x'.repeat(150) });

      assert.equal(calls.find((c) => c.key.endsWith('/chapters')).json.title.length, 100);
    });

    it('throws when the file upload to storage fails', async () => {
      const { fetch, calls } = fakeFetch(tonieRoutes({ s3Status: 403 }));
      const tonieCloud = new TonieCloud({ email: 'me@example.com', password: 'secret', fetch });

      await assert.rejects(
        tonieCloud.uploadSong({ householdId: 'H1', tonieId: 'T1', filePath, title: 'New Song' }),
        { message: 'File upload to tonie.cloud storage failed (HTTP 403): AccessDenied' },
      );
      assert.ok(!calls.some((c) => c.key.endsWith('/chapters')), 'no chapter must be added');
    });

    it('rejects missing parameters without any request', async () => {
      const { fetch, calls } = fakeFetch(tonieRoutes());
      const tonieCloud = new TonieCloud({ email: 'me@example.com', password: 'secret', fetch });
      const valid = { householdId: 'H1', tonieId: 'T1', filePath, title: 'New Song' };

      for (const missing of Object.keys(valid)) {
        await assert.rejects(tonieCloud.uploadSong({ ...valid, [missing]: '' }), /are required/);
      }
      await assert.rejects(tonieCloud.uploadSong(), /are required/);
      assert.equal(calls.length, 0);
    });
  });
});
