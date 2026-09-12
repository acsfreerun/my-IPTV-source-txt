/**
 * ═══════════════════════════════════════════════════════════════
 *   番薯动漫（FongMi / 影视仓 / CatVodOpen · cat.js）
 *   站点: https://www.fsdm02.com/
 *   解析: https://ym.bjdaile.fun/   （new_mui1 → fsyun_ 密文）
 * ═══════════════════════════════════════════════════════════════
 *
 *  【站点形态】苹果 CMS + mxtheme，无可用 provide/app JSON
 *    分类/列表/详情/搜索全部走 HTML。
 *
 *  【播放】player_aaaa.encrypt=3，url=fsyun_...
 *    → iframe https://ym.bjdaile.fun/?url=fsyun_...
 *    → 页内 config.url 为 AES 密文；密钥由两个 meta#id 排序后
 *      MD5(material + "3G7Fh9Dp6R2QsE8w") 得到，再 AES-128-CBC 解密
 *      得到 douyinvod.com 直链 mp4。
 *
 *  【数据契约】与 CYC.js 相同
 * ═══════════════════════════════════════════════════════════════
 */

import { Crypto, load, _ } from 'assets://js/lib/cat.js';

let HOST = 'https://www.fsdm02.com';
let PARSE_HOST = 'https://ym.bjdaile.fun';
let playMode = 'direct';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_SIZE = 24;
const PROXY_BASE = 'http://127.0.0.1:9978/proxy?do=js&';
const PARSE_SALT = '3G7Fh9Dp6R2QsE8w';

const FALLBACK_CLASSES = [
    { type_id: '1', type_name: 'TV番剧' },
    { type_id: '22', type_name: '国产动漫' },
    { type_id: '3', type_name: '剧场版' },
    { type_id: '20', type_name: '4k分区' },
    { type_id: '21', type_name: '欧美动漫' }
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

// ==================== 工具 ====================

function baseHeaders(extra) {
    const h = {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': HOST + '/',
        'Origin': HOST
    };
    if (extra) {
        for (const k in extra) h[k] = extra[k];
    }
    return h;
}

function playHeaders(ref) {
    return {
        'User-Agent': UA,
        'Referer': ref || (PARSE_HOST + '/'),
        'Origin': PARSE_HOST
    };
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
    if (/douyinvod\.com|byteicdn\.com|bilivideo\.com|googlevideo\.com/i.test(u)) return true;
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

async function httpGet(url, headers) {
    try {
        const res = normalizeRes(await req(url, {
            headers: headers || baseHeaders(),
            timeout: 15000
        }));
        const html = res.content || '';
        if (isCfChallenge(html)) return { status: 403, content: '', blocked: true };
        return { status: res.status || 200, content: html, blocked: false };
    } catch (e) {
        return { status: 0, content: '', blocked: false };
    }
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

function hexToAscii(hex) {
    const h = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
    if (!h || h.length % 2 !== 0) return '';
    let out = '';
    for (let i = 0; i < h.length; i += 2) {
        out += String.fromCharCode(parseInt(h.substr(i, 2), 16));
    }
    return out;
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

function md5Hex(text) {
    if (Crypto && typeof Crypto.MD5 === 'function') {
        return Crypto.MD5(String(text)).toString();
    }
    return '';
}

function aesDecryptUtf8(cipherB64, keyUtf8, ivUtf8) {
    if (!Crypto || !Crypto.AES || !Crypto.enc || !Crypto.enc.Utf8) return '';
    try {
        const key = Crypto.enc.Utf8.parse(keyUtf8);
        const iv = Crypto.enc.Utf8.parse(ivUtf8);
        const out = Crypto.AES.decrypt(String(cipherB64), key, {
            iv,
            mode: Crypto.mode.CBC,
            padding: Crypto.pad.Pkcs7
        });
        return out.toString(Crypto.enc.Utf8) || '';
    } catch (e) {
        try {
            const key = Crypto.enc.Utf8.parse(keyUtf8);
            const iv = Crypto.enc.Utf8.parse(ivUtf8);
            const out = Crypto.AES.decrypt(
                { ciphertext: Crypto.enc.Base64.parse(String(cipherB64)) },
                key,
                { iv, mode: Crypto.mode.CBC, padding: Crypto.pad.Pkcs7 }
            );
            return out.toString(Crypto.enc.Utf8) || '';
        } catch (e2) {
            return '';
        }
    }
}

function buildParseKeyMaterial(html) {
    if (!html) return '';
    const charsetM = html.match(/<meta[^>]*charset=["']?UTF-8["']?[^>]*\sid=["']now_([^"']+)["']/i)
        || html.match(/<meta[^>]*\sid=["']now_([^"']+)["'][^>]*charset=["']?UTF-8["']/i);
    const viewM = html.match(/<meta[^>]*name=["']viewport["'][^>]*\sid=["']now_([^"']+)["']/i)
        || html.match(/<meta[^>]*\sid=["']now_([^"']+)["'][^>]*name=["']viewport["']/i);
    if (!charsetM || !viewM) return '';
    const idPart = charsetM[1];
    const textPart = viewM[1];
    const n = Math.min(idPart.length, textPart.length);
    const pairs = [];
    for (let i = 0; i < n; i++) {
        pairs.push({ id: idPart[i], text: textPart[i] });
    }
    pairs.sort((a, b) => Number(a.id) - Number(b.id));
    let material = '';
    for (let i = 0; i < pairs.length; i++) material += pairs[i].text;
    return material;
}

function decryptParseConfig(cipherB64, html) {
    const material = buildParseKeyMaterial(html);
    if (!material || !cipherB64) return '';
    const hash = md5Hex(material + PARSE_SALT);
    if (!hash || hash.length < 32) return '';
    const iv = hash.substring(0, 16);
    const key = hash.substring(16, 32);
    return aesDecryptUtf8(cipherB64, key, iv);
}

function extractConfigUrl(html) {
    if (!html) return '';
    let m = html.match(/"url"\s*:\s*"([^"]+)"/);
    if (m && m[1] && m[1].indexOf('http') < 0 && m[1].length > 20) return m[1];
    m = html.match(/url\s*:\s*['"]([^'"]+)['"]/);
    if (m && m[1] && m[1].indexOf('http') < 0 && m[1].length > 20) return m[1];
    return '';
}

function extractPlayerData(html) {
    if (!html) return null;
    let m = html.match(/player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i)
        || html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (!m) return null;
    try {
        return JSON.parse(m[1]);
    } catch (e) {
        try {
            // eslint-disable-next-line no-new-func
            return (new Function('return (' + m[1] + ')'))();
        } catch (e2) {
            return null;
        }
    }
}

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
        || h.match(/\/vodplay\/([^\/.?#]+)/i)
        || h.match(/\/video\/([^\/.?#]+)/i)
        || h.match(/\/detail\/([^\/.?#]+)/i)
        || h.match(/[?&]id=([^&#]+)/i);
    if (m) return m[1].replace(/\.html$/i, '');
    return '';
}

function parseListHtml(html) {
    const list = [];
    const $ = cheerio(html);
    if ($) {
        const selectors = [
            '.module-items .module-poster-item',
            '.module-poster-item',
            '.module-card-item',
            '.module-items .module-item',
            '.module-item'
        ];
        let nodes = null;
        for (let i = 0; i < selectors.length; i++) {
            const n = $(selectors[i]);
            if (n && n.length) { nodes = n; break; }
        }
        if (nodes) {
            nodes.each((i, el) => {
                const box = $(el);
                let a = box.is('a') ? box : box.find('a[href*="voddetail"]').first();
                if (!a || !a.length) a = box.find('a').first();
                if (!a || !a.length) return;
                const href = a.attr('href') || '';
                const vid = hrefId(href);
                if (!vid || /vodplay/i.test(vid) === false && !/voddetail|JJJJk|[A-Za-z0-9]{4,}/.test(vid)) {
                    if (!vid) return;
                }
                if (!vid) return;
                const name = clean(
                    a.attr('title')
                    || box.find('.module-poster-item-title, .module-card-item-title, .module-item-title, strong, h3, .title').first().text()
                    || a.text()
                );
                const pic = attrPic(box.find('img').first()) || a.attr('data-original') || '';
                const remark = clean(box.find('.module-item-note, .module-item-text, .pic-text').first().text());
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

    const re = /href="([^"]*voddetail\/[^"]+)"[^>]*?(?:title="([^"]*)")?[\s\S]{0,500}?(?:data-original|data-src|src)="([^"]+)"/gi;
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

function parsePageCount(html, page) {
    if (!html) return page || 1;
    let m = html.match(/vodshow\/[^"']*?--------(\d+)---\.html[^>]*>\s*尾页/i)
        || html.match(/title="尾页"[^>]*>[\s\S]*?--------(\d+)---/i)
        || html.match(/--------(\d+)---\.html"\s+class="page-link page-next"[^>]*title="尾页"/i);
    if (m) return parseInt(m[1], 10) || (page || 1);
    const nums = [];
    const re = /--------(\d+)---\.html/g;
    let mm;
    while ((mm = re.exec(html)) !== null) nums.push(parseInt(mm[1], 10));
    if (nums.length) return Math.max.apply(null, nums);
    return page || 1;
}

function parseNavClasses(html) {
    const cls = [];
    const seen = {};
    const $ = cheerio(html);
    if ($) {
        $('a[href*="vodtype/"]').each((i, el) => {
            const a = $(el);
            const href = a.attr('href') || '';
            const name = clean(a.find('span').text() || a.text());
            const m = href.match(/\/vodtype\/(\w+)/i);
            if (!m || !name) return;
            const tid = m[1].replace(/\.html$/i, '');
            if (!tid || seen[tid] || name.length > 12) return;
            if (/首页|APP|周表|排行|专题|留言|求片|发布|热搜|今日|Ai|AI/i.test(name)) return;
            seen[tid] = 1;
            cls.push({ type_id: tid, type_name: name });
        });
    }
    if (cls.length) return cls;
    const re = /href="[^"]*\/vodtype\/(\w+)[^"]*"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const tid = m[1].replace(/\.html$/i, '');
        const name = clean(m[2]);
        if (!tid || seen[tid] || !name || name.length > 12) continue;
        if (/首页|APP|周表|排行|专题|留言|求片|发布|热搜|今日|Ai|AI/i.test(name)) continue;
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
        vod.vod_name = clean($('h1').first().text() || $('.module-info-heading h1').first().text());
        vod.vod_pic = normalizePic(attrPic($('.module-info-poster img, .module-item-pic img, .lazyload').first()));
        vod.vod_content = clean($('.module-info-introduction-content, .module-info-introduction, .show-desc').first().text());
        const infoText = clean($('.module-info-items, .module-info-item, .module-info-tag').text());
        const yearM = infoText.match(/(?:年份|上映|年代)[:：]?\s*(\d{4})/);
        if (yearM) vod.vod_year = yearM[1];
        const areaM = infoText.match(/(?:地区|国家)[:：]?\s*([^\s/]+)/);
        if (areaM) vod.vod_area = clean(areaM[1]);
        const actorM = infoText.match(/(?:主演|演员)[:：]\s*([^\n]+)/);
        if (actorM) vod.vod_actor = clean(actorM[1]).slice(0, 80);
        const dirM = infoText.match(/(?:导演)[:：]\s*([^\n]+)/);
        if (dirM) vod.vod_director = clean(dirM[1]).slice(0, 80);
        vod.vod_remarks = clean($('.module-info-tag, .module-item-note').first().text());
    } else {
        const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        if (h1) vod.vod_name = clean(h1[1]);
    }

    const playFrom = [];
    const playUrls = [];

    if ($) {
        const tabs = $('#y-playList .module-tab-item, .module-tab-items-box .module-tab-item, .module-tab-item.tab-item');
        const lists = $('.module-list.sort-list .module-play-list, .his-tab-list .module-play-list, .module-play-list');
        if (lists && lists.length) {
            lists.each((i, el) => {
                const box = $(el);
                let lineName = '线路' + (i + 1);
                if (tabs && tabs.length > i) {
                    lineName = clean($(tabs[i]).attr('data-dropdown-value') || $(tabs[i]).find('span').first().text() || $(tabs[i]).text()) || lineName;
                }
                const parts = [];
                box.find('a.module-play-list-link, a[href*="vodplay"]').each((j, ael) => {
                    const a = $(ael);
                    const href = a.attr('href') || '';
                    if (!href || href === '#' || href.indexOf('javascript') >= 0) return;
                    const title = clean(a.find('span').text() || a.attr('title') || a.text()) || ('第' + (j + 1) + '集');
                    parts.push(title + '$' + absUrl(href));
                });
                if (parts.length) {
                    playFrom.push(lineName);
                    playUrls.push(parts.join('#'));
                }
            });
        }
    }

    if (!playUrls.length) {
        const re = /href="([^"]*vodplay\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        const buckets = {};
        let m;
        while ((m = re.exec(html)) !== null) {
            const href = m[1];
            const title = clean(m[2]) || '正片';
            const sidM = href.match(/vodplay\/[^\/-]+-(\d+)-/i);
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

function showUrl(tid, pg, ext) {
    const page = Number(pg) > 1 ? String(pg) : '';
    const parts = [
        String(tid || '1'),
        ext.area || '',
        ext.by || '',
        ext['class'] || ext.cate || '',
        ext.lang || '',
        ext.letter || '',
        '',
        '',
        page,
        '',
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
    const page = Number(pg) > 1 ? String(pg) : '';
    // 抓包实际是 query 形式；path 形式也兼容
    return HOST + '/vodsearch/-------------.html?wd=' + encodeURIComponent(wd) + (page ? '&page=' + page : '');
}

function detailUrl(vid) {
    const id = String(vid || '');
    if (/^https?:\/\//i.test(id)) return id;
    if (id.startsWith('/')) return HOST + id;
    if (/voddetail|vodplay/i.test(id)) return absUrl(id);
    return HOST + '/voddetail/' + id + '.html';
}

function playPageUrl(id) {
    const s = String(id || '');
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('/')) return HOST + s;
    if (/vodplay/i.test(s)) return absUrl(s);
    return HOST + '/vodplay/' + s + '.html';
}

function playResult(url, headers) {
    const videoUrl = String(url || '');
    const h = headers || playHeaders();
    if (playMode === 'direct') {
        return JSON.stringify({ parse: 0, url: videoUrl, header: h });
    }
    const ext = /\.mp4(\?|#|$)/i.test(videoUrl) ? '.mp4' : '.m3u8';
    return JSON.stringify({
        parse: 0,
        url: PROXY_BASE + 'url=' + encodeURIComponent(videoUrl) + '&ext=' + ext,
        header: h
    });
}

async function resolveFsyun(fsyunUrl) {
    const parsePage = PARSE_HOST + '/?url=' + encodeURIComponent(fsyunUrl);
    const r = await httpGet(parsePage, baseHeaders({
        Referer: HOST + '/',
        Origin: HOST,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8'
    }));
    if (!r.content || r.blocked) return '';
    const cipher = extractConfigUrl(r.content);
    if (!cipher) {
        // 页内也许已经是直链
        const direct = r.content.match(/(https?:\/\/[^"'\\\s]+?\.(?:mp4|m3u8)[^"'\\\s]*)/i);
        return direct ? direct[1].replace(/\\u0026/g, '&') : '';
    }
    const plain = decryptParseConfig(cipher, r.content);
    if (plain && /^https?:\/\//i.test(plain)) return plain.replace(/\\u0026/g, '&');
    return '';
}

async function resolvePlay(raw) {
    let target = String(raw || '').trim().replace(/\\\//g, '/');
    if (!target) return '';

    if (isVideoUrl(target) && /^https?:\/\//i.test(target)) return target;

    if (/^fsyun_/i.test(target)) {
        return await resolveFsyun(target);
    }

    if (/bjdaile\.fun\/\?url=/i.test(target)) {
        const um = target.match(/[?&]url=([^&]+)/i);
        if (um) {
            const u = decodeURIComponent(um[1]);
            if (/^fsyun_/i.test(u)) return await resolveFsyun(u);
            if (isVideoUrl(u)) return u;
        }
    }

    const page = playPageUrl(target);
    const r = await httpGet(page, false);
    if (!r.content || r.blocked) return '';

    const data = extractPlayerData(r.content);
    if (data && data.url) {
        let u = String(data.url).replace(/\\\//g, '/');
        const enc = Number(data.encrypt || 0);
        if (enc === 1 || enc === 2) u = macDecrypt(u, enc);
        if (/^fsyun_/i.test(u)) return await resolveFsyun(u);
        if (isVideoUrl(u) && /^https?:\/\//i.test(u)) return u;
        if (/^https?:\/\//i.test(u) && /bjdaile\.fun/i.test(u)) {
            const um = u.match(/[?&]url=([^&]+)/i);
            if (um) {
                const inner = decodeURIComponent(um[1]);
                if (/^fsyun_/i.test(inner)) return await resolveFsyun(inner);
            }
        }
        // encrypt=3 但前缀不是 fsyun_ 时，仍丢给解析站
        if (enc === 3 && u) return await resolveFsyun(u);
    }

    // 正则兜底
    const layers = [
        /(https?:\/\/[^"'\\\s]+?\.(?:m3u8|mp4)[^"'\\\s]*)/i,
        /src=["'](https?:\/\/ym\.bjdaile\.fun\/\?url=[^"']+)["']/i
    ];
    for (let i = 0; i < layers.length; i++) {
        const mm = r.content.match(layers[i]);
        if (!mm || !mm[1]) continue;
        const u = mm[1].replace(/\\\//g, '/');
        if (/bjdaile\.fun/i.test(u)) {
            const um = u.match(/[?&]url=([^&]+)/i);
            if (um) {
                const inner = decodeURIComponent(um[1]);
                if (/^fsyun_/i.test(inner)) return await resolveFsyun(inner);
            }
        }
        if (isVideoUrl(u)) return u;
    }
    return '';
}

// ==================== 接口实现 ====================

async function init(cfg) {
    playMode = 'direct';
    HOST = 'https://www.fsdm02.com';
    PARSE_HOST = 'https://ym.bjdaile.fun';
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
            if (obj.parse) PARSE_HOST = String(obj.parse).replace(/\/+$/, '');
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
        const r = await httpGet(HOST + '/', false);
        if (r.content && !r.blocked) {
            const nav = parseNavClasses(r.content);
            if (nav.length) {
                classes = nav;
                const flt = {};
                for (let i = 0; i < nav.length; i++) {
                    flt[nav[i].type_id] = defaultFilters()[FALLBACK_CLASSES[0].type_id];
                }
                filters = flt;
            }
        }
    } catch (e) {}
    return JSON.stringify({ class: classes, filters });
}

async function homeVod() {
    const list = [];
    try {
        const r = await httpGet(HOST + '/', false);
        if (r.content && !r.blocked) {
            const arr = parseListHtml(r.content);
            for (let i = 0; i < arr.length && list.length < 30; i++) list.push(arr[i]);
        }
        if (!list.length) {
            const r2 = await httpGet(showUrl('1', 1, {}), false);
            if (r2.content && !r2.blocked) {
                const arr = parseListHtml(r2.content);
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
    let pagecount = page;
    try {
        const urls = [showUrl(tid, page, ext), typeUrl(tid, page)];
        for (let i = 0; i < urls.length && !list.length; i++) {
            const r = await httpGet(urls[i], false);
            if (!r.content || r.blocked) continue;
            const arr = parseListHtml(r.content);
            for (let j = 0; j < arr.length; j++) list.push(arr[j]);
            pagecount = parsePageCount(r.content, page);
            total = pagecount * PAGE_SIZE;
        }
    } catch (e) {}
    if (!total) total = list.length ? page * PAGE_SIZE + (list.length >= PAGE_SIZE ? PAGE_SIZE : 0) : 0;
    return pageResult(page, total || list.length, list);
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
        const urls = [
            searchUrl(key, page),
            HOST + '/vodsearch/' + encodeURIComponent(key) + '----------' + page + '---.html'
        ];
        for (let i = 0; i < urls.length && !list.length; i++) {
            const r = await httpGet(urls[i], false);
            if (!r.content || r.blocked) continue;
            const arr = parseListHtml(r.content);
            for (let j = 0; j < arr.length; j++) list.push(arr[j]);
            const tm = r.content.match(/mac_total["']?\s*>\s*(\d+)/i)
                || r.content.match(/找到\s*<strong[^>]*>\s*(\d+)\s*<\/strong>/i);
            if (tm) total = parseInt(tm[1], 10) || 0;
        }
        if (!total) total = list.length;
    } catch (e) {}
    return pageResult(page, total, list);
}

async function detail(id) {
    const vid = pickId(id);
    if (!vid) return JSON.stringify({ list: [] });
    try {
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
        const raw = pickId(id).trim();
        if (!raw) return fallback;
        const videoUrl = await resolvePlay(raw);
        if (videoUrl && isVideoUrl(videoUrl)) {
            return playResult(videoUrl, playHeaders(PARSE_HOST + '/'));
        }
        if (videoUrl && /^https?:\/\//i.test(videoUrl)) {
            return JSON.stringify({ parse: 1, url: videoUrl, header: playHeaders() });
        }
        // 最后兜底：把播放页交给嗅探
        if (/^https?:\/\//i.test(raw) || /vodplay/i.test(raw)) {
            return JSON.stringify({ parse: 1, url: playPageUrl(raw), header: baseHeaders() });
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
    if (/douyinvod\.com|bjdaile\.fun|fsdm02\.com/i.test(u) && /\.(mp4|m3u8|mp3)/i.test(u)) return true;
    return /\.(mp4|m3u8|flv|mkv|avi|mov|webm|ts|mp3|mpd)(\?|#|$)/i.test(u);
}

function sniffer() {
    // 已在 play() 内主动解开直链，不需要网页嗅探
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
