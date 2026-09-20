const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const http = require('http');
const multer = require('multer');
const { Server: SocketIOServer } = require('socket.io');

const app = express();
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: false } });
const PORT = process.env.PORT || 3000;

const onlineSockets = new Map(); // userId -> Set(socket.id)
function isOnline(id) { return onlineSockets.has(Number(id)); }

app.use(express.json());

// فایل‌های html/js/css همیشه revalidate می‌شوند (بعد از آپدیت کش قدیمی نمی‌ماند)
// بقیه فایل‌ها (عکس، فونت و ...) یک روز کش می‌شوند
app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    setHeaders(res, filePath) {
        if (/\.(html|js|css|json)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
        else res.setHeader('Cache-Control', 'public, max-age=86400');
    }
}));

const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'cinema_secret_key_123',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax'
    }
});
app.use(sessionMiddleware);

// اشتراک‌گذاری سشن اکسپرس با سوکت (تا بدانیم هر اتصال سوکت متعلق به کدام کاربر است)
io.engine.use(sessionMiddleware);

/* ========================================================
   دیتابیس
======================================================== */
const db = new sqlite3.Database('./movies.db', (err) => {
    if (!err) console.log('دیتابیس سینما متصل شد.');
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            avatar TEXT DEFAULT '',
            bio TEXT DEFAULT ''
        )
    `);

    db.all("PRAGMA table_info(users)", (err, columns) => {
        if (err || !columns) return;
        const colNames = columns.map(c => c.name);
        if (!colNames.includes('avatar')) db.run(`ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''`);
        if (!colNames.includes('bio')) db.run(`ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''`);
    });

    // درخواست/رابطه‌ی دوستی بین دو کاربر
    db.run(`
        CREATE TABLE IF NOT EXISTS friendships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            requester_id INTEGER NOT NULL,
            receiver_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER DEFAULT (strftime('%s','now')),
            UNIQUE(requester_id, receiver_id)
        )
    `);

    // پیام‌های چت خصوصی بین دو کاربر
    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id INTEGER NOT NULL,
            receiver_id INTEGER NOT NULL,
            body TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'text',
            created_at INTEGER DEFAULT (strftime('%s','now')),
            is_read INTEGER DEFAULT 0
        )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender_id, receiver_id)`);
    db.all("PRAGMA table_info(messages)", (err, cols) => {
        if (err || !cols) return;
        if (!cols.map(c => c.name).includes('type')) db.run(`ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'`);
    });

    // ثبت فعالیت‌های کاربر (برای نمودار روزانه‌ی داشبورد)
    db.run(`
        CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_activity_user_time ON activity_log (user_id, created_at)`);

    // اجتماع: پست‌ها و پسندها
    db.run(`
        CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            body TEXT NOT NULL DEFAULT '',
            media_url TEXT NOT NULL DEFAULT '',
            media_type TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )
    `);
    db.run(`
        CREATE TABLE IF NOT EXISTS post_likes (
            post_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            PRIMARY KEY (post_id, user_id)
        )
    `);

    db.all("PRAGMA table_info(my_movies)", (err, columns) => {
        if (err || !columns || columns.length === 0) {
            db.run(`
                CREATE TABLE IF NOT EXISTS my_movies (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    movie_id TEXT,
                    title TEXT,
                    poster TEXT,
                    type TEXT,
                    status TEXT,
                    season INTEGER DEFAULT 0,
                    episode INTEGER DEFAULT 0,
                    total_seasons INTEGER DEFAULT 0,
                    total_episodes INTEGER DEFAULT 0,
                    minute INTEGER DEFAULT 0,
                    rating REAL DEFAULT 0,
                    note TEXT DEFAULT '',
                    genre TEXT DEFAULT '',
                    runtime INTEGER DEFAULT 0,
                    is_private INTEGER DEFAULT 0,
                    UNIQUE(user_id, movie_id)
                )
            `);
            return;
        }

        const colNames = columns.map(c => c.name);
        if (!colNames.includes('user_id')) {
            db.serialize(() => {
                db.run(`ALTER TABLE my_movies RENAME TO my_movies_old`);
                db.run(`
                    CREATE TABLE my_movies (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id INTEGER,
                        movie_id TEXT,
                        title TEXT,
                        poster TEXT,
                        type TEXT,
                        status TEXT,
                        season INTEGER DEFAULT 0,
                        episode INTEGER DEFAULT 0,
                        total_seasons INTEGER DEFAULT 0,
                        total_episodes INTEGER DEFAULT 0,
                        minute INTEGER DEFAULT 0,
                        rating REAL DEFAULT 0,
                        note TEXT DEFAULT '',
                        genre TEXT DEFAULT '',
                        runtime INTEGER DEFAULT 0,
                        is_private INTEGER DEFAULT 0,
                        UNIQUE(user_id, movie_id)
                    )
                `);
                db.run(`DROP TABLE IF EXISTS my_movies_old`);
            });
        } else {
            if (!colNames.includes('rating')) db.run(`ALTER TABLE my_movies ADD COLUMN rating REAL DEFAULT 0`);
            if (!colNames.includes('note')) db.run(`ALTER TABLE my_movies ADD COLUMN note TEXT DEFAULT ''`);
            if (!colNames.includes('total_seasons')) db.run(`ALTER TABLE my_movies ADD COLUMN total_seasons INTEGER DEFAULT 0`);
            if (!colNames.includes('total_episodes')) db.run(`ALTER TABLE my_movies ADD COLUMN total_episodes INTEGER DEFAULT 0`);
            if (!colNames.includes('genre')) db.run(`ALTER TABLE my_movies ADD COLUMN genre TEXT DEFAULT ''`);
            if (!colNames.includes('runtime')) db.run(`ALTER TABLE my_movies ADD COLUMN runtime INTEGER DEFAULT 0`);
            if (!colNames.includes('is_private')) db.run(`ALTER TABLE my_movies ADD COLUMN is_private INTEGER DEFAULT 0`);
        }
    });
});

/* ========================================================
   ابزارهای عمومی
======================================================== */
function logActivity(userId, type) {
    if (!userId) return;
    db.run("INSERT INTO activity_log (user_id, type) VALUES (?, ?)", [Number(userId), type], () => {});
}

const OMDB_API_KEY = process.env.OMDB_API_KEY || '1cb71949';
const enc = encodeURIComponent;

// هر درخواست خارجی timeout دارد تا سرور هیچ‌وقت معطل نماند
async function fetchJson(url, ms = 4500) {
    const r = await fetch(url, {
        signal: AbortSignal.timeout(ms),
        headers: { 'User-Agent': 'CinemaApp/1.0', 'Accept': 'application/json' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
}

const GENRE_FA = {
    'action': 'اکشن', 'adventure': 'ماجراجویی', 'animation': 'انیمیشن', 'anime': 'انیمه',
    'biography': 'بیوگرافی', 'comedy': 'کمدی', 'crime': 'جنایی', 'documentary': 'مستند',
    'drama': 'درام', 'family': 'خانوادگی', 'fantasy': 'فانتزی', 'history': 'تاریخی',
    'horror': 'ترسناک', 'music': 'موسیقی', 'musical': 'موزیکال', 'mystery': 'معمایی',
    'romance': 'عاشقانه', 'science-fiction': 'علمی-تخیلی', 'sci-fi': 'علمی-تخیلی',
    'thriller': 'هیجان‌انگیز', 'war': 'جنگی', 'western': 'وسترن', 'sport': 'ورزشی',
    'supernatural': 'ماورایی', 'medical': 'پزشکی', 'legal': 'حقوقی', 'espionage': 'جاسوسی',
    'food': 'غذا', 'travel': 'سفر', 'nature': 'طبیعت', 'reality-tv': 'واقعیت', 'talk-show': 'گفتگو'
};

function translateGenres(input) {
    if (!input) return '';
    const list = Array.isArray(input) ? input : String(input).split(/[,،]\s*/);
    const out = [];
    list.forEach(g => {
        const key = String(g).trim().toLowerCase();
        if (!key) return;
        const fa = GENRE_FA[key] || String(g).trim();
        if (!out.includes(fa)) out.push(fa);
    });
    return out.join('، ');
}

/* ========================================================
   کاتالوگ محلی (پوستر به‌جای آدرس دستی، از روی شناسه IMDb پیدا می‌شود)
======================================================== */
const CATALOG = [
    { id: 'tt0068646', title: 'The Godfather', year: '1972', type: 'movie', runtime: 175, genre: 'جنایی، درام' },
    { id: 'tt0468569', title: 'The Dark Knight', year: '2008', type: 'movie', runtime: 152, genre: 'اکشن، جنایی، درام' },
    { id: 'tt1375666', title: 'Inception', year: '2010', type: 'movie', runtime: 148, genre: 'علمی-تخیلی، اکشن' },
    { id: 'tt0816692', title: 'Interstellar', year: '2014', type: 'movie', runtime: 169, genre: 'ماجراجویی، علمی-تخیلی، درام' },
    { id: 'tt0111161', title: 'The Shawshank Redemption', year: '1994', type: 'movie', runtime: 142, genre: 'درام' },
    { id: 'tt0110912', title: 'Pulp Fiction', year: '1994', type: 'movie', runtime: 154, genre: 'جنایی، درام' },
    { id: 'tt0137523', title: 'Fight Club', year: '1999', type: 'movie', runtime: 139, genre: 'درام' },
    { id: 'tt0109830', title: 'Forrest Gump', year: '1994', type: 'movie', runtime: 142, genre: 'درام، عاشقانه' },
    { id: 'tt0133093', title: 'The Matrix', year: '1999', type: 'movie', runtime: 136, genre: 'اکشن، علمی-تخیلی' },
    { id: 'tt0903747', title: 'Breaking Bad', year: '2008', type: 'series', total_seasons: 5, total_episodes: 62, genre: 'درام، جنایی' },
    { id: 'tt0944947', title: 'Game of Thrones', year: '2011', type: 'series', total_seasons: 8, total_episodes: 73, genre: 'اکشن، ماجراجویی، فانتزی' },
    { id: 'tt4574334', title: 'Stranger Things', year: '2016', type: 'series', total_seasons: 5, total_episodes: 42, genre: 'علمی-تخیلی، ترسناک' },
    { id: 'tt7366338', title: 'Chernobyl', year: '2019', type: 'series', total_seasons: 1, total_episodes: 5, genre: 'تاریخی، درام' },
    { id: 'tt2442560', title: 'Peaky Blinders', year: '2013', type: 'series', total_seasons: 6, total_episodes: 36, genre: 'جنایی، درام' }
];

/* ========================================================
   پیدا کردن پوستر (با کش حافظه + timeout)
======================================================== */
const posterMeta = new Map();      // id -> { poster, retryAt }
const posterInflight = new Map();  // id -> Promise

async function resolveCatalogPoster(item) {
    const cached = posterMeta.get(item.id);
    if (cached && (cached.poster || Date.now() < cached.retryAt)) return cached.poster;
    if (posterInflight.has(item.id)) return posterInflight.get(item.id);

    const job = (async () => {
        let poster = '';
        if (OMDB_API_KEY && /^tt\d+$/i.test(item.id)) {
            try {
                const d = await fetchJson(`https://www.omdbapi.com/?i=${item.id}&apikey=${OMDB_API_KEY}`, 4500);
                if (d && d.Response !== 'False' && d.Poster && d.Poster !== 'N/A') poster = d.Poster;
            } catch (e) {}
        }
        if (!poster && item.type === 'series') {
            try {
                const d = await fetchJson(`https://api.tvmaze.com/singlesearch/shows?q=${enc(item.title)}`, 4500);
                poster = (d && d.image && (d.image.medium || d.image.original)) || '';
            } catch (e) {}
        }
        posterMeta.set(item.id, { poster, retryAt: Date.now() + 5 * 60 * 1000 });
        return poster;
    })().finally(() => posterInflight.delete(item.id));

    posterInflight.set(item.id, job);
    return job;
}

// اگر تا ms میلی‌ثانیه جواب نیامد، بدون پوستر ادامه می‌دهیم (در پس‌زمینه کش می‌شود)
function resolvePosterWithin(item, ms) {
    return Promise.race([
        resolveCatalogPoster(item).catch(() => ''),
        new Promise(resolve => setTimeout(() => resolve(''), ms))
    ]);
}

// گرم کردن کش پوسترها هنگام بالا آمدن سرور
CATALOG.forEach(item => { resolveCatalogPoster(item).catch(() => {}); });

/* ========================================================
   پروکسی + کش دیسکی عکس‌ها  →  /api/img
   عکس‌ها یک بار دانلود و روی دیسک ذخیره می‌شوند و از آن به بعد فوری و با کش یک‌ساله سرو می‌شوند.
======================================================== */
const IMG_CACHE_DIR = path.join(__dirname, 'img_cache');
fs.mkdirSync(IMG_CACHE_DIR, { recursive: true });

const IMG_ALLOWED_HOSTS = [
    'image.tmdb.org',
    'static.tvmaze.com',
    'media-amazon.com',
    'ssl-images-amazon.com',
    'images-amazon.com',
    'media-imdb.com'
];
const IMG_EXT_BY_TYPE = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMG_EXTS = ['jpg', 'png', 'webp', 'gif'];
const imgInflight = new Map();
const imgFailedUntil = new Map();

// آدرس اصلی را امن می‌کند و به اندازه‌ی مناسب تغییر می‌دهد
function buildImageSource(rawUrl, w) {
    let u;
    try { u = new URL(rawUrl); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

    const host = u.hostname.toLowerCase();
    if (!IMG_ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h))) return null;
    u.protocol = 'https:';

    if (host === 'image.tmdb.org') {
        const size = w <= 200 ? 'w185' : (w <= 380 ? 'w342' : 'w500');
        u.pathname = u.pathname.replace(/^\/t\/p\/(?:w\d+|h\d+|original)\//, `/t/p/${size}/`);
    } else if (host.includes('amazon.com') || host.includes('media-imdb.com')) {
        u.pathname = u.pathname.replace(/_V1_[^./]*\./i, `_V1_SX${w}.`);
    } else if (host === 'static.tvmaze.com' && w <= 400) {
        u.pathname = u.pathname.replace('/original_untouched/', '/medium_portrait/');
    }
    return u.toString();
}

function findCachedImage(hash) {
    for (const ext of IMG_EXTS) {
        const file = path.join(IMG_CACHE_DIR, `${hash}.${ext}`);
        if (fs.existsSync(file)) return file;
    }
    return null;
}

async function downloadImage(srcUrl, hash) {
    const r = await fetch(srcUrl, {
        signal: AbortSignal.timeout(8000),
        redirect: 'follow',
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; CinemaApp/1.0)',
            'Accept': 'image/webp,image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5'
        }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);

    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = IMG_EXT_BY_TYPE[type];
    if (!ext) throw new Error('not an image');

    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 6 * 1024 * 1024) throw new Error('bad size');

    const file = path.join(IMG_CACHE_DIR, `${hash}.${ext}`);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, file);
    return file;
}

app.get('/api/img', async (req, res) => {
    const w = Math.min(Math.max(parseInt(req.query.w, 10) || 300, 80), 600);
    const srcUrl = buildImageSource(String(req.query.u || ''), w);
    if (!srcUrl) return res.status(400).end();

    const hash = crypto.createHash('sha1').update(srcUrl).digest('hex');
    let file = findCachedImage(hash);

    if (!file) {
        const blockedUntil = imgFailedUntil.get(hash);
        if (blockedUntil && Date.now() < blockedUntil) return res.status(502).end();

        try {
            if (!imgInflight.has(hash)) {
                imgInflight.set(hash, downloadImage(srcUrl, hash).finally(() => imgInflight.delete(hash)));
            }
            file = await imgInflight.get(hash);
        } catch (e) {
            imgFailedUntil.set(hash, Date.now() + 60 * 1000);
            return res.status(502).end();
        }
    }

    res.sendFile(file, {
        maxAge: '365d',
        immutable: true,
        headers: { 'X-Content-Type-Options': 'nosniff' }
    }, () => {});
});

// پاک کردن عکس‌های خیلی قدیمی کش (هنگام اجرا)
(function pruneImageCache() {
    const maxAge = 45 * 24 * 60 * 60 * 1000;
    fs.readdir(IMG_CACHE_DIR, (err, files) => {
        if (err) return;
        files.forEach(f => {
            const full = path.join(IMG_CACHE_DIR, f);
            fs.stat(full, (e, st) => {
                if (!e && (f.endsWith('.tmp') || Date.now() - st.mtimeMs > maxAge)) fs.unlink(full, () => {});
            });
        });
    });
})();

/* ========================================================
   احراز هویت
======================================================== */
function requireAuth(req, res, next) {
    if (req.session && req.session.userId) next();
    else res.status(401).json({ error: 'لطفاً ابتدا وارد حساب کاربری خود شوید.' });
}

app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'نام کاربری و رمز عبور الزامی است.' });

    try {
        const hashedPassword = await bcrypt.hash(String(password), 10);
        db.run("INSERT INTO users (username, password) VALUES (?, ?)", [String(username), hashedPassword], function (err) {
            if (err) return res.status(400).json({ error: 'این نام کاربری قبلاً ثبت شده است.' });
            req.session.userId = Number(this.lastID);
            req.session.username = String(username);
            logActivity(this.lastID, 'login');
            req.session.save(() => res.json({ success: true, username }));
        });
    } catch (e) {
        res.status(500).json({ error: 'خطای سرور.' });
    }
});

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    db.get("SELECT * FROM users WHERE username = ?", [String(username || '')], async (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'اطلاعات ورود اشتباه است.' });
        const match = await bcrypt.compare(String(password || ''), user.password);
        if (!match) return res.status(400).json({ error: 'اطلاعات ورود اشتباه است.' });

        req.session.userId = Number(user.id);
        req.session.username = user.username;
        logActivity(user.id, 'login');
        req.session.save(() => res.json({ success: true, username: user.username }));
    });
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.json({ success: true });
    });
});

app.get('/api/auth/me', (req, res) => {
    if (req.session && req.session.userId) {
        db.get("SELECT id, username, avatar, bio FROM users WHERE id = ?", [req.session.userId], (err, row) => {
            res.json({
                loggedIn: true,
                username: req.session.username,
                id: req.session.userId,
                avatar: row ? row.avatar : '',
                bio: row ? row.bio : ''
            });
        });
    } else {
        res.json({ loggedIn: false });
    }
});

/* ========================================================
   پروفایل کاربر (عکس پروفایل + بیوگرافی)
======================================================== */
const AVATAR_DIR = path.join(__dirname, 'public', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 3 * 1024 * 1024 },
    fileFilter(req, file, cb) {
        const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
        cb(ok ? null : new Error('نوع فایل مجاز نیست.'), ok);
    }
});

app.post('/api/profile/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'فایلی ارسال نشده است.' });
    try {
        const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[req.file.mimetype] || 'jpg';
        const userId = Number(req.session.userId);
        const fileName = `u${userId}_${Date.now()}.${ext}`;
        const filePath = path.join(AVATAR_DIR, fileName);

        // حذف عکس قدیمی این کاربر
        fs.readdirSync(AVATAR_DIR).forEach(f => {
            if (f.startsWith(`u${userId}_`)) { try { fs.unlinkSync(path.join(AVATAR_DIR, f)); } catch (e) {} }
        });

        await fs.promises.writeFile(filePath, req.file.buffer);
        const avatarUrl = `/avatars/${fileName}`;
        db.run("UPDATE users SET avatar = ? WHERE id = ?", [avatarUrl, userId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, avatar: avatarUrl });
        });
    } catch (e) {
        res.status(500).json({ error: 'خطا در آپلود عکس.' });
    }
});

app.put('/api/profile', requireAuth, (req, res) => {
    const bio = String((req.body && req.body.bio) || '').slice(0, 300);
    db.run("UPDATE users SET bio = ? WHERE id = ?", [bio, req.session.userId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, bio });
    });
});

/* ========================================================
   آپلود عکس/گیف داخل چت
======================================================== */
const CHAT_UPLOAD_DIR = path.join(__dirname, 'public', 'chat_uploads');
fs.mkdirSync(CHAT_UPLOAD_DIR, { recursive: true });

const chatUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter(req, file, cb) {
        const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype);
        cb(ok ? null : new Error('نوع فایل مجاز نیست.'), ok);
    }
});

app.post('/api/messages/attachment', requireAuth, chatUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'فایلی ارسال نشده است.' });
    try {
        const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[req.file.mimetype] || 'jpg';
        const fileName = `c${req.session.userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
        await fs.promises.writeFile(path.join(CHAT_UPLOAD_DIR, fileName), req.file.buffer);
        res.json({ success: true, url: `/chat_uploads/${fileName}` });
    } catch (e) {
        res.status(500).json({ error: 'خطا در آپلود فایل.' });
    }
});

/* ========================================================
   جستجو و مشاهده‌ی پروفایل عمومی کاربران
======================================================== */
async function getFriendStatus(myId, otherId) {
    return new Promise((resolve) => {
        db.get(
            `SELECT * FROM friendships WHERE
                (requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?)`,
            [myId, otherId, otherId, myId],
            (err, row) => {
                if (err || !row) return resolve({ state: 'none' });
                if (row.status === 'accepted') return resolve({ state: 'friends', id: row.id });
                if (row.status === 'pending' && row.requester_id === myId) return resolve({ state: 'pending_sent', id: row.id });
                if (row.status === 'pending' && row.requester_id === otherId) return resolve({ state: 'pending_received', id: row.id });
                resolve({ state: 'none' });
            }
        );
    });
}

app.get('/api/users/search', requireAuth, (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q || q.length > 40) return res.json([]);
    db.all(
        "SELECT id, username, avatar FROM users WHERE username LIKE ? AND id != ? LIMIT 15",
        [`%${q}%`, req.session.userId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

app.get('/api/users/:id', requireAuth, async (req, res) => {
    const myId = Number(req.session.userId);
    const otherId = Number(req.params.id);
    if (!otherId) return res.status(400).json({ error: 'شناسه نامعتبر است.' });

    db.get("SELECT id, username, avatar, bio FROM users WHERE id = ?", [otherId], async (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'کاربر پیدا نشد.' });

        const friendStatus = otherId === myId ? { state: 'self' } : await getFriendStatus(myId, otherId);
        const canSeeAll = friendStatus.state === 'friends' || otherId === myId;

        const movieFilter = canSeeAll
            ? "user_id = ? AND status = 'watched'"
            : "user_id = ? AND status = 'watched' AND is_private = 0";

        db.all(
            `SELECT movie_id, title, poster, type, rating, genre FROM my_movies WHERE ${movieFilter} ORDER BY id DESC LIMIT 60`,
            [otherId],
            (err2, movies) => {
                res.json({
                    id: user.id,
                    username: user.username,
                    avatar: user.avatar || '',
                    bio: user.bio || '',
                    friendStatus: friendStatus.state,
                    online: isOnline(user.id),
                    movies: movies || []
                });
            }
        );
    });
});

/* ========================================================
   درخواست دوستی
======================================================== */
app.post('/api/friends/:id/request', requireAuth, (req, res) => {
    const myId = Number(req.session.userId);
    const otherId = Number(req.params.id);
    if (!otherId || otherId === myId) return res.status(400).json({ error: 'درخواست نامعتبر است.' });

    // اگر طرف مقابل قبلاً درخواست فرستاده، به‌جای درخواست جدید، قبول می‌کنیم
    db.get(
        "SELECT * FROM friendships WHERE requester_id = ? AND receiver_id = ?",
        [otherId, myId],
        (err, reverseRow) => {
            if (reverseRow && reverseRow.status === 'pending') {
                return db.run("UPDATE friendships SET status = 'accepted' WHERE id = ?", [reverseRow.id], (e) => {
                    if (e) return res.status(500).json({ error: e.message });
                    notifyUser(otherId, 'friend:accepted', { userId: myId });
                    res.json({ success: true, state: 'friends' });
                });
            }
            db.run(
                "INSERT INTO friendships (requester_id, receiver_id, status) VALUES (?, ?, 'pending')",
                [myId, otherId],
                function (e) {
                    if (e) return res.status(400).json({ error: 'درخواست قبلاً ارسال شده است.' });
                    logActivity(myId, 'friend');
                    notifyUser(otherId, 'friend:request', { userId: myId });
                    res.json({ success: true, state: 'pending_sent' });
                }
            );
        }
    );
});

app.post('/api/friends/:id/accept', requireAuth, (req, res) => {
    const myId = Number(req.session.userId);
    const otherId = Number(req.params.id);
    db.run(
        "UPDATE friendships SET status = 'accepted' WHERE requester_id = ? AND receiver_id = ? AND status = 'pending'",
        [otherId, myId],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'درخواستی یافت نشد.' });
            notifyUser(otherId, 'friend:accepted', { userId: myId });
            res.json({ success: true });
        }
    );
});

app.post('/api/friends/:id/reject', requireAuth, (req, res) => {
    const myId = Number(req.session.userId);
    const otherId = Number(req.params.id);
    db.run(
        "DELETE FROM friendships WHERE requester_id = ? AND receiver_id = ? AND status = 'pending'",
        [otherId, myId],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

app.delete('/api/friends/:id', requireAuth, (req, res) => {
    const myId = Number(req.session.userId);
    const otherId = Number(req.params.id);
    db.run(
        `DELETE FROM friendships WHERE
            (requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?)`,
        [myId, otherId, otherId, myId],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

app.get('/api/friends', requireAuth, (req, res) => {
    const myId = Number(req.session.userId);
    db.all(
        `SELECT u.id, u.username, u.avatar,
                (SELECT body FROM messages m WHERE (m.sender_id = u.id AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = u.id) ORDER BY m.id DESC LIMIT 1) AS lastMessage,
                (SELECT type FROM messages m WHERE (m.sender_id = u.id AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = u.id) ORDER BY m.id DESC LIMIT 1) AS lastMessageType,
                (SELECT created_at FROM messages m WHERE (m.sender_id = u.id AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = u.id) ORDER BY m.id DESC LIMIT 1) AS lastAt,
                (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id AND m.receiver_id = ? AND m.is_read = 0) AS unread
         FROM friendships f
         JOIN users u ON u.id = (CASE WHEN f.requester_id = ? THEN f.receiver_id ELSE f.requester_id END)
         WHERE (f.requester_id = ? OR f.receiver_id = ?) AND f.status = 'accepted'
         ORDER BY lastAt DESC, u.id DESC`,
        [myId, myId, myId, myId, myId, myId, myId, myId, myId, myId],
        (err, friends) => {
            if (err) return res.status(500).json({ error: err.message });
            (friends || []).forEach(f => { f.online = isOnline(f.id); });

            db.all(
                `SELECT u.id, u.username, u.avatar FROM friendships f
                 JOIN users u ON u.id = f.requester_id
                 WHERE f.receiver_id = ? AND f.status = 'pending'`,
                [myId],
                (err2, incoming) => {
                    if (err2) return res.status(500).json({ error: err2.message });
                    res.json({ friends: friends || [], incomingRequests: incoming || [] });
                }
            );
        }
    );
});

/* ========================================================
   چت خصوصی (تاریخچه از طریق REST، پیام‌های زنده از طریق سوکت)
======================================================== */
async function areFriends(a, b) {
    return new Promise((resolve) => {
        db.get(
            `SELECT 1 FROM friendships WHERE status = 'accepted' AND
                ((requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?))`,
            [a, b, b, a],
            (err, row) => resolve(!!row)
        );
    });
}

app.get('/api/conversations', requireAuth, (req, res) => {
    const myId = Number(req.session.userId);
    db.all(
        `SELECT u.id, u.username, u.avatar,
                (SELECT body FROM messages m WHERE (m.sender_id = u.id AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = u.id) ORDER BY m.id DESC LIMIT 1) AS lastMessage,
                (SELECT created_at FROM messages m WHERE (m.sender_id = u.id AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = u.id) ORDER BY m.id DESC LIMIT 1) AS lastAt,
                (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id AND m.receiver_id = ? AND m.is_read = 0) AS unread
         FROM friendships f
         JOIN users u ON u.id = (CASE WHEN f.requester_id = ? THEN f.receiver_id ELSE f.requester_id END)
         WHERE (f.requester_id = ? OR f.receiver_id = ?) AND f.status = 'accepted'
         ORDER BY lastAt DESC`,
        [myId, myId, myId, myId, myId, myId, myId, myId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

app.get('/api/messages/:userId', requireAuth, async (req, res) => {
    const myId = Number(req.session.userId);
    const otherId = Number(req.params.userId);
    if (!(await areFriends(myId, otherId))) return res.status(403).json({ error: 'فقط با دوستان می‌توانید گفتگو کنید.' });

    db.all(
        `SELECT id, sender_id, receiver_id, body, type, created_at FROM messages
         WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
         ORDER BY id ASC LIMIT 200`,
        [myId, otherId, otherId, myId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            db.run("UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?", [otherId, myId]);
            res.json(rows || []);
        }
    );
});

/* ========================================================
   جستجو (سریع: بدون انتظار برای جزئیات؛ جزئیات با /api/details گرفته می‌شود)
======================================================== */
const searchCache = new Map(); // q -> { ts, data }
const SEARCH_TTL = 10 * 60 * 1000;

async function searchTvmaze(q) {
    const data = await fetchJson(`https://api.tvmaze.com/search/shows?q=${enc(q)}`, 4500);
    return (Array.isArray(data) ? data : []).slice(0, 10).map(({ show }) => ({
        id: String(show.id),
        title: show.name,
        year: (show.premiered || '').slice(0, 4),
        type: 'series',
        poster: (show.image && (show.image.medium || show.image.original)) || '',
        genre: translateGenres(show.genres)
    }));
}

async function searchOmdbMovies(q) {
    if (!OMDB_API_KEY) return [];
    const d = await fetchJson(`https://www.omdbapi.com/?s=${enc(q)}&type=movie&apikey=${OMDB_API_KEY}`, 4500);
    if (!d || d.Response === 'False' || !Array.isArray(d.Search)) return [];
    return d.Search.slice(0, 10).map(x => ({
        id: x.imdbID,
        title: x.Title,
        year: (x.Year || '').slice(0, 4),
        type: 'movie',
        poster: x.Poster && x.Poster !== 'N/A' ? x.Poster : ''
    }));
}

function interleave(...lists) {
    const out = [];
    const max = Math.max(0, ...lists.map(l => l.length));
    for (let i = 0; i < max; i++) lists.forEach(l => { if (l[i]) out.push(l[i]); });
    return out;
}

app.get('/api/search', async (req, res) => {
    const raw = String(req.query.q || '').trim();
    const q = raw.toLowerCase();
    if (!q || q.length > 80) return res.json([]);

    const cached = searchCache.get(q);
    if (cached && Date.now() - cached.ts < SEARCH_TTL) return res.json(cached.data);

    const localMatches = CATALOG.filter(m => m.title.toLowerCase().includes(q));

    const [localR, tvR, omdbR] = await Promise.allSettled([
        Promise.all(localMatches.map(async m => ({ ...m, poster: await resolvePosterWithin(m, 2500) }))),
        searchTvmaze(raw),
        searchOmdbMovies(raw)
    ]);

    const local = localR.status === 'fulfilled' ? localR.value : [];
    const tv = tvR.status === 'fulfilled' ? tvR.value : [];
    const movies = omdbR.status === 'fulfilled' ? omdbR.value : [];

    const seen = new Set();
    const out = [];
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, '');
    const add = it => {
        const key = norm(it.title) + '|' + (it.year || '');
        if (seen.has(key)) return;
        seen.add(key);
        out.push(it);
    };

    local.forEach(add);
    interleave(movies, tv).forEach(add);

    const data = out.slice(0, 14);
    if (tvR.status === 'fulfilled' || omdbR.status === 'fulfilled') {
        searchCache.set(q, { ts: Date.now(), data });
        if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
    }
    res.json(data);
});

/* ========================================================
   جزئیات (مدت زمان، تعداد فصل/قسمت، ژانر) — هنگام انتخاب یک آیتم
======================================================== */
const detailsCache = new Map();
const DETAILS_TTL = 60 * 60 * 1000;

async function getDetails(id) {
    const local = CATALOG.find(m => m.id === id);
    if (local) {
        return {
            type: local.type,
            runtime: local.runtime || 0,
            total_seasons: local.total_seasons || 0,
            total_episodes: local.total_episodes || 0,
            genre: local.genre || '',
            poster: await resolvePosterWithin(local, 3000)
        };
    }

    // شناسه عددی = سریال TVMaze
    if (/^\d+$/.test(id)) {
        const [showR, epsR] = await Promise.allSettled([
            fetchJson(`https://api.tvmaze.com/shows/${id}`, 5000),
            fetchJson(`https://api.tvmaze.com/shows/${id}/episodes`, 6000)
        ]);
        const out = { type: 'series' };
        if (showR.status === 'fulfilled' && showR.value) {
            const s = showR.value;
            out.genre = translateGenres(s.genres);
            out.poster = (s.image && (s.image.medium || s.image.original)) || '';
        }
        if (epsR.status === 'fulfilled' && Array.isArray(epsR.value)) {
            const regular = epsR.value.filter(e => e.number != null && e.season > 0);
            out.total_episodes = regular.length;
            out.total_seasons = regular.reduce((mx, e) => Math.max(mx, e.season), 0);
        }
        return out;
    }

    // شناسه IMDb = فیلم (یا سریال) از OMDb
    if (/^tt\d+$/i.test(id) && OMDB_API_KEY) {
        const d = await fetchJson(`https://www.omdbapi.com/?i=${id}&apikey=${OMDB_API_KEY}`, 5000);
        if (d && d.Response !== 'False') {
            const isSeries = d.Type === 'series';
            const out = {
                type: isSeries ? 'series' : 'movie',
                genre: translateGenres(d.Genre),
                poster: d.Poster && d.Poster !== 'N/A' ? d.Poster : ''
            };
            if (isSeries) {
                out.total_seasons = parseInt(d.totalSeasons, 10) || 0;
            } else {
                const m = (d.Runtime || '').match(/\d+/);
                out.runtime = m ? parseInt(m[0], 10) : 0;
            }
            return out;
        }
    }
    return {};
}

app.get('/api/details', async (req, res) => {
    const id = String(req.query.id || '').trim();
    if (!id) return res.json({});

    const cached = detailsCache.get(id);
    if (cached && Date.now() - cached.ts < DETAILS_TTL) return res.json(cached.data);

    try {
        const data = await getDetails(id);
        if (data && Object.keys(data).length > 1) detailsCache.set(id, { ts: Date.now(), data });
        res.json(data || {});
    } catch (e) {
        res.json({});
    }
});

// لیست پیشنهادی «امشب چی ببینم؟» با پوستر واقعی
app.get('/api/featured', async (req, res) => {
    const list = await Promise.all(CATALOG.map(async m => ({ ...m, poster: await resolvePosterWithin(m, 3500) })));
    res.set('Cache-Control', 'public, max-age=300');
    res.json(list);
});

/* ========================================================
   نمودار فعالیت روزانه (داشبورد)
   tz = getTimezoneOffset() مرورگر (دقیقه) تا روزها به وقت محلی کاربر شمرده شوند
======================================================== */
app.get('/api/activity', requireAuth, (req, res) => {
    const userId = Number(req.session.userId);
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 60);
    let tz = parseInt(req.query.tz, 10);
    if (!Number.isFinite(tz) || Math.abs(tz) > 840) tz = 0;

    const DAY_MS = 86400000;
    const nowLocal = Date.now() - tz * 60000;
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
        dates.push(new Date(nowLocal - i * DAY_MS).toISOString().slice(0, 10));
    }
    const since = Math.floor((Date.parse(dates[0] + 'T00:00:00Z') + tz * 60000) / 1000);

    db.all(
        `SELECT date(created_at - ? * 60, 'unixepoch') AS d, COUNT(*) AS n
         FROM activity_log WHERE user_id = ? AND created_at >= ? GROUP BY d`,
        [tz, userId, since],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const map = new Map((rows || []).map(r => [r.d, r.n]));
            const list = dates.map(date => ({ date, count: map.get(date) || 0 }));
            res.json({ days: list, total: list.reduce((sum, x) => sum + x.count, 0) });
        }
    );
});

/* ========================================================
   اجتماع: پست، عکس و ویدیو
======================================================== */
const COMMUNITY_DIR = path.join(__dirname, 'public', 'community_uploads');
fs.mkdirSync(COMMUNITY_DIR, { recursive: true });

const POST_MEDIA_TYPES = {
    'image/jpeg': { ext: 'jpg', kind: 'image' },
    'image/png': { ext: 'png', kind: 'image' },
    'image/webp': { ext: 'webp', kind: 'image' },
    'image/gif': { ext: 'gif', kind: 'image' },
    'video/mp4': { ext: 'mp4', kind: 'video' },
    'video/webm': { ext: 'webm', kind: 'video' },
    'video/quicktime': { ext: 'mov', kind: 'video' }
};
const POST_MAX_IMAGE = 8 * 1024 * 1024;
const POST_MAX_VIDEO = 50 * 1024 * 1024;

// فایل مستقیم روی دیسک ذخیره می‌شود (ویدیو در حافظه‌ی سرور نمی‌ماند)
const postUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, COMMUNITY_DIR),
        filename: (req, file, cb) => {
            const t = POST_MEDIA_TYPES[file.mimetype];
            cb(null, `p${req.session.userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${t.ext}`);
        }
    }),
    limits: { fileSize: POST_MAX_VIDEO, files: 1 },
    fileFilter(req, file, cb) {
        if (POST_MEDIA_TYPES[file.mimetype]) cb(null, true);
        else cb(new Error('BAD_TYPE'));
    }
});

const POST_SELECT = `
    SELECT p.id, p.user_id, u.username, u.avatar, p.body, p.media_url, p.media_type, p.created_at,
           (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS likes,
           EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
    FROM posts p JOIN users u ON u.id = p.user_id
`;

function removeCommunityFile(mediaUrl) {
    if (!mediaUrl) return;
    const file = path.join(COMMUNITY_DIR, path.basename(mediaUrl));
    fs.unlink(file, () => {});
}

app.get('/api/posts', requireAuth, (req, res) => {
    const myId = Number(req.session.userId);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 30);
    const before = parseInt(req.query.before, 10) || null;

    db.all(
        `${POST_SELECT} WHERE (? IS NULL OR p.id < ?) ORDER BY p.id DESC LIMIT ?`,
        [myId, before, before, limit + 1],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const hasMore = rows.length > limit;
            const posts = rows.slice(0, limit).map(r => ({ ...r, liked: !!r.liked }));
            res.json({ posts, hasMore });
        }
    );
});

app.post('/api/posts', requireAuth, (req, res) => {
    postUpload.single('media')(req, res, (uploadErr) => {
        if (uploadErr) {
            let msg = 'خطا در آپلود فایل.';
            if (uploadErr.code === 'LIMIT_FILE_SIZE') msg = 'حجم فایل بیش از حد مجاز است (ویدیو حداکثر ۵۰ و عکس حداکثر ۸ مگابایت).';
            else if (uploadErr.message === 'BAD_TYPE') msg = 'فقط عکس (JPG/PNG/WEBP/GIF) یا ویدیو (MP4/WEBM/MOV) مجاز است.';
            return res.status(400).json({ error: msg });
        }

        const userId = Number(req.session.userId);
        const body = String((req.body && req.body.body) || '').trim().slice(0, 1000);
        const file = req.file;
        const discardFile = () => { if (file) fs.unlink(file.path, () => {}); };

        if (!body && !file) return res.status(400).json({ error: 'متن یا فایلی برای انتشار وارد کنید.' });

        let mediaUrl = '';
        let mediaType = '';
        if (file) {
            const info = POST_MEDIA_TYPES[file.mimetype];
            if (info.kind === 'image' && file.size > POST_MAX_IMAGE) {
                discardFile();
                return res.status(400).json({ error: 'حجم عکس نباید بیشتر از ۸ مگابایت باشد.' });
            }
            mediaType = info.kind;
            mediaUrl = `/community_uploads/${file.filename}`;
        }

        db.run(
            "INSERT INTO posts (user_id, body, media_url, media_type) VALUES (?, ?, ?, ?)",
            [userId, body, mediaUrl, mediaType],
            function (err) {
                if (err) { discardFile(); return res.status(500).json({ error: 'خطا در ذخیره‌ی پست.' }); }
                logActivity(userId, 'post');
                db.get(`${POST_SELECT} WHERE p.id = ?`, [userId, this.lastID], (e, row) => {
                    if (e || !row) return res.status(500).json({ error: 'پست ذخیره شد ولی خوانده نشد.' });
                    res.json({ success: true, post: { ...row, liked: !!row.liked } });
                });
            }
        );
    });
});

app.post('/api/posts/:id/like', requireAuth, (req, res) => {
    const myId = Number(req.session.userId);
    const postId = Number(req.params.id);
    if (!postId) return res.status(400).json({ error: 'شناسه نامعتبر است.' });

    const respond = (liked) => {
        db.get("SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?", [postId], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ liked, likes: row ? row.n : 0 });
        });
    };

    db.get("SELECT id FROM posts WHERE id = ?", [postId], (err, post) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!post) return res.status(404).json({ error: 'پست پیدا نشد.' });

        db.run("INSERT OR IGNORE INTO post_likes (post_id, user_id) VALUES (?, ?)", [postId, myId], function (e) {
            if (e) return res.status(500).json({ error: e.message });
            if (this.changes > 0) {
                logActivity(myId, 'like');
                return respond(true);
            }
            // قبلاً پسندیده بود → برداشتن پسند
            db.run("DELETE FROM post_likes WHERE post_id = ? AND user_id = ?", [postId, myId], (e2) => {
                if (e2) return res.status(500).json({ error: e2.message });
                respond(false);
            });
        });
    });
});

app.delete('/api/posts/:id', requireAuth, (req, res) => {
    const myId = Number(req.session.userId);
    const postId = Number(req.params.id);
    db.get("SELECT media_url FROM posts WHERE id = ? AND user_id = ?", [postId, myId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'پست پیدا نشد.' });
        db.run("DELETE FROM posts WHERE id = ?", [postId], (e) => {
            if (e) return res.status(500).json({ error: e.message });
            db.run("DELETE FROM post_likes WHERE post_id = ?", [postId], () => {});
            removeCommunityFile(row.media_url);
            res.json({ success: true });
        });
    });
});

/* ========================================================
   لیست شخصی کاربر
======================================================== */
app.get('/api/movies', requireAuth, (req, res) => {
    const userId = Number(req.session.userId);
    db.all("SELECT * FROM my_movies WHERE user_id = ? ORDER BY id DESC", [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.post('/api/movies', requireAuth, (req, res) => {
    const userId = Number(req.session.userId);
    const b = req.body || {};
    const m_id = String(b.movie_id || b.movieId || b.id || '');
    const m_title = b.title || 'بدون عنوان';
    const m_poster = b.poster || b.image || '';
    const m_type = b.type || 'movie';
    const m_status = b.status || 'watched';
    const m_season = Number(b.season) || 0;
    const m_episode = Number(b.episode) || 0;
    const m_total_seasons = Number(b.total_seasons) || 0;
    const m_total_episodes = Number(b.total_episodes) || 0;
    const m_minute = Number(b.minute) || 0;
    const m_rating = Math.min(10, Math.max(0, Number(b.rating) || 0));
    const m_note = String(b.note || '');
    const m_genre = String(b.genre || '');
    const m_runtime = Number(b.runtime) || 0;
    const m_is_private = b.is_private ? 1 : 0;

    if (!m_id) return res.status(400).json({ error: 'شناسه فیلم معتبر نیست.' });

    const query = `
        INSERT INTO my_movies (user_id, movie_id, title, poster, type, status, season, episode, total_seasons, total_episodes, minute, rating, note, genre, runtime, is_private)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, movie_id) DO UPDATE SET
            title = excluded.title,
            poster = excluded.poster,
            type = excluded.type,
            status = excluded.status,
            season = excluded.season,
            episode = excluded.episode,
            total_seasons = excluded.total_seasons,
            total_episodes = excluded.total_episodes,
            minute = excluded.minute,
            rating = excluded.rating,
            note = excluded.note,
            genre = excluded.genre,
            runtime = excluded.runtime,
            is_private = excluded.is_private
    `;

    db.run(query, [userId, m_id, m_title, m_poster, m_type, m_status, m_season, m_episode, m_total_seasons, m_total_episodes, m_minute, m_rating, m_note, m_genre, m_runtime, m_is_private], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        logActivity(userId, 'movie');
        res.json({ success: true });
    });
});

app.delete('/api/movies/:id', requireAuth, (req, res) => {
    const userId = Number(req.session.userId);
    db.run("DELETE FROM my_movies WHERE user_id = ? AND movie_id = ?", [userId, req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes > 0) logActivity(userId, 'movie');
        res.json({ success: true });
    });
});

/* ========================================================
   چت زنده (Socket.IO)
======================================================== */
function notifyUser(userId, event, payload) {
    io.to(`user:${userId}`).emit(event, payload);
}

function getFriendIds(userId) {
    return new Promise((resolve) => {
        db.all(
            `SELECT (CASE WHEN requester_id = ? THEN receiver_id ELSE requester_id END) AS fid
             FROM friendships WHERE (requester_id = ? OR receiver_id = ?) AND status = 'accepted'`,
            [userId, userId, userId],
            (err, rows) => resolve(err ? [] : rows.map(r => r.fid))
        );
    });
}

io.use((socket, next) => {
    const req = socket.request;
    if (req.session && req.session.userId) return next();
    next(new Error('unauthorized'));
});

io.on('connection', async (socket) => {
    const userId = Number(socket.request.session.userId);
    socket.join(`user:${userId}`);

    const wasOffline = !onlineSockets.has(userId);
    if (!onlineSockets.has(userId)) onlineSockets.set(userId, new Set());
    onlineSockets.get(userId).add(socket.id);

    if (wasOffline) {
        const friendIds = await getFriendIds(userId);
        friendIds.forEach(fid => notifyUser(fid, 'presence:update', { userId, online: true }));
    }

    socket.on('chat:send', async (payload, ack) => {
        try {
            const receiverId = Number(payload && payload.receiverId);
            const type = (payload && payload.type === 'image') ? 'image' : 'text';
            let body = String((payload && payload.body) || '').trim().slice(0, 2000);
            if (type === 'image') {
                // برای پیام تصویری، body باید یک مسیر آپلودشده معتبر از سرور خودمان باشد
                if (!body.startsWith('/chat_uploads/')) return ack && ack({ error: 'پیام تصویری نامعتبر است.' });
            }
            if (!receiverId || !body) return ack && ack({ error: 'پیام نامعتبر است.' });

            const isFriend = await areFriends(userId, receiverId);
            if (!isFriend) return ack && ack({ error: 'فقط با دوستان می‌توانید گفتگو کنید.' });

            db.run(
                "INSERT INTO messages (sender_id, receiver_id, body, type) VALUES (?, ?, ?, ?)",
                [userId, receiverId, body, type],
                function (err) {
                    if (err) return ack && ack({ error: 'خطا در ارسال پیام.' });
                    logActivity(userId, 'chat');
                    const msg = { id: this.lastID, sender_id: userId, receiver_id: receiverId, body, type, created_at: Math.floor(Date.now() / 1000) };
                    io.to(`user:${receiverId}`).emit('chat:message', msg);
                    io.to(`user:${userId}`).emit('chat:message', msg);
                    ack && ack({ success: true, message: msg });
                }
            );
        } catch (e) {
            ack && ack({ error: 'خطای سرور.' });
        }
    });

    socket.on('chat:typing', (payload) => {
        const receiverId = Number(payload && payload.receiverId);
        if (receiverId) io.to(`user:${receiverId}`).emit('chat:typing', { userId });
    });

    socket.on('disconnect', async () => {
        const set = onlineSockets.get(userId);
        if (set) {
            set.delete(socket.id);
            if (!set.size) {
                onlineSockets.delete(userId);
                const friendIds = await getFriendIds(userId);
                friendIds.forEach(fid => notifyUser(fid, 'presence:update', { userId, online: false }));
            }
        }
    });
});

httpServer.listen(PORT, () => console.log(`سرور آماده است: http://localhost:${PORT}`));
