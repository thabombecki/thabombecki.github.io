'use strict';

const CONFIG = {
  owner: 'thabombecki',
  repo: 'thabombecki.github.io',
  branch: 'main',
  dir: 'katter',          // folder inside the repo
  start: new Date(2026, 9, 15),
  days: 16,
  maxPhotoSide: 1600,
  photoQuality: 0.8,
};

const API = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}`;
const RAW = `https://raw.githubusercontent.com/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}/${CONFIG.dir}/`;
const TOKEN_KEY = 'katter-token';
const PREVIEW_KEY = 'katter-preview';

const HOME_TZ = 'Africa/Johannesburg';
const AWAY_TZ = 'Asia/Tokyo';

const DEFAULT_CATS = [
  { id: 'batman', name: 'Batman', avatar: 'batman.png', bio: '', rating: { label: 'Hungry stare', emoji: '😾', value: 5 } },
  { id: 'harvey', name: 'Harvey', avatar: 'harvey.png', bio: '', rating: { label: 'Shelf chaos', emoji: '🙀', value: 4 } },
];

const state = {
  data: { tasks: [], notes: [], done: {}, times: {}, diary: {}, photos: {}, captions: {}, cats: [] },
  sha: null,
  token: readToken(),
  selected: null,
  previews: {},   // photo path -> local object URL, so fresh uploads show before Pages redeploys
  drafts: {},     // unsaved text in note/bio boxes, so re-renders don't wipe what's being typed
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

// "Today" is the sitter's day in South Africa, also for the owners viewing from Japan.
function zonedKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
const TODAY = zonedKey(new Date(), HOME_TZ);

function zonedTime(date, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

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
  return {
    tasks: d.tasks || [],
    notes: d.notes || [],
    done: d.done || {},
    times: d.times || {},
    diary: d.diary || {},
    photos: d.photos || {},
    captions: d.captions || {},
    cats: d.cats || structuredClone(DEFAULT_CATS),
  };
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
    const { photos, captions, ...rest } = state.data;
    try { localStorage.setItem(PREVIEW_KEY, JSON.stringify(rest)); } catch { /* ignore */ }
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

const setDone = (day, id, on, at = new Date().toISOString()) => (d) => {
  const list = new Set(d.done[day] || []);
  on ? list.add(id) : list.delete(id);
  d.done[day] = [...list];
  d.times[day] = d.times[day] || {};
  if (on) d.times[day][id] = d.times[day][id] || at;
  else delete d.times[day][id];
};
const setDiary = (day, text) => (d) => {
  if (text) d.diary[day] = text;
  else delete d.diary[day];
};
const setCaption = (path, text) => (d) => {
  if (text) d.captions[path] = text;
  else delete d.captions[path];
};
const setCat = (id, fields) => (d) => {
  const cat = d.cats.find((c) => c.id === id);
  if (cat) Object.assign(cat, structuredClone(fields));
};
const addPhoto = (day, path) => (d) => {
  const list = d.photos[day] || [];
  if (!list.includes(path)) d.photos[day] = [...list, path];
};
const removePhoto = (day, path) => (d) => {
  d.photos[day] = (d.photos[day] || []).filter((p) => p !== path);
  if (!d.photos[day].length) delete d.photos[day];
  delete d.captions[path];
};
const addTask = (task) => (d) => {
  if (!d.tasks.some((t) => t.id === task.id)) d.tasks.push(task);
};
const removeTask = (id) => (d) => {
  d.tasks = d.tasks.filter((t) => t.id !== id);
};

// ---------- rendering ----------

// A task or note without `days` applies to every day; otherwise only to the listed dates.
const appliesTo = (day) => (item) => !item.days || item.days.includes(day);
const tasksFor = (day) => state.data.tasks.filter(appliesTo(day));
const notesFor = (day) => state.data.notes.filter(appliesTo(day));

function doneCount(day) {
  const done = new Set(state.data.done[day] || []);
  return tasksFor(day).filter((t) => done.has(t.id)).length;
}
function isDone(day) {
  const total = tasksFor(day).length;
  return total > 0 && doneCount(day) === total;
}

// Icons for the extras on a day, shown on its calendar cell.
function iconsFor(day) {
  const icons = [...tasksFor(day), ...notesFor(day)].filter((x) => x.days && x.icon).map((x) => x.icon);
  return [...new Set(icons)].slice(0, 3);
}

const MOODS = {
  none: ['Batman is giving you the hungry stare 😾', 'Harvey has knocked something off a shelf to get your attention 🙀', 'Two hungry boys dreaming of sushi 🍣'],
  some: ['Harvey says: keep going, human 😺', 'Batman is cautiously optimistic 🐈‍⬛', 'Getting there, the purring has begun 😸'],
  all: ['Purr-fect day! Both boys approve 😻', 'Batman and Harvey rate you 10/10 🏆', 'Sugoi! Mission accomplished. Nap time 💤'],
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
    const [y, m, d] = TODAY.split('-').map(Number);
    const days = Math.round((DAYS[0] - new Date(y, m - 1, d)) / 86400000);
    return days === 1 ? '🧳 Starts tomorrow!' : `🧳 Starts in ${days} days`;
  }
  if (TODAY > last) return '💜 All done, thanks for looking after us!';
  return `🐾 Day ${DAYS.findIndex((d) => key(d) === TODAY) + 1} of ${DAYS.length}`;
}

const shortDate = (day) => DAYS.find((d) => key(d) === day)
  .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

function photoImg(path, alt) {
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = alt;
  img.src = state.previews[path] || path;
  // Pages takes a minute to publish new files; raw.githubusercontent has them sooner
  img.addEventListener('error', () => { if (!img.src.startsWith(RAW)) img.src = RAW + path; }, { once: true });
  return img;
}

const allPhotos = () => DAYS.flatMap((d) => (state.data.photos[key(d)] || []).map((path) => ({ day: key(d), path })));

// A text block: plain text for viewers, a textarea with a Save button for the sitter.
function editableText({ id, value = '', placeholder, empty, rows = 3, onSave }) {
  const wrap = document.createElement('div');
  wrap.className = 'editable';
  if (!canEdit()) {
    const p = document.createElement('p');
    p.className = value ? 'editable-text' : 'muted';
    p.textContent = value || empty || '';
    wrap.append(p);
    return wrap;
  }
  const ta = document.createElement('textarea');
  ta.rows = rows;
  ta.placeholder = placeholder;
  ta.value = state.drafts[id] ?? value;
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn primary';
  save.textContent = 'Save';
  save.disabled = ta.value === value;
  ta.addEventListener('input', () => {
    state.drafts[id] = ta.value;
    save.disabled = ta.value === value;
  });
  save.addEventListener('click', () => {
    delete state.drafts[id];
    onSave(ta.value.trim());
    toast('Saved ✍️');
  });
  wrap.append(ta, save);
  return wrap;
}

function renderAlbum() {
  const photos = allPhotos();
  $('album-empty').hidden = photos.length > 0;
  $('slideshow').hidden = photos.length < 2;
  const box = $('album-days');
  box.replaceChildren();
  for (const d of DAYS) {
    const k = key(d);
    const list = state.data.photos[k] || [];
    if (!list.length) continue;
    const group = document.createElement('div');
    group.className = 'album-day';
    const label = document.createElement('div');
    label.className = 'album-date';
    label.textContent = shortDate(k);
    const strip = document.createElement('div');
    strip.className = 'album-strip';
    for (const p of list) {
      const thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'thumb';
      thumb.append(photoImg(p, `Batman and Harvey, ${shortDate(k)}`));
      thumb.addEventListener('click', () => openLightbox(photos, photos.findIndex((x) => x.path === p)));
      strip.append(thumb);
    }
    group.append(label, strip);
    box.append(group);
  }
}

function renderCats() {
  const box = $('cats');
  box.replaceChildren();
  for (const cat of state.data.cats) {
    const card = document.createElement('article');
    card.className = 'cat-card';

    const head = document.createElement('div');
    head.className = 'cat-head';
    const img = document.createElement('img');
    img.className = 'avatar';
    img.src = cat.avatar;
    img.alt = cat.name;
    const name = document.createElement('h4');
    name.textContent = cat.name;
    head.append(img, name);

    const rating = document.createElement('div');
    rating.className = 'rating';
    const label = document.createElement('span');
    label.className = 'rating-label';
    label.textContent = cat.rating.label;
    const meter = document.createElement('span');
    meter.className = 'meter';
    for (let i = 1; i <= 5; i++) {
      const pip = document.createElement(canEdit() ? 'button' : 'span');
      pip.textContent = cat.rating.emoji;
      pip.className = i <= cat.rating.value ? 'pip on' : 'pip';
      if (canEdit()) {
        pip.type = 'button';
        pip.setAttribute('aria-label', `${cat.rating.label} ${i} of 5`);
        pip.addEventListener('click', () =>
          change(setCat(cat.id, { rating: { ...cat.rating, value: i } }), `${cat.name}: ${cat.rating.label} ${i}/5`));
      }
      meter.append(pip);
    }
    rating.append(label, meter);

    const bio = editableText({
      id: `bio-${cat.id}`,
      value: cat.bio,
      placeholder: `Quirks, favourite spots, how ${cat.name} likes to be greeted…`,
      empty: 'Profile coming soon 🐾',
      onSave: (text) => change(setCat(cat.id, { bio: text }), `Update ${cat.name}'s profile`),
    });
    card.append(head, rating, bio);
    box.append(card);
  }
}

function tickClocks() {
  const now = new Date();
  const away = zonedTime(now, AWAY_TZ);
  const hour = Number(away.slice(0, 2));
  const night = hour >= 22 || hour < 7;
  $('clocks').textContent = `🇯🇵 ${away}${night ? ' 😴' : ''} · 🇿🇦 ${zonedTime(now, HOME_TZ)}`;
  $('clocks').title = night ? "It's night in Japan" : '';
}

function render() {
  const editing = canEdit();

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
  $('progress-text').textContent = finished === DAYS.length ? `${DAYS.length}/${DAYS.length} 🎉` : `${finished} of ${DAYS.length} days`;

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
    const total = tasksFor(k).length;
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
    const icons = document.createElement('span');
    icons.className = 'icons';
    icons.textContent = iconsFor(k).join('');
    const bar = document.createElement('span');
    bar.className = 'mini';
    const fill = document.createElement('span');
    fill.style.width = `${total ? (n / total) * 100 : 0}%`;
    bar.append(fill);
    cell.append(num, icons, bar);

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
    span.textContent = `${t.when === 'pm' ? '🌙' : '🌅'} ${t.label}`;
    if (t.days) {
      const when = document.createElement('small');
      when.className = 'only';
      when.textContent = `only ${t.days.map((x) => Number(x.slice(-2))).join(', ')} Oct`;
      span.append(when);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '×';
    del.setAttribute('aria-label', `Remove ${t.label}`);
    del.addEventListener('click', () => {
      const where = t.days ? 'the days it is on' : 'every day';
      if (confirm(`Remove "${t.label}" from ${where}?`)) change(removeTask(t.id), `Remove task: ${t.label}`);
    });
    li.append(span, del);
    editor.append(li);
  }

  renderAlbum();
  renderCats();
  if ($('day').open) renderDay();
}

function openDay(day) {
  state.selected = day;
  renderDay();
  $('day').showModal();
  // Viewers get the party every time they open a finished day.
  if (!canEdit() && isDone(day)) celebrate(day);
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
  for (const [when, heading] of [['am', '🌅 Morning'], ['pm', '🌙 Evening']]) {
    const tasks = tasksFor(day).filter((t) => (t.when || 'am') === when);
    const notes = notesFor(day).filter((n) => (n.when || 'am') === when);
    if (!tasks.length && !notes.length) continue;

    const head = document.createElement('li');
    head.className = 'group';
    head.textContent = heading;
    list.append(head);

    for (const n of notes) {
      const li = document.createElement('li');
      li.className = 'note';
      li.textContent = `${n.icon || 'ℹ️'} ${n.text}`;
      list.append(li);
    }
    for (const t of tasks) {
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
      text.textContent = t.days && t.icon ? `${t.label} ${t.icon}` : t.label;
      label.append(box, mark, text);
      const at = state.data.times[day]?.[t.id];
      if (box.checked && at) {
        const time = document.createElement('span');
        time.className = 'time';
        time.textContent = zonedTime(new Date(at), HOME_TZ);
        time.title = 'Ticked at (South African time)';
        label.append(time);
      }
      li.append(label);
      list.append(li);
    }
  }
  if (isDone(day)) {
    const cheer = document.createElement('li');
    cheer.className = 'all-done';
    cheer.textContent = '🎉 All jobs done for today!';
    list.append(cheer);
  }

  const note = state.data.diary[day] || '';
  $('diary').hidden = !editing && !note;
  $('diary-body').replaceChildren(editableText({
    id: `diary-${day}`,
    value: note,
    placeholder: 'How did the boys do today? 🐾',
    rows: 3,
    onSave: (text) => change(setDiary(day, text), `Note for ${day}`),
  }));

  const photos = state.data.photos[day] || [];
  $('no-photos').hidden = photos.length > 0;
  const strip = $('photos');
  strip.replaceChildren();
  const lbList = photos.map((path) => ({ day, path }));
  photos.forEach((p, i) => {
    const frame = document.createElement('button');
    frame.type = 'button';
    frame.className = 'polaroid';
    frame.append(photoImg(p, `Batman and Harvey, ${day}`));
    const cap = document.createElement('span');
    cap.className = 'cap';
    cap.textContent = state.data.captions[p] || '';
    frame.append(cap);
    frame.addEventListener('click', () => openLightbox(lbList, i));
    strip.append(frame);
  });
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
    ? ['🌸', '🍣', '🐾'].map((text) => confetti.shapeFromText({ text, scalar: 2 }))
    : undefined;
  const opts = { particleCount: 70, spread: 80, startVelocity: 40, scalar: 2, origin: { y: 0.7 } };
  confettiCanvas.fire({ ...opts, shapes, angle: 60, origin: { x: 0, y: 0.75 } });
  confettiCanvas.fire({ ...opts, shapes, angle: 120, origin: { x: 1, y: 0.75 } });
  confettiCanvas.fire({ particleCount: 60, spread: 100, origin: { y: 0.6 }, colors: ['#e23b45', '#f6a9bb', '#2d3f7a', '#ffffff'] });
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

// ---------- lightbox / slideshow ----------

const lb = { list: [], index: 0, timer: null };

function openLightbox(list, index, play = false) {
  lb.list = list;
  stopSlideshow();
  showPhoto(index);
  if (!$('lightbox').open) $('lightbox').showModal();
  if (play) startSlideshow();
}

function showPhoto(index) {
  const n = lb.list.length;
  if (!n) { $('lightbox').close(); return; }
  lb.index = ((index % n) + n) % n;
  const { day, path } = lb.list[lb.index];
  const img = $('lightbox-img');
  img.onerror = () => { img.onerror = null; img.src = RAW + path; };
  img.src = state.previews[path] || path;
  img.alt = `Batman and Harvey, ${shortDate(day)}`;
  $('lb-meta').textContent = n > 1 ? `${shortDate(day)} · ${lb.index + 1} / ${n}` : shortDate(day);
  $('lb-prev').hidden = $('lb-next').hidden = $('lb-play').hidden = n < 2;

  const caption = state.data.captions[path] || '';
  $('lb-caption').textContent = caption;
  $('lb-caption').hidden = canEdit() || !caption;
  $('caption-form').hidden = !canEdit();
  $('caption-input').value = caption;
  $('delete-photo').hidden = !canEdit();
}

function startSlideshow() {
  stopSlideshow();
  lb.timer = setInterval(() => showPhoto(lb.index + 1), 3500);
  $('lb-play').textContent = '⏸ Pause';
}
function stopSlideshow() {
  clearInterval(lb.timer);
  lb.timer = null;
  $('lb-play').textContent = '▶ Play';
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
    // Backdrop clicks target the dialog itself; keyboard "clicks" have no position, so ignore those.
    if (e.target !== dialog || (e.clientX === 0 && e.clientY === 0)) return;
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
    const item = lb.list[lb.index];
    if (!item || !confirm('Delete this photo?')) return;
    const { day, path } = item;
    change(removePhoto(day, path), `Remove photo (${day})`);
    if (!isPreview()) deleteFile(path, `Delete photo (${day})`).catch(() => { /* orphaned file is harmless */ });
    lb.list.splice(lb.index, 1);
    showPhoto(lb.index);
  });

  $('lb-prev').addEventListener('click', () => { stopSlideshow(); showPhoto(lb.index - 1); });
  $('lb-next').addEventListener('click', () => { stopSlideshow(); showPhoto(lb.index + 1); });
  $('lb-play').addEventListener('click', () => (lb.timer ? stopSlideshow() : startSlideshow()));
  $('lightbox').addEventListener('close', stopSlideshow);
  $('lightbox').addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') { stopSlideshow(); showPhoto(lb.index - 1); }
    if (e.key === 'ArrowRight') { stopSlideshow(); showPhoto(lb.index + 1); }
  });
  let touchX = null;
  $('lightbox-img').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  $('lightbox-img').addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 40) { stopSlideshow(); showPhoto(lb.index + (dx < 0 ? 1 : -1)); }
  });
  $('caption-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const { day, path } = lb.list[lb.index];
    change(setCaption(path, $('caption-input').value.trim()), `Caption for photo (${day})`);
    toast('Caption saved ✍️');
  });
  $('slideshow').addEventListener('click', () => openLightbox(allPhotos(), 0, true));

  $('add-task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const label = $('new-task').value.trim();
    if (!label) return;
    const when = $('new-task-when').value;
    change(addTask({ id: `${slug(label)}-${Date.now().toString(36)}`, label, when }), `Add task: ${label}`);
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

  // Secret login: five quick taps on the cat banner open the unlock box.
  let taps = 0;
  let tapTimer;
  document.querySelector('.banner').addEventListener('click', () => {
    taps += 1;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { taps = 0; }, 1500);
    if (taps < 5) return;
    taps = 0;
    if (state.token) toast('Already unlocked on this device ✏️');
    else $('unlock').showModal();
  });

  // Keep viewers up to date without hammering the API.
  const refresh = async () => {
    const typing = ['TEXTAREA', 'INPUT'].includes(document.activeElement?.tagName);
    if (document.hidden || isPreview() || saving || queue.length || typing) return;
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

  tickClocks();
  setInterval(tickClocks, 15000);

  const params = new URLSearchParams(location.search);
  if (params.has('edit')) {
    history.replaceState(null, '', location.pathname);
    if (!state.token) $('unlock').showModal();
  } else if (canEdit() && DAYS.some((d) => key(d) === TODAY)) {
    // The sitter lands straight on today's jobs.
    openDay(TODAY);
  }
}

init();
