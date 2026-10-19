const fs = require('node:fs');

const LOGIN_URL = 'https://login.tonies.com/auth/realms/tonies/protocol/openid-connect/token';
const API_URL = 'https://api.tonie.cloud/v2';

class TonieCloud {
  // `fetch` is injectable for tests
  constructor({ email, password, fetch = globalThis.fetch }) {
    this.email = email;
    this.password = password;
    this.fetch = fetch;
  }

  // Exchange email / password for an access token.
  // Every public method logs in again, so nothing needs to be kept between requests.
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

  // Authenticated JSON request against the tonie.cloud API
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

  // Logged-in user and all creative tonies across all households
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

  // Upload an audio file and put it at the top of the creative tonie's playlist,
  // optionally deleting the oldest (= last) chapter first to make room
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
