
import { Crypto, load, _ } from 'assets://js/lib/cat.js';

let HOST = 'https://www.cycani.org';
let token = '';                                    // 运行时自动登录获取，无需配置
let username = 'acsfreee';                         // 默认账号，可被 ext 覆盖
let password = 'zxc123qwe';
let playMode = 'direct';                           // direct(默认,直连) | redirect(本地代理302) | stream(本地代理转发)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_SIZE = 24;
const SECTION_PAGE_SIZE = 100;
const MAX_SECTION_PAGES = 50;
const PROXY_BASE = 'http://127.0.0.1:9978/proxy?do=js&';

const CLASSES = [
    { type_id: "1", type_name: "TV番组" },
    { type_id: "2", type_name: "剧场番组" }
];

// /api/video-zones 里混入的提示性文本，不是真实题材，需剔除
const TAG_PLACEHOLDERS = ['分类资源不代表全部资源'];

// 排序维度：/api/videos 的 order_by 参数
const ORDER_OPTIONS = [
    { n: '更新时间', v: 'update_time' },
    { n: '热度', v: 'hits' },
    { n: '评分', v: 'score' }
];

// ==================== 工具 ====================

function baseHeaders() {
    return {
        'User-Agent': UA,
        'Accept': 'application/json',
        'X-App-Name': 'cyc_web',
        'X-Time-Zone': 'Asia/Shanghai',
        'X-App-Version': 'cycweb',
        'Referer': HOST + '/',
        'Origin': HOST
    };
}

function playHeaders() {
    // 与 TvTFun.js 相同契约：FongMi 直连只要 UA + Referer + Origin，不要 format / #isVideo / 本地代理套娃
    return {
        'User-Agent': UA,
        'Referer': HOST + '/',
        'Origin': HOST
    };
}

function stripBearer(t) {
    const s = String(t || '');
    return s.startsWith('Bearer ') ? s.substring(7) : s;
}

function clean(text) {
    if (text === null || text === undefined) return '';
    let t = String(text);
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    t = t.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, e) => {
        if (entities[e] !== undefined) return entities[e];
        if (e[0] === '#') {
            const code = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.substring(2), 16) : parseInt(e.substring(1), 10);
            if (!isNaN(code) && code > 0 && code < 0x110000) { try { return String.fromCharCode(code); } catch (err) {} }
        }
        return all;
    });
    t = t.replace(/<[^>]+>/g, '').replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ');
    return t.trim();
}

function normalizePic(src) {
    if (!src) return '';
    const s = String(src);
    if (s.startsWith('//')) return 'https:' + s;
    if (s.startsWith('http')) return s;
    if (s.startsWith('/')) return HOST + s;
    return s;
}

// 网页卡片右上角评分：保留一位小数（7.2 / 7.0），无分或 0 分不展示
function formatScore(score) {
    if (score === undefined || score === null || score === '') return '';
    const n = Number(score);
    if (isNaN(n) || n <= 0) return '';
    return (Math.round(n * 10) / 10).toFixed(1);
}

// ==================== API 请求 ====================

async function apiReq(path, params, auth, tok, post, body) {
    let url = HOST + '/api' + path;
    if (params) {
        const qs = Object.keys(params)
            .filter(k => params[k] !== undefined && params[k] !== null)
            .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
        if (qs.length) url += '?' + qs.join('&');
    }
    const headers = baseHeaders();
    if (auth && tok) headers['Authorization'] = 'Bearer ' + stripBearer(tok);
    const opt = { headers, timeout: 15000 };
    if (post) {
        opt.method = 'POST';
        // 注意：cat.js / FongMi quickjs 的 req() 要求 data 传【对象】，
        // 框架(getJsonBody)会自动 JSON 序列化并设 Content-Type: application/json。
        // 千万不要传 JSON.stringify 后的字符串（会被框架二次加引号导致登录失败）。
        opt.data = (body !== undefined && body !== null) ? body : {};
    }
    try {
        const res = await req(url, opt);
        if (!res || !res.content) return null;
        const obj = JSON.parse(res.content);
        return (obj && typeof obj === 'object') ? obj : null;
    } catch (e) {
        return null;
    }
}

async function apiData(path, params, auth, tok, post, body) {
    const obj = await apiReq(path, params, auth, tok, post, body);
    return (obj && obj.code === 0) ? obj.data : null;
}

// ==================== token 自动登录 / 续期 ====================

function b64UrlDecode(input) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let s = String(input).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4 !== 0) s += '=';
    const bytes = [];
    let val = 0, bits = 0;
    for (let i = 0; i < s.length; i++) {
        const c = chars.indexOf(s[i]);
        if (c < 0) continue;
        val = (val << 6) | c;
        bits += 6;
        if (bits >= 8) { bits -= 8; bytes.push((val >> bits) & 0xFF); }
    }
    let out = '';
    for (let j = 0; j < bytes.length; ) {
        const b = bytes[j];
        if (b < 0x80) { out += String.fromCharCode(b); j += 1; }
        else if (b < 0xE0) { out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[j + 1] & 0x3F)); j += 2; }
        else if (b < 0xF0) { out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[j + 1] & 0x3F) << 6) | (bytes[j + 2] & 0x3F)); j += 3; }
        else {
            let cp = ((b & 0x07) << 18) | ((bytes[j + 1] & 0x3F) << 12) | ((bytes[j + 2] & 0x3F) << 6) | (bytes[j + 3] & 0x3F);
            cp -= 0x10000;
            out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
            j += 4;
        }
    }
    return out;
}

function jwtExp(tok) {
    try {
        const t = stripBearer(tok);
        const parts = t.split('.');
        if (parts.length < 2) return null;
        const payload = JSON.parse(b64UrlDecode(parts[1]));
        if (!payload || !payload.exp) return null;
        return Number(payload.exp) - Math.floor(Date.now() / 1000);
    } catch (e) {
        return null;
    }
}

async function doLogin() {
    if (!username || !password) return '';
    const obj = await apiReq('/auth/login', null, false, null, true, { username, password });
    if (!obj || obj.code !== 0) return '';
    return stripBearer((obj.data || {}).token || '');
}

async function refreshToken(tok) {
    const obj = await apiReq('/auth/refresh', null, true, tok, true, {});
    if (obj && obj.code === 0) {
        const t = stripBearer((obj.data || {}).token || '');
        if (t) return t;
    }
    return doLogin();
}

async function ensureToken() {
    if (!token) {
        const lt = await doLogin();
        if (lt) { token = lt; }
        return token;
    }
    const remain = jwtExp(token);
    if (remain !== null && remain > 86400) return token;
    const nt = await refreshToken(token);
    if (nt) token = nt;
    return token;
}

// ==================== 数据标准化 ====================

function buildItem(v) {
    if (!v) return null;
    const vid = (v.video_id !== undefined && v.video_id !== null) ? v.video_id : v.id;
    if (vid === undefined || vid === null) return null;
    const scoreText = formatScore(v.score);
    // 列表海报角标跟网页一致：右上角显示评分；无评分时回退到更新备注
    let remark = scoreText;
    if (!remark) {
        remark = v.remarks || '';
        if (!remark && v.total) remark = '更新至' + v.total + '集';
    }
    return {
        vod_id: String(vid),
        vod_name: clean(v.title || ''),
        vod_pic: normalizePic(v.cover_url || ''),
        vod_remarks: clean(remark),
        vod_score: scoreText
    };
}

function joinNames(arr) {
    if (!arr || !arr.length) return '';
    return arr.map(a => clean(a)).filter(s => s).join(', ');
}

// ==================== 接口实现 ====================

async function init(cfg) {
    token = '';
    username = 'acsfreee';
    password = 'zxc123qwe';
    playMode = 'direct';
    try {
        let ext = '';
        if (cfg && typeof cfg === 'object') ext = cfg.ext || '';
        else if (typeof cfg === 'string') ext = cfg;
        let obj = null;
        if (ext && typeof ext === 'object') obj = ext;
        else if (ext && typeof ext === 'string' && ext.trim().startsWith('{')) {
            try { obj = JSON.parse(ext); } catch (e) { obj = null; }
        }
        if (obj) {
            if (obj.token) token = stripBearer(obj.token);
            if (obj.username) username = String(obj.username).trim();
            if (obj.password) password = String(obj.password);
            if (obj.host) HOST = String(obj.host).replace(/\/+$/, '');
            if (obj.mode) {
                const m = String(obj.mode).toLowerCase();
                if (m === 'direct' || m === 'redirect' || m === 'proxy' || m === 'stream') {
                    playMode = (m === 'proxy') ? 'redirect' : m;
                }
            }
        } else if (ext && typeof ext === 'string' && ext.trim()) {
            token = stripBearer(ext.trim());
        }
    } catch (e) {}
    return '';
}

// 把站点返回的字符串数组转成筛选选项（首项为“全部”=空值）
function toFilterOptions(arr) {
    const out = [{ n: '全部', v: '' }];
    const seen = {};
    for (const raw of (arr || [])) {
        const s = String(raw === null || raw === undefined ? '' : raw).trim();
        if (!s || seen[s] || TAG_PLACEHOLDERS.indexOf(s) >= 0) continue;
        seen[s] = 1;
        out.push({ n: s, v: s });
    }
    return out;
}

// 依据分区 filters 构建 FongMi 筛选组：[{key,name,value:[{n,v}]}]
function buildFilterGroups(zone) {
    const f = (zone && zone.filters) || {};
    const groups = [];
    const cats = toFilterOptions(f.categories);
    if (cats.length > 1) groups.push({ key: 'tag', name: '题材', value: cats });
    const areas = toFilterOptions(f.areas);
    if (areas.length > 1) groups.push({ key: 'area', name: '地区', value: areas });
    const langs = toFilterOptions(f.languages);
    if (langs.length > 1) groups.push({ key: 'language', name: '语言', value: langs });
    const years = toFilterOptions(f.years);
    if (years.length > 1) groups.push({ key: 'year', name: '年份', value: years });
    groups.push({ key: 'order_by', name: '排序', value: ORDER_OPTIONS.slice() });
    return groups;
}

async function home(filter) {
    let classes = CLASSES;
    let filters = {};
    try {
        const data = await apiData('/video-zones');
        const zones = (data && data.list) ? data.list : [];
        const cls = [];
        const flt = {};
        for (const z of zones) {
            if (!z || z.id === undefined || z.id === null) continue;
            const tid = String(z.id);
            cls.push({ type_id: tid, type_name: clean(z.name || '') || ('分区' + tid) });
            flt[tid] = buildFilterGroups(z);
        }
        if (cls.length) { classes = cls; filters = flt; }
    } catch (e) {}
    return JSON.stringify({ class: classes, filters });
}

async function fetchRecommend() {
    const list = [];
    try {
        const data = await apiData('/index/recommend');
        if (data && data.list && data.list.length) {
            for (const sec of data.list) {
                for (const v of (sec.videos || [])) {
                    const item = buildItem(v);
                    if (item) list.push(item);
                }
            }
        }
    } catch (e) {}
    return list;
}

async function homeVod() {
    return JSON.stringify({ list: (await fetchRecommend()).slice(0, 30) });
}

async function category(tid, pg, filter, extend) {
    let page = parseInt(pg, 10);
    if (!page || page < 1) page = 1;
    const list = [];
    let total = 0;
    let ext = extend;
    if (typeof ext === 'string') {
        try { ext = JSON.parse(ext); } catch (e) { ext = null; }
    }
    if (!ext || typeof ext !== 'object') ext = {};
    const params = { zone_id: String(tid), page, page_size: PAGE_SIZE };
    // 筛选键与 /api/videos 参数同名：tag(题材) / area(地区) / language(语言) / year(年份) / order_by(排序)
    const FILTER_KEYS = ['tag', 'area', 'language', 'year', 'order_by'];
    for (const k of FILTER_KEYS) {
        const v = ext[k];
        if (v === undefined || v === null) continue;
        const s = String(v).trim();
        if (s) params[k] = s;
    }
    try {
        const data = await apiData('/videos', params);
        if (data) {
            for (const v of (data.list || [])) {
                const item = buildItem(v);
                if (item) list.push(item);
            }
            total = parseInt((data.pager || {}).total, 10) || 0;
        }
    } catch (e) {}
    const pagecount = total > 0 ? Math.ceil(total / PAGE_SIZE) : 1;
    return JSON.stringify({
        page, pagecount, limit: PAGE_SIZE, total, list
    });
}

async function search(wd, quick, pg) {
    // 兼容 search(wd, pg) 与 search(wd, quick, pg) 两种调用签名
    if (pg === undefined || pg === null) {
        if (typeof quick === 'number' || typeof quick === 'string') pg = quick;
    }
    let page = parseInt(pg, 10);
    if (!page || page < 1) page = 1;
    const list = [];
    let total = 0;
    const key = clean(wd);
    if (key) {
        try {
            const data = await apiData('/videos/search', { q: key, page, page_size: PAGE_SIZE });
            if (data) {
                for (const v of (data.list || [])) {
                    const item = buildItem(v);
                    if (item) list.push(item);
                }
                total = parseInt((data.pager || {}).total, 10) || 0;
            }
        } catch (e) {}
    }
    const pagecount = total > 0 ? Math.ceil(total / PAGE_SIZE) : 1;
    return JSON.stringify({
        page, pagecount, limit: PAGE_SIZE, total, list
    });
}

async function fetchSections(vid, playerCode) {
    const eps = [];
    let page = 1;
    while (page <= MAX_SECTION_PAGES) {
        const data = await apiData('/videos/' + vid + '/sections', {
            player_code: playerCode, page, page_size: SECTION_PAGE_SIZE
        });
        if (!data) break;
        const lst = data.list || [];
        for (const ep of lst) eps.push(ep);
        const total = parseInt((data.pager || {}).total, 10) || 0;
        if (!lst.length || page * SECTION_PAGE_SIZE >= total) break;
        page++;
    }
    return eps;
}

function pickId(id) {
    if (id === null || id === undefined) return '';
    if (typeof id === 'object' && id.length !== undefined) {
        return id.length > 0 ? String(id[0]) : '';
    }
    return String(id);
}

async function detail(id) {
    const vid = pickId(id);
    if (!vid) return JSON.stringify({ list: [] });
    const data = await apiData('/videos/' + vid);
    if (!data) return JSON.stringify({ list: [] });

    const vod = {
        vod_id: vid,
        vod_name: clean(data.title || ''),
        vod_pic: normalizePic(data.cover_url || ''),
        vod_year: (data.year !== undefined && data.year !== null && data.year !== '') ? String(data.year) : '',
        vod_area: clean(data.area || ''),
        vod_actor: joinNames(data.actor),
        vod_director: joinNames(data.director),
        vod_remarks: clean(data.remarks || ''),
        vod_content: clean(data.description || ''),
        vod_score: formatScore(data.score),
        vod_play_from: '',
        vod_play_url: ''
    };

    const playFrom = [];
    const playUrls = [];
    for (const line of (data.play_from || [])) {
        const code = line.code || '';
        const lineName = clean(line.title || '') || '默认线路';
        const eps = await fetchSections(vid, code);
        const parts = [];
        for (let i = 0; i < eps.length; i++) {
            const ep = eps[i] || {};
            if (ep.id === undefined || ep.id === null) continue;
            const epTitle = clean(ep.title || '') || ('第' + (i + 1) + '集');
            parts.push(epTitle + '$' + ep.id);
        }
        if (parts.length) {
            playFrom.push(lineName);
            playUrls.push(parts.join('#'));
        }
    }
    vod.vod_play_from = playFrom.join('$$$');
    vod.vod_play_url = playUrls.join('$$$');
    return JSON.stringify({ list: [vod] });
}

async function play(flag, id, flags) {
    const fallback = JSON.stringify({ parse: 1, url: '', header: playHeaders() });
    try {
        const sectionId = pickId(id).trim();
        if (!sectionId) return fallback;

        // vipFlags 里可能带 {"token":"..."} 配置，优先使用
        let tok = '';
        try {
            if (flags && flags.length) {
                for (const f of flags) {
                    if (f && typeof f === 'string' && f.trim().startsWith('{')) {
                        try {
                            const j = JSON.parse(f);
                            if (j && j.token) { tok = stripBearer(j.token); break; }
                        } catch (e) {}
                    }
                }
            }
        } catch (e) {}
        if (!tok) tok = await ensureToken();

        const path = '/v2/sections/' + sectionId + '/play-url';
        let obj = await apiReq(path, null, true, tok);
        let data = obj ? obj.data : null;

        // 401：token 失效，刷新后重试一次
        if (obj && obj.code === 401) {
            const nt = await refreshToken(tok);
            if (nt) {
                token = nt;
                obj = await apiReq(path, null, true, nt);
                data = obj ? obj.data : null;
            }
        }

        if (data && data.url) {
            const videoUrl = String(data.url).replace(/\\\//g, '/');
            if (playMode === 'direct') {
                return JSON.stringify({ parse: 0, url: videoUrl, header: playHeaders() });
            }
            return JSON.stringify({
                parse: 0,
                url: PROXY_BASE + 'url=' + encodeURIComponent(videoUrl) + '&ext=.mp4',
                header: playHeaders()
            });
        }
        return fallback;
    } catch (e) {
        return fallback;
    }
}

async function proxy(params) {
    try {
        let realUrl = '';
        if (params && typeof params === 'object') {
            if (params.url) realUrl = String(params.url);
            else {
                for (const k in params) {
                    const v = String(params[k] || '');
                    if (v.startsWith('http')) { realUrl = v; break; }
                }
            }
        } else if (typeof params === 'string' && params.startsWith('http')) {
            realUrl = params;
        }
        if (!realUrl.startsWith('http')) return [500, 'text/plain', 'bad proxy param'];
        if (playMode === 'stream') {
            const res = await req(realUrl, { headers: playHeaders(), buffer: 2 });
            if (!res || !res.content) return [502, 'text/plain', 'fetch failed'];
            return [200, 'video/mp4', res.content];
        }
        return [302, 'text/plain', '', { 'Location': realUrl }];
    } catch (e) {
        return [500, 'text/plain', 'proxy error'];
    }
}

// CDN 真实地址常是 .mp3 伪后缀的 MP4（Content-Type: video/mp4），必须按视频识别
function isVideo(url) {
    if (!url) return false;
    const u = String(url);
    if (u.indexOf('/proxy?do=js') >= 0) return true;
    if (u.indexOf('cycstream.com') >= 0) return true;
    if (u.indexOf('cycr2.top') >= 0 || u.indexOf('cycani.org') >= 0) return true;
    return /\.(mp4|m3u8|flv|mkv|avi|mov|webm|ts|mp3|mpd)(\?|#|$)/i.test(u);
}

function sniffer() {
    return false;
}

export function __jsEvalReturn() {
    return {
        init,
        home,
        homeVod,
        category,
        detail,
        search,
        play,
        proxy,
        isVideo,
        sniffer
    };
}
