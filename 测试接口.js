import { Crypto, load, _ } from 'assets://js/lib/cat.js';

let HOST = 'https://www.tvtfun.net';
let playMode = 'direct';                 // direct | proxy（本地 302 代理）

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_SIZE = 24;
const PROXY_BASE = 'http://127.0.0.1:9978/proxy?do=js&';

// 全局唯一的请求头对象（复用，不重复构造）
const H = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Referer': HOST + '/',
    'Origin': HOST
};

// 分类即排序维度：type_id 直接当 orderBy
const CLASSES = [
    { type_id: 'updatedAt', type_name: '最近更新' },
    { type_id: 'hits', type_name: '热门榜' },
    { type_id: 'score', type_name: '高分榜' }
];

const ORDER = [
    { n: '更新时间', v: 'updatedAt' },
    { n: '热度', v: 'hits' },
    { n: '评分', v: 'score' }
];

// ==================== 基础 ====================

function api(path) {
    return HOST + '/api' + path;
}

// 拼接 query（自动跳过空值）
function qs(params) {
    let out = '';
    for (const k in params) {
        const v = params[k];
        if (v === '' || v === undefined || v === null) continue;
        out += (out ? '&' : '?') + k + '=' + encodeURIComponent(v);
    }
    return out;
}

// GET /api/xxx → 返回 data 对象；无数据返回 null
async function get(path, params, headers) {
    const res = await req(api(path) + (params ? qs(params) : ''), { headers: headers || H, timeout: 15000 });
    if (!res || !res.content) return null;
    const obj = JSON.parse(res.content);
    return obj && obj.data ? obj.data : null;
}

// ==================== 列表 ====================

async function fetchList(params) {
    const data = await get('/videos', params);
    if (!data) return { list: [], total: 0 };
    const src = data.videos || [];
    const list = [];
    for (let i = 0; i < src.length; i++) {
        const v = src[i];
        list.push({
            vod_id: v.id,
            vod_name: v.name,
            vod_pic: v.pic,
            vod_remarks: v.remarks || ''
        });
    }
    return { list: list, total: data.total || 0 };
}

function pageObj(page, r) {
    return JSON.stringify({
        page: page,
        pagecount: r.total ? Math.ceil(r.total / PAGE_SIZE) : 1,
        limit: PAGE_SIZE,
        total: r.total,
        list: r.list
    });
}

// ==================== 接口实现 ====================

let cachedHome = '';

async function init(cfg) {
    HOST = 'https://www.tvtfun.net';
    playMode = 'direct';
    let ext = '';
    if (cfg && typeof cfg === 'object') ext = cfg.ext || '';
    else if (typeof cfg === 'string') ext = cfg;
    if (ext) {
        const o = (typeof ext === 'object') ? ext : JSON.parse(ext);
        if (o.host) HOST = String(o.host).replace(/\/+$/, '');
        if (o.mode === 'proxy' || o.mode === 'redirect') playMode = 'proxy';
    }
    H['Referer'] = HOST + '/';
    H['Origin'] = HOST;
    cachedHome = '';
    return '';
}

async function home() {
    if (cachedHome) return cachedHome;
    let filters = {};
    const st = await get('/settings');
    if (st) {
        const groups = [];
        const tag = opts(st.videoFilterTags);
        const year = opts(st.videoFilterYears);
        const area = opts(st.videoFilterAreas);
        if (tag.length > 1) groups.push({ key: 'tag', name: '题材', value: tag });
        if (year.length > 1) groups.push({ key: 'year', name: '年份', value: year });
        if (area.length > 1) groups.push({ key: 'area', name: '地区', value: area });
        groups.push({ key: 'order', name: '排序', value: ORDER });
        for (let i = 0; i < CLASSES.length; i++) filters[CLASSES[i].type_id] = groups;
    }
    cachedHome = JSON.stringify({ class: CLASSES, filters: filters });
    return cachedHome;
}

function opts(str) {
    const out = [{ n: '全部', v: '' }];
    if (!str) return out;
    const arr = String(str).split(',');
    for (let i = 0; i < arr.length; i++) {
        const s = arr[i].trim();
        if (s) out.push({ n: s, v: s });
    }
    return out;
}

async function homeVod() {
    const r = await fetchList({ page: 1, pageSize: 30, order: 'desc', orderBy: 'hits' });
    return JSON.stringify({ list: r.list });
}

async function category(tid, pg, filter, extend) {
    const e = extend ? (typeof extend === 'string' ? JSON.parse(extend) : extend) : {};
    const page = parseInt(pg, 10) || 1;
    const r = await fetchList({
        page: page,
        pageSize: PAGE_SIZE,
        order: 'desc',
        orderBy: e.order || tid || 'updatedAt',
        tag: e.tag,
        year: e.year,
        area: e.area
    });
    return pageObj(page, r);
}

async function search(wd, quick, pg) {
    if (pg === undefined || pg === null) pg = quick;
    const page = parseInt(pg, 10) || 1;
    const r = await fetchList({ page: page, pageSize: PAGE_SIZE, order: 'desc', orderBy: 'updatedAt', name: wd });
    return pageObj(page, r);
}

async function detail(id) {
    const vid = Array.isArray(id) ? id[0] : id;
    const d = await get('/videos/' + encodeURIComponent(vid));
    if (!d) return JSON.stringify({ list: [] });

    const from = [];
    const urls = [];
    const ps = d.playSources || [];
    for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        if (!p || p.openlistPath) continue;          // 网盘线路需登录，跳过
        const eps = p.episodes || [];
        const parts = [];
        for (let j = 0; j < eps.length; j++) {
            const ep = eps[j];
            if (!ep || !ep.id) continue;
            // 打包 episodeId|slug，play() 用 slug 先取播放券
            parts.push((ep.name || ('第' + (j + 1) + '集')) + '$' + ep.id + '|' + d.slug);
        }
        if (parts.length) {
            from.push(p.name || '默认线路');
            urls.push(parts.join('#'));
        }
    }

    return JSON.stringify({
        list: [{
            vod_id: vid,
            vod_name: d.name,
            vod_pic: d.pic,
            vod_year: d.year || '',
            vod_area: d.area || '',
            vod_actor: d.actor || '',
            vod_director: d.director || '',
            vod_remarks: d.remarks || '',
            vod_content: String(d.content || d.blurb || '').replace(/<[^>]+>/g, '').trim(),
            vod_score: d.score || '',
            vod_play_from: from.join('$$$'),
            vod_play_url: urls.join('$$$')
        }]
    });
}

// 同连接取券 + 解析（失败返回 null）
async function resolve(episodeId, slug) {
    // 1) 请求播放页，拿 tvt-pt 券
    const w = await req(HOST + '/video/' + slug + '/play?source=0&episode=0', { headers: H, timeout: 15000 });
    const raw = (w && w.headers) ? (w.headers['set-cookie'] || '') : '';
    const sc = Array.isArray(raw) ? raw.join(';') : String(raw);
    const i = sc.indexOf('tvt-pt=');
    const cookie = (i < 0) ? '' : sc.slice(i, sc.indexOf(';', i) < 0 ? sc.length : sc.indexOf(';', i));

    // 2) 同连接解析真实地址
    const headers = {
        'User-Agent': UA,
        'Accept': H['Accept'],
        'Referer': H['Referer'],
        'Origin': HOST
    };
    if (cookie) headers['Cookie'] = cookie;

    const res = await req(api('/videos/resolve-play-url') + qs({ episodeId: episodeId }), { headers: headers, timeout: 15000 });
    if (!res || !res.content) return null;
    const d = JSON.parse(res.content).data;
    if (!d || !d.url) return null;
    return { u: d.url.replace(/\\\//g, '/'), h: d.headers || H };
}

async function play(flag, id, flags) {
    const raw = Array.isArray(id) ? id[0] : id;
    const seg = String(raw || '').split('|');
    for (let i = 0; i < 2; i++) {
        const r = await resolve(seg[0], seg[1]);
        if (r) {
            if (playMode === 'direct') return JSON.stringify({ parse: 0, url: r.u, header: r.h });
            return JSON.stringify({ parse: 0, url: PROXY_BASE + 'url=' + encodeURIComponent(r.u) + '&ext=.mp4', header: r.h });
        }
    }
    return JSON.stringify({ parse: 1, url: '', header: H });
}

function proxy(params) {
    const u = (typeof params === 'string') ? params : (params && params.url);
    if (!u) return [404, 'text/plain', ''];
    return [302, 'text/plain', '', { 'Location': u }];
}

// 真实地址常为「无扩展名、以 / 结尾」的 CDN 直链，必须主动声明为视频
function isVideo(url) {
    if (!url) return false;
    const u = String(url);
    if (u.indexOf('/proxy?do=js') >= 0) return true;
    if (/\.(mp4|m3u8|flv|mkv|avi|mov|webm|ts)(\?|#|$)/i.test(u)) return true;
    return u.indexOf('topbuzzcdn') > 0 || u.indexOf('lemon8cdn') > 0;
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
