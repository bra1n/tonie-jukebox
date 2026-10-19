'use strict';

const $ = (id) => document.getElementById(id);
const MARGIN_SECONDS = 10;
const EMPTY_HINT = $('results').dataset.empty;
let busy = false;
let tonies = [];
let userWantsDelete = false; // the user's own checkbox choice, restored when deletion is no longer forced
let selectedRadio = null; // to allow unselecting a video by tapping it again

function setStatus(text, type = '') {
  $('status').textContent = text;
  $('status').className = `message ${type}`;
}

async function request(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status} ${res.statusText}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function selectedTonie() {
  return tonies.find((t) => t.id === $('tonie').value);
}

// Does the selected video fit on the selected tonie? Returns { forceDelete, blocked, message }
function checkSpace(tonie, video) {
  if (!tonie || !video) return {};
  const needed = Number(video.dataset.duration) + MARGIN_SECONDS;
  if (needed <= tonie.secondsRemaining && tonie.chaptersRemaining > 0) return {};

  const oldest = tonie.oldestTrack;
  const left = `Only ${formatDuration(tonie.secondsRemaining)} and ${tonie.chaptersRemaining} track slot(s) left on ${tonie.name}`;
  if (oldest && needed <= tonie.secondsRemaining + oldest.seconds) {
    return {
      forceDelete: true,
      message: `${left}. The oldest track “${oldest.title}” (${formatDuration(oldest.seconds)}) will be deleted to make room.`,
    };
  }
  if (!oldest) {
    return { blocked: true, message: `${left}, which is too short for this ${formatDuration(video.dataset.duration)} video.` };
  }
  return {
    blocked: true,
    message: `${left}, and deleting only the oldest track won't free up enough space for this ` +
      `${formatDuration(video.dataset.duration)} video. Please delete more than one track from the tonie manually first.`,
  };
}

function updateControls() {
  const tonie = selectedTonie();
  const video = document.querySelector('input[name="video"]:checked');
  const space = checkSpace(tonie, video);

  $('target').textContent = tonie ? `Adding to ${tonie.name}, ${formatDuration(tonie.secondsRemaining)} left` : 'Choose a tonie in the menu';
  $('query').disabled = $('search-button').disabled = busy || !tonie;
  $('delete-oldest').checked = space.forceDelete || userWantsDelete;
  $('delete-oldest').disabled = busy || Boolean(space.forceDelete);
  $('upload-button').disabled = busy || !tonie || !video || Boolean(space.blocked);
  $('space-notice').textContent = space.message || '';
  $('space-notice').className = `message ${space.blocked ? 'error' : 'notice'}`;
}

function formatViews(count) {
  return count == null ? '' : new Intl.NumberFormat('en', { notation: 'compact' }).format(count) + ' views';
}

function formatDuration(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Account info + creative tonie selection (keeps the current selection when reloading)
async function loadAccount() {
  try {
    const account = await request('api/account');
    const { user } = account;
    tonies = account.tonies;
    $('account').textContent = `Logged in as ${user.name ? `${user.name} (${user.email})` : user.email}`;
    const select = $('tonie');
    const selected = select.value;
    select.replaceChildren();
    if (tonies.length > 1) select.add(new Option('Please choose a tonie', ''));
    for (const tonie of tonies) {
      const label = `${tonie.name} (${tonie.chaptersPresent} tracks, ${formatDuration(tonie.secondsRemaining)} left)`;
      const option = new Option(label, tonie.id, false, tonie.id === selected);
      option.dataset.householdId = tonie.householdId;
      select.add(option);
    }
    select.disabled = tonies.length === 1;
    if (!select.value) $('menu').open = true; // a tonie must be chosen before searching
  } catch (err) {
    $('account').textContent = 'Could not load account.';
    setStatus(err.message, 'error');
  }
  updateControls();
}

// Burger menu: close after choosing a tonie or when tapping outside
$('tonie').addEventListener('change', () => {
  if ($('tonie').value) $('menu').open = false;
  updateControls();
});
document.addEventListener('click', (event) => {
  if (selectedTonie() && !$('menu').contains(event.target)) $('menu').open = false;
});

$('delete-oldest').addEventListener('change', (event) => {
  userWantsDelete = event.target.checked;
  updateControls();
});

// Radio list that can be unselected by tapping the selected video again
$('results').addEventListener('click', (event) => {
  if (event.target.name !== 'video') return;
  if (event.target === selectedRadio) {
    event.target.checked = false;
    selectedRadio = null;
  } else {
    selectedRadio = event.target;
  }
  updateControls();
});

function renderVideo(video) {
  const li = document.createElement('li');
  li.innerHTML = `
    <label class="video">
      <input type="radio" name="video">
      <span class="thumb"><img alt="" loading="lazy"><span class="duration"></span></span>
      <span class="info">
        <p class="title"></p>
        <p class="meta"><span class="channel"></span><span class="views"></span></p>
        <p class="description"></p>
      </span>
    </label>`;
  const radio = li.querySelector('input');
  radio.value = video.id;
  radio.dataset.title = video.title;
  radio.dataset.duration = video.duration;
  li.querySelector('img').src = video.thumbnail;
  li.querySelector('.duration').textContent = video.durationString;
  li.querySelector('.title').textContent = video.title;
  li.querySelector('.channel').textContent = video.channel;
  li.querySelector('.views').textContent = formatViews(video.viewCount);
  li.querySelector('.description').textContent = video.description;
  if (video.tooLong) {
    radio.disabled = true;
    li.querySelector('.video').classList.add('too-long');
    const label = document.createElement('p');
    label.className = 'too-long-label';
    label.textContent = 'Too long to add (max. 10 minutes)';
    li.querySelector('.video').append(label);
  }
  return li;
}

function renderPager(page, hasNext) {
  const li = document.createElement('li');
  li.className = 'pager';
  li.innerHTML = `
    <button type="button" class="button" data-page="${page - 1}">Previous page</button>
    <span>Page ${page}</span>
    <button type="button" class="button" data-page="${page + 1}">Next page</button>`;
  li.querySelector('button').disabled = page <= 1;
  li.querySelector('button:last-child').disabled = !hasNext;
  return li;
}

// YouTube search, one page at a time
let currentQuery = '';

async function search(page) {
  busy = true;
  selectedRadio = null;
  $('results').replaceChildren();
  delete $('results').dataset.empty; // the hint is only for before the first search
  updateControls();
  setStatus(page > 1 ? `Loading page ${page}…` : 'Searching…');
  try {
    const params = new URLSearchParams({ q: currentQuery, page });
    const { videos, hasNext } = await request(`api/search?${params}`);
    const items = videos.map(renderVideo);
    if (page > 1 || hasNext) items.push(renderPager(page, hasNext));
    $('results').replaceChildren(...items);
    $('results').scrollTop = 0;
    setStatus(videos.length ? '' : 'No results found. Try a different search term.');
  } catch (err) {
    setStatus(err.message, 'error');
  }
  busy = false;
  updateControls();
}

$('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  $('query').blur(); // hide the on-screen keyboard to reveal the results
  currentQuery = $('query').value;
  search(1);
});

$('results').addEventListener('click', (event) => {
  const page = event.target.closest('.pager button')?.dataset.page;
  if (page && !busy) search(Number(page));
});

// Download + upload to the tonie
$('upload-button').addEventListener('click', async () => {
  const video = document.querySelector('input[name="video"]:checked');
  const tonie = $('tonie').selectedOptions[0];
  busy = true;
  updateControls();
  setStatus(`Adding “${video.dataset.title}” to the tonie. This can take a minute.`);
  try {
    const { message } = await request('api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: video.value,
        title: video.dataset.title,
        householdId: tonie.dataset.householdId,
        tonieId: tonie.value,
        deleteOldest: $('delete-oldest').checked,
      }),
    });
    // Reset for the next song and refresh the tonie's remaining time / slots
    $('results').replaceChildren();
    $('results').dataset.empty = EMPTY_HINT;
    selectedRadio = null;
    $('query').value = '';
    userWantsDelete = false;
    setStatus(`✔ ${message}`, 'success');
    await loadAccount();
  } catch (err) {
    setStatus(err.message, 'error');
  }
  busy = false;
  updateControls();
});

loadAccount();
