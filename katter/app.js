'use strict';

const CONFIG = {
  owner: 'thabombecki',
  repo: 'thabombecki.github.io',
  branch: 'main',
  dir: 'katter',          // folder inside the repo
  start: new Date(2026, 9, 15),
  days: 15,
  maxPhotoSide: 1600,
  photoQuality: 0.8,
};

const API = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}`;
const RAW = `https://raw.githubusercontent.com/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}/${CONFIG.dir}/`;
const TOKEN_KEY = 'katter-token';
const PREVIEW_KEY = 'katter-preview';

const state = {
  data: { tasks: [], done: {}, photos: {} },
  sha: null,
  token: readToken(),
  selected: null,
  previews: {},   // photo path -> local object URL, so fresh uploads show before Pages redeploys
};

// Running on localhost without a token: edits are kept in this browser only, so the app can be tried out.
const PREVIEW = ['localhost', '127.0.0.1'].includes(location.hostname);
const isPreview = () => PREVIEW && !state.token;
const canEdit = () => !!state.token || isPreview();

const $ = (id) => document.getElementById(id);

// ---------- dates ----------

const DAYS = Array.from({ length: CONFIG.days }, (_, i) =>
  new Date(CONFIG.start.getFullYear(), CONFIG.start.getMonth(), CONFIG.start.getDate() + i));

function key(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const TODAY = key(new Date());

// ---------- storage helpers ----------

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function writeToken(t) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const textToB64 = (str) => bytesToB64(new TextEncoder().encode(str));
const b64ToText = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

// ---------- GitHub API ----------

function gh(path, opts = {}) {
  const headers = { Accept: 'application/vnd.github+json', ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  return fetch(`${API}${path}`, { ...opts, headers, cache: 'no-store' });
}

const contentsPath = (p) => `/contents/${`${CONFIG.dir}/${p}`.split('/').map(encodeURIComponent).join('/')}`;

async function fetchRemote() {
  const res = await gh(`${contentsPath('data.json')}?ref=${CONFIG.branch}`);
  if (res.status === 404) return { data: null, sha: null };
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const json = await res.json();
  return { data: normalise(JSON.parse(b64ToText(json.content))), sha: json.sha };
}

function normalise(d) {
  return { tasks: d.tasks || [], done: d.done || {}, photos: d.photos || {} };
}

async function load() {
  if (isPreview()) {
    try {
      const saved = localStorage.getItem(PREVIEW_KEY);
      if (saved) {
        state.data = normalise(JSON.parse(saved));
        return;
      }
    } catch { /* fall through to the file */ }
    const res = await fetch(`data.json?t=${Date.now()}`, { cache: 'no-store' });
    state.data = normalise(await res.json());
    return;
  }
  try {
    const remote = await fetchRemote();
    if (remote.data) {
      state.data = remote.data;
      state.sha = remote.sha;
      return;
    }
  } catch { /* rate limited or offline: fall back to the Pages copy */ }
  const res = await fetch(`data.json?t=${Date.now()}`, { cache: 'no-store' });
  state.data = normalise(await res.json());
}

async function putFile(path, b64, message, sha) {
  const body = { message, content: b64, branch: CONFIG.branch };
  if (sha) body.sha = sha;
  return gh(contentsPath(path), { method: 'PUT', body: JSON.stringify(body) });
}

async function deleteFile(path, message) {
  const res = await gh(`${contentsPath(path)}?ref=${CONFIG.branch}`);
  if (!res.ok) return;
  const { sha } = await res.json();
  await gh(contentsPath(path), { method: 'DELETE', body: JSON.stringify({ message, sha, branch: CONFIG.branch }) });
}

// ---------- saving (queued, optimistic) ----------
// Each change is a mutator applied locally right away, then queued.
// Queued changes are written in one commit. On a sha conflict the remote copy
// is refetched and the mutators re-applied (they are all idempotent).

const queue = [];
let saving = false;

function change(mutator, message) {
  mutator(state.data);
  render();
  if (isPreview()) {
    // Preview photos only live in memory, so keep them out of storage.
    const { tasks, done } = state.data;
    try { localStorage.setItem(PREVIEW_KEY, JSON.stringify({ tasks, done })); } catch { /* ignore */ }
    return;
  }
  queue.push({ mutator, message });
  flush();
}

async function flush() {
  if (saving) return;
  saving = true;
  while (queue.length) {
    const batch = queue.splice(0);
    const message = batch.length === 1 ? batch[0].message : `Pet sitting: ${batch.length} updates`;
    try {
      await saveData(batch, message);
    } catch (err) {
      toast(err.message, true);
      try { await load(); } catch { /* keep what we have */ }
      render();
    }
  }
  saving = false;
}

async function saveData(batch, message, retried = false) {
  const res = await putFile('data.json', textToB64(JSON.stringify(state.data, null, 2) + '\n'), message, state.sha);
  if (res.ok) {
    state.sha = (await res.json()).content.sha;
    return;
  }
  if ((res.status === 409 || res.status === 422) && !retried) {
    const remote = await fetchRemote();
    const data = remote.data || normalise({});
    for (const op of [...batch, ...queue]) op.mutator(data);
    state.data = data;
    state.sha = remote.sha;
    render();
    return saveData(batch, message, true);
  }
  throw await saveError(res);
}

async function saveError(res) {
  let detail = '';
  try { detail = (await res.json()).message || ''; } catch { /* no body */ }
  if (res.status === 401) return new Error('GitHub says the token is invalid or expired. Tap Lock and unlock with a new one.');
  if (res.status === 403 || res.status === 404) {
    return new Error(`GitHub won't let this token save (${res.status}${detail ? `: ${detail}` : ''}). `
      + 'Check the token has this repo selected and Contents set to "Read and write".');
  }
  return new Error(`Couldn't save (GitHub ${res.status}${detail ? `: ${detail}` : ''}).`);
}

// ---------- mutators ----------

const setDone = (day, id, on) => (d) => {
  const list = new Set(d.done[day] || []);
  on ? list.add(id) : list.delete(id);
  d.done[day] = [...list];
};
const addPhoto = (day, path) => (d) => {
  const list = d.photos[day] || [];
  if (!list.includes(path)) d.photos[day] = [...list, path];
};
const removePhoto = (day, path) => (d) => {
  d.photos[day] = (d.photos[day] || []).filter((p) => p !== path);
  if (!d.photos[day].length) delete d.photos[day];
};
const addTask = (task) => (d) => {
  if (!d.tasks.some((t) => t.id === task.id)) d.tasks.push(task);
};
const removeTask = (id) => (d) => {
  d.tasks = d.tasks.filter((t) => t.id !== id);
};

// ---------- rendering ----------

function doneCount(day) {
  const done = new Set(state.data.done[day] || []);
  return state.data.tasks.filter((t) => done.has(t.id)).length;
}
function isDone(day) {
  return state.data.tasks.length > 0 && doneCount(day) === state.data.tasks.length;
}

const MOODS = {
  none: ['Batman is giving you the hungry stare 😾', 'Harvey has knocked something off a shelf to get your attention 🙀', 'Two hungry boys, zero patience 😼'],
  some: ['Harvey says: keep going, human 😺', 'Batman is cautiously optimistic 🐈‍⬛', 'Getting there, the purring has begun 😸'],
  all: ['Purr-fect day! Both boys approve 😻', 'Batman and Harvey rate you 10/10 🏆', 'Mission accomplished. Nap time 💤'],
};

function moodFor(day) {
  const n = doneCount(day);
  const list = isDone(day) ? MOODS.all : n === 0 ? MOODS.none : MOODS.some;
  return list[Number(day.slice(-2)) % list.length];
}

function countdownText() {
  const first = key(DAYS[0]);
  const last = key(DAYS[DAYS.length - 1]);
  if (TODAY < first) {
    const days = Math.round((DAYS[0] - new Date(new Date().toDateString())) / 86400000);
    return days === 1 ? '🧳 Starts tomorrow!' : `🧳 Starts in ${days} days`;
  }
  if (TODAY > last) return '💜 All done, thanks for looking after us!';
  return `🐾 Day ${DAYS.findIndex((d) => key(d) === TODAY) + 1} of ${DAYS.length}`;
}

function render() {
  const editing = canEdit();
  const total = state.data.tasks.length;

  $('mode-badge').hidden = !editing;
  $('mode-badge').textContent = isPreview() ? '👀 Preview: saved in this browser only' : '✏️ Editing';
  $('lock-btn').hidden = !state.token;
  $('edit-tasks').hidden = !editing;
  $('countdown').textContent = countdownText();

  // progress
  const finished = DAYS.filter((d) => isDone(key(d))).length;
  const pct = (finished / DAYS.length) * 100;
  $('progress-bar').style.width = `${pct}%`;
  $('progress-cat').style.left = `${Math.max(pct, 3)}%`;
  $('progress-text').textContent = finished === DAYS.length ? '15/15 🎉' : `${finished} of ${DAYS.length} days`;

  // calendar
  const grid = $('grid');
  grid.replaceChildren();
  const lead = (DAYS[0].getDay() + 6) % 7; // Monday-first
  for (let i = 0; i < lead; i++) {
    const blank = document.createElement('div');
    blank.className = 'cell blank';
    grid.append(blank);
  }
  for (const d of DAYS) {
    const k = key(d);
    const n = doneCount(k);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell';
    cell.dataset.day = k;
    if (k === TODAY) cell.classList.add('today');
    if (isDone(k)) cell.classList.add('done');
    else if (k < TODAY) cell.classList.add('missed');
    cell.setAttribute('aria-label', `${d.toDateString()}, ${n} of ${total} tasks done`);

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = d.getDate();
    const dots = document.createElement('span');
    dots.className = 'dots';
    for (let i = 0; i < total; i++) {
      const dot = document.createElement('span');
      dot.className = i < n ? 'dot on' : 'dot';
      dots.append(dot);
    }
    cell.append(num, dots);

    if ((state.data.photos[k] || []).length) {
      const cam = document.createElement('span');
      cam.className = 'cam';
      cam.textContent = '📸';
      cell.append(cam);
    }
    cell.addEventListener('click', () => openDay(k));
    grid.append(cell);
  }

  // task editor
  const editor = $('task-editor');
  editor.replaceChildren();
  for (const t of state.data.tasks) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = t.label;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '×';
    del.setAttribute('aria-label', `Remove ${t.label}`);
    del.addEventListener('click', () => {
      if (confirm(`Remove "${t.label}" from every day?`)) change(removeTask(t.id), `Remove task: ${t.label}`);
    });
    li.append(span, del);
    editor.append(li);
  }

  if ($('day').open) renderDay();
}

function openDay(day) {
  state.selected = day;
  renderDay();
  $('day').showModal();
}

function renderDay() {
  const day = state.selected;
  const editing = canEdit();
  const date = DAYS.find((d) => key(d) === day);

  const badge = $('day-date');
  badge.replaceChildren();
  const small = document.createElement('small');
  small.textContent = date.toLocaleDateString('en-GB', { weekday: 'short' });
  badge.append(small, String(date.getDate()));

  $('day-title').textContent =
    `${date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}`;
  $('day-mood').textContent = `Day ${DAYS.indexOf(date) + 1} · ${moodFor(day)}`;
  $('add-photo').hidden = !editing;

  const done = new Set(state.data.done[day] || []);
  const list = $('tasks');
  list.replaceChildren();
  for (const t of state.data.tasks) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = done.has(t.id);
    box.disabled = !editing;
    box.addEventListener('change', () => toggleTask(day, t, box.checked));
    const mark = document.createElement('span');
    mark.className = 'box';
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = t.label;
    label.append(box, mark, text);
    li.append(label);
    list.append(li);
  }
  if (isDone(day)) {
    const cheer = document.createElement('li');
    cheer.className = 'all-done';
    cheer.textContent = '🎉 All jobs done for today!';
    list.append(cheer);
  }

  const photos = state.data.photos[day] || [];
  $('no-photos').hidden = photos.length > 0;
  const strip = $('photos');
  strip.replaceChildren();
  for (const p of photos) {
    const frame = document.createElement('div');
    frame.className = 'polaroid';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = `Batman and Harvey, ${day}`;
    img.src = state.previews[p] || p;
    // Pages takes a minute to publish new files; raw.githubusercontent has them sooner
    img.addEventListener('error', () => { if (!img.src.startsWith(RAW)) img.src = RAW + p; }, { once: true });
    frame.addEventListener('click', () => openLightbox(day, p, img.src));
    frame.append(img);
    strip.append(frame);
  }
}

function toggleTask(day, task, on) {
  const wasDone = isDone(day);
  change(setDone(day, task.id, on), `${on ? 'Done' : 'Undo'}: ${task.label} (${day})`);
  if (!wasDone && isDone(day)) celebrate(day);
}

// ---------- celebration ----------

let confettiCanvas;
function celebrate(day) {
  document.querySelector(`.cell[data-day="${day}"]`)?.classList.add('stamp');
  if (typeof confetti !== 'function') return;
  if (!confettiCanvas) {
    // A popover sits in the top layer, so the confetti shows above the open modal.
    const canvas = document.createElement('canvas');
    canvas.className = 'confetti';
    canvas.setAttribute('popover', 'manual');
    document.body.append(canvas);
    confettiCanvas = { el: canvas, fire: confetti.create(canvas, { resize: true }) };
  }
  confettiCanvas.el.hidePopover?.();
  confettiCanvas.el.showPopover?.();
  const shapes = confetti.shapeFromText
    ? ['🐾', '🐟', '💛'].map((text) => confetti.shapeFromText({ text, scalar: 2 }))
    : undefined;
  const opts = { particleCount: 70, spread: 80, startVelocity: 40, scalar: 2, origin: { y: 0.7 } };
  confettiCanvas.fire({ ...opts, shapes, angle: 60, origin: { x: 0, y: 0.75 } });
  confettiCanvas.fire({ ...opts, shapes, angle: 120, origin: { x: 1, y: 0.75 } });
  confettiCanvas.fire({ particleCount: 60, spread: 100, origin: { y: 0.6 }, colors: ['#f5e33b', '#19e3c4', '#ff6b81', '#ffffff'] });
  setTimeout(() => confettiCanvas.el.hidePopover?.(), 5000);
}

// ---------- photos ----------

async function resize(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, CONFIG.maxPhotoSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', CONFIG.photoQuality));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadPhotos(files) {
  const day = state.selected;
  for (const file of files) {
    try {
      toast('Uploading photo… 📸');
      const blob = await resize(file);
      const path = `photos/${day}/${Date.now()}.jpg`;
      if (!isPreview()) {
        const b64 = bytesToB64(new Uint8Array(await blob.arrayBuffer()));
        const res = await putFile(path, b64, `Photo for ${day}`);
        if (!res.ok) throw await saveError(res);
      }
      state.previews[path] = URL.createObjectURL(blob);
      change(addPhoto(day, path), `Add photo (${day})`);
      toast(isPreview() ? 'Photo added (preview only, gone on refresh)' : 'Photo added 😻');
    } catch (err) {
      toast(err.message || 'Upload failed.', true);
    }
  }
}

let lightboxPhoto = null;

function openLightbox(day, path, src) {
  lightboxPhoto = { day, path };
  $('lightbox-img').src = src;
  $('delete-photo').hidden = !canEdit();
  $('lightbox').showModal();
}

// ---------- misc UI ----------

let toastTimer;
function toast(msg, error = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.hidden = false;
  // Re-show as a popover so it stacks above any open dialog.
  if (el.showPopover) {
    el.setAttribute('popover', 'manual');
    try { el.hidePopover(); } catch { /* not shown */ }
    el.showPopover();
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
    try { el.hidePopover?.(); } catch { /* not shown */ }
  }, error ? 10000 : 2500);
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'task';
}

function closeOnBackdrop(dialog) {
  dialog.addEventListener('click', (e) => {
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dialog.close();
  });
}

function wire() {
  $('photo-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) uploadPhotos(files);
  });

  $('close-day').addEventListener('click', () => $('day').close());
  closeOnBackdrop($('day'));
  $('close-lightbox').addEventListener('click', () => $('lightbox').close());
  closeOnBackdrop($('lightbox'));

  $('delete-photo').addEventListener('click', () => {
    if (!lightboxPhoto || !confirm('Delete this photo?')) return;
    const { day, path } = lightboxPhoto;
    $('lightbox').close();
    change(removePhoto(day, path), `Remove photo (${day})`);
    if (!isPreview()) deleteFile(path, `Delete photo (${day})`).catch(() => { /* orphaned file is harmless */ });
  });

  $('add-task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const label = $('new-task').value.trim();
    if (!label) return;
    change(addTask({ id: `${slug(label)}-${Date.now().toString(36)}`, label }), `Add task: ${label}`);
    $('new-task').value = '';
  });

  $('lock-btn').addEventListener('click', () => {
    writeToken(null);
    state.token = null;
    render();
    toast('Locked: read-only on this device');
  });

  $('unlock-form').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    const token = $('token-input').value.trim();
    $('token-input').value = '';
    const res = await fetch(API, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
    if (!res.ok) {
      toast("That token didn't work.", true);
      return;
    }
    writeToken(token);
    state.token = token;
    await load();
    render();
    toast('Editing unlocked on this device 🔓');
  });

  // Keep viewers up to date without hammering the API.
  const refresh = async () => {
    if (document.hidden || isPreview() || saving || queue.length) return;
    try { await load(); render(); } catch { /* ignore */ }
  };
  document.addEventListener('visibilitychange', refresh);
  setInterval(refresh, 120000);
}

async function init() {
  state.selected = DAYS.some((d) => key(d) === TODAY) ? TODAY : key(DAYS[0]);
  wire();
  try {
    await load();
  } catch {
    toast("Couldn't load progress.", true);
  }
  render();

  const params = new URLSearchParams(location.search);
  if (params.has('edit')) {
    history.replaceState(null, '', location.pathname);
    if (!state.token) $('unlock').showModal();
  }
}

init();
