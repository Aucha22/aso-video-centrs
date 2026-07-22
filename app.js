const API_URL = '/.netlify/functions/youtube-videos';
const videoPageSize = () => window.innerWidth <= 470 ? 4 : window.innerWidth <= 960 ? 6 : 9;
const shortsPageSize = () => window.innerWidth <= 700 ? 6 : 10;

const state = {
  videos: [], shorts: [], featured: null,
  visibleVideos: videoPageSize(), visibleShorts: shortsPageSize(),
  query: '', year: 'all',
};

const els = {
  videoTotal: document.querySelector('#video-total'), shortsTotal: document.querySelector('#shorts-total'),
  featured: document.querySelector('#featured'), featuredImage: document.querySelector('#featured-image'),
  featuredTitle: document.querySelector('#featured-title'), featuredMeta: document.querySelector('#featured-meta'),
  featuredDescription: document.querySelector('#featured-description'), grid: document.querySelector('#video-grid'),
  videoTemplate: document.querySelector('#video-card-template'), year: document.querySelector('#year-filter'),
  search: document.querySelector('#video-search'), results: document.querySelector('#results-count'),
  loadMore: document.querySelector('#load-more'), remaining: document.querySelector('#remaining-count'),
  reset: document.querySelector('#reset-filters'), empty: document.querySelector('#empty-state'),
  emptyReset: document.querySelector('#empty-reset'), shortsSection: document.querySelector('#shorts-section'),
  shortsGrid: document.querySelector('#shorts-grid'), shortTemplate: document.querySelector('#short-card-template'),
  shortsLoadMore: document.querySelector('#shorts-load-more'), shortsRemaining: document.querySelector('#shorts-remaining-count'),
  systemMessage: document.querySelector('#system-message'), systemMessageTitle: document.querySelector('#system-message-title'),
  systemMessageText: document.querySelector('#system-message-text'), dialog: document.querySelector('#video-dialog'),
  dialogClose: document.querySelector('#dialog-close'), dialogTitle: document.querySelector('#dialog-title'),
  dialogMeta: document.querySelector('#dialog-meta'), dialogLink: document.querySelector('#dialog-youtube-link'),
  player: document.querySelector('#player-wrap'),
};

const normalize = (value = '') => String(value).toLocaleLowerCase('lv-LV').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const formatDuration = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
const safeThumb = (video) => video.thumbnail || `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;

function postHeight() {
  requestAnimationFrame(() => window.parent?.postMessage({ type: 'aso-video-height', height: Math.ceil(document.documentElement.scrollHeight) }, '*'));
}

async function loadData() {
  renderSkeletons();
  const response = await fetch(`${API_URL}?v=dates-2`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `YouTube API kļūda (${response.status})`);
  return data;
}

function renderSkeletons() {
  els.grid.innerHTML = '';
  for (let i = 0; i < 6; i += 1) {
    const node = els.videoTemplate.content.cloneNode(true);
    const media = node.querySelector('.card-media');
    media.classList.add('skeleton'); media.innerHTML = '';
    node.querySelector('.card-meta').style.visibility = 'hidden';
    node.querySelector('h3').textContent = 'Ielādējam Ašo video…';
    els.grid.append(node);
  }
}

function hydrate(data) {
  state.videos = Array.isArray(data.videos) ? data.videos.filter(validVideo) : [];
  state.shorts = Array.isArray(data.shorts) ? data.shorts.filter(validVideo) : [];
  state.featured = data.featured || state.videos[0] || null;
  els.videoTotal.textContent = state.videos.length.toLocaleString('lv-LV');
  els.shortsTotal.textContent = state.shorts.length.toLocaleString('lv-LV');
  renderFeatured(); renderYears(); renderVideos(); renderShorts(); hideSystemMessage();
}

const validVideo = (video) => Boolean(video?.id && video?.title);

function renderFeatured() {
  const video = state.featured;
  if (!video) { els.featured.hidden = true; return; }
  els.featured.hidden = false; els.featured.dataset.videoId = video.id;
  els.featuredImage.src = safeThumb(video); els.featuredImage.alt = video.title;
  els.featuredImage.onerror = () => { els.featuredImage.src = `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`; };
  els.featuredTitle.textContent = cleanTitle(video.title);
  els.featuredMeta.textContent = ['AŠO VIDEO', formatDate(video.archiveDate || video.publishedAt)].filter(Boolean).join(' · ');
  els.featuredDescription.textContent = video.description || ''; els.featuredDescription.hidden = !video.description;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value); if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('lv-LV', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

function cleanTitle(title = '') {
  return title.replace(/^Sporta klubs\s*["“”']?Ašais["“”']?[.\s:-]*/i, '').replace(/\s+/g, ' ').trim();
}

function renderYears() {
  const years = [...new Set(state.videos.map((v) => String(v.year || '')).filter((y) => /^20\d{2}$/.test(y)))].sort((a, b) => Number(b) - Number(a));
  els.year.innerHTML = '<option value="all">Visi gadi</option>';
  years.forEach((year) => { const option = document.createElement('option'); option.value = year; option.textContent = year; els.year.append(option); });
}

function filteredVideos() {
  const query = normalize(state.query);
  return state.videos.filter((video) => {
    const yearMatch = state.year === 'all' || String(video.year) === state.year;
    const queryMatch = !query || normalize(video.searchText || `${video.title} ${video.description || ''}`).includes(query);
    return yearMatch && queryMatch;
  });
}

function renderVideos() {
  const matches = filteredVideos(), visible = matches.slice(0, state.visibleVideos); els.grid.innerHTML = '';
  visible.forEach((video) => {
    const node = els.videoTemplate.content.cloneNode(true), button = node.querySelector('.card-media'), image = node.querySelector('img');
    const duration = node.querySelector('.duration'), category = node.querySelector('.card-category'), time = node.querySelector('time'), title = node.querySelector('h3');
    button.setAttribute('aria-label', `Skatīties: ${video.title}`); image.src = safeThumb(video); image.alt = '';
    image.onerror = () => { image.src = `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`; };
    duration.textContent = formatDuration(video.durationSeconds); duration.hidden = !duration.textContent;
    category.hidden = true;
    time.textContent = formatDate(video.archiveDate || video.publishedAt) || video.year || '';
    time.dateTime = video.archiveDate || video.publishedAt || '';
    title.textContent = cleanTitle(video.title); button.addEventListener('click', () => openVideo(video)); els.grid.append(node);
  });
  els.results.textContent = `${matches.length.toLocaleString('lv-LV')} pilnie video${state.query || state.year !== 'all' ? ' atrasti' : ' arhīvā'}`;
  els.empty.hidden = matches.length !== 0; els.grid.hidden = matches.length === 0;
  els.reset.hidden = state.year === 'all' && !state.query;
  const remaining = Math.max(0, matches.length - visible.length); els.loadMore.hidden = remaining === 0; els.remaining.textContent = remaining ? `(${remaining})` : ''; postHeight();
}

function renderShorts() {
  if (!state.shorts.length) { els.shortsSection.hidden = true; return; }
  els.shortsSection.hidden = false; const visible = state.shorts.slice(0, state.visibleShorts); els.shortsGrid.innerHTML = '';
  visible.forEach((video) => {
    const node = els.shortTemplate.content.cloneNode(true), button = node.querySelector('.short-media'), image = node.querySelector('img');
    const duration = node.querySelector('.duration'), time = node.querySelector('time'), title = node.querySelector('h3');
    button.setAttribute('aria-label', `Skatīties Short: ${video.title}`); image.src = safeThumb(video); image.alt = '';
    image.onerror = () => { image.src = `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`; };
    duration.textContent = formatDuration(video.durationSeconds); duration.hidden = !duration.textContent;
    time.textContent = formatDate(video.archiveDate || video.publishedAt) || video.year || '';
    time.dateTime = video.archiveDate || video.publishedAt || '';
    title.textContent = cleanTitle(video.title); button.addEventListener('click', () => openVideo(video)); els.shortsGrid.append(node);
  });
  const remaining = Math.max(0, state.shorts.length - visible.length); els.shortsLoadMore.hidden = remaining === 0; els.shortsRemaining.textContent = remaining ? `(${remaining})` : ''; postHeight();
}

function openVideo(video) {
  if (!video) return;
  els.dialogTitle.textContent = cleanTitle(video.title);
  els.dialogMeta.textContent = [video.isShort ? 'SHORT' : 'AŠO VIDEO', formatDate(video.archiveDate || video.publishedAt)].filter(Boolean).join(' · ');
  els.dialogLink.href = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`;
  els.player.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.id)}?autoplay=1&rel=0" title="${escapeHtml(video.title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
  if (typeof els.dialog.showModal === 'function') els.dialog.showModal(); else window.open(els.dialogLink.href, '_blank', 'noopener');
}
function closeVideo() { els.player.innerHTML = ''; if (els.dialog.open) els.dialog.close(); }
function resetFilters() { state.query = ''; state.year = 'all'; state.visibleVideos = videoPageSize(); els.search.value = ''; els.year.value = 'all'; renderVideos(); }
function showSystemMessage(title, text) { els.systemMessageTitle.textContent = title; els.systemMessageText.textContent = text; els.systemMessage.hidden = false; postHeight(); }
function hideSystemMessage() { els.systemMessage.hidden = true; }
function escapeHtml(value = '') { return value.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }

for (const button of document.querySelectorAll('.js-featured-play')) button.addEventListener('click', () => openVideo(state.featured));
els.search.addEventListener('input', (event) => { state.query = event.target.value.trim(); state.visibleVideos = videoPageSize(); renderVideos(); });
els.year.addEventListener('change', (event) => { state.year = event.target.value; state.visibleVideos = videoPageSize(); renderVideos(); });
els.loadMore.addEventListener('click', () => { state.visibleVideos += videoPageSize(); renderVideos(); });
els.shortsLoadMore.addEventListener('click', () => { state.visibleShorts += shortsPageSize(); renderShorts(); });
els.reset.addEventListener('click', resetFilters); els.emptyReset.addEventListener('click', resetFilters); els.dialogClose.addEventListener('click', closeVideo);
els.dialog.addEventListener('click', (event) => { const r = els.dialog.getBoundingClientRect(); if (!(event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom)) closeVideo(); });
els.dialog.addEventListener('close', () => { els.player.innerHTML = ''; });
new ResizeObserver(postHeight).observe(document.documentElement); window.addEventListener('load', postHeight); window.addEventListener('resize', postHeight);
document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); els.search.focus(); } });

loadData().then(hydrate).catch((error) => {
  console.error(error); state.videos = []; state.shorts = []; els.videoTotal.textContent = '0'; els.shortsTotal.textContent = '0'; els.featured.hidden = true; els.grid.innerHTML = '';
  els.results.textContent = 'Video šobrīd neizdevās ielādēt.'; els.empty.hidden = false; els.shortsSection.hidden = true;
  showSystemMessage('YouTube dati neielādējās.', error.message || 'Pārbaudi YOUTUBE_API_KEY Netlify iestatījumos.');
});
