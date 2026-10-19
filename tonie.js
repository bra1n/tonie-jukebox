const fs = require('node:fs');

const LOGIN_URL = 'https://login.tonies.com/auth/realms/tonies/protocol/openid-connect/token';
const API_URL = 'https://api.tonie.cloud/v2';

// Exchange email / password for an access token
async function login(email, password) {
  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'my-tonies',
      scope: 'openid',
      username: email,
      password,
    }),
  });
  if (!res.ok) {
    throw new Error(`tonie.cloud login failed (HTTP ${res.status}): ${await res.text()}`);
  }
  const { access_token } = await res.json();
  return access_token;
}

// Authenticated JSON request against the tonie.cloud API
async function api(token, method, urlPath, body) {
  const res = await fetch(API_URL + urlPath, {
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
async function getAccount(token) {
  const [user, households] = await Promise.all([api(token, 'GET', '/me'), api(token, 'GET', '/households')]);
  const tonies = [];
  for (const household of households) {
    const creativeTonies = await api(token, 'GET', `/households/${household.id}/creativetonies`);
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
async function uploadSong(token, { householdId, tonieId, filePath, title, deleteOldest }) {
  const toniePath = `/households/${encodeURIComponent(householdId)}/creativetonies/${encodeURIComponent(tonieId)}`;

  // 1. Upload the file to tonie.cloud's S3 bucket via a presigned POST
  const { fileId, request } = await api(token, 'POST', '/file');
  const form = new FormData();
  for (const [key, value] of Object.entries(request.fields)) form.append(key, value);
  form.append('file', await fs.openAsBlob(filePath, { type: 'audio/mpeg' }), request.fields.key);
  const s3 = await fetch(request.url, { method: 'POST', body: form });
  if (!s3.ok) throw new Error(`File upload to tonie.cloud storage failed (HTTP ${s3.status}): ${await s3.text()}`);

  // 2. Optionally delete the oldest chapter
  let deleted = null;
  if (deleteOldest) {
    const { chapters } = await api(token, 'GET', toniePath);
    if (chapters.length) {
      deleted = chapters.at(-1).title;
      await api(token, 'PATCH', toniePath, { chapters: chapters.slice(0, -1) });
    }
  }

  // 3. Add the new chapter (gets appended at the end)
  await api(token, 'POST', `${toniePath}/chapters`, { title: title.slice(0, 100), file: fileId });

  // 4. Move the new chapter to the top and save the playlist
  const { chapters } = await api(token, 'GET', toniePath);
  let index = chapters.findIndex((chapter) => chapter.file === fileId);
  if (index === -1) index = chapters.length - 1;
  const [newChapter] = chapters.splice(index, 1);
  const tonie = await api(token, 'PATCH', toniePath, { chapters: [newChapter, ...chapters] });

  return { tonieName: tonie.name, chapterCount: tonie.chapters.length, deleted };
}

module.exports = { login, getAccount, uploadSong };
