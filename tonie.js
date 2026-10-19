const fs = require('node:fs');

/** OpenID Connect token endpoint of the tonies.com login. */
const LOGIN_URL = 'https://login.tonies.com/auth/realms/tonies/protocol/openid-connect/token';
/** Base URL of the (unofficial) tonie.cloud REST API. */
const API_URL = 'https://api.tonie.cloud/v2';

/**
 * A creative tonie as returned by {@link TonieCloud#getAccount}.
 * @typedef {object} Tonie
 * @property {string} id
 * @property {string} householdId - household the tonie belongs to; needed for all tonie API calls
 * @property {string} name
 * @property {string} imageUrl
 * @property {number} chaptersPresent - number of tracks on the tonie
 * @property {number} chaptersRemaining - number of free track slots
 * @property {number} secondsRemaining - free recording time in seconds
 * @property {{ title: string, seconds: number }|null} oldestTrack - the last track (new songs are added
 *   on top, so the last one is the oldest), or null if the tonie is empty
 */

/**
 * The logged-in user and their creative tonies.
 * @typedef {object} Account
 * @property {{ email: string, name: string }} user - name may be empty
 * @property {Tonie[]} tonies - creative tonies across all households
 */

/**
 * Client for the tonie.cloud API: reading creative tonies and uploading songs to them.
 */
class TonieCloud {
  /**
   * @param {object} options
   * @param {string} options.email - tonies.com account email
   * @param {string} options.password - tonies.com account password
   * @param {typeof globalThis.fetch} [options.fetch] - fetch implementation; tests pass a fake here
   */
  constructor({ email, password, fetch = globalThis.fetch }) {
    this.email = email;
    this.password = password;
    this.fetch = fetch;
  }

  /**
   * Exchanges email and password for an access token.
   * Every public method logs in again, so nothing needs to be kept between requests.
   * @returns {Promise<string>} access token for the `Authorization: Bearer` header
   * @throws {Error} with the server's response, e.g. on wrong credentials
   */
  async login() {
    const res = await this.fetch(LOGIN_URL, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'my-tonies',
        scope: 'openid',
        username: this.email,
        password: this.password,
      }),
    });
    if (!res.ok) {
      throw new Error(`tonie.cloud login failed (HTTP ${res.status}): ${await res.text()}`);
    }
    const { access_token } = await res.json();
    return access_token;
  }

  /**
   * Sends an authenticated JSON request to the tonie.cloud API.
   * @param {string} token - access token from {@link TonieCloud#login}
   * @param {'GET'|'POST'|'PATCH'} method
   * @param {string} urlPath - path below {@link API_URL}, e.g. "/households"
   * @param {object} [body] - sent as JSON
   * @returns {Promise<any>} parsed JSON response, or null for an empty response
   * @throws {Error} with method, path, HTTP status and response body if the request fails
   */
  async api(token, method, urlPath, body) {
    const res = await this.fetch(API_URL + urlPath, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`tonie.cloud ${method} ${urlPath} failed (HTTP ${res.status}): ${await res.text()}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /**
   * Loads the logged-in user and all creative tonies across all of their households.
   * @returns {Promise<Account>}
   */
  async getAccount() {
    const token = await this.login();
    const [user, households] = await Promise.all([
      this.api(token, 'GET', '/me'),
      this.api(token, 'GET', '/households'),
    ]);
    const tonies = [];
    for (const household of households) {
      const creativeTonies = await this.api(token, 'GET', `/households/${household.id}/creativetonies`);
      for (const tonie of creativeTonies) {
        tonies.push({
          id: tonie.id,
          householdId: tonie.householdId,
          name: tonie.name,
          imageUrl: tonie.imageUrl,
          chaptersPresent: tonie.chaptersPresent,
          chaptersRemaining: tonie.chaptersRemaining,
          secondsRemaining: tonie.secondsRemaining,
          // the oldest track is the last one, see uploadSong()
          oldestTrack: tonie.chapters.length
            ? { title: tonie.chapters.at(-1).title, seconds: tonie.chapters.at(-1).seconds }
            : null,
        });
      }
    }
    return {
      user: { email: user.email, name: [user.firstName, user.lastName].filter(Boolean).join(' ') },
      tonies,
    };
  }

  /**
   * Uploads an audio file and puts it at the top of a creative tonie's playlist.
   *
   * Steps: upload the file to tonie.cloud's storage, optionally delete the oldest (= last) track,
   * add the new track (tonie.cloud appends it at the end), then move it to the top and save the playlist.
   * @param {object} options
   * @param {string} options.householdId
   * @param {string} options.tonieId
   * @param {string} options.filePath - local audio file to upload
   * @param {string} options.title - track title, shortened to 100 characters
   * @param {boolean} [options.deleteOldest=false] - delete the last track first to make room
   * @returns {Promise<{ tonieName: string, chapterCount: number, deleted: string|null }>}
   *   tonie name, number of tracks afterwards, and the title of the deleted track (if any)
   * @throws {Error} if a parameter is missing or any request fails
   */
  async uploadSong({ householdId, tonieId, filePath, title, deleteOldest = false } = {}) {
    if (!householdId || !tonieId || !filePath || !title) {
      throw new Error('householdId, tonieId, filePath and title are required.');
    }
    const token = await this.login();
    const toniePath = `/households/${encodeURIComponent(householdId)}/creativetonies/${encodeURIComponent(tonieId)}`;

    // 1. Upload the file to tonie.cloud's S3 bucket via a presigned POST
    const { fileId, request } = await this.api(token, 'POST', '/file');
    const form = new FormData();
    for (const [key, value] of Object.entries(request.fields)) form.append(key, value);
    form.append('file', await fs.openAsBlob(filePath, { type: 'audio/mpeg' }), request.fields.key);
    const s3 = await this.fetch(request.url, { method: 'POST', body: form });
    if (!s3.ok) throw new Error(`File upload to tonie.cloud storage failed (HTTP ${s3.status}): ${await s3.text()}`);

    // 2. Optionally delete the oldest chapter
    let deleted = null;
    if (deleteOldest) {
      const { chapters } = await this.api(token, 'GET', toniePath);
      if (chapters.length) {
        deleted = chapters.at(-1).title;
        await this.api(token, 'PATCH', toniePath, { chapters: chapters.slice(0, -1) });
      }
    }

    // 3. Add the new chapter (gets appended at the end)
    await this.api(token, 'POST', `${toniePath}/chapters`, { title: title.slice(0, 100), file: fileId });

    // 4. Move the new chapter to the top and save the playlist
    const { chapters } = await this.api(token, 'GET', toniePath);
    let index = chapters.findIndex((chapter) => chapter.file === fileId);
    if (index === -1) index = chapters.length - 1;
    const [newChapter] = chapters.splice(index, 1);
    const tonie = await this.api(token, 'PATCH', toniePath, { chapters: [newChapter, ...chapters] });

    return { tonieName: tonie.name, chapterCount: tonie.chapters.length, deleted };
  }
}

module.exports = { TonieCloud, LOGIN_URL, API_URL };
