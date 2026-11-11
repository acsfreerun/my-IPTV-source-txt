/**
 * ═══════════════════════════════════════════════════════════════
 *   NBA 录播 · FongMi / 影视仓 JS 源1
 *   站点：https://www.tiyuhu.com/nbalx/
 *
 *   流程：NBA录像列表  
 *         → 详情页里标签带“微博”的链接（[微博录像] / [微博-国语]）
 *         → m.weibo.cn 状态接口取 mp4 直链
 *
 *   要点：微博视频 CDN 必须带 Referer: https://weibo.com/，否则 403。
 *         play() 返回的 header 会交给播放器，无需本地代理。
 *
 *   范围：只处理标题含“录像 / 回放”的 NBA 录像详情页；
 *         线路只要标签带“微博”就抓（[微博录像] / [微博-国语]），
 *         [腾讯国语] / [腾讯原声] / [咪咕] 等一律不抓。
 *
 *   部署：FongMi / 影视仓 → 设置 → 点播 → 添加 JS 源（type=3）
 *         api 指向本文件即可，无需 ext。
 * ═══════════════════════════════════════════════════════════════
 */

// 与 CYC.js 相同：加载 cat.js，确保全局 req() 可用
import { Crypto, load, _ } from 'assets://js/lib/cat.js';

var HOST = 'https://www.tiyuhu.com';

var UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

var CATEGORY_ID = 'nbalx';
var CATEGORY_NAME = 'NBA录像';
var CATEGORY_PATH = '/nbalx/';
var PAGE_SIZE = 20;
var MAX_PAGE = 999;

// ==================== 工具 ====================

function clean(text) {
    if (text === null || text === undefined) return '';
    var t = String(text);
    t = t.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, function (all, e) {
        var map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
        return map[e] !== undefined ? map[e] : all;
    });
    t = t.replace(/&#(x?[0-9a-fA-F]+);/g, function (all, e) {
        var code = (e.charAt(0) === 'x' || e.charAt(0) === 'X')
            ? parseInt(e.substring(1), 16)
            : parseInt(e, 10);
        if (!isNaN(code) && code > 0 && code < 0x110000) {
            try { return String.fromCharCode(code); } catch (err) {}
        }
        return all;
    });
    return t.replace(/<[^>]+>/g, '').replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim();
}

function getAttr(tag, name) {
    var m = String(tag).match(new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"', 'i'));
    if (!m) m = String(tag).match(new RegExp("\\b" + name + "\\s*=\\s*'([^']*)'", 'i'));
    return m ? m[1] : '';
}

function pickId(id) {
    if (id === null || id === undefined) return '';
    if (typeof id === 'object' && id.length !== undefined) {
        return id.length > 0 ? String(id[0]) : '';
    }
    return String(id);
}

function fixUrl(url) {
    var s = String(url || '');
    s = s.replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/\\u0026/g, '&');
    if (s.indexOf('//') === 0) s = 'https:' + s;
    return s;
}

// ==================== 请求 ====================

function siteHeaders(ref) {
    return {
        'User-Agent': UA_PC,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': ref || (HOST + '/'),
        'Origin': HOST
    };
}

function weiboHeaders() {
    return {
        'User-Agent': UA_MOBILE,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://m.weibo.cn/',
        'X-Requested-With': 'XMLHttpRequest',
        'MWeibo-Pwa': '1'
    };
}

// 微博 CDN 只认 Referer，UA 不敏感
function playHeaders() {
    return {
        'User-Agent': UA_PC,
        'Referer': 'https://weibo.com/'
    };
}

async function httpGet(url, headers) {
    try {
        var res = await req(url, { headers: headers, timeout: 20000 });
        if (!res || !res.content) return '';
        return String(res.content);
    } catch (e) {
        return '';
    }
}

// ==================== 列表解析 ====================

// 列表只显示对阵：2026年11月11日 NBA常规赛 雄鹿vs尼克斯 录像回放 → 雄鹿vs尼克斯
function shortName(title) {
    var t = clean(title);
    if (!t) return '';
    var m = t.match(/([^\s，,：:]{1,14})\s*(?:vs|Vs|VS|vS)\s*([^\s，,：:]{1,14})/);
    if (!m) return t;
    var name = m[1] + 'vs' + m[2];
    // 系列赛带 G1/G2 时保留场次，避免同对阵多条同名
    var g = t.match(/\bG\s?(\d{1,2})\b/i);
    if (g) name += ' G' + g[1];
    return name;
}

// /nbalx/ 列表页混着侧栏新闻，只取 <article class="blog"> 且标题含“录像/回放”的
function parseList(html) {
    var out = [];
    var seen = {};
    if (!html) return out;
    var re = /<article[^>]*\bclass="[^"]*\bblog\b[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
        var block = m[1];
        var a = block.match(/<h2[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>/i);
        if (!a) continue;
        var href = getAttr(a[1], 'href');
        var title = clean(getAttr(a[1], 'title') || a[2]);
        if (!href || !title) continue;
        var idm = href.match(/\/post\/(\d+)\.html/i);
        if (!idm) continue;
        var vid = idm[1];
        if (seen[vid]) continue;
        if (!/录像|回放/.test(title)) continue;
        seen[vid] = 1;
        var dm = block.match(/<time[^>]*\bpubdate="([^"]*)"/i);
        var date = dm ? clean(dm[1]).slice(0, 10) : '';
        out.push({
            vod_id: vid,
            vod_name: shortName(title) || title,
            vod_pic: '',
            vod_remarks: date ? date.slice(5) : '录像'
        });
    }
    return out;
}

function parsePageCount(html, page) {
    var max = page;
    if (!html) return max;
    var re = /href="[^"]*\/nbalx\/(\d+)\/?"/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
        var n = parseInt(m[1], 10);
        if (!isNaN(n) && n > max && n <= MAX_PAGE) max = n;
    }
    return max;
}

async function fetchListPage(page) {
    var url = HOST + CATEGORY_PATH + (page > 1 ? page + '/' : '');
    var html = await httpGet(url, siteHeaders(HOST + CATEGORY_PATH));
    return {
        list: parseList(html),
        pagecount: parsePageCount(html, page)
    };
}

// ==================== 详情解析 ====================

// 从 weibo.com/<uid>/<bid> 或 m.weibo.cn/detail/<mid> 提取微博状态 id
function extractBid(input) {
    var s = String(input || '').trim();
    if (!s) return '';
    if (/^\d{6,}$/.test(s)) return s;
    if (!/^https?:/i.test(s) && /^[A-Za-z0-9]{6,12}$/.test(s)) return s;
    var patterns = [
        /^https?:\/\/(?:www\.|m\.)?weibo\.(?:com|cn)\/\d+\/([A-Za-z0-9]+)\/?(?:[?#].*)?$/i,
        /^https?:\/\/(?:www\.|m\.)?weibo\.(?:com|cn)\/(?:detail|status)\/([A-Za-z0-9]+)\/?(?:[?#].*)?$/i
    ];
    for (var i = 0; i < patterns.length; i++) {
        var m = s.match(patterns[i]);
        if (m) return m[1];
    }
    return '';
}

function epName(text) {
    var t = clean(text);
    var m = t.match(/第[一二三四五六七八九十百零0-9]+节/);
    if (m) return m[0];
    if (/全场精华/.test(t)) return '全场精华';
    if (/全场录像/.test(t)) return '全场录像';
    if (/原声回放/.test(t)) return '原声回放';
    var label = '';
    var lm = t.match(/^\[([^\]]+)\]/);
    if (lm) label = lm[1];
    var rest = t.replace(/^\[[^\]]*\]\s*/, '')
        .replace(/^\d{4}年\d{1,2}月\d{1,2}日\s*/, '')
        .replace(/NBA[^ ]*?\s+/i, '')
        .replace(/[^\s]{1,10}vs[^\s]{1,10}\s*/i, '')
        .replace(/\s*(录像|回放|视频)\s*$/, '')
        .trim();
    rest = clean(rest);
    if (rest && rest.length <= 16) return rest;
    if (label) return label;
    return '播放';
}

// 线路标签：只要方括号标签里带“微博”就保留（[微博录像]、[微博-国语] 等），其余丢弃
var LABEL_RE = /^[\[【][^\]】]{0,20}微博[^\]】]{0,20}[\]】]/;

// 详情页里标签带“微博”的视频链接（微博录像 / 微博-国语 都能直接看）
function parseEpisodes(html) {
    var out = [];
    var seen = {};
    if (!html) return out;
    var re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
        var href = getAttr(m[1], 'href');
        var text = clean(m[2]);
        if (!href || !text) continue;
        // 没有“微博”标签的线路不抓
        if (!LABEL_RE.test(text)) continue;
        var bid = extractBid(href);
        if (!bid || seen[bid]) continue;
        seen[bid] = 1;
        out.push({ bid: bid, name: epName(text) });
    }
    return out;
}

// ==================== 播放解析 ====================

function findVideo(status) {
    var depth = 0;
    while (status && depth < 5) {
        var pi = status.page_info;
        if (pi) {
            var urls = pi.urls || {};
            var media = pi.media_info || {};
            var url = urls.mp4_720p_mp4 || urls.mp4_hd_mp4 || urls.mp4_ld_mp4 ||
                      media.stream_url_hd || media.stream_url;
            if (url) return fixUrl(url);
        }
        status = status.retweeted_status;
        depth++;
    }
    return '';
}

function regexVideo(content) {
    if (!content) return '';
    var keys = ['mp4_720p_mp4', 'mp4_hd_mp4', 'mp4_ld_mp4', 'stream_url_hd', 'stream_url'];
    for (var i = 0; i < keys.length; i++) {
        var re = new RegExp('"' + keys[i] + '"\\s*:\\s*"([^"]+)"');
        var m = String(content).match(re);
        if (m && m[1]) {
            var u = fixUrl(m[1]);
            if (u.indexOf('http') === 0) return u;
        }
    }
    var g = String(content).match(/https?:\\?\/\\?\/f\.video\.weibocdn\.com[^"'\s]+\.mp4[^"'\s]*/);
    return g ? fixUrl(g[0]) : '';
}

// ==================== 接口实现 ====================

function init(cfg) {
    try {
        var ext = null;
        if (cfg && typeof cfg === 'object') ext = cfg.ext;
        else if (typeof cfg === 'string') ext = cfg;
        if (typeof ext === 'string' && ext.trim().charAt(0) === '{') {
            try { ext = JSON.parse(ext); } catch (e) { ext = null; }
        }
        if (ext && typeof ext === 'object') {
            if (ext.host) HOST = String(ext.host).replace(/\/+$/, '');
            if (ext.ua) UA_PC = String(ext.ua);
            if (ext.uaMobile) UA_MOBILE = String(ext.uaMobile);
        }
    } catch (e) {}
    return '';
}

async function home(filter) {
    var classes = [{ type_id: CATEGORY_ID, type_name: CATEGORY_NAME }];
    return JSON.stringify({ 'class': classes, filters: {} });
}

async function homeVod() {
    var page = await fetchListPage(1);
    return JSON.stringify({ list: page.list });
}

async function category(tid, pg, filter, extend) {
    var page = parseInt(pg, 10);
    if (!page || page < 1) page = 1;
    if (page > MAX_PAGE) page = MAX_PAGE;
    var data = await fetchListPage(page);
    return JSON.stringify({
        page: page,
        pagecount: data.pagecount,
        limit: PAGE_SIZE,
        total: data.pagecount * PAGE_SIZE,
        list: data.list
    });
}

async function detail(id) {
    var pid = pickId(id);
    if (!pid) return JSON.stringify({ list: [] });
    var numMatch = pid.match(/\/post\/(\d+)\.html/i);
    var num = numMatch ? numMatch[1] : (/^\d+$/.test(pid) ? pid : '');
    if (!num) return JSON.stringify({ list: [] });

    var url = HOST + '/post/' + num + '.html';
    var html = await httpGet(url, siteHeaders(HOST + CATEGORY_PATH));
    if (!html) return JSON.stringify({ list: [] });

    var title = '';
    var tm = html.match(/<h1[^>]*\bclass="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
    if (tm) title = clean(tm[1]);
    if (!title) {
        var ttm = html.match(/<title>([\s\S]*?)<\/title>/i);
        if (ttm) title = clean(ttm[1]).replace(/\s*[-_|].*$/, '');
    }

    var date = '';
    var dm = html.match(/<time[^>]*\bpubdate="([^"]*)"/i);
    if (dm) date = clean(dm[1]).slice(0, 10);

    var content = '';
    var metas = html.match(/<meta\b[^>]*>/gi) || [];
    for (var i = 0; i < metas.length; i++) {
        if (/\bname\s*=\s*["']description["']/i.test(metas[i])) {
            content = clean(getAttr(metas[i], 'content'));
            break;
        }
    }

    var eps = parseEpisodes(html);
    var names = {};
    var parts = [];
    for (var j = 0; j < eps.length; j++) {
        var name = eps[j].name;
        if (names[name]) {
            var k = 2;
            while (names[name + '(' + k + ')']) k++;
            name = name + '(' + k + ')';
        }
        names[name] = 1;
        parts.push(name + '$' + eps[j].bid);
    }

    var vod = {
        vod_id: num,
        vod_name: title || ('NBA录像 ' + num),
        vod_pic: '',
        vod_year: date ? date.slice(0, 4) : '',
        vod_area: '',
        vod_actor: '',
        vod_director: '',
        vod_remarks: date || '',
        vod_content: content,
        vod_play_from: parts.length ? '微博' : '',
        vod_play_url: parts.join('#')
    };
    return JSON.stringify({ list: [vod] });
}

async function search(wd, quick, pg) {
    // 站点没有可用的搜索接口（search.php / cmd.php 均 404）
    return JSON.stringify({ page: 1, pagecount: 1, limit: PAGE_SIZE, total: 0, list: [] });
}

async function play(flag, id, flags) {
    var fallback = JSON.stringify({ parse: 1, url: '', header: playHeaders() });
    try {
        var bid = extractBid(pickId(id));
        if (!bid) return fallback;

        var api = 'https://m.weibo.cn/statuses/show?id=' + encodeURIComponent(bid);
        var content = await httpGet(api, weiboHeaders());
        if (!content) return fallback;

        var url = '';
        var obj = null;
        try { obj = JSON.parse(content); } catch (e) { obj = null; }
        if (obj && obj.data) url = findVideo(obj.data);
        if (!url) url = regexVideo(content);
        if (!url) return fallback;

        return JSON.stringify({ parse: 0, url: url, header: playHeaders() });
    } catch (e) {
        return fallback;
    }
}

function isVideo(url) {
    if (!url) return false;
    var u = String(url);
    if (u.indexOf('weibocdn.com') >= 0) return true;
    return /\.(mp4|m3u8|flv|mkv|avi|mov|webm)(\?|#|$)/i.test(u);
}

function sniffer() {
    return false;
}

export function __jsEvalReturn() {
    return {
        init: init,
        home: home,
        homeVod: homeVod,
        category: category,
        detail: detail,
        search: search,
        play: play,
        isVideo: isVideo,
        sniffer: sniffer
    };
}
