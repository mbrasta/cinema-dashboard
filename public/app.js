'use strict';

/* ========================================================
   وضعیت کلی برنامه
======================================================== */
let currentSelectedMovie = null;
let isAuthLoginMode = true;
let allUserMovies = [];
let movieToDeleteId = null;
let lastRandomKey = '';
let suggestSeq = 0;
let gridSeq = 0;
let suggestTimer = null;

// وضعیت مربوط به پروفایل/دوستان/چت
let currentUserId = null;
let currentUserAvatar = '';
let currentUserBio = '';
let chatSocket = null;
let activeChatPartnerId = null;
let activeChatPartnerName = '';
let userSearchTimer = null;

const $ = (id) => document.getElementById(id);

// لیست پیشنهادی اولیه (تا وقتی پوسترهای واقعی از سرور می‌رسند)
const FALLBACK_FEATURED = [
    { id: 'tt0816692', title: 'Interstellar', genre: 'ماجراجویی، علمی-تخیلی', type: 'movie', runtime: 169 },
    { id: 'tt1375666', title: 'Inception', genre: 'علمی-تخیلی، اکشن', type: 'movie', runtime: 148 },
    { id: 'tt0468569', title: 'The Dark Knight', genre: 'اکشن، جنایی', type: 'movie', runtime: 152 },
    { id: 'tt0903747', title: 'Breaking Bad', genre: 'درام، جنایی', type: 'series', total_seasons: 5, total_episodes: 62 },
    { id: 'tt0944947', title: 'Game of Thrones', genre: 'اکشن، ماجراجویی', type: 'series', total_seasons: 8, total_episodes: 73 },
    { id: 'tt4574334', title: 'Stranger Things', genre: 'علمی-تخیلی، ترسناک', type: 'series', total_seasons: 5, total_episodes: 42 },
    { id: 'tt7366338', title: 'Chernobyl', genre: 'تاریخی، درام', type: 'series', total_seasons: 1, total_episodes: 5 },
    { id: 'tt2442560', title: 'Peaky Blinders', genre: 'جنایی، درام', type: 'series', total_seasons: 6, total_episodes: 36 }
];
let featuredList = [...FALLBACK_FEATURED];

/* ========================================================
   ابزارها
======================================================== */
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function isSeriesMovie(m) {
    return !!m && (m.type === 'series' || m.is_series || Number(m.total_seasons) > 0);
}

function persistLocal() {
    try { localStorage.setItem('my_cinema_movies', JSON.stringify(allUserMovies)); } catch (e) {}
}

function showToast(message, type = 'info') {
    const container = $('toastContainer');
    if (!container) return;
    const icons = { success: 'fa-circle-check', error: 'fa-circle-exclamation', info: 'fa-circle-info' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="fa-solid ${icons[type] || icons.info}"></i><span>${esc(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('out');
        setTimeout(() => toast.remove(), 300);
    }, 2800);
}

/* ========================================================
   پوسترها: پروکسی سرور → آدرس اصلی → تصویر جایگزین با نام فیلم
======================================================== */
const POSTER_WIDTHS = { thumb: 120, medium: 300, large: 500 };
const placeholderCache = new Map();

// تصویر جایگزین (SVG داخلی، بدون هیچ درخواست شبکه‌ای) که نام فیلم روی آن نوشته می‌شود
function placeholderSvg(title) {
    const key = String(title || '');
    if (placeholderCache.has(key)) return placeholderCache.get(key);

    const words = key.trim().split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    words.forEach((w) => {
        const next = (cur + ' ' + w).trim();
        if (next.length > 14 && cur) { lines.push(cur); cur = w; } else { cur = next; }
    });
    if (cur) lines.push(cur);

    let shown = lines.slice(0, 4);
    if (lines.length > 4) shown[3] = shown[3] + '…';
    if (!shown.length) shown = ['بدون پوستر'];

    const text = shown.map((l, i) =>
        `<text x="150" y="${262 + i * 26}" text-anchor="middle" font-family="Vazirmatn,Tahoma,Arial,sans-serif" font-size="20" font-weight="700" fill="#e9e9ee">${esc(l)}</text>`
    ).join('');

    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450">` +
        `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#262638"/><stop offset="1" stop-color="#0e0e15"/></linearGradient></defs>` +
        `<rect width="300" height="450" fill="url(#g)"/>` +
        `<circle cx="150" cy="150" r="48" fill="none" stroke="#e50914" stroke-width="4" opacity=".9"/>` +
        `<path d="M137 126 L137 174 L178 150 Z" fill="#e50914" opacity=".95"/>` +
        text +
        `</svg>`;

    const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    if (placeholderCache.size > 300) placeholderCache.clear();
    placeholderCache.set(key, uri);
    return uri;
}

function isRemoteUrl(u) {
    return typeof u === 'string' && /^https?:\/\//i.test(u.trim());
}

// آدرس پوستر را از مسیر پروکسی سرور عبور می‌دهد (کش دیسکی + اندازه‌ی مناسب)
function proxiedPoster(url, size = 'medium') {
    if (!isRemoteUrl(url)) return '';
    return `/api/img?w=${POSTER_WIDTHS[size] || 300}&u=${encodeURIComponent(url.trim())}`;
}

// اگر پروکسی خطا داد، یک بار آدرس اصلی را امتحان می‌کند؛ اگر آن هم خطا داد تصویر جایگزین
function imgErr(img) {
    const stage = Number(img.dataset.stage || 0);
    const orig = img.dataset.orig;
    if (stage === 0 && orig) {
        img.dataset.stage = '1';
        img.src = orig;
        return;
    }
    img.onerror = null;
    img.removeAttribute('onerror');
    img.dataset.stage = '2';
    img.classList.add('loaded', 'is-fallback');
    img.src = placeholderSvg(img.dataset.title || '');
}

function posterImgHTML(poster, title, size, opts = {}) {
    const { width = 160, height = 240, eager = true } = opts;
    const hasPoster = isRemoteUrl(poster);
    const src = hasPoster ? proxiedPoster(poster, size) : placeholderSvg(title);
    const cls = 'poster-img' + (hasPoster ? '' : ' loaded is-fallback');
    return `<img class="${cls}" src="${esc(src)}" data-orig="${hasPoster ? esc(poster.trim()) : ''}" data-title="${esc(title)}" alt="${esc(title)}" width="${width}" height="${height}" loading="${eager ? 'eager' : 'lazy'}" decoding="async" onload="this.classList.add('loaded')" onerror="imgErr(this)">`;
}

// برای تصاویری که داخل index.html هستند (پنل ویرایش و مدال پیشنهاد)
function setPoster(img, poster, title, size) {
    if (!img) return;
    const hasPoster = isRemoteUrl(poster);
    img.classList.add('poster-img');
    img.classList.remove('loaded', 'is-fallback');
    img.dataset.stage = '0';
    img.dataset.orig = hasPoster ? poster.trim() : '';
    img.dataset.title = title || '';
    img.alt = title || '';
    img.onload = () => img.classList.add('loaded');
    img.onerror = () => imgErr(img);
    if (hasPoster) {
        img.src = proxiedPoster(poster, size);
    } else {
        img.classList.add('loaded', 'is-fallback');
        img.src = placeholderSvg(title);
    }
}

/* ========================================================
   شروع برنامه
======================================================== */
document.addEventListener('DOMContentLoaded', () => {
    checkUserSession();
    setupAutocomplete();
    restoreLastTab();
    setupKeyboardShortcuts();
    setupOverlays();
    loadFeatured();
});

async function loadFeatured() {
    try {
        const res = await fetch('/api/featured');
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data) && data.length) featuredList = data;
    } catch (e) {}
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closePurplePanel();
            closeAuthModal();
            closeConfirmModal();
            closeRandomModal();
            closeMobileSidebar();
        }
    });
}

// بستن مدال‌ها با کلیک روی پس‌زمینه + ساخت پس‌زمینه‌ی پنل ویرایش
function setupOverlays() {
    const closers = {
        authModal: closeAuthModal,
        randomModal: closeRandomModal,
        confirmModal: closeConfirmModal
    };
    Object.keys(closers).forEach((id) => {
        const el = $(id);
        if (el) el.addEventListener('click', (e) => { if (e.target === el) closers[id](); });
    });

    if (!$('panelBackdrop')) {
        const b = document.createElement('div');
        b.id = 'panelBackdrop';
        b.className = 'panel-backdrop hidden';
        b.addEventListener('click', closePurplePanel);
        document.body.appendChild(b);
    }

    const filterInput = $('filterInput');
    if (filterInput) filterInput.addEventListener('input', filterMovies);
}

function togglePasswordVisibility() {
    const input = $('authPassword');
    const icon = document.querySelector('.toggle-password');
    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
        input.type = 'password';
        icon.classList.replace('fa-eye-slash', 'fa-eye');
    }
}

/* ========================================================
   تب‌ها
======================================================== */
function switchTab(tabName) {
    document.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((tab) => tab.classList.add('hidden'));

    try { localStorage.setItem('activeTab', tabName); } catch (e) {}

    const activeBtn = $(`tabNav-${tabName}`);
    if (activeBtn) activeBtn.classList.add('active');

    const tabMap = {
        search: 'searchTab',
        watching: 'watchingTab',
        watched: 'watchedTab',
        watchlist: 'watchlistTab',
        social: 'socialTab'
    };
    const target = $(tabMap[tabName] || 'searchTab');
    if (target) target.classList.remove('hidden');

    if (tabName === 'social') loadSocialData();

    const content = document.querySelector('.content-blue');
    if (content) content.scrollTop = 0;
    window.scrollTo({ top: 0 });
    closeMobileSidebar();
}

function restoreLastTab() {
    let last = 'search';
    try { last = localStorage.getItem('activeTab') || 'search'; } catch (e) {}
    switchTab(last);
}

function getStarRatingHTML(rating) {
    if (!rating || rating <= 0) return '';
    const starsCount = Math.round(rating / 2);
    let starsHtml = '';
    for (let i = 1; i <= 5; i++) starsHtml += i <= starsCount ? '★' : '☆';
    return `<div class="star-rating" title="امتیاز: ${esc(rating)}">${starsHtml}</div>`;
}

/* ========================================================
   نشست و ورود / ثبت‌نام
======================================================== */
async function checkUserSession() {
    try {
        const res = await fetch('/api/auth/me');
        if (res.ok) {
            const data = await res.json();
            if (data && data.loggedIn) {
                $('displayUsername').innerHTML = `
                    <div class="user-status-container">
                        <span class="online-dot"></span>
                        <span>${esc(data.username)}</span>
                    </div>
                `;
                $('displayStatus').innerText = 'عضو رسمی';
                const authBtn = $('authBtn');
                authBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i> <span class="auth-text">خروج</span>';
                authBtn.onclick = logoutUser;

                currentUserId = data.id;
                currentUserAvatar = data.avatar || '';
                currentUserBio = data.bio || '';
                const avatarBtn = $('myAvatarBtn');
                if (avatarBtn) {
                    avatarBtn.classList.remove('hidden');
                    setPoster($('myAvatarImg'), currentUserAvatar, data.username, 'thumb');
                }

                await loadMyMovies();
                initChatSocket();
                refreshSocialBadge();
                return;
            }
        }
    } catch (err) {}
    handleLoggedOutState();
}

function handleLoggedOutState() {
    $('displayUsername').innerText = 'کاربر مهمان';
    $('displayStatus').innerText = 'غیرفعال (لطفاً وارد شوید)';
    const authBtn = $('authBtn');
    authBtn.innerHTML = '<i class="fa-solid fa-user-plus"></i> <span class="auth-text">ورود / ثبت‌نام</span>';
    authBtn.onclick = openAuthModal;

    allUserMovies = [];
    try { localStorage.removeItem('my_cinema_movies'); } catch (e) {}
    refreshUI();

    currentUserId = null;
    const avatarBtn = $('myAvatarBtn');
    if (avatarBtn) avatarBtn.classList.add('hidden');
    disconnectChatSocket();
    closeChatWindow();
    const badge = $('socialBadge');
    if (badge) badge.classList.add('hidden');
}

function openAuthModal() { $('authModal').classList.remove('hidden'); }
function closeAuthModal() { $('authModal').classList.add('hidden'); }

function toggleAuthMode(e) {
    e.preventDefault();
    isAuthLoginMode = !isAuthLoginMode;
    $('authTitle').innerText = isAuthLoginMode ? 'ورود به حساب' : 'ایجاد حساب جدید';
    $('authSubmitBtn').innerText = isAuthLoginMode ? 'ورود' : 'ثبت‌نام';
    $('toggleAuthText').innerHTML = isAuthLoginMode
        ? 'حساب ندارید؟ <a href="#" onclick="toggleAuthMode(event)">ثبت‌نام کنید</a>'
        : 'حساب دارید؟ <a href="#" onclick="toggleAuthMode(event)">وارد شوید</a>';
    $('authPassword').autocomplete = isAuthLoginMode ? 'current-password' : 'new-password';
}

async function submitAuth() {
    const username = $('authUsername').value.trim();
    const password = $('authPassword').value.trim();
    const endpoint = isAuthLoginMode ? '/api/auth/login' : '/api/auth/register';

    if (!username || !password) {
        showToast('لطفاً نام کاربری و رمز عبور را وارد کنید.', 'error');
        return;
    }

    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        if (res.ok) {
            closeAuthModal();
            $('authPassword').value = '';
            showToast(isAuthLoginMode ? 'با موفقیت وارد شدید.' : 'حساب شما ساخته شد.', 'success');
            await checkUserSession();
        } else {
            const data = await res.json().catch(() => ({}));
            showToast(data.error || 'خطا در ورود/ثبت‌نام', 'error');
        }
    } catch (e) {
        showToast('ارتباط با سرور برقرار نشد.', 'error');
    }
}

async function logoutUser() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
        showToast('از حساب خارج شدید.', 'info');
    } catch (e) {}
    handleLoggedOutState();
}

/* ========================================================
   جستجو: پیشنهاد سریع + نتایج کامل
======================================================== */
async function fetchSearch(q) {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error('search failed');
    const data = await res.json();
    return Array.isArray(data) ? data : [];
}

function typeLabel(item) {
    return item.type === 'series' ? 'سریال' : 'فیلم';
}

function metaHtmlFor(item) {
    if (item.type === 'series') {
        const s = item.total_seasons || 0;
        const e = item.total_episodes || 0;
        if (s > 0 || e > 0) {
            const parts = [s > 0 ? `${s} فصل` : '', e > 0 ? `${e} قسمت` : ''].filter(Boolean).join(' | ');
            return `<div class="suggestion-meta"><i class="fa-solid fa-tv"></i> ${parts}</div>`;
        }
        return '';
    }
    const runtime = item.runtime || 0;
    return runtime > 0 ? `<div class="suggestion-meta"><i class="fa-solid fa-clock"></i> ${runtime} دقیقه</div>` : '';
}

function setupAutocomplete() {
    const searchInput = $('searchInput');
    const blueBox = $('blueSuggestionsBox');
    if (!searchInput || !blueBox) return;

    searchInput.addEventListener('input', () => {
        clearTimeout(suggestTimer);
        const query = searchInput.value.trim();
        if (!query) {
            suggestSeq++;
            blueBox.classList.add('hidden');
            return;
        }
        suggestTimer = setTimeout(() => runSuggest(query), 300);
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            searchMovies();
        }
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-input-container')) blueBox.classList.add('hidden');
    });
}

async function runSuggest(query) {
    const blueBox = $('blueSuggestionsBox');
    const list = $('suggestionsList');
    const seq = ++suggestSeq;

    list.innerHTML = '<div class="suggest-msg"><i class="fa-solid fa-spinner fa-spin"></i> در حال جستجو...</div>';
    blueBox.classList.remove('hidden');

    try {
        const items = await fetchSearch(query);
        if (seq !== suggestSeq) return;

        list.innerHTML = '';
        if (!items.length) {
            list.innerHTML = '<div class="suggest-msg">موردی پیدا نشد.</div>';
            return;
        }

        const frag = document.createDocumentFragment();
        items.forEach((item) => {
            const title = item.title || 'بدون عنوان';
            const year = item.year || '—';
            const card = document.createElement('div');
            card.className = 'suggestion-card';
            card.innerHTML = `
                ${posterImgHTML(item.poster, title, 'thumb', { width: 45, height: 65, eager: true })}
                <div class="suggestion-text">
                    <div class="title">${esc(title)} <span class="year">(${esc(year)})</span></div>
                    <div class="suggestion-line">
                        <span class="type-pill ${item.type === 'series' ? 'is-series' : ''}">${typeLabel(item)}</span>
                        ${item.genre ? `<span class="suggestion-genre">${esc(item.genre)}</span>` : ''}
                    </div>
                    ${metaHtmlFor(item)}
                </div>
            `;
            card.onclick = () => {
                blueBox.classList.add('hidden');
                openPurplePanel({ ...item, title });
            };
            frag.appendChild(card);
        });
        list.appendChild(frag);
    } catch (e) {
        if (seq !== suggestSeq) return;
        list.innerHTML = '<div class="suggest-msg error">ارتباط با سرور برقرار نشد.</div>';
    }
}

function emptyState(icon, text) {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.innerHTML = `<i class="fa-solid ${icon}"></i><p>${esc(text)}</p>`;
    return div;
}

function buildSearchCard(item, index) {
    const title = item.title || 'بدون عنوان';
    const card = document.createElement('div');
    card.className = 'card search-card';
    card.tabIndex = 0;
    card.innerHTML = `
        ${posterImgHTML(item.poster, title, 'medium', { eager: index < 24 })}
        <span class="type-chip ${item.type === 'series' ? 'is-series' : ''}">${typeLabel(item)}</span>
        <div class="card-info">
            <div class="card-title" title="${esc(title)}">${esc(title)}</div>
            <div class="card-subtext">${esc(item.year || '')}</div>
            ${item.genre ? `<span class="genre-tag">${esc(item.genre)}</span>` : ''}
        </div>
    `;
    card.onclick = () => openPurplePanel({ ...item, title });
    card.onkeydown = (e) => { if (e.key === 'Enter') openPurplePanel({ ...item, title }); };
    return card;
}

async function searchMovies() {
    const input = $('searchInput');
    const query = (input ? input.value : '').trim();
    if (!query) {
        showToast('نام فیلم یا سریال را وارد کنید.', 'info');
        if (input) input.focus();
        return;
    }

    clearTimeout(suggestTimer);
    suggestSeq++;
    $('blueSuggestionsBox').classList.add('hidden');

    const section = $('searchResultsSection');
    const grid = $('searchResults');
    section.classList.remove('hidden');
    grid.innerHTML = Array.from({ length: 8 }).map(() =>
        '<div class="card skeleton-card"><div class="poster-img"></div><div class="card-info"><div class="sk-line"></div><div class="sk-line short"></div></div></div>'
    ).join('');

    const seq = ++gridSeq;
    try {
        const items = await fetchSearch(query);
        if (seq !== gridSeq) return;
        grid.innerHTML = '';
        if (!items.length) {
            grid.appendChild(emptyState('fa-face-frown', 'نتیجه‌ای پیدا نشد. اسم را انگلیسی هم امتحان کنید.'));
            return;
        }
        const frag = document.createDocumentFragment();
        items.forEach((item, i) => frag.appendChild(buildSearchCard(item, i)));
        grid.appendChild(frag);
    } catch (e) {
        if (seq !== gridSeq) return;
        grid.innerHTML = '';
        grid.appendChild(emptyState('fa-triangle-exclamation', 'ارتباط با سرور برقرار نشد.'));
    }
}

/* ========================================================
   پنل ثبت / ویرایش جزئیات
======================================================== */
function renderPanelInfo() {
    const m = currentSelectedMovie;
    if (!m) return;

    const genre = m.genre || (Array.isArray(m.genres) ? m.genres.join('، ') : '');
    const genreEl = $('panelGenreText');
    if (genreEl) genreEl.innerText = genre;

    const extra = $('panelExtraInfo');
    if (!extra) return;

    if (isSeriesMovie(m)) {
        const s = Number(m.total_seasons) || 0;
        const e = Number(m.total_episodes) || 0;
        const parts = [s > 0 ? `${s} فصل` : '', e > 0 ? `${e} قسمت` : ''].filter(Boolean).join(' | ');
        extra.innerText = `📺 سریال${parts ? ` (${parts})` : ''}`;
    } else {
        const runtime = Number(m.runtime || m.duration) || 0;
        extra.innerText = runtime > 0 ? `🎬 فیلم سینمایی (${runtime} دقیقه)` : '🎬 فیلم سینمایی';
    }
}

function openPurplePanel(movie) {
    currentSelectedMovie = { ...movie };
    const m = currentSelectedMovie;

    const title = m.title || m.name || 'بدون نام';
    setPoster($('panelPoster'), m.poster || m.image, title, 'large');
    $('panelTitle').innerText = title;
    renderPanelInfo();

    $('inputStatus').value = m.status || 'watching';
    $('inputRating').value = m.rating || m.vote_average || '';
    $('inputNote').value = m.note || '';
    const privateBox = $('inputPrivate');
    if (privateBox) privateBox.checked = !!(m.is_private && Number(m.is_private) === 1);

    toggleStatusFields();

    $('purpleFloatingPanel').classList.remove('hidden');
    $('panelBackdrop').classList.remove('hidden');
    document.body.classList.add('no-scroll');
    closeMobileSidebar();

    loadDetailsForPanel();
}

// جزئیات کامل (مدت زمان، فصل/قسمت، ژانر) را در پس‌زمینه می‌گیرد تا پنل فوری باز شود
async function loadDetailsForPanel() {
    const m = currentSelectedMovie;
    if (!m) return;

    const id = String(m.id || m.movie_id || '');
    if (!id) return;

    const series = isSeriesMovie(m);
    const missing = series ? !(Number(m.total_episodes) > 0) : !(Number(m.runtime) > 0);
    if (!missing && m.genre && isRemoteUrl(m.poster)) return;

    try {
        const res = await fetch(`/api/details?id=${encodeURIComponent(id)}`);
        if (!res.ok) return;
        const d = await res.json();

        const cur = currentSelectedMovie;
        if (!cur || String(cur.id || cur.movie_id || '') !== id) return;

        if (d.runtime && !cur.runtime) cur.runtime = d.runtime;
        if (d.total_seasons && !cur.total_seasons) cur.total_seasons = d.total_seasons;
        if (d.total_episodes && !cur.total_episodes) cur.total_episodes = d.total_episodes;
        if (d.genre && !cur.genre) cur.genre = d.genre;
        if (d.poster && !isRemoteUrl(cur.poster)) {
            cur.poster = d.poster;
            setPoster($('panelPoster'), cur.poster, cur.title, 'large');
        }

        renderPanelInfo();
        const rt = $('inputRuntime');
        if (rt && !rt.value && cur.runtime) rt.value = cur.runtime;
    } catch (e) {}
}

function toggleStatusFields() {
    if (!currentSelectedMovie) return;

    const movie = currentSelectedMovie;
    const dynamicInputs = $('dynamicInputs');

    if (isSeriesMovie(movie)) {
        const currentSeason = movie.season || 1;
        const currentEpisode = movie.episode || 1;
        dynamicInputs.innerHTML = `
            <div class="form-group">
                <label>فصل فعلی:</label>
                <input type="number" id="inputSeason" value="${esc(currentSeason)}" min="1" inputmode="numeric" placeholder="فصل">
            </div>
            <div class="form-group">
                <label>قسمت فعلی:</label>
                <input type="number" id="inputEpisode" value="${esc(currentEpisode)}" min="1" inputmode="numeric" placeholder="قسمت">
            </div>
        `;
    } else {
        const runtime = movie.runtime || movie.duration || movie.total_minutes || '';
        dynamicInputs.innerHTML = `
            <div class="form-group" style="grid-column: 1 / -1;">
                <label>تا دقیقه چند دیده‌اید؟</label>
                <input type="number" id="inputMinute" value="${esc(movie.minute || '')}" min="0" inputmode="numeric" placeholder="مثلاً: 45">
            </div>
            <div class="form-group" style="grid-column: 1 / -1;">
                <label>مدت زمان کل فیلم (دقیقه):</label>
                <input type="number" id="inputRuntime" value="${esc(runtime)}" min="0" inputmode="numeric" placeholder="مثلاً: 120">
            </div>
        `;
    }
}

function closePurplePanel() {
    const panel = $('purpleFloatingPanel');
    if (panel) panel.classList.add('hidden');
    const backdrop = $('panelBackdrop');
    if (backdrop) backdrop.classList.add('hidden');
    document.body.classList.remove('no-scroll');
}

async function savePanelData() {
    if (!currentSelectedMovie) return;
    const cur = currentSelectedMovie;

    const readInt = (id) => {
        const el = $(id);
        return el ? (parseInt(el.value, 10) || 0) : 0;
    };

    const status = $('inputStatus').value;
    const genre = cur.genre || (Array.isArray(cur.genres) ? cur.genres.join('، ') : '');
    const season = readInt('inputSeason');
    const episode = readInt('inputEpisode');
    const minute = readInt('inputMinute');
    const runtimeInput = readInt('inputRuntime');
    const rating = Math.min(10, Math.max(0, parseFloat($('inputRating').value) || 0));
    const note = $('inputNote').value || '';
    const isPrivate = $('inputPrivate') ? $('inputPrivate').checked : false;

    const movieId = String(cur.id || cur.movie_id || Date.now());
    const title = cur.title || 'بدون عنوان';
    const poster = cur.poster || '';
    const type = isSeriesMovie(cur) ? 'series' : 'movie';

    const totalSeasons = cur.total_seasons || 0;
    const totalEpisodes = cur.total_episodes || 0;
    const runtime = runtimeInput || cur.runtime || 0;

    closePurplePanel();
    await saveMovie(movieId, title, poster, type, status, season, episode, totalSeasons, totalEpisodes, minute, rating, note, genre, runtime, isPrivate);
    showToast('اطلاعات با موفقیت ذخیره شد.', 'success');
}

async function saveMovie(movie_id, title, poster, type, status, season = 0, episode = 0, total_seasons = 0, total_episodes = 0, minute = 0, rating = 0, note = '', genre = '', runtime = 0, is_private = false) {
    const movieData = {
        movie_id: String(movie_id),
        title, poster, type, status,
        season: Number(season), episode: Number(episode),
        total_seasons: Number(total_seasons), total_episodes: Number(total_episodes),
        minute: Number(minute), rating: Number(rating), note: String(note), genre: String(genre),
        runtime: Number(runtime), is_private: !!is_private
    };

    allUserMovies = allUserMovies.filter((m) => String(m.movie_id || m.id) !== String(movie_id));
    allUserMovies.unshift(movieData);
    persistLocal();
    refreshUI();

    try {
        const res = await fetch('/api/movies', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(movieData)
        });
        if (res.status === 401) {
            showToast('برای ذخیره‌ی دائمی لیست، وارد حساب کاربری شوید.', 'error');
        } else if (!res.ok) {
            showToast('ذخیره روی سرور انجام نشد.', 'error');
        }
    } catch (e) {
        showToast('ارتباط با سرور برقرار نشد؛ فقط روی این دستگاه ذخیره شد.', 'error');
    }
}

async function loadMyMovies() {
    try {
        const res = await fetch('/api/movies');
        if (res.ok) {
            const data = await res.json();
            allUserMovies = Array.isArray(data) ? data : [];
            persistLocal();
            refreshUI();
            return;
        }
    } catch (e) {}
    loadFromLocalStorage();
}

function loadFromLocalStorage() {
    try {
        const localData = localStorage.getItem('my_cinema_movies');
        if (localData) allUserMovies = JSON.parse(localData) || [];
    } catch (e) { allUserMovies = []; }
    refreshUI();
}

/* ========================================================
   آمار
======================================================== */
function updateStatistics() {
    const total = allUserMovies.length;
    const watchlistCount = allUserMovies.filter((m) => m.status === 'watchlist').length;
    const watchingCount = allUserMovies.filter((m) => m.status === 'watching').length;

    const rated = allUserMovies.filter((m) => m.rating > 0);
    const avg = rated.length > 0
        ? (rated.reduce((acc, cur) => acc + cur.rating, 0) / rated.length).toFixed(1)
        : '0';

    $('statTotalMovies').innerText = total;
    $('statAvgRating').innerText = avg;
    $('statWatchlistCount').innerText = watchlistCount;
    $('statWatchingCount').innerText = watchingCount;
}

/* ========================================================
   فیلتر + مرتب‌سازی (هر دو با هم اعمال می‌شوند)
======================================================== */
function getVisibleMovies() {
    const q = (($('filterInput') || {}).value || '').trim().toLowerCase();
    const sort = ($('sortSelect') || {}).value || 'newest';

    const list = allUserMovies.filter((m) => !q || (m.title || '').toLowerCase().includes(q));
    if (sort === 'rating') list.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    else if (sort === 'title') list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    return list;
}

function refreshUI() {
    renderMovies(getVisibleMovies());
}

function filterMovies() { refreshUI(); }
function sortMovies() { refreshUI(); }

/* ========================================================
   رندر کارت‌ها
======================================================== */
function buildContext(m) {
    const status = (m.status || 'watched').toLowerCase();
    const type = (m.type || 'movie').toLowerCase();
    const title = m.title || 'بدون عنوان';
    const id = String(m.movie_id || m.id);
    const rating = Number(m.rating) || 0;

    let details = '';
    let progress = 0;

    if (type === 'series') {
        const s = m.season || 1;
        const e = m.episode || 1;
        details = `فصل ${s} / قسمت ${e}`;
        progress = m.total_episodes > 0
            ? Math.min(100, Math.round((e / m.total_episodes) * 100))
            : Math.min(100, e * 10);
    } else {
        const min = m.minute || 0;
        const total = m.runtime || 120;
        details = min > 0 ? `تا دقیقه ${min}` : 'فیلم سینمایی';
        if (min > 0) progress = Math.min(100, Math.round((min / (total > 0 ? total : 120)) * 100));
    }

    return {
        status, type, title, id, rating, details, progress,
        genreHtml: m.genre ? `<span class="genre-tag">${esc(m.genre)}</span>` : '',
        starsHtml: getStarRatingHTML(rating),
        progressBar: `
            <div class="progress-bar-container" title="پیشرفت: ${progress}%">
                <div class="progress-bar-fill" style="width: ${progress}%;"></div>
            </div>`
    };
}

function buildSidebarCard(m, c, index) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
        ${posterImgHTML(m.poster, c.title, 'thumb', { width: 55, height: 80, eager: index < 20 })}
        <div class="card-info">
            <div class="card-title" title="${esc(c.title)}">${esc(c.title)}</div>
            <div class="card-subtext">${esc(c.details)}</div>
            ${m.note ? `<div class="card-note">${esc(m.note)}</div>` : ''}
            ${c.progressBar}
        </div>
        <button type="button" class="btn-delete" title="حذف" aria-label="حذف"><i class="fa-solid fa-trash-can"></i></button>
    `;
    card.onclick = (e) => { if (!e.target.closest('.btn-delete')) openPurplePanel(m); };
    card.querySelector('.btn-delete').onclick = (e) => {
        e.stopPropagation();
        openConfirmModal(c.id);
    };
    return card;
}

function buildGridCard(m, c, kind, index) {
    const card = document.createElement('div');
    card.className = 'card';

    const badge = kind === 'watched' && c.rating ? `<div class="card-rating-badge">★ ${esc(c.rating)}</div>` : '';

    let infoExtra = '';
    if (kind === 'watching') infoExtra = `<div class="card-subtext">${esc(c.details)}</div>${c.progressBar}`;
    else infoExtra = c.genreHtml;

    const primaryBtn = kind === 'watchlist'
        ? '<button type="button" class="btn-primary-red btn-mark-watched" title="دیدم"><i class="fa-solid fa-check"></i><span class="btn-label">دیدم</span></button>'
        : '<button type="button" class="btn-primary-red btn-edit" title="ویرایش"><i class="fa-solid fa-pen-to-square"></i><span class="btn-label">ویرایش</span></button>';

    card.innerHTML = `
        ${posterImgHTML(m.poster, c.title, 'medium', { eager: index < 30 })}
        ${badge}
        <div class="card-info">
            <div class="card-title" title="${esc(c.title)}">${esc(c.title)}</div>
            ${infoExtra}
        </div>
        <div class="card-overlay">
            ${kind === 'watched' ? c.starsHtml : ''}
            ${primaryBtn}
            <button type="button" class="btn-outline-red btn-delete" title="حذف"><i class="fa-solid fa-trash"></i><span class="btn-label">حذف</span></button>
        </div>
    `;

    card.onclick = () => openPurplePanel(m);

    const editBtn = card.querySelector('.btn-edit');
    if (editBtn) editBtn.onclick = (e) => { e.stopPropagation(); openPurplePanel(m); };

    const watchedBtn = card.querySelector('.btn-mark-watched');
    if (watchedBtn) {
        watchedBtn.onclick = async (e) => {
            e.stopPropagation();
            await saveMovie(
                c.id, c.title, m.poster || '', c.type, 'watched',
                m.season || 0, m.episode || 0, m.total_seasons || 0, m.total_episodes || 0,
                m.minute || 0, m.rating || 0, m.note || '', m.genre || '', m.runtime || 0
            );
            showToast('به لیست دیده‌شده‌ها منتقل شد.', 'success');
        };
    }

    card.querySelector('.btn-delete').onclick = (e) => {
        e.stopPropagation();
        openConfirmModal(c.id);
    };
    return card;
}

function renderMovies(movies) {
    updateStatistics();

    const targets = {
        side: $('watchedList'),
        watching: $('watchingList'),
        watched: $('completedGrid'),
        watchlist: $('watchlist')
    };
    if (!targets.side || !targets.watching || !targets.watchlist) return;

    const frags = {};
    const counts = { side: 0, watching: 0, watched: 0, watchlist: 0 };
    Object.keys(targets).forEach((k) => { frags[k] = document.createDocumentFragment(); });

    movies.forEach((m) => {
        const c = buildContext(m);

        if (c.status === 'watching') {
            frags.side.appendChild(buildSidebarCard(m, c, counts.side++));
            frags.watching.appendChild(buildGridCard(m, c, 'watching', counts.watching++));
        } else if (c.status === 'watched') {
            frags.watched.appendChild(buildGridCard(m, c, 'watched', counts.watched++));
        } else if (c.status === 'watchlist') {
            frags.watchlist.appendChild(buildGridCard(m, c, 'watchlist', counts.watchlist++));
        }
    });

    const emptyTexts = {
        side: ['fa-film', 'فعلاً چیزی در حال تماشا نیست.'],
        watching: ['fa-play', 'هیچ فیلم یا سریالی در حال تماشا نیست. از تب «جستجو» یکی اضافه کنید.'],
        watched: ['fa-check-double', 'هنوز چیزی به «دیده‌شده‌ها» اضافه نشده است.'],
        watchlist: ['fa-bookmark', 'واچ‌لیست شما خالی است.']
    };

    Object.keys(targets).forEach((k) => {
        const el = targets[k];
        if (!el) return;
        el.innerHTML = '';
        if (counts[k] === 0) el.appendChild(emptyState(emptyTexts[k][0], emptyTexts[k][1]));
        else el.appendChild(frags[k]);
    });
}

/* ========================================================
   «امشب چی ببینم؟»
======================================================== */
function pickRandomMovie() {
    const mine = allUserMovies.filter((m) => ['watchlist', 'watching'].includes((m.status || '').toLowerCase()));
    const myTitles = new Set(allUserMovies.map((m) => (m.title || '').toLowerCase()));
    const extra = featuredList.filter((f) => !myTitles.has((f.title || '').toLowerCase()));

    let pool = [...mine, ...extra];
    if (!pool.length) pool = [...featuredList];

    const keyOf = (x) => String(x.movie_id || x.id || x.title);
    if (pool.length > 1) pool = pool.filter((x) => keyOf(x) !== lastRandomKey);

    const selected = pool[Math.floor(Math.random() * pool.length)];
    lastRandomKey = keyOf(selected);

    const title = selected.title || selected.name || 'بدون عنوان';
    const isSeries = isSeriesMovie(selected);
    const genreText = selected.genre || (isSeries ? '📺 سریال' : '🎬 فیلم سینمایی');

    let extraText = '';
    if (isSeries) {
        const s = selected.total_seasons || selected.season || 0;
        const e = selected.total_episodes || 0;
        const parts = [s > 0 ? `${s} فصل` : '', e > 0 ? `${e} قسمت` : ''].filter(Boolean).join(' | ');
        extraText = `📺 سریال${parts ? ` | ${parts}` : ''}`;
    } else {
        const runtime = selected.runtime || selected.duration || 0;
        extraText = runtime > 0 ? `⏱️ زمان: ${runtime} دقیقه` : '🎬 فیلم سینمایی';
    }

    setPoster($('randomPoster'), selected.poster || selected.image, title, 'large');
    $('randomTitle').innerText = title;
    $('randomGenre').innerText = genreText;
    $('randomDetailsInfo').innerText = extraText;

    openRandomModal();
}

function openRandomModal() { const m = $('randomModal'); if (m) m.classList.remove('hidden'); }
function closeRandomModal() { const m = $('randomModal'); if (m) m.classList.add('hidden'); }

/* ========================================================
   حذف
======================================================== */
function openConfirmModal(id) {
    movieToDeleteId = id;
    $('confirmModal').classList.remove('hidden');
    $('confirmDeleteBtn').onclick = () => executeDelete();
}

function closeConfirmModal() {
    $('confirmModal').classList.add('hidden');
    movieToDeleteId = null;
}

async function executeDelete() {
    if (!movieToDeleteId) return;
    const id = movieToDeleteId;

    allUserMovies = allUserMovies.filter((m) => String(m.movie_id || m.id) !== String(id));
    persistLocal();
    refreshUI();
    closeConfirmModal();
    showToast('آیتم با موفقیت حذف شد.', 'info');

    try {
        await fetch(`/api/movies/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (e) {}
}

/* ========================================================
   کشوی موبایل
======================================================== */
function setDrawer(open) {
    const sidebar = document.querySelector('.sidebar-watched');
    const overlay = $('drawerOverlay');
    if (sidebar) sidebar.classList.toggle('drawer-open', open);
    if (overlay) overlay.classList.toggle('active', open);
    document.body.classList.toggle('drawer-active', open);
}

function toggleMobileSidebar() {
    const sidebar = document.querySelector('.sidebar-watched');
    setDrawer(!(sidebar && sidebar.classList.contains('drawer-open')));
}

function closeMobileSidebar() { setDrawer(false); }

/* ========================================================
   پروفایل، دوستان و چت داخل برنامه
======================================================== */
const DEFAULT_AVATAR = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#262638"/><circle cx="50" cy="38" r="18" fill="#55556a"/><path d="M18 90c4-24 26-34 32-34s28 10 32 34" fill="#55556a"/></svg>`
);

function avatarSrc(path) {
    return path ? path : DEFAULT_AVATAR;
}

function userRowHTML(user, actionsHtml) {
    return `
        <div class="user-row" data-user-id="${esc(user.id)}">
            <img class="user-row-avatar" src="${esc(avatarSrc(user.avatar))}" alt="${esc(user.username)}" loading="lazy">
            <span class="user-row-name">${esc(user.username)}</span>
            <div class="user-row-actions">${actionsHtml}</div>
        </div>
    `;
}

/* ---- بارگذاری تب دوستان ---- */
async function loadSocialData() {
    if (!currentUserId) {
        $('userSearchResults').innerHTML = '';
        $('friendsList').innerHTML = '<p class="empty-hint">برای استفاده از این بخش وارد حساب کاربری خود شوید.</p>';
        $('conversationsList').innerHTML = '';
        $('incomingRequestsSection').classList.add('hidden');
        return;
    }
    try {
        const res = await fetch('/api/friends');
        if (res.ok) {
            const data = await res.json();
            renderFriendsList(data.friends || []);
            renderIncomingRequests(data.incomingRequests || []);
        }
    } catch (e) {}
    loadConversations();
}

function renderFriendsList(friends) {
    const box = $('friendsList');
    if (!friends.length) { box.innerHTML = '<p class="empty-hint">هنوز دوستی اضافه نکرده‌اید.</p>'; return; }
    box.innerHTML = friends.map((u) => userRowHTML(u, `
        <button type="button" class="btn-outline-red btn-sm" onclick="openPublicProfile(${u.id})" title="پروفایل"><i class="fa-solid fa-id-card"></i></button>
        <button type="button" class="btn-primary-red btn-sm" onclick="openChatWindow(${u.id}, '${esc(u.username).replace(/'/g, "\\'")}', '${esc(u.avatar || '')}')" title="گفتگو"><i class="fa-solid fa-comment"></i></button>
    `)).join('');
}

function renderIncomingRequests(list) {
    const section = $('incomingRequestsSection');
    const box = $('incomingRequestsList');
    if (!list.length) { section.classList.add('hidden'); box.innerHTML = ''; refreshSocialBadge(list.length); return; }
    section.classList.remove('hidden');
    box.innerHTML = list.map((u) => userRowHTML(u, `
        <button type="button" class="btn-primary-red btn-sm" onclick="respondFriendRequest(${u.id}, true)" title="قبول"><i class="fa-solid fa-check"></i></button>
        <button type="button" class="btn-outline-red btn-sm" onclick="respondFriendRequest(${u.id}, false)" title="رد"><i class="fa-solid fa-xmark"></i></button>
    `)).join('');
    refreshSocialBadge(list.length);
}

function refreshSocialBadge(pendingCount) {
    const badge = $('socialBadge');
    if (!badge) return;
    if (typeof pendingCount === 'number') {
        if (pendingCount > 0) { badge.textContent = pendingCount; badge.classList.remove('hidden'); }
        else badge.classList.add('hidden');
        return;
    }
    if (!currentUserId) { badge.classList.add('hidden'); return; }
    fetch('/api/friends').then(r => r.ok ? r.json() : null).then(data => {
        if (data) refreshSocialBadge((data.incomingRequests || []).length);
    }).catch(() => {});
}

/* ---- جستجوی کاربران ---- */
function handleUserSearch() {
    clearTimeout(userSearchTimer);
    const q = $('userSearchInput').value.trim();
    const box = $('userSearchResults');
    if (!q) { box.innerHTML = ''; return; }
    userSearchTimer = setTimeout(async () => {
        try {
            const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
            if (!res.ok) return;
            const users = await res.json();
            if (!users.length) { box.innerHTML = '<p class="empty-hint">کاربری پیدا نشد.</p>'; return; }
            box.innerHTML = users.map((u) => userRowHTML(u, `
                <button type="button" class="btn-outline-red btn-sm" onclick="openPublicProfile(${u.id})" title="مشاهده پروفایل"><i class="fa-solid fa-id-card"></i></button>
            `)).join('');
        } catch (e) {}
    }, 350);
}

/* ---- درخواست دوستی ---- */
async function sendFriendRequest(userId) {
    try {
        const res = await fetch(`/api/friends/${userId}/request`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            showToast(data.state === 'friends' ? 'حالا با هم دوست هستید!' : 'درخواست دوستی ارسال شد.', 'success');
            loadSocialData();
            if ($('publicProfileModal') && !$('publicProfileModal').classList.contains('hidden')) openPublicProfile(userId);
        } else {
            showToast(data.error || 'ارسال درخواست ناموفق بود.', 'error');
        }
    } catch (e) { showToast('ارتباط با سرور برقرار نشد.', 'error'); }
}

async function respondFriendRequest(userId, accept) {
    try {
        await fetch(`/api/friends/${userId}/${accept ? 'accept' : 'reject'}`, { method: 'POST' });
        showToast(accept ? 'درخواست دوستی قبول شد.' : 'درخواست رد شد.', 'info');
        loadSocialData();
    } catch (e) {}
}

async function removeFriend(userId) {
    try {
        await fetch(`/api/friends/${userId}`, { method: 'DELETE' });
        showToast('از لیست دوستان حذف شد.', 'info');
        loadSocialData();
        closePublicProfileModal();
    } catch (e) {}
}

/* ---- پروفایل عمومی کاربر دیگر ---- */
async function openPublicProfile(userId) {
    try {
        const res = await fetch(`/api/users/${userId}`);
        if (!res.ok) { showToast('پروفایل پیدا نشد.', 'error'); return; }
        const p = await res.json();

        setPoster($('ppAvatar'), p.avatar, p.username, 'medium');
        $('ppUsername').innerText = p.username;
        $('ppBio').innerText = p.bio || '';
        $('ppBio').classList.toggle('hidden', !p.bio);

        const actions = $('ppFriendActions');
        if (p.friendStatus === 'self') {
            actions.innerHTML = '';
        } else if (p.friendStatus === 'friends') {
            actions.innerHTML = `
                <button type="button" class="btn-primary-red" onclick="openChatWindow(${p.id}, '${esc(p.username).replace(/'/g, "\\'")}', '${esc(p.avatar || '')}')"><i class="fa-solid fa-comment"></i> ارسال پیام</button>
                <button type="button" class="btn-outline-red" onclick="removeFriend(${p.id})"><i class="fa-solid fa-user-minus"></i> حذف دوستی</button>
            `;
        } else if (p.friendStatus === 'pending_sent') {
            actions.innerHTML = `<button type="button" class="btn-outline-red" disabled><i class="fa-solid fa-clock"></i> درخواست ارسال شده</button>`;
        } else if (p.friendStatus === 'pending_received') {
            actions.innerHTML = `
                <button type="button" class="btn-primary-red" onclick="respondFriendRequest(${p.id}, true)"><i class="fa-solid fa-check"></i> قبول درخواست</button>
                <button type="button" class="btn-outline-red" onclick="respondFriendRequest(${p.id}, false)"><i class="fa-solid fa-xmark"></i> رد</button>
            `;
        } else {
            actions.innerHTML = `<button type="button" class="btn-primary-red" onclick="sendFriendRequest(${p.id})"><i class="fa-solid fa-user-plus"></i> ارسال درخواست دوستی</button>`;
        }

        const grid = $('ppMovies');
        if (!p.movies.length) {
            grid.innerHTML = '';
            grid.appendChild(emptyState('fa-film', 'فیلمی برای نمایش وجود ندارد.'));
        } else {
            grid.innerHTML = '';
            p.movies.forEach((m, i) => {
                const card = document.createElement('div');
                card.className = 'card card-readonly';
                card.innerHTML = `
                    ${posterImgHTML(m.poster, m.title, 'medium', { eager: i < 12 })}
                    ${m.rating ? `<div class="card-rating-badge">★ ${esc(m.rating)}</div>` : ''}
                    <div class="card-info">
                        <div class="card-title" title="${esc(m.title)}">${esc(m.title)}</div>
                        <div class="card-subtext">${esc(m.genre || (m.type === 'series' ? 'سریال' : 'فیلم'))}</div>
                    </div>
                `;
                grid.appendChild(card);
            });
        }

        $('publicProfileModal').classList.remove('hidden');
    } catch (e) { showToast('خطا در دریافت پروفایل.', 'error'); }
}

function closePublicProfileModal() { $('publicProfileModal').classList.add('hidden'); }

/* ---- تنظیمات پروفایل من (عکس + بیوگرافی) ---- */
function openProfileSettingsModal() {
    setPoster($('settingsAvatarPreview'), currentUserAvatar, 'من', 'medium');
    $('bioInput').value = currentUserBio || '';
    $('profileSettingsModal').classList.remove('hidden');
}

function closeProfileSettingsModal() { $('profileSettingsModal').classList.add('hidden'); }

async function handleAvatarUpload(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) { showToast('حجم عکس نباید بیشتر از ۳ مگابایت باشد.', 'error'); return; }

    const fd = new FormData();
    fd.append('avatar', file);
    try {
        const res = await fetch('/api/profile/avatar', { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.avatar) {
            currentUserAvatar = data.avatar;
            setPoster($('settingsAvatarPreview'), currentUserAvatar, 'من', 'medium');
            setPoster($('myAvatarImg'), currentUserAvatar, 'من', 'thumb');
            showToast('عکس پروفایل به‌روزرسانی شد.', 'success');
        } else {
            showToast(data.error || 'آپلود عکس ناموفق بود.', 'error');
        }
    } catch (err) { showToast('ارتباط با سرور برقرار نشد.', 'error'); }
    e.target.value = '';
}

async function saveBio() {
    const bio = $('bioInput').value;
    try {
        const res = await fetch('/api/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bio })
        });
        if (res.ok) {
            currentUserBio = bio;
            showToast('بیوگرافی ذخیره شد.', 'success');
            closeProfileSettingsModal();
        } else {
            showToast('ذخیره‌سازی ناموفق بود.', 'error');
        }
    } catch (e) { showToast('ارتباط با سرور برقرار نشد.', 'error'); }
}

/* ---- چت زنده (Socket.IO) ---- */
function initChatSocket() {
    if (chatSocket || typeof io === 'undefined') return;
    chatSocket = io({ autoConnect: true });

    chatSocket.on('chat:message', (msg) => {
        if (activeChatPartnerId && (msg.sender_id === activeChatPartnerId || msg.receiver_id === activeChatPartnerId)) {
            appendChatMessage(msg);
        } else if (msg.sender_id !== currentUserId) {
            showToast('پیام جدید دریافت شد.', 'info');
        }
        loadConversations();
    });

    chatSocket.on('friend:request', () => { refreshSocialBadge(); if (isSocialTabActive()) loadSocialData(); });
    chatSocket.on('friend:accepted', () => { showToast('یک درخواست دوستی قبول شد!', 'success'); if (isSocialTabActive()) loadSocialData(); });
}

function disconnectChatSocket() {
    if (chatSocket) { chatSocket.disconnect(); chatSocket = null; }
}

function isSocialTabActive() {
    const tab = $('socialTab');
    return tab && !tab.classList.contains('hidden');
}

async function loadConversations() {
    if (!currentUserId) return;
    try {
        const res = await fetch('/api/conversations');
        if (!res.ok) return;
        const list = await res.json();
        const box = $('conversationsList');
        if (!box) return;
        if (!list.length) { box.innerHTML = '<p class="empty-hint">برای شروع گفتگو، اول با کسی دوست شوید.</p>'; return; }
        box.innerHTML = list.map((u) => userRowHTML(u, `
            ${u.unread ? `<span class="unread-dot">${esc(u.unread)}</span>` : ''}
            <button type="button" class="btn-primary-red btn-sm" onclick="openChatWindow(${u.id}, '${esc(u.username).replace(/'/g, "\\'")}', '${esc(u.avatar || '')}')"><i class="fa-solid fa-comment"></i></button>
        `)).join('');
    } catch (e) {}
}

async function openChatWindow(userId, username, avatar) {
    activeChatPartnerId = userId;
    activeChatPartnerName = username;
    setPoster($('chatPartnerAvatar'), avatar, username, 'thumb');
    $('chatPartnerName').innerText = username;
    $('chatWindow').classList.remove('hidden');
    $('chatMessages').innerHTML = '<p class="empty-hint">در حال بارگذاری...</p>';

    try {
        const res = await fetch(`/api/messages/${userId}`);
        if (!res.ok) { $('chatMessages').innerHTML = '<p class="empty-hint">فقط با دوستان می‌توانید گفتگو کنید.</p>'; return; }
        const msgs = await res.json();
        $('chatMessages').innerHTML = '';
        msgs.forEach(appendChatMessage);
        scrollChatToBottom();
    } catch (e) {}
}

function closeChatWindow() {
    $('chatWindow').classList.add('hidden');
    activeChatPartnerId = null;
}

function appendChatMessage(msg) {
    const box = $('chatMessages');
    if (!box) return;
    const mine = msg.sender_id === currentUserId;
    const div = document.createElement('div');
    div.className = 'chat-bubble ' + (mine ? 'mine' : 'theirs');
    div.innerText = msg.body;
    box.appendChild(div);
    scrollChatToBottom();
}

function scrollChatToBottom() {
    const box = $('chatMessages');
    if (box) box.scrollTop = box.scrollHeight;
}

function sendChatMessage() {
    const input = $('chatInput');
    const body = input.value.trim();
    if (!body || !activeChatPartnerId || !chatSocket) return;
    input.value = '';
    chatSocket.emit('chat:send', { receiverId: activeChatPartnerId, body }, (ack) => {
        if (ack && ack.error) showToast(ack.error, 'error');
    });
}
