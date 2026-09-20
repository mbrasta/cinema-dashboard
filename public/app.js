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

// وضعیت داشبورد و اجتماع
let activeTabName = 'search';
let dashFilter = 'all'; // all | watching | watched | watchlist
let communityOldestId = null;
let communityBusy = false;
let postMediaFile = null;
let postMediaPreviewUrl = '';

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

    const dashSearch = $('dashSearchInput');
    if (dashSearch) dashSearch.addEventListener('input', refreshUI);
    const recentSearch = $('recentSearchInput');
    if (recentSearch) recentSearch.addEventListener('input', renderRecentList);
    const recentSort = $('recentSortSelect');
    if (recentSort) recentSort.addEventListener('change', renderRecentList);
    const dashSort = $('dashSortSelect');
    if (dashSort) dashSort.addEventListener('change', refreshUI);
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
const TAB_MAP = {
    search: 'searchTab',
    dashboard: 'dashboardTab',
    community: 'communityTab',
    friends: 'friendsTab'
};

function switchTab(tabName) {
    if (!TAB_MAP[tabName]) tabName = 'search';
    activeTabName = tabName;

    document.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((tab) => tab.classList.add('hidden'));

    try { localStorage.setItem('activeTab', tabName); } catch (e) {}

    const activeBtn = $(`tabNav-${tabName}`);
    if (activeBtn) activeBtn.classList.add('active');

    const target = $(TAB_MAP[tabName]);
    if (target) target.classList.remove('hidden');

    refreshActiveTab();

    const content = document.querySelector('.content-blue');
    if (content) content.scrollTop = 0;
    window.scrollTo({ top: 0 });
}

// محتوای تبِ فعال را (دوباره) بارگذاری می‌کند
function refreshActiveTab() {
    if (activeTabName === 'dashboard') { refreshUI(); loadActivity(); }
    else if (activeTabName === 'community') loadCommunity(true);
    else if (activeTabName === 'friends') loadSocialData();
}

function restoreLastTab() {
    let last = 'search';
    let filter = 'all';
    try {
        last = localStorage.getItem('activeTab') || 'search';
        filter = localStorage.getItem('dashFilter') || 'all';
    } catch (e) {}

    // مقدارهای قدیمی که قبل از ساخت داشبورد ذخیره شده بودند
    if (['watching', 'watched', 'watchlist'].includes(last)) { filter = last; last = 'dashboard'; }
    else if (last === 'social') last = 'friends';

    dashFilter = ['watching', 'watched', 'watchlist'].includes(filter) ? filter : 'all';
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
                refreshActiveTab();
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
    deselectChat();
    const badge = $('socialBadge');
    if (badge) badge.classList.add('hidden');
    resetCommunity();
    renderActivityChart(null);
    if (activeTabName === 'community') updateComposerState();
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
        } else {
            refreshActivityIfVisible();
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

    $('statTotalMovies').innerText = total;
    $('statWatchlistCount').innerText = watchlistCount;
    $('statWatchingCount').innerText = watchingCount;
}

/* ========================================================
   فیلتر + مرتب‌سازی (جستجو، مرتب‌سازی و دکمه‌های وضعیت با هم اعمال می‌شوند)
======================================================== */
function getVisibleMovies() {
    const q = (($('dashSearchInput') || {}).value || '').trim().toLowerCase();
    const sort = ($('dashSortSelect') || {}).value || 'newest';

    const list = allUserMovies.filter((m) => !q || (m.title || '').toLowerCase().includes(q));
    if (sort === 'rating') list.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    else if (sort === 'title') list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    return list;
}

function refreshUI() {
    renderMovies(getVisibleMovies());
}

// کلیک روی دکمه‌ی وضعیت: همان وضعیت را نشان می‌دهد؛ کلیک دوباره = نمایش همه
function setDashFilter(filter) {
    dashFilter = (filter && filter !== dashFilter && ['watching', 'watched', 'watchlist'].includes(filter)) ? filter : 'all';
    try { localStorage.setItem('dashFilter', dashFilter); } catch (e) {}
    refreshUI();
}

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

// پنل «آخرین فعالیت‌ها»: آیتم‌های در حال تماشا با میزان پیشرفت (در تب جستجو و داشبورد)
function renderRecentList() {
    const targets = document.querySelectorAll('.recent-list');
    if (!targets.length) return;
    const q = (($('recentSearchInput') || {}).value || '').trim().toLowerCase();
    const sort = ($('recentSortSelect') || {}).value || 'newest';
    const items = allUserMovies.filter((m) =>
        (m.status || '').toLowerCase() === 'watching' && (!q || (m.title || '').toLowerCase().includes(q))
    );
    if (sort === 'rating') items.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    else if (sort === 'title') items.sort((a, b) => (a.title || '').localeCompare(b.title || ''));

    targets.forEach((el) => {
        el.innerHTML = '';
        if (!items.length) {
            el.appendChild(emptyState('fa-film', 'فعلاً چیزی در حال تماشا نیست.'));
            return;
        }
        const frag = document.createDocumentFragment();
        items.forEach((m, i) => frag.appendChild(buildSidebarCard(m, buildContext(m), i)));
        el.appendChild(frag);
    });
}

const STATUS_LABELS = { watching: 'در حال تماشا', watched: 'دیده‌شده', watchlist: 'واچ‌لیست' };

function buildGridCard(m, c, kind, index, showStatus = false) {
    const card = document.createElement('div');
    card.className = 'card';

    const badge = kind === 'watched' && c.rating ? `<div class="card-rating-badge">★ ${esc(c.rating)}</div>` : '';

    let infoExtra = '';
    if (kind === 'watching') infoExtra = `<div class="card-subtext">${esc(c.details)}</div>${c.progressBar}`;
    else infoExtra = c.genreHtml;

    const primaryBtn = kind === 'watchlist'
        ? '<button type="button" class="btn-primary-red btn-mark-watched" title="دیدم"><i class="fa-solid fa-check"></i><span class="btn-label">دیدم</span></button>'
        : '<button type="button" class="btn-primary-red btn-edit" title="ویرایش"><i class="fa-solid fa-pen-to-square"></i><span class="btn-label">ویرایش</span></button>';

    const statusChip = showStatus
        ? `<span class="type-chip status-chip status-${kind}">${STATUS_LABELS[kind] || ''}</span>`
        : '';

    card.innerHTML = `
        ${posterImgHTML(m.poster, c.title, 'medium', { eager: index < 30 })}
        ${badge}
        ${statusChip}
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
                m.minute || 0, m.rating || 0, m.note || '', m.genre || '', m.runtime || 0,
                !!Number(m.is_private)
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

const DASH_HEADINGS = {
    all: 'همه‌ی ذخیره‌شده‌ها',
    watching: 'در حال تماشا',
    watched: 'فیلم و سریال‌های دیده‌شده',
    watchlist: 'واچ‌لیست (بعداً می‌بینم)'
};

const DASH_EMPTY = {
    all: ['fa-film', 'هنوز چیزی ذخیره نکرده‌اید. از تب «جستجو» یک فیلم یا سریال اضافه کنید.'],
    watching: ['fa-play', 'هیچ فیلم یا سریالی در حال تماشا نیست.'],
    watched: ['fa-check-double', 'هنوز چیزی به «دیده‌شده‌ها» اضافه نشده است.'],
    watchlist: ['fa-bookmark', 'واچ‌لیست شما خالی است.']
};

function renderMovies(movies) {
    updateStatistics();
    renderRecentList();

    document.querySelectorAll('.dash-filter-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.id === `dashFilter-${dashFilter}`);
    });

    const grid = $('dashGrid');
    if (!grid) return;

    const frag = document.createDocumentFragment();
    let count = 0;
    movies.forEach((m) => {
        const c = buildContext(m);
        if (!STATUS_LABELS[c.status]) return;
        if (dashFilter !== 'all' && c.status !== dashFilter) return;
        frag.appendChild(buildGridCard(m, c, c.status, count++, dashFilter === 'all'));
    });

    const heading = $('dashHeading');
    if (heading) heading.textContent = count > 0 ? `${DASH_HEADINGS[dashFilter]} (${count})` : DASH_HEADINGS[dashFilter];

    grid.innerHTML = '';
    if (count > 0) {
        grid.appendChild(frag);
        return;
    }

    const searching = (($('dashSearchInput') || {}).value || '').trim() !== '';
    if (searching) grid.appendChild(emptyState('fa-magnifying-glass', 'موردی با این نام در فهرست شما پیدا نشد.'));
    else if (!currentUserId) grid.appendChild(emptyState('fa-user-lock', 'برای ذخیره و دیدن فهرست خود، وارد حساب کاربری شوید.'));
    else grid.appendChild(emptyState(...DASH_EMPTY[dashFilter]));
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
        refreshActivityIfVisible();
    } catch (e) {}
}

/* ========================================================
   پروفایل، دوستان و چت داخل برنامه
======================================================== */
const DEFAULT_AVATAR = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#262638"/><circle cx="50" cy="38" r="18" fill="#55556a"/><path d="M18 90c4-24 26-34 32-34s28 10 32 34" fill="#55556a"/></svg>`
);

const EMOJI_SET = ['😀','😂','😍','😎','🥳','😉','🙂','😇','🤔','😴','😭','😡','👍','👎','🙏','👏','💪','🔥','❤️','💔','🎬','🍿','⭐','🎉','😢','😅','🤩','😱','🙄','😏'];

let contactsCache = [];
let requestsPanelOpen = false;

function avatarSrc(path) {
    return path ? path : DEFAULT_AVATAR;
}

function timeAgoShort(ts) {
    if (!ts) return '';
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60) return 'اکنون';
    if (diff < 3600) return `${Math.floor(diff / 60)} دقیقه`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} ساعت`;
    return `${Math.floor(diff / 86400)} روز`;
}

/* ---- بارگذاری تب دوستان ---- */
async function loadSocialData() {
    if (!currentUserId) {
        $('contactsList').innerHTML = '<p class="empty-hint">برای استفاده از این بخش وارد حساب کاربری خود شوید.</p>';
        $('userSearchResults').innerHTML = '';
        $('requestsToggleBtn').classList.add('hidden');
        $('incomingRequestsList').classList.add('hidden');
        return;
    }
    try {
        const res = await fetch('/api/friends');
        if (!res.ok) return;
        const data = await res.json();
        contactsCache = data.friends || [];
        renderContactsList(contactsCache);
        renderIncomingRequests(data.incomingRequests || []);
    } catch (e) {}
}

function renderContactsList(friends) {
    const box = $('contactsList');
    if (!friends.length) {
        box.innerHTML = '<p class="empty-hint">هنوز دوستی اضافه نکرده‌اید. از قسمت جستجو، دوستان خود را پیدا کنید.</p>';
        return;
    }
    box.innerHTML = friends.map((u) => {
        const preview = u.lastMessageType === 'image' ? '📷 عکس' : (u.lastMessage || 'شروع گفتگو کنید');
        const isActive = activeChatPartnerId === u.id;
        return `
        <div class="contact-row ${isActive ? 'active' : ''}" data-user-id="${esc(u.id)}" onclick="selectContact(${u.id}, '${esc(u.username).replace(/'/g, "\\'")}', '${esc(u.avatar || '')}')">
            <div class="contact-avatar-wrap">
                <img class="contact-avatar" src="${esc(avatarSrc(u.avatar))}" alt="${esc(u.username)}" loading="lazy">
                <span class="presence-dot ${u.online ? 'online' : 'offline'}"></span>
            </div>
            <div class="contact-meta">
                <span class="contact-name">${esc(u.username)}</span>
                <span class="contact-preview">${esc(preview)}</span>
            </div>
            <div class="contact-side">
                ${u.lastAt ? `<span class="contact-time">${timeAgoShort(u.lastAt)}</span>` : ''}
                ${u.unread ? `<span class="unread-dot" id="unread-${u.id}">${esc(u.unread)}</span>` : ''}
            </div>
        </div>`;
    }).join('');
}

function renderIncomingRequests(list) {
    const toggleBtn = $('requestsToggleBtn');
    const box = $('incomingRequestsList');
    if (!list.length) {
        toggleBtn.classList.add('hidden');
        box.classList.add('hidden');
        box.innerHTML = '';
        requestsPanelOpen = false;
        refreshSocialBadge(0);
        return;
    }
    toggleBtn.classList.remove('hidden');
    $('requestsCountBadge').textContent = list.length;
    box.innerHTML = list.map((u) => `
        <div class="user-row">
            <img class="user-row-avatar" src="${esc(avatarSrc(u.avatar))}" alt="${esc(u.username)}" loading="lazy">
            <span class="user-row-name">${esc(u.username)}</span>
            <div class="user-row-actions">
                <button type="button" class="btn-primary-red btn-sm" onclick="respondFriendRequest(${u.id}, true)" title="قبول"><i class="fa-solid fa-check"></i></button>
                <button type="button" class="btn-outline-red btn-sm" onclick="respondFriendRequest(${u.id}, false)" title="رد"><i class="fa-solid fa-xmark"></i></button>
            </div>
        </div>
    `).join('');
    box.classList.toggle('hidden', !requestsPanelOpen);
    refreshSocialBadge(list.length);
}

function toggleRequestsPanel() {
    requestsPanelOpen = !requestsPanelOpen;
    $('incomingRequestsList').classList.toggle('hidden', !requestsPanelOpen);
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
    if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    userSearchTimer = setTimeout(async () => {
        try {
            const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
            if (!res.ok) return;
            const users = await res.json();
            box.classList.remove('hidden');
            if (!users.length) { box.innerHTML = '<p class="empty-hint">کاربری پیدا نشد.</p>'; return; }
            box.innerHTML = users.map((u) => `
                <div class="user-row">
                    <img class="user-row-avatar" src="${esc(avatarSrc(u.avatar))}" alt="${esc(u.username)}" loading="lazy">
                    <span class="user-row-name">${esc(u.username)}</span>
                    <div class="user-row-actions">
                        <button type="button" class="btn-outline-red btn-sm" onclick="openPublicProfile(${u.id})" title="مشاهده پروفایل"><i class="fa-solid fa-id-card"></i></button>
                        <button type="button" class="btn-primary-red btn-sm" onclick="sendFriendRequest(${u.id})" title="افزودن دوست"><i class="fa-solid fa-user-plus"></i></button>
                    </div>
                </div>
            `).join('');
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
        if (activeChatPartnerId === userId) deselectChat();
        loadSocialData();
        closePublicProfileModal();
    } catch (e) {}
}

/* ---- پروفایل عمومی کاربر دیگر ---- */
async function openPublicProfile(userId) {
    if (!userId) return;
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
                <button type="button" class="btn-primary-red" onclick="selectContact(${p.id}, '${esc(p.username).replace(/'/g, "\\'")}', '${esc(p.avatar || '')}'); closePublicProfileModal();"><i class="fa-solid fa-comment"></i> ارسال پیام</button>
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
        if (isSocialTabActive()) loadSocialData();
    });

    chatSocket.on('presence:update', (data) => {
        const row = document.querySelector(`.contact-row[data-user-id="${data.userId}"] .presence-dot`);
        if (row) row.className = 'presence-dot ' + (data.online ? 'online' : 'offline');
        const c = contactsCache.find(u => u.id === data.userId);
        if (c) c.online = data.online;
    });

    chatSocket.on('friend:request', () => { refreshSocialBadge(); if (isSocialTabActive()) loadSocialData(); });
    chatSocket.on('friend:accepted', () => { showToast('یک درخواست دوستی قبول شد!', 'success'); if (isSocialTabActive()) loadSocialData(); });
}

function disconnectChatSocket() {
    if (chatSocket) { chatSocket.disconnect(); chatSocket = null; }
}

function isSocialTabActive() {
    const tab = $('friendsTab');
    return tab && !tab.classList.contains('hidden');
}

/* ---- گفتگوی فعال ---- */
async function selectContact(userId, username, avatar) {
    activeChatPartnerId = userId;
    activeChatPartnerName = username;

    $('chatPartnerName2').innerText = username;
    $('chatEmptyState').classList.add('hidden');
    $('chatActive').classList.remove('hidden');
    $('emojiPicker').classList.add('hidden');
    $('chatMessages2').innerHTML = '<p class="empty-hint">در حال بارگذاری...</p>';

    document.querySelectorAll('.contact-row').forEach(r => r.classList.toggle('active', Number(r.dataset.userId) === userId));
    const badge = document.getElementById(`unread-${userId}`);
    if (badge) badge.remove();

    try {
        const res = await fetch(`/api/messages/${userId}`);
        if (!res.ok) { $('chatMessages2').innerHTML = '<p class="empty-hint">فقط با دوستان می‌توانید گفتگو کنید.</p>'; return; }
        const msgs = await res.json();
        $('chatMessages2').innerHTML = '';
        if (!msgs.length) $('chatMessages2').innerHTML = '<p class="empty-hint">هنوز پیامی رد و بدل نشده. اولین پیام را بفرست!</p>';
        else msgs.forEach(appendChatMessage);
        scrollChatToBottom();
    } catch (e) {}
}

function deselectChat() {
    activeChatPartnerId = null;
    $('chatActive').classList.add('hidden');
    $('chatEmptyState').classList.remove('hidden');
    document.querySelectorAll('.contact-row.active').forEach(r => r.classList.remove('active'));
}

function appendChatMessage(msg) {
    const box = $('chatMessages2');
    if (!box) return;
    const emptyHint = box.querySelector('.empty-hint');
    if (emptyHint) emptyHint.remove();
    const mine = msg.sender_id === currentUserId;
    const div = document.createElement('div');
    div.className = 'chat-bubble2 ' + (mine ? 'mine' : 'theirs');
    if (msg.type === 'image') {
        div.classList.add('chat-bubble-image');
        div.innerHTML = `<img src="${esc(msg.body)}" alt="عکس" loading="lazy" onclick="window.open('${esc(msg.body)}', '_blank')">`;
    } else {
        div.innerText = msg.body;
    }
    box.appendChild(div);
    scrollChatToBottom();
}

function scrollChatToBottom() {
    const box = $('chatMessages2');
    if (box) box.scrollTop = box.scrollHeight;
}

function sendChatMessage() {
    const input = $('chatInput2');
    const body = input.value.trim();
    if (!body || !activeChatPartnerId || !chatSocket) return;
    input.value = '';
    chatSocket.emit('chat:send', { receiverId: activeChatPartnerId, body, type: 'text' }, (ack) => {
        if (ack && ack.error) showToast(ack.error, 'error');
    });
}

/* ---- ایموجی ---- */
function toggleEmojiPicker() {
    const picker = $('emojiPicker');
    if (!picker) return;
    if (picker.classList.contains('hidden')) {
        if (!picker.dataset.built) {
            picker.innerHTML = EMOJI_SET.map(e => `<button type="button" class="emoji-item" onclick="insertEmoji('${e}')">${e}</button>`).join('');
            picker.dataset.built = '1';
        }
        picker.classList.remove('hidden');
    } else {
        picker.classList.add('hidden');
    }
}

function insertEmoji(e) {
    const input = $('chatInput2');
    input.value += e;
    input.focus();
}

/* ---- ارسال عکس/گیف در چت ---- */
async function handleChatAttachment(evt) {
    const file = evt.target.files && evt.target.files[0];
    if (!file || !activeChatPartnerId) return;
    if (file.size > 8 * 1024 * 1024) { showToast('حجم فایل نباید بیشتر از ۸ مگابایت باشد.', 'error'); evt.target.value = ''; return; }

    const fd = new FormData();
    fd.append('file', file);
    try {
        showToast('در حال ارسال فایل...', 'info');
        const res = await fetch('/api/messages/attachment', { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.url) { showToast(data.error || 'ارسال فایل ناموفق بود.', 'error'); return; }

        chatSocket.emit('chat:send', { receiverId: activeChatPartnerId, body: data.url, type: 'image' }, (ack) => {
            if (ack && ack.error) showToast(ack.error, 'error');
        });
    } catch (e) {
        showToast('ارتباط با سرور برقرار نشد.', 'error');
    }
    evt.target.value = '';
}

document.addEventListener('click', (e) => {
    const picker = $('emojiPicker');
    const toggleBtn = $('emojiToggleBtn');
    if (!picker || picker.classList.contains('hidden')) return;
    if (!picker.contains(e.target) && e.target !== toggleBtn && !toggleBtn.contains(e.target)) {
        picker.classList.add('hidden');
    }
});


/* ========================================================
   نمودار فعالیت روزانه (داشبورد)
======================================================== */
function refreshActivityIfVisible() {
    if (activeTabName === 'dashboard') loadActivity();
}

async function loadActivity() {
    if (!$('activityChart')) return;
    if (!currentUserId) { renderActivityChart(null); return; }
    try {
        const res = await fetch(`/api/activity?days=7&tz=${new Date().getTimezoneOffset()}`);
        if (!res.ok) throw new Error('activity failed');
        renderActivityChart(await res.json());
    } catch (e) {
        renderActivityChart(null, 'دریافت نمودار ناموفق بود.');
    }
}

const WEEKDAY_LETTER = ['ی', 'د', 'س', 'چ', 'پ', 'ج', 'ش']; // یکشنبه … شنبه (getDay)
const WEEKDAY_FULL = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];

function renderActivityChart(data, message) {
    const chart = $('activityChart');
    const totalEl = $('activityTotal');
    if (!chart) return;

    if (!data || !Array.isArray(data.days)) {
        chart.innerHTML = `<div class="activity-hint">${esc(message || 'برای دیدن نمودار فعالیت، وارد حساب کاربری شوید.')}</div>`;
        if (totalEl) totalEl.textContent = '';
        return;
    }

    const days = data.days;
    const max = Math.max(1, ...days.map((d) => d.count));
    if (totalEl) totalEl.textContent = `مجموع: ${data.total || 0}`;

    chart.innerHTML = days.map((d, i) => {
        const dt = new Date(`${d.date}T12:00:00`);
        const dow = dt.getDay();
        const label = i === days.length - 1 ? 'امروز' : WEEKDAY_LETTER[dow];
        const height = d.count > 0 ? Math.max(8, Math.round((d.count / max) * 100)) : 4;
        const tip = `${WEEKDAY_FULL[dow]} ${dt.toLocaleDateString('fa-IR')}: ${d.count} فعالیت`;
        const cls = ['activity-col', i === days.length - 1 ? 'is-today' : '', d.count === 0 ? 'is-empty' : ''].join(' ').trim();
        return `
            <div class="${cls}" title="${esc(tip)}">
                <span class="activity-count">${d.count > 0 ? d.count : ''}</span>
                <div class="activity-bar-wrap"><div class="activity-bar" style="height:${height}px"></div></div>
                <span class="activity-day">${label}</span>
            </div>`;
    }).join('');
}


/* ========================================================
   اجتماع: پست، عکس و ویدیو
======================================================== */
const POST_MAX_VIDEO = 50 * 1024 * 1024;
const POST_MAX_IMAGE = 8 * 1024 * 1024;
const POST_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'];

function postTime(ts) {
    if (!ts) return '';
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60) return 'اکنون';
    if (diff > 7 * 86400) return new Date(ts * 1000).toLocaleDateString('fa-IR');
    return `${timeAgoShort(ts)} پیش`;
}

function updateComposerState() {
    const composer = $('postComposer');
    const hint = $('communityLoginHint');
    if (composer) composer.classList.toggle('hidden', !currentUserId);
    if (hint) hint.classList.toggle('hidden', !!currentUserId);
}

function resetCommunity() {
    communityOldestId = null;
    const feed = $('postsFeed');
    if (feed) feed.innerHTML = '';
    const more = $('loadMorePostsBtn');
    if (more) more.classList.add('hidden');
    const body = $('postBody');
    if (body) body.value = '';
    clearPostMedia();
}

async function loadCommunity(reset) {
    const feed = $('postsFeed');
    const more = $('loadMorePostsBtn');
    if (!feed) return;

    updateComposerState();
    if (!currentUserId) { feed.innerHTML = ''; if (more) more.classList.add('hidden'); return; }
    if (communityBusy) return;
    communityBusy = true;

    if (reset) {
        communityOldestId = null;
        feed.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>در حال بارگذاری...</p></div>';
    }

    try {
        const qs = new URLSearchParams({ limit: '15' });
        if (!reset && communityOldestId) qs.set('before', communityOldestId);
        const res = await fetch(`/api/posts?${qs}`);
        if (!res.ok) throw new Error('posts failed');
        const data = await res.json();
        const posts = Array.isArray(data.posts) ? data.posts : [];

        if (reset) feed.innerHTML = '';
        if (reset && !posts.length) feed.appendChild(emptyState('fa-people-group', 'هنوز پستی منتشر نشده. اولین نفر باش!'));
        posts.forEach((p) => feed.appendChild(buildPostCard(p)));
        if (posts.length) communityOldestId = posts[posts.length - 1].id;
        if (more) more.classList.toggle('hidden', !data.hasMore);
    } catch (e) {
        if (reset) {
            feed.innerHTML = '';
            feed.appendChild(emptyState('fa-triangle-exclamation', 'دریافت پست‌ها ناموفق بود.'));
        } else {
            showToast('دریافت پست‌ها ناموفق بود.', 'error');
        }
    } finally {
        communityBusy = false;
    }
}

function buildPostCard(p) {
    const el = document.createElement('article');
    el.className = 'post-card';
    el.dataset.postId = p.id;
    const mine = Number(p.user_id) === Number(currentUserId);

    let media = '';
    if (p.media_url) {
        media = p.media_type === 'video'
            ? `<video class="post-media" src="${esc(p.media_url)}" controls preload="metadata" playsinline></video>`
            : `<img class="post-media" src="${esc(p.media_url)}" alt="تصویر پست" loading="lazy" onclick="window.open(this.src, '_blank')">`;
    }

    el.innerHTML = `
        <div class="post-head">
            <img class="post-avatar" src="${esc(avatarSrc(p.avatar))}" alt="" loading="lazy">
            <div class="post-author">
                <button type="button" class="post-author-name" onclick="openPublicProfile(${Number(p.user_id)})">${esc(p.username)}</button>
                <span class="post-time">${esc(postTime(p.created_at))}</span>
            </div>
            ${mine ? '<button type="button" class="chat-icon-btn post-delete-btn" title="حذف پست"><i class="fa-solid fa-trash-can"></i></button>' : ''}
        </div>
        ${p.body ? `<div class="post-body">${esc(p.body)}</div>` : ''}
        ${media}
        <div class="post-actions">
            <button type="button" class="post-like-btn ${p.liked ? 'liked' : ''}">
                <i class="${p.liked ? 'fa-solid' : 'fa-regular'} fa-heart"></i> <span class="like-count">${Number(p.likes) || 0}</span>
            </button>
        </div>
    `;

    el.querySelector('.post-like-btn').onclick = (e) => togglePostLike(p.id, e.currentTarget);
    const delBtn = el.querySelector('.post-delete-btn');
    if (delBtn) delBtn.onclick = () => deletePost(p.id, el);
    return el;
}

async function togglePostLike(postId, btn) {
    try {
        const res = await fetch(`/api/posts/${postId}/like`, { method: 'POST' });
        if (!res.ok) throw new Error('like failed');
        const d = await res.json();
        btn.classList.toggle('liked', !!d.liked);
        btn.querySelector('i').className = `${d.liked ? 'fa-solid' : 'fa-regular'} fa-heart`;
        btn.querySelector('.like-count').textContent = d.likes;
    } catch (e) {
        showToast('ثبت پسند ناموفق بود.', 'error');
    }
}

async function deletePost(postId, el) {
    if (!window.confirm('این پست حذف شود؟')) return;
    try {
        const res = await fetch(`/api/posts/${postId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('delete failed');
        el.remove();
        showToast('پست حذف شد.', 'info');
        const feed = $('postsFeed');
        if (feed && !feed.querySelector('.post-card')) feed.appendChild(emptyState('fa-people-group', 'هنوز پستی منتشر نشده. اولین نفر باش!'));
    } catch (e) {
        showToast('حذف پست ناموفق بود.', 'error');
    }
}

/* ---- انتخاب و پیش‌نمایش فایل ---- */
function clearPostMedia() {
    if (postMediaPreviewUrl) URL.revokeObjectURL(postMediaPreviewUrl);
    postMediaPreviewUrl = '';
    postMediaFile = null;
    const box = $('postMediaPreview');
    if (box) { box.innerHTML = ''; box.classList.add('hidden'); }
}

function handlePostMediaSelect(evt) {
    const file = evt.target.files && evt.target.files[0];
    evt.target.value = '';
    if (!file) return;

    if (!POST_ALLOWED_TYPES.includes(file.type)) {
        showToast('فقط عکس (JPG/PNG/WEBP/GIF) یا ویدیو (MP4/WEBM/MOV) مجاز است.', 'error');
        return;
    }
    const isVideo = file.type.startsWith('video/');
    if (file.size > (isVideo ? POST_MAX_VIDEO : POST_MAX_IMAGE)) {
        showToast(isVideo ? 'حجم ویدیو نباید بیشتر از ۵۰ مگابایت باشد.' : 'حجم عکس نباید بیشتر از ۸ مگابایت باشد.', 'error');
        return;
    }

    clearPostMedia();
    postMediaFile = file;
    postMediaPreviewUrl = URL.createObjectURL(file);

    const box = $('postMediaPreview');
    box.innerHTML = isVideo
        ? `<video src="${esc(postMediaPreviewUrl)}" controls playsinline></video>`
        : `<img src="${esc(postMediaPreviewUrl)}" alt="پیش‌نمایش">`;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'preview-remove';
    rm.title = 'حذف فایل';
    rm.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    rm.onclick = clearPostMedia;
    box.appendChild(rm);
    box.classList.remove('hidden');
}

async function submitPost() {
    if (!currentUserId) { openAuthModal(); return; }

    const bodyEl = $('postBody');
    const body = bodyEl.value.trim();
    if (!body && !postMediaFile) {
        showToast('متنی بنویس یا یک عکس/ویدیو اضافه کن.', 'info');
        return;
    }

    const btn = $('postSubmitBtn');
    const oldHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> در حال ارسال...';

    const fd = new FormData();
    fd.append('body', body);
    if (postMediaFile) fd.append('media', postMediaFile);

    try {
        const res = await fetch('/api/posts', { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.post) {
            showToast(data.error || 'انتشار پست ناموفق بود.', 'error');
            return;
        }

        const feed = $('postsFeed');
        const emptyEl = feed.querySelector('.empty-state');
        if (emptyEl) emptyEl.remove();
        feed.prepend(buildPostCard(data.post));

        bodyEl.value = '';
        clearPostMedia();
        showToast('پست منتشر شد.', 'success');
    } catch (e) {
        showToast('ارتباط با سرور برقرار نشد.', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
    }
}
