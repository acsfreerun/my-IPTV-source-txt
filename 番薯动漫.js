/**
 * ═══════════════════════════════════════════════════════════════
 *   番薯动漫（FongMi / 影视仓 / CatVodOpen · cat.js）
 *   站点: https://www.fsdm02.com/
 *   参照: CYC.js 契约 + 遮天法 v3.0 JS（多路径降级 / 前字秘提取）
 * ═══════════════════════════════════════════════════════════════
 *
 *  【站点形态】苹果 CMS（MacCMS）+ Cloudflare 盾
 *    本机/机房 IP 常被 JS Challenge 拦住；影视 App 走家庭/手机网
 *    多数情况下能直接打开。源内按优先级尝试：
 *      1) /api.php/provide/vod/     苹果 CMS JSON
 *      2) /api.php/app/             苹果 CMS App 接口
 *      3) HTML（mxpro / stui / myui 模板）
 *
 *  【播放】优先直链；否则打开 /vodplay/ 页抠 player_aaaa
 *         encrypt=1 Base64，encrypt=2 URL 解码
 *
 *  【数据契约】与 CYC.js 相同
 *    列表 {list, page, pagecount, limit, total}
 *    详情 {list:[{vod_play_from:'线路$$$线路', vod_play_url:'第1集$id#第2集$id'}]}
 *    播放 {parse:0, url, header:{User-Agent, Referer, Origin}}
 * ═══════════════════════════════════════════════════════════════
 */

import { Crypto, load, _ } from 'assets://js/lib/cat.js';

let HOST = 'https://www.fsdm02.com';
let playMode = 'direct';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_SIZE = 24;
const PROXY_BASE = 'http://127.0.0.1:9978/proxy?do=js&';

const FALLBACK_CLASSES = [
    { type_id: '1', type_name: '新番连载' },
    { type_id: '2', type_name: '完结动漫' },
    { type_id: '3', type_name: '剧场动画' },
    { type_id: '4', type_name: '特摄' }
];

const ORDER_OPTIONS = [
    { n: '时间', v: 'time' },
    { n: '人气', v: 'hits' },
    { n: '评分', v: 'score' }
];

const YEAR_OPTIONS = (function () {
    const out = [{ n: '全部', v: '' }];
    const now = new Date().getFullYear();
    for (let y = now; y >= 2000; y--) out.push({ n: String(y), v: String(y) });
    return out;
})();

const AREA_OPTIONS = [
    { n: '全部', v: '' },
    { n: '日本', v: '日本' },
    { n: '中国', v: '中国' },
    { n: '欧美', v: '欧美' },
    { n: '其他', v: '其他' }
];

// 运行时探测到的接口形态：provide | app | html
let apiKind = '';

// ==================== 工具 ====================

function baseHeaders(extra) {
    const h = {
        'User-Agent': UA,
        'Accept': 'text/html,application/json,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': HOST + '/',
        'Origin': HOST
    };
    if (extra) {
        for (const k in extra) h[k] = extra[k];
    }
    return h;
}

function playHeaders() {
    return {
        'User-Agent': UA,
        'Referer': HOST + '/',
        'Origin': HOST
    };
}

function jsonHeaders() {
    return baseHeaders({
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest'
    });
}

function clean(text) {
    if (text === null || text === undefined) return '';
    let t = String(text);
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    t = t.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, e) => {
        if (entities[e] !== undefined) return entities[e];
        if (e[0] === '#') {
            const code = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.substring(2), 16) : parseInt(e.substring(1), 10);
            if (!isNaN(code) && code > 0 && code < 0x110000) {
                try { return String.fromCharCode(code); } catch (err) {}
            }
        }
        return all;
    });
    t = t.replace(/<[^>]+>/g, '').replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ');
    return t.trim();
}

function absUrl(src) {
    if (!src) return '';
    let s = String(src).trim().replace(/\\\//g, '/');
    if (!s) return '';
    if (s.startsWith('//')) return 'https:' + s;
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('/')) return HOST + s;
    return HOST + '/' + s;
}

function normalizePic(src) {
    return absUrl(src);
}

function pickId(id) {
    if (id === null || id === undefined) return '';
    if (typeof id === 'object' && id.length !== undefined) {
        return id.length > 0 ? String(id[0]) : '';
    }
    return String(id);
}

function isCfChallenge(html) {
    if (!html) return false;
    const t = String(html);
    return t.indexOf('Just a moment') >= 0
        || t.indexOf('请稍候') >= 0
        || t.indexOf('cf-mitigated') >= 0
        || t.indexOf('challenge-platform') >= 0
        || t.indexOf('cdn-cgi/challenge') >= 0;
}

function isVideoUrl(url) {
    if (!url) return false;
    const u = String(url);
    if (/\.(m3u8|mp4|flv|mkv|avi|mov|webm|ts|mpd|mp3)(\?|#|$)/i.test(u)) return true;
    if (u.indexOf('.m3u8') >= 0 || u.indexOf('.mp4') >= 0) return true;
    return false;
}

function normalizeRes(res) {
    if (res === null || res === undefined) return { status: 0, headers: {}, content: '' };
    if (typeof res === 'string') {
        const s = res.trim();
        if (s.startsWith('{') && s.indexOf('"content"') >= 0) {
            try { return normalizeRes(JSON.parse(s)); } catch (e) {}
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

async function httpGet(url, jsonPref) {
    const headers = jsonPref ? jsonHeaders() : baseHeaders();
    try {
        const res = normalizeRes(await req(url, { headers, timeout: 15000 }));
        const html = res.content || '';
        if (isCfChallenge(html)) return { status: 403, content: '', blocked: true };
        return { status: res.status || 200, content: html, blocked: false };
    } catch (e) {
        return { status: 0, content: '', blocked: false };
    }
}

function parseJson(text) {
    if (!text) return null;
    const s = String(text).trim();
    if (!s) return null;
    const start = s.indexOf('{') >= 0 && (s.indexOf('[') < 0 || s.indexOf('{') < s.indexOf('['))
        ? s.indexOf('{') : s.indexOf('[');
    if (start < 0) return null;
    try { return JSON.parse(s.substring(start)); } catch (e) { return null; }
}

function apiOk(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj.code === undefined || obj.code === null) {
        return !!(obj.list || obj.data || obj.class);
    }
    const c = Number(obj.code);
    return c === 1 || c === 200 || c === 0;
}

function unwrapList(obj) {
    if (!obj) return [];
    if (Array.isArray(obj.list)) return obj.list;
    if (obj.data && Array.isArray(obj.data.list)) return obj.data.list;
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.class)) return obj.class;
    return [];
}

function b64decode(input) {
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
        if (bits >= 8) {
            bits -= 8;
            bytes.push((val >> bits) & 0xFF);
        }
    }
    let out = '';
    for (let j = 0; j < bytes.length;) {
        const b = bytes[j];
        if (b < 0x80) { out += String.fromCharCode(b); j += 1; }
        else if (b < 0xE0 && j + 1 < bytes.length) {
            out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[j + 1] & 0x3F));
            j += 2;
        } else if (b < 0xF0 && j + 2 < bytes.length) {
            out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[j + 1] & 0x3F) << 6) | (bytes[j + 2] & 0x3F));
            j += 3;
        } else if (j + 3 < bytes.length) {
            let cp = ((b & 0x07) << 18) | ((bytes[j + 1] & 0x3F) << 12) | ((bytes[j + 2] & 0x3F) << 6) | (bytes[j + 3] & 0x3F);
            cp -= 0x10000;
            out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
            j += 4;
        } else break;
    }
    return out;
}

function macDecrypt(url, encrypt) {
    let u = String(url || '').replace(/\\\//g, '/');
    const n = Number(encrypt || 0);
    try {
        if (n === 1) u = unescape(b64decode(u));
        else if (n === 2) u = unescape(u);
    } catch (e) {}
    return u.replace(/\\\//g, '/');
}

function buildItem(v) {
    if (!v) return null;
    const vid = (v.vod_id !== undefined && v.vod_id !== null) ? v.vod_id : (v.id !== undefined ? v.id : v.video_id);
    if (vid === undefined || vid === null || vid === '') return null;
    return {
        vod_id: String(vid),
        vod_name: clean(v.vod_name || v.name || v.title || ''),
        vod_pic: normalizePic(v.vod_pic || v.pic || v.cover || v.img || ''),
        vod_remarks: clean(v.vod_remarks || v.remarks || v.note || v.continu || v.msg || '')
    };
}

function emptyPage(page) {
    return JSON.stringify({ page: page || 1, pagecount: 1, limit: PAGE_SIZE, total: 0, list: [] });
}

function pageResult(page, total, list, limit) {
    const lim = limit || PAGE_SIZE;
    const tot = parseInt(total, 10) || list.length;
    const pagecount = tot > 0 ? Math.ceil(tot / lim) : (list.length ? page : 1);
    return JSON.stringify({
        page, pagecount: pagecount || 1, limit: lim, total: tot, list
    });
}

function asExt(extend) {
    let ext = extend;
    if (typeof ext === 'string') {
        try { ext = JSON.parse(ext); } catch (e) { ext = null; }
    }
    if (!ext || typeof ext !== 'object') ext = {};
    return ext;
}

function defaultFilters() {
    const groups = [
        { key: 'by', name: '排序', value: ORDER_OPTIONS.slice() },
        { key: 'year', name: '年份', value: YEAR_OPTIONS.slice() },
        { key: 'area', name: '地区', value: AREA_OPTIONS.slice() }
    ];
    const filters = {};
    for (let i = 0; i < FALLBACK_CLASSES.length; i++) {
        filters[FALLBACK_CLASSES[i].type_id] = groups;
    }
    return filters;
}

// ==================== API ====================

function provideUrl(params) {
    const qs = [];
    for (const k in params) {
        if (params[k] === undefined || params[k] === null || params[k] === '') continue;
        qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
    return HOST + '/api.php/provide/vod/?' + qs.join('&');
}

async function fetchProvide(params) {
    const urls = [
        provideUrl(params),
        HOST + '/api.php/provide/vod/at/json/?' + Object.keys(params)
            .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
            .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
            .join('&')
    ];
    for (let i = 0; i < urls.length; i++) {
        const r = await httpGet(urls[i], true);
        if (r.blocked || !r.content) continue;
        const obj = parseJson(r.content);
        if (apiOk(obj)) return obj;
    }
    return null;
}

async function fetchApp(path, params) {
    let url = HOST + '/api.php/app/' + path.replace(/^\//, '');
    const qs = [];
    if (params) {
        for (const k in params) {
            if (params[k] === undefined || params[k] === null || params[k] === '') continue;
            qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
        }
    }
    if (qs.length) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs.join('&');
    const r = await httpGet(url, true);
    if (r.blocked || !r.content) return null;
    const obj = parseJson(r.content);
    return apiOk(obj) ? obj : null;
}

async function detectKind() {
    if (apiKind) return apiKind;
    try {
        const p = await fetchProvide({ ac: 'list' });
        if (p && (unwrapList(p).length || (p.class && p.class.length))) {
            apiKind = 'provide';
            return apiKind;
        }
    } catch (e) {}
    try {
        const a = await fetchApp('nav', {});
        if (a && unwrapList(a).length) {
            apiKind = 'app';
            return apiKind;
        }
    } catch (e) {}
    apiKind = 'html';
    return apiKind;
}

// ==================== HTML 解析（斗字秘） ====================

function cheerio(html) {
    try {
        if (typeof load === 'function') return load(html);
    } catch (e) {}
    return null;
}

function attrPic($el) {
    if (!$el || !$el.length) return '';
    return $el.attr('data-original') || $el.attr('data-src') || $el.attr('data-pic')
        || $el.attr('src') || $el.attr('data-bg') || '';
}

function hrefId(href) {
    if (!href) return '';
    const h = String(href).trim();
    let m = h.match(/\/voddetail\/([^\/.?#]+)/i)
        || h.match(/\/video\/([^\/.?#]+)/i)
        || h.match(/\/detail\/([^\/.?#]+)/i)
        || h.match(/\/bangumi\/([^\/.?#]+)/i)
        || h.match(/[?&]id=(\d+)/i)
        || h.match(/\/id\/(\d+)/i);
    if (m) return m[1].replace(/\.html$/i, '');
    if (/^https?:\/\//i.test(h) || h.startsWith('/')) return h;
    return '';
}

function parseListHtml(html) {
    const list = [];
    const $ = cheerio(html);
    if ($) {
        const selectors = [
            '.module-items .module-item',
            '.module-item',
            '.stui-vodlist__box',
            '.stui-vodlist li',
            '.myui-vodlist__box',
            '.myui-vodlist li',
            '.pack-packcover',
            '.hl-vod-list li',
            '.vodlist li',
            'a.vodlist_thumb',
            '.video-item',
            '.list-item'
        ];
        let nodes = null;
        for (let i = 0; i < selectors.length; i++) {
            const n = $(selectors[i]);
            if (n && n.length) { nodes = n; break; }
        }
        if (nodes) {
            nodes.each((i, el) => {
                const box = $(el);
                let a = box.find('a[href*="voddetail"], a[href*="/video/"], a[href*="/detail/"]').first();
                if (!a || !a.length) a = box.is('a') ? box : box.find('a').first();
                if (!a || !a.length) return;
                const href = a.attr('href') || '';
                const vid = hrefId(href);
                if (!vid) return;
                const name = clean(a.attr('title') || box.find('.module-item-title, .module-card-item-title, h3, .title, .vodlist_title').first().text() || a.text());
                let pic = attrPic(box.find('img').first()) || a.attr('data-original') || '';
                const remark = clean(
                    box.find('.module-item-note, .module-item-text, .pic-text, .pic_text, .hl-pic-text, .pack-prb, .note').first().text()
                );
                if (!name) return;
                list.push({
                    vod_id: vid,
                    vod_name: name,
                    vod_pic: normalizePic(pic),
                    vod_remarks: remark
                });
            });
        }
    }
    if (list.length) return list;

    // 正则兜底
    const re = /href="([^"]*?(?:voddetail|\/video\/|\/detail\/)[^"]+)"[^>]*?(?:title="([^"]+)")?[\s\S]{0,400}?(?:data-original|data-src|src)="([^"]+)"/gi;
    let m;
    const seen = {};
    while ((m = re.exec(html)) !== null) {
        const vid = hrefId(m[1]);
        if (!vid || seen[vid]) continue;
        seen[vid] = 1;
        list.push({
            vod_id: vid,
            vod_name: clean(m[2] || ''),
            vod_pic: normalizePic(m[3] || ''),
            vod_remarks: ''
        });
    }
    return list;
}

function parseNavClasses(html) {
    const cls = [];
    const seen = {};
    const $ = cheerio(html);
    if ($) {
        $('a[href*="vodtype"], a[href*="vodshow"], a[href*="/type/"]').each((i, el) => {
            const a = $(el);
            const href = a.attr('href') || '';
            const name = clean(a.text());
            const m = href.match(/\/(?:vodtype|vodshow|type)\/(\w+)/i);
            if (!m || !name) return;
            const tid = m[1].replace(/\.html$/i, '').split('-')[0];
            if (!tid || seen[tid] || name.length > 12) return;
            if (/首页|APP|周表|排行|专题|留言|求片/.test(name)) return;
            seen[tid] = 1;
            cls.push({ type_id: tid, type_name: name });
        });
    }
    if (cls.length) return cls;
    const re = /href="[^"]*\/(?:vodtype|vodshow|type)\/(\w+)[^"]*"[^>]*>([^<]+)</gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const tid = m[1].replace(/\.html$/i, '').split('-')[0];
        const name = clean(m[2]);
        if (!tid || seen[tid] || !name || name.length > 12) continue;
        if (/首页|APP|周表|排行|专题|留言|求片/.test(name)) continue;
        seen[tid] = 1;
        cls.push({ type_id: tid, type_name: name });
    }
    return cls;
}

function parseDetailHtml(html, vid) {
    const $ = cheerio(html);
    const vod = {
        vod_id: vid,
        vod_name: '',
        vod_pic: '',
        vod_year: '',
        vod_area: '',
        vod_actor: '',
        vod_director: '',
        vod_remarks: '',
        vod_content: '',
        vod_play_from: '',
        vod_play_url: ''
    };
    if ($) {
        vod.vod_name = clean($('h1').first().text() || $('.module-info-heading h1, .stui-content__detail h1, .myui-content__detail h1').first().text());
        vod.vod_pic = normalizePic(attrPic($('.module-info-poster img, .stui-content__thumb img, .myui-content__thumb img, .lazyload').first()));
        vod.vod_content = clean($('.module-info-introduction, .stui-content__desc, .sketch, .desc, .content_desc').first().text());
        const infoText = clean($('.module-info-item, .stui-content__detail, .myui-content__detail').text());
        const yearM = infoText.match(/(?:年份|上映|年代)[:：]?\s*(\d{4})/);
        if (yearM) vod.vod_year = yearM[1];
        const areaM = infoText.match(/(?:地区|国家)[:：]?\s*([^\s/]+)/);
        if (areaM) vod.vod_area = clean(areaM[1]);
        const actorM = infoText.match(/(?:主演|演员)[:：]\s*([^\n]+)/);
        if (actorM) vod.vod_actor = clean(actorM[1]).slice(0, 80);
        const dirM = infoText.match(/(?:导演)[:：]\s*([^\n]+)/);
        if (dirM) vod.vod_director = clean(dirM[1]).slice(0, 80);
        vod.vod_remarks = clean($('.module-info-tag, .pic-text, .module-item-note').first().text());
    } else {
        const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        if (h1) vod.vod_name = clean(h1[1]);
    }

    const playFrom = [];
    const playUrls = [];

    if ($) {
        const tabSels = ['.module-tab-item', '.stui-pannel__head .nav-tabs li', '.myui-panel__head .nav-tabs li', '.hl-tabs-btn', '.play-source a', '[data-dropdown-value]'];
        const listSels = ['.module-play-list', '.stui-content__playlist', '.myui-content__list', '.hl-plays-list', '.play-list'];
        let tabs = null;
        for (let i = 0; i < tabSels.length; i++) {
            const n = $(tabSels[i]);
            if (n && n.length) { tabs = n; break; }
        }
        let lists = null;
        for (let i = 0; i < listSels.length; i++) {
            const n = $(listSels[i]);
            if (n && n.length) { lists = n; break; }
        }
        if (lists && lists.length) {
            lists.each((i, el) => {
                const box = $(el);
                let lineName = '线路' + (i + 1);
                if (tabs && tabs.length > i) {
                    lineName = clean($(tabs[i]).text()) || lineName;
                }
                const parts = [];
                box.find('a').each((j, ael) => {
                    const a = $(ael);
                    const href = a.attr('href') || '';
                    if (!href || href === '#' || href.indexOf('javascript') >= 0) return;
                    const title = clean(a.text()) || ('第' + (j + 1) + '集');
                    const pid = hrefId(href) ? absUrl(href) : absUrl(href);
                    parts.push(title + '$' + pid);
                });
                if (parts.length) {
                    playFrom.push(lineName);
                    playUrls.push(parts.join('#'));
                }
            });
        }
    }

    if (!playUrls.length) {
        const re = /href="([^"]*vodplay[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        const buckets = {};
        let m;
        while ((m = re.exec(html)) !== null) {
            const href = m[1];
            const title = clean(m[2]) || '正片';
            const sidM = href.match(/vodplay\/[^\/-]+-(\d+)-/i) || href.match(/sid[=\/](\d+)/i);
            const sid = sidM ? sidM[1] : '1';
            if (!buckets[sid]) buckets[sid] = [];
            buckets[sid].push(title + '$' + absUrl(href));
        }
        const sids = Object.keys(buckets);
        for (let i = 0; i < sids.length; i++) {
            playFrom.push('线路' + sids[i]);
            playUrls.push(buckets[sids[i]].join('#'));
        }
    }

    vod.vod_play_from = playFrom.join('$$$');
    vod.vod_play_url = playUrls.join('$$$');
    return vod;
}

function extractPlayer(html) {
    if (!html) return '';
    let m = html.match(/player_aaaa\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i)
        || html.match(/player_aaaa\s*=\s*(\{[\s\S]*?\});/)
        || html.match(/player_\w+\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i);
    if (m) {
        try {
            const data = JSON.parse(m[1]);
            if (data && data.url) {
                return macDecrypt(data.url, data.encrypt);
            }
        } catch (e) {}
    }
    const layers = [
        /<video[^>]+src=['"]([^'"]+)['"]/i,
        /<source[^>]+src=['"]([^'"]+)['"]/i,
        /initPlayer\(\s*'[^']*'\s*,\s*'([^']+)'/i,
        /playurl\s*=\s*['"]([^'"]+)['"]/i,
        /(?:var\s+)?(?:video_)?url\s*=\s*['"]([^'"]+)['"]/i,
        /(https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*)/i,
        /(https?:\/\/[^\s"'<>\\]+?\.mp4[^\s"'<>\\]*)/i
    ];
    for (let i = 0; i < layers.length; i++) {
        const mm = html.match(layers[i]);
        if (mm && mm[1]) {
            const u = String(mm[1]).replace(/\\\//g, '/').trim();
            if (/^https?:\/\//i.test(u) || u.indexOf('.m3u8') >= 0 || u.indexOf('.mp4') >= 0) return u;
        }
    }
    const iframe = html.match(/<iframe[^>]+src=['"]([^'"]+)['"]/i);
    if (iframe && iframe[1]) return absUrl(iframe[1]);
    return '';
}

function showUrl(tid, pg, ext) {
    const parts = [
        String(tid || '1'),
        ext.area || '',
        ext.by || '',
        ext['class'] || ext.cate || '',
        ext.lang || '',
        ext.letter || '',
        '',
        '',
        String(pg || 1),
        '',
        ext.year || ''
    ];
    return HOST + '/vodshow/' + parts.join('-') + '.html';
}

function typeUrl(tid, pg) {
    if (Number(pg) <= 1) return HOST + '/vodtype/' + tid + '.html';
    return HOST + '/vodtype/' + tid + '-' + pg + '.html';
}

function searchUrl(wd, pg) {
    return HOST + '/vodsearch/' + encodeURIComponent(wd) + '----------' + pg + '---.html';
}

function detailUrl(vid) {
    const id = String(vid || '');
    if (/^https?:\/\//i.test(id)) return id;
    if (id.startsWith('/')) return HOST + id;
    if (/voddetail|vodplay|\/video\//i.test(id)) return absUrl(id);
    return HOST + '/voddetail/' + id + '.html';
}

function playPageUrl(id) {
    const s = String(id || '');
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('/')) return HOST + s;
    if (/vodplay/i.test(s)) return absUrl(s);
    return HOST + '/vodplay/' + s + '.html';
}

// ==================== 接口实现 ====================

async function init(cfg) {
    apiKind = '';
    playMode = 'direct';
    HOST = 'https://www.fsdm02.com';
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

async function home(filter) {
    let classes = FALLBACK_CLASSES.slice();
    let filters = defaultFilters();
    try {
        const kind = await detectKind();
        if (kind === 'provide') {
            const obj = await fetchProvide({ ac: 'list' });
            const nav = (obj && obj.class) ? obj.class : [];
            const cls = [];
            const flt = {};
            for (let i = 0; i < nav.length; i++) {
                const c = nav[i];
                if (!c) continue;
                const tid = String(c.type_id !== undefined ? c.type_id : c.id);
                const name = clean(c.type_name || c.name || '');
                if (!tid || !name) continue;
                cls.push({ type_id: tid, type_name: name });
                flt[tid] = defaultFilters()[FALLBACK_CLASSES[0].type_id];
            }
            if (cls.length) { classes = cls; filters = flt; }
        } else if (kind === 'app') {
            const obj = await fetchApp('nav', {});
            const nav = unwrapList(obj);
            const cls = [];
            const flt = {};
            for (let i = 0; i < nav.length; i++) {
                const c = nav[i];
                if (!c) continue;
                const tid = String(c.type_id !== undefined ? c.type_id : c.id);
                const name = clean(c.type_name || c.name || '');
                if (!tid || !name) continue;
                cls.push({ type_id: tid, type_name: name });
                flt[tid] = defaultFilters()[FALLBACK_CLASSES[0].type_id];
            }
            if (cls.length) { classes = cls; filters = flt; }
        } else {
            const r = await httpGet(HOST + '/', false);
            if (r.content && !r.blocked) {
                const nav = parseNavClasses(r.content);
                if (nav.length) {
                    classes = nav;
                    const flt = {};
                    for (let i = 0; i < nav.length; i++) flt[nav[i].type_id] = defaultFilters()[FALLBACK_CLASSES[0].type_id];
                    filters = flt;
                }
            }
        }
    } catch (e) {}
    return JSON.stringify({ class: classes, filters });
}

async function homeVod() {
    const list = [];
    try {
        const kind = await detectKind();
        if (kind === 'provide') {
            const obj = await fetchProvide({ ac: 'detail', pg: 1 });
            const arr = unwrapList(obj);
            for (let i = 0; i < arr.length && list.length < 30; i++) {
                const it = buildItem(arr[i]);
                if (it) list.push(it);
            }
        } else if (kind === 'app') {
            const obj = await fetchApp('video', { tid: '1', pg: 1, limit: 24 });
            const arr = unwrapList(obj);
            for (let i = 0; i < arr.length && list.length < 30; i++) {
                const it = buildItem(arr[i]);
                if (it) list.push(it);
            }
        }
        if (!list.length) {
            const r = await httpGet(HOST + '/', false);
            if (r.content && !r.blocked) {
                const arr = parseListHtml(r.content);
                for (let i = 0; i < arr.length && list.length < 30; i++) list.push(arr[i]);
            }
        }
    } catch (e) {}
    return JSON.stringify({ list });
}

async function category(tid, pg, filter, extend) {
    let page = parseInt(pg, 10);
    if (!page || page < 1) page = 1;
    const ext = asExt(extend);
    const list = [];
    let total = 0;
    try {
        const kind = await detectKind();
        if (kind === 'provide') {
            const params = { ac: 'detail', t: String(tid), pg: page };
            if (ext.year) params.year = ext.year;
            if (ext.area) params.area = ext.area;
            const obj = await fetchProvide(params);
            if (obj) {
                const arr = unwrapList(obj);
                for (let i = 0; i < arr.length; i++) {
                    const it = buildItem(arr[i]);
                    if (it) list.push(it);
                }
                total = parseInt(obj.total, 10) || 0;
                const pc = parseInt(obj.pagecount, 10) || 0;
                if (!total && pc) total = pc * PAGE_SIZE;
                if (list.length) return pageResult(page, total || list.length, list, parseInt(obj.limit, 10) || PAGE_SIZE);
            }
        } else if (kind === 'app') {
            const params = { tid: String(tid), pg: page, limit: PAGE_SIZE };
            if (ext.year) params.year = ext.year;
            if (ext.area) params.area = ext.area;
            if (ext.by) params.by = ext.by;
            const obj = await fetchApp('video', params);
            if (obj) {
                const arr = unwrapList(obj);
                for (let i = 0; i < arr.length; i++) {
                    const it = buildItem(arr[i]);
                    if (it) list.push(it);
                }
                const pager = obj.page || obj;
                total = parseInt(pager.total || obj.total, 10) || 0;
                if (list.length) return pageResult(page, total || list.length, list);
            }
        }

        const urls = [showUrl(tid, page, ext), typeUrl(tid, page)];
        for (let i = 0; i < urls.length && !list.length; i++) {
            const r = await httpGet(urls[i], false);
            if (!r.content || r.blocked) continue;
            const arr = parseListHtml(r.content);
            for (let j = 0; j < arr.length; j++) list.push(arr[j]);
        }
        total = list.length ? (page * PAGE_SIZE + (list.length >= PAGE_SIZE ? PAGE_SIZE : 0)) : list.length;
    } catch (e) {}
    return pageResult(page, total, list);
}

async function search(wd, quick, pg) {
    if (pg === undefined || pg === null) {
        if (typeof quick === 'number' || typeof quick === 'string') pg = quick;
    }
    let page = parseInt(pg, 10);
    if (!page || page < 1) page = 1;
    const key = clean(wd);
    if (!key) return emptyPage(page);
    const list = [];
    let total = 0;
    try {
        const kind = await detectKind();
        if (kind === 'provide') {
            const obj = await fetchProvide({ ac: 'detail', wd: key, pg: page });
            if (obj) {
                const arr = unwrapList(obj);
                for (let i = 0; i < arr.length; i++) {
                    const it = buildItem(arr[i]);
                    if (it) list.push(it);
                }
                total = parseInt(obj.total, 10) || list.length;
                if (list.length) return pageResult(page, total, list, parseInt(obj.limit, 10) || PAGE_SIZE);
            }
        } else if (kind === 'app') {
            const obj = await fetchApp('search', { text: key, pg: page });
            if (obj) {
                const arr = unwrapList(obj);
                for (let i = 0; i < arr.length; i++) {
                    const it = buildItem(arr[i]);
                    if (it) list.push(it);
                }
                total = parseInt(obj.total, 10) || list.length;
                if (list.length) return pageResult(page, total, list);
            }
        }

        const urls = [
            searchUrl(key, page),
            HOST + '/vodsearch/-------------.html?wd=' + encodeURIComponent(key) + '&page=' + page,
            HOST + '/index.php/ajax/suggest?mid=1&wd=' + encodeURIComponent(key) + '&limit=20'
        ];
        for (let i = 0; i < urls.length && !list.length; i++) {
            const r = await httpGet(urls[i], i === 2);
            if (!r.content || r.blocked) continue;
            const obj = parseJson(r.content);
            if (obj && (obj.list || obj.data)) {
                const arr = unwrapList(obj);
                for (let j = 0; j < arr.length; j++) {
                    const it = buildItem(arr[j]);
                    if (it) list.push(it);
                }
            } else {
                const arr = parseListHtml(r.content);
                for (let j = 0; j < arr.length; j++) list.push(arr[j]);
            }
        }
        total = list.length;
    } catch (e) {}
    return pageResult(page, total, list);
}

function splitPlay(fromStr, urlStr) {
    const froms = String(fromStr || '').split('$$$');
    const urls = String(urlStr || '').split('$$$');
    const playFrom = [];
    const playUrls = [];
    for (let i = 0; i < froms.length; i++) {
        const name = clean(froms[i]) || ('线路' + (i + 1));
        const line = urls[i] || '';
        if (!line) continue;
        playFrom.push(name);
        playUrls.push(line);
    }
    return { playFrom, playUrls };
}

async function detail(id) {
    const vid = pickId(id);
    if (!vid) return JSON.stringify({ list: [] });
    try {
        const kind = await detectKind();
        if (kind === 'provide' && !/voddetail|vodplay|\.html|\//.test(vid)) {
            const obj = await fetchProvide({ ac: 'detail', ids: vid });
            const arr = unwrapList(obj);
            const v = arr.length ? arr[0] : null;
            if (v) {
                const sp = splitPlay(v.vod_play_from, v.vod_play_url);
                return JSON.stringify({
                    list: [{
                        vod_id: String(v.vod_id || vid),
                        vod_name: clean(v.vod_name || ''),
                        vod_pic: normalizePic(v.vod_pic || ''),
                        vod_year: v.vod_year ? String(v.vod_year) : '',
                        vod_area: clean(v.vod_area || ''),
                        vod_actor: clean(v.vod_actor || ''),
                        vod_director: clean(v.vod_director || ''),
                        vod_remarks: clean(v.vod_remarks || ''),
                        vod_content: clean(v.vod_content || v.vod_blurb || ''),
                        vod_play_from: sp.playFrom.join('$$$'),
                        vod_play_url: sp.playUrls.join('$$$')
                    }]
                });
            }
        }
        if (kind === 'app' && !/voddetail|vodplay|\.html|\//.test(vid)) {
            const obj = await fetchApp('video_detail', { id: vid });
            const data = obj && (obj.data || obj);
            const v = data && (data.vod || data.list && data.list[0] || data);
            if (v && (v.vod_play_url || v.vodlist || v.list)) {
                let froms = v.vod_play_from || '';
                let urls = v.vod_play_url || '';
                if ((!urls || !froms) && Array.isArray(v.vod_url_with_player || v.list)) {
                    const lines = v.vod_url_with_player || v.list;
                    const pf = [], pu = [];
                    for (let i = 0; i < lines.length; i++) {
                        const ln = lines[i];
                        pf.push(clean(ln.name || ln.from || ('线路' + (i + 1))));
                        pu.push(ln.url || ln.urls || '');
                    }
                    froms = pf.join('$$$');
                    urls = pu.join('$$$');
                }
                const sp = splitPlay(froms, urls);
                return JSON.stringify({
                    list: [{
                        vod_id: String(v.vod_id || vid),
                        vod_name: clean(v.vod_name || v.name || ''),
                        vod_pic: normalizePic(v.vod_pic || v.pic || ''),
                        vod_year: v.vod_year ? String(v.vod_year) : '',
                        vod_area: clean(v.vod_area || ''),
                        vod_actor: clean(v.vod_actor || ''),
                        vod_director: clean(v.vod_director || ''),
                        vod_remarks: clean(v.vod_remarks || ''),
                        vod_content: clean(v.vod_content || v.content || ''),
                        vod_play_from: sp.playFrom.join('$$$'),
                        vod_play_url: sp.playUrls.join('$$$')
                    }]
                });
            }
        }

        const r = await httpGet(detailUrl(vid), false);
        if (!r.content || r.blocked) return JSON.stringify({ list: [] });
        const vod = parseDetailHtml(r.content, vid);
        if (!vod.vod_name) vod.vod_name = vid;
        return JSON.stringify({ list: [vod] });
    } catch (e) {
        return JSON.stringify({ list: [] });
    }
}

async function play(flag, id, flags) {
    const fallback = JSON.stringify({ parse: 1, url: '', header: playHeaders() });
    try {
        let raw = pickId(id).trim();
        if (!raw) return fallback;
        raw = raw.replace(/\\\//g, '/');

        if (isVideoUrl(raw) && /^https?:\/\//i.test(raw)) {
            const videoUrl = raw;
            if (playMode === 'direct') {
                return JSON.stringify({ parse: 0, url: videoUrl, header: playHeaders() });
            }
            return JSON.stringify({
                parse: 0,
                url: PROXY_BASE + 'url=' + encodeURIComponent(videoUrl) + '&ext=.m3u8',
                header: playHeaders()
            });
        }

        const page = playPageUrl(raw);
        const r = await httpGet(page, false);
        let videoUrl = extractPlayer(r.content || '');
        if (videoUrl && !/^https?:\/\//i.test(videoUrl) && videoUrl.indexOf('.m3u8') < 0) {
            videoUrl = absUrl(videoUrl);
        }
        if (videoUrl && isVideoUrl(videoUrl)) {
            if (playMode === 'direct') {
                return JSON.stringify({ parse: 0, url: videoUrl, header: playHeaders() });
            }
            return JSON.stringify({
                parse: 0,
                url: PROXY_BASE + 'url=' + encodeURIComponent(videoUrl) + '&ext=.m3u8',
                header: playHeaders()
            });
        }
        if (videoUrl && /^https?:\/\//i.test(videoUrl)) {
            return JSON.stringify({ parse: 1, url: videoUrl, header: playHeaders() });
        }
        if (/^https?:\/\//i.test(raw)) {
            return JSON.stringify({ parse: 1, url: raw, header: playHeaders() });
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

function isVideo(url) {
    if (!url) return false;
    const u = String(url);
    if (u.indexOf('/proxy?do=js') >= 0) return true;
    if (u.indexOf('fsdm02.com') >= 0 && /\.(mp4|m3u8|mp3)/i.test(u)) return true;
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
