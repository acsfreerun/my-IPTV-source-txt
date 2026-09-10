/**
 * ═══════════════════════════════════════════════════════════════
 *   TvTFun 番剧源（FongMi / 影视仓 / CatVodOpen · cat.js）
 *   站点: https://www.tvtfun.net
 *   生成: 参照 CYC.js 成功经验 + 遮天法 v3.0 JS 规范
 * ═══════════════════════════════════════════════════════════════
 *
 *  【站点形态】Next.js(SSR/RSC) + Cloudflare，但暴露了干净的 JSON API：
 *    列表  GET /api/videos?page=&pageSize=&order=desc&orderBy=updatedAt|hits|score
 *                            &tag=&year=&area=&name=
 *    详情  GET /api/videos/{id}            （id 为 cuid，不是 slug！）
 *    配置  GET /api/settings               （题材/年份/地区 筛选项）
 *    解析  GET /api/videos/resolve-play-url?episodeId={episodeId}
 *
 *  【播放关键机制 · 已实测】
 *   1) 站点用 HttpOnly Cookie `tvt-pt` 做播放凭证，该 Cookie 由
 *      `/video/{slug}/play?source=&episode=` 页面下发；
 *   2) 该凭证与「同一条 TCP 连接」强绑定 —— 换连接即 403「播放凭证无效」。
 *      → 所以必须【先请求一次播放页拿券，紧接着在同一连接上解析】。
 *      FongMi 的 req() 走 OkHttp 连接池，同域顺序请求会复用连接，可满足；
 *      若仍 403，则重试（重取券 + 重解析）。
 *   3) `X-Play-Ctx` 头为 btoa({"f":帧数,"v":1,"w":宽,"hgt":高,"p":1})，
 *      实测服务端未严格校验，带上即可（缺省也能过）。
 *
 *  【数据契约】
 *    列表 {list, page, pagecount, limit, total}
 *    详情 {list:[{vod_play_from:'线路$$$线路', vod_play_url:'第1集$id#第2集$id'}]}
 *    播放 {parse:0, url, header:{User-Agent, Referer}}
 * ═══════════════════════════════════════════════════════════════
 */

import { Crypto, load, _ } from 'assets://js/lib/cat.js';

let HOST = 'https://www.tvtfun.net';
let playMode = 'direct';                 // direct(直连) | redirect(本地代理302) | stream(本地代理转发)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_SIZE = 24;
const MAX_RESOLVE_RETRY = 3;
const PROXY_BASE = 'http://127.0.0.1:9978/proxy?do=js&';

// 分类即排序维度：type_id 直接用作 orderBy
const CLASSES = [
    { type_id: 'updatedAt', type_name: '最近更新' },
    { type_id: 'hits', type_name: '热门榜' },
    { type_id: 'score', type_name: '高分榜' }
];

const ORDER_OPTIONS = [
    { n: '默认', v: '' },
    { n: '更新时间', v: 'updatedAt' },
    { n: '热度', v: 'hits' },
    { n: '评分', v: 'score' }
];

// ==================== 工具 ====================

function api(path) {
    return HOST + '/api' + path;
}

function pageHeaders(extra) {
    // ⚠️ 不要加 Accept-Language（站点 WAF 会直接 403「禁止访问」），也不要加奇怪的浏览器头
    const h = {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': HOST + '/',
        'Origin': HOST
    };
    if (extra) { for (const k in extra) h[k] = extra[k]; }
    return h;
}

function playHeaders(ref) {
    return {
        'User-Agent': UA,
        'Referer': ref || (HOST + '/'),
        'Origin': HOST
    };
}

function clean(text) {
    if (text === null || text === undefined) return '';
    let t = String(text);
    t = t.replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/\s+/g, ' ');
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

// QuickJS 环境可能没有 btoa，手写一份（输入为 ASCII JSON）
function b64(str) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const s = String(str);
    let out = '';
    let i = 0;
    while (i < s.length) {
        const c1 = s.charCodeAt(i++);
        const c2 = i < s.length ? s.charCodeAt(i++) : NaN;
        const c3 = i < s.length ? s.charCodeAt(i++) : NaN;
        const e1 = c1 >> 2;
        const e2 = ((c1 & 3) << 4) | (isNaN(c2) ? 0 : (c2 >> 4));
        const e3 = isNaN(c2) ? 64 : (((c2 & 15) << 2) | (isNaN(c3) ? 0 : (c3 >> 6)));
        const e4 = isNaN(c3) ? 64 : (c3 & 63);
        out += chars.charAt(e1) + chars.charAt(e2)
            + (e3 === 64 ? '=' : chars.charAt(e3))
            + (e4 === 64 ? '=' : chars.charAt(e4));
    }
    return out;
}

// 归一化 req() 返回：兼容 {code,headers,content} / JSON 字符串 / 纯文本
function normalizeRes(res) {
    if (res === null || res === undefined) return { status: 0, headers: {}, content: '' };
    if (typeof res === 'string') {
        const s = res.trim();
        if (s.startsWith('{') && s.indexOf('"content"') >= 0) {
            try { return normalizeRes(JSON.parse(s)); } catch (e) { /* 当纯文本 */ }
        }
        return { status: 200, headers: {}, content: res };
    }
    const status = Number(res.code || res.status || res.statusCode || 0);
    const headers = res.headers || {};
    let content = res.content;
    if (content === undefined || content === null) content = res.body || res.data || '';
    if (typeof content !== 'string') {
        try { content = JSON.stringify(content); } catch (e) { content = String(content); }
    }
    return { status, headers, content };
}

function getHeader(headers, name) {
    if (!headers) return '';
    const lower = name.toLowerCase();
    for (const k in headers) {
        if (String(k).toLowerCase() === lower) {
            const v = headers[k];
            return Array.isArray(v) ? v.join('; ') : String(v);
        }
    }
    return '';
}

function extractCookie(res, cookieName) {
    const raw = getHeader(res.headers, 'set-cookie');
    if (!raw) return '';
    const parts = raw.split(',');
    for (const p of parts) {
        const seg = p.split(';')[0].trim();
        if (seg.indexOf(cookieName + '=') === 0) return seg;
    }
    // 兜底：整串里找
    const i = raw.indexOf(cookieName + '=');
    if (i >= 0) {
        let seg = raw.substring(i);
        const end = seg.indexOf(';');
        if (end >= 0) seg = seg.substring(0, end);
        return seg.trim();
    }
    return '';
}

async function reqRaw(url, opt) {
    try {
        const res = await req(url, opt || {});
        return normalizeRes(res);
    } catch (e) {
        return { status: -1, headers: {}, content: '' };
    }
}

function buildQuery(params) {
    const qs = [];
    for (const k in params) {
        const v = params[k];
        if (v === undefined || v === null || v === '') continue;
        qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
    return qs.length ? ('?' + qs.join('&')) : '';
}

// ==================== 数据标准化 ====================

function buildItem(v) {
    if (!v || v.id === undefined || v.id === null) return null;
    return {
        vod_id: String(v.id),
        vod_name: clean(v.name || ''),
        vod_pic: normalizePic(v.pic || ''),
        vod_remarks: clean(v.remarks || '')
    };
}

function toOptions(arr) {
    const out = [{ n: '全部', v: '' }];
    const seen = {};
    for (const raw of (arr || [])) {
        const s = String(raw === null || raw === undefined ? '' : raw).trim();
        if (!s || seen[s]) continue;
        seen[s] = 1;
        out.push({ n: s, v: s });
    }
    return out;
}

function splitList(str) {
    if (!str) return [];
    return String(str).split(/[,，]/).map(s => s.trim()).filter(s => s);
}

// ==================== 接口实现 ====================

async function init(cfg) {
    HOST = 'https://www.tvtfun.net';
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
            if (obj.host) HOST = String(obj.host).replace(/\/+$/, '');
            if (obj.mode) {
                const m = String(obj.mode).toLowerCase();
                if (m === 'direct' || m === 'redirect' || m === 'proxy' || m === 'stream') {
                    playMode = (m === 'proxy') ? 'redirect' : m;
                }
            }
        }
    } catch (e) {}
    return '';
}

async function fetchSettings() {
    const res = await reqRaw(api('/settings') + buildQuery({}), { headers: pageHeaders(), timeout: 15000 });
    if (!res.content) return null;
    try {
        const obj = JSON.parse(res.content);
        return (obj && obj.data) ? obj.data : null;
    } catch (e) {
        return null;
    }
}

async function home(filter) {
    let filters = {};
    let classes = CLASSES;
    try {
        const st = await fetchSettings();
        if (st) {
            const tag = toOptions(splitList(st.videoFilterTags));
            const year = toOptions(splitList(st.videoFilterYears));
            const area = toOptions(splitList(st.videoFilterAreas));
            for (const c of CLASSES) {
                const groups = [];
                if (tag.length > 1) groups.push({ key: 'tag', name: '题材', value: tag });
                if (year.length > 1) groups.push({ key: 'year', name: '年份', value: year });
                if (area.length > 1) groups.push({ key: 'area', name: '地区', value: area });
                groups.push({ key: 'order', name: '排序', value: ORDER_OPTIONS.slice() });
                filters[c.type_id] = groups;
            }
            classes = CLASSES;
        }
    } catch (e) {}
    return JSON.stringify({ class: classes, filters });
}

async function listVideos(params) {
    const p = {
        page: params.page || 1,
        pageSize: params.pageSize || PAGE_SIZE,
        order: params.order || 'desc',
        orderBy: params.orderBy || 'updatedAt'
    };
    if (params.tag) p.tag = params.tag;
    if (params.year) p.year = params.year;
    if (params.area) p.area = params.area;
    if (params.name) p.name = params.name;

    const res = await reqRaw(api('/videos') + buildQuery(p), { headers: pageHeaders(), timeout: 15000 });
    if (!res.content) return { list: [], total: 0 };
    try {
        const obj = JSON.parse(res.content);
        const data = (obj && obj.data) ? obj.data : null;
        if (!data) return { list: [], total: 0 };
        const list = [];
        for (const v of (data.videos || [])) {
            const item = buildItem(v);
            if (item) list.push(item);
        }
        return { list: list, total: parseInt(data.total, 10) || 0 };
    } catch (e) {
        return { list: [], total: 0 };
    }
}

async function homeVod() {
    const r = await listVideos({ page: 1, pageSize: 30, order: 'desc', orderBy: 'hits' });
    return JSON.stringify({ list: r.list.slice(0, 30) });
}

async function category(tid, pg, filter, extend) {
    let page = parseInt(pg, 10);
    if (!page || page < 1) page = 1;
    let ext = extend;
    if (typeof ext === 'string') {
        try { ext = JSON.parse(ext); } catch (e) { ext = null; }
    }
    if (!ext || typeof ext !== 'object') ext = {};

    const orderBy = (ext.order && String(ext.order).trim()) ? String(ext.order).trim() : String(tid || 'updatedAt');
    const r = await listVideos({
        page: page,
        pageSize: PAGE_SIZE,
        order: 'desc',
        orderBy: orderBy,
        tag: ext.tag ? String(ext.tag).trim() : '',
        year: ext.year ? String(ext.year).trim() : '',
        area: ext.area ? String(ext.area).trim() : ''
    });
    const pagecount = r.total > 0 ? Math.ceil(r.total / PAGE_SIZE) : 1;
    return JSON.stringify({
        page: page,
        pagecount: pagecount,
        limit: PAGE_SIZE,
        total: r.total,
        list: r.list
    });
}

async function search(wd, quick, pg) {
    // 兼容 search(wd, pg) 与 search(wd, quick, pg)
    if (pg === undefined || pg === null) {
        if (typeof quick === 'number' || (typeof quick === 'string' && String(quick).trim().length)) pg = quick;
    }
    let page = parseInt(pg, 10);
    if (!page || page < 1) page = 1;
    const key = clean(wd);
    if (!key) return JSON.stringify({ page: page, pagecount: 1, limit: PAGE_SIZE, total: 0, list: [] });
    const r = await listVideos({ page: page, pageSize: PAGE_SIZE, order: 'desc', orderBy: 'updatedAt', name: key });
    const pagecount = r.total > 0 ? Math.ceil(r.total / PAGE_SIZE) : 1;
    return JSON.stringify({
        page: page,
        pagecount: pagecount,
        limit: PAGE_SIZE,
        total: r.total,
        list: r.list
    });
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
    const res = await reqRaw(api('/videos/' + encodeURIComponent(vid)), { headers: pageHeaders(), timeout: 15000 });
    if (!res.content) return JSON.stringify({ list: [] });
    let data = null;
    try {
        const obj = JSON.parse(res.content);
        data = (obj && obj.data) ? obj.data : null;
    } catch (e) { data = null; }
    if (!data) return JSON.stringify({ list: [] });

    const slug = data.slug || '';
    const vod = {
        vod_id: vid,
        vod_name: clean(data.name || ''),
        vod_pic: normalizePic(data.pic || ''),
        vod_year: (data.year !== undefined && data.year !== null && data.year !== '') ? String(data.year) : '',
        vod_area: clean(data.area || ''),
        vod_actor: clean(data.actor || ''),
        vod_director: clean(data.director || ''),
        vod_remarks: clean(data.remarks || ''),
        vod_content: clean(data.content || data.blurb || ''),
        vod_score: (data.score !== undefined && data.score !== null) ? String(data.score) : '',
        vod_play_from: '',
        vod_play_url: ''
    };

    const playFrom = [];
    const playUrls = [];
    for (const ps of (data.playSources || [])) {
        if (!ps) continue;
        // 跳过网盘线路（需登录且走 /api/openlist）
        if (ps.openlistPath) continue;
        const lineName = clean(ps.name || '') || '默认线路';
        const eps = ps.episodes || [];
        const parts = [];
        for (let i = 0; i < eps.length; i++) {
            const ep = eps[i] || {};
            if (ep.id === undefined || ep.id === null) continue;
            const epTitle = clean(ep.name || '') || ('第' + (i + 1) + '集');
            // 打包：episodeId|slug   —— play() 用 slug 先取播放凭证
            parts.push(epTitle + '$' + ep.id + '|' + slug);
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

// 先请求播放页拿 tvt-pt 凭证（Cookie 与连接绑定），再解析真实地址
async function resolvePlayUrl(episodeId, slug) {
    let cookie = '';
    // 1) 取券：请求播放页（下发 HttpOnly tvt-pt）
    if (slug) {
        const warmUrl = HOST + '/video/' + encodeURIComponent(slug) + '/play?source=0&episode=0';
        const warm = await reqRaw(warmUrl, {
            headers: {
                'User-Agent': UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Referer': HOST + '/'
            },
            timeout: 15000
        });
        cookie = extractCookie(warm, 'tvt-pt');
    }

    // 2) 解析（同一连接；FongMi/OkHttp 会复用连接池）
    const ctx = b64('{"f":200,"v":1,"w":1280,"hgt":720,"p":1}');
    const headers = pageHeaders({ 'X-Play-Ctx': ctx });
    if (cookie) headers['Cookie'] = cookie;

    const res = await reqRaw(api('/videos/resolve-play-url') + buildQuery({ episodeId: episodeId }), {
        headers: headers,
        timeout: 15000
    });
    if (!res.content) return null;
    let obj = null;
    try { obj = JSON.parse(res.content); } catch (e) { return null; }
    if (obj && obj.error) return { error: String(obj.error) };
    const data = obj ? obj.data : null;
    if (!data || !data.url) return null;
    if (data.type === 'login_required' || data.type === 'unavailable') {
        return { error: data.type };
    }
    return { data: data };
}

async function play(flag, id, flags) {
    const fallback = JSON.stringify({ parse: 1, url: '', header: playHeaders() });
    try {
        const raw = pickId(id).trim();
        if (!raw) return fallback;
        const seg = raw.split('|');
        const episodeId = (seg[0] || '').trim();
        const slug = (seg[1] || '').trim();
        if (!episodeId) return fallback;

        for (let attempt = 1; attempt <= MAX_RESOLVE_RETRY; attempt++) {
            const r = await resolvePlayUrl(episodeId, slug);
            if (r && r.data && r.data.url) {
                const videoUrl = String(r.data.url).replace(/\\\//g, '/');
                const hdr = (r.data.headers && typeof r.data.headers === 'object') ? r.data.headers : playHeaders();
                if (playMode === 'direct') {
                    return JSON.stringify({ parse: 0, url: videoUrl, header: hdr });
                }
                return JSON.stringify({
                    parse: 0,
                    url: PROXY_BASE + 'url=' + encodeURIComponent(videoUrl) + '&ext=.mp4',
                    header: hdr
                });
            }
            // 需要登录 / 源不可用：不再重试
            if (r && r.error && r.error !== 'unavailable') break;
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
            const r = normalizeRes(res);
            if (!r.content) return [502, 'text/plain', 'fetch failed'];
            return [200, 'video/mp4', r.content];
        }
        // redirect：302 跳真实地址
        return [302, 'text/plain', '', { 'Location': realUrl }];
    } catch (e) {
        return [500, 'text/plain', 'proxy error'];
    }
}

// 框架扩展：真实地址多为 CDN 直链 mp4，主动声明为视频，避免按后缀误判走嗅探
function isVideo(url) {
    if (!url) return false;
    const u = String(url);
    if (u.indexOf('/proxy?do=js') >= 0) return true;
    if (u.indexOf('lemon8cdn') > 0) return true;
    if (u.indexOf('tvtfun') > 0) return true;
    return /\.(mp4|m3u8|flv|mkv|avi|mov|webm|ts)(\?|#|$)/i.test(u);
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
