// ============================================================================
// 次元城动画（cycani.org）JS 采集源
// ============================================================================
// 运行环境：FongMi 影视 / TVBox / CatVodOpen 等支持函数式 JS 爬虫的框架
//          （QuickJS / Rhino 引擎，内置 request()/req() HTTP 函数）
//          同时提供 Python 式函数名别名（homeContent / detailContent /
//          playerContent / localProxy ...），兼容 webhtv 等沿用 Python
//          蜘蛛命名的框架。
//
// 配置示例（站点配置 json 中）：
//   {"key":"cycani","name":"次元城动画","type":3,
//    "api":"./spider/次元城动画.js","ext":"{\"mode\":\"proxy\"}"}
//
// 架构：目标站为 React SPA + JSON API（/api 前缀，统一 {code,msg,data} 响应）
//
// 播放 / token 说明：
//   1. 播放接口需登录 token（Authorization: Bearer xxx）：
//      - 本源不内置默认 token（写死必过期），首次播放自动用账号密码
//        POST /api/auth/login 登录获取并缓存，后续复用；
//      - 已有 token 快过期时先 POST /api/auth/refresh 换新；
//      - refresh 失效（已彻底过期）则回退重新登录。
//      （默认账号见 DEFAULT_USERNAME / DEFAULT_PASSWORD，可被 ext 覆盖）
//   2. ext 支持以下写法：
//      - "eyJhbGciOi..."（纯 token 字符串）   手动指定 token（优先级最高）
//      - {"token":"eyJ..."}                     指定 token
//      - {"username":"xx","password":"yy"}      指定登录账号
//      - {"mode":"proxy"}    ← 默认。本地代理 + 302 重定向（推荐，最稳）
//      - {"mode":"stream"}   ← 本地代理全量转发视频流（强制 video/mp4，大文件慢）
//      - {"mode":"direct"}   ← 直连真实地址 + 防盗链头（部分客户端可能误判 .mp3）
//   3. 真实播放地址为 .mp3 伪后缀（实为 video/mp4），部分客户端按扩展名误判
//      为音频导致"无有效播放地址"。本源默认返回本地代理地址并追加 &ext=.mp4
//      兜底骗过扩展名检查，由 proxy() 处理防盗链。
//   4. 本地代理地址默认 http://127.0.0.1:9978/proxy?do=js（FongMi/TVBox 本地
//      服务默认端口 9978），端口有改动请同步修改 PROXY_BASE。
// ============================================================================

// ==================== 全局配置 ====================

var HOST = 'https://www.cycani.org';
var API = HOST + '/api';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var PROXY_BASE = 'http://127.0.0.1:9978/proxy?do=js&';

// 登录账号（自动登录获取 token 用，可被 ext 覆盖）
var DEFAULT_USERNAME = 'acsfreee';
var DEFAULT_PASSWORD = 'zxc123qwe';

var PAGE_SIZE = 24;            // 列表分页大小（与网站一致）
var SECTION_PAGE_SIZE = 100;   // 选集接口分页上限（服务端约 100）
var MAX_SECTION_PAGES = 50;    // 选集翻页防御上限

// 运行状态（可被 init(ext) 覆盖）
var token = '';                // 无内置 token，首次播放自动登录获取
var username = DEFAULT_USERNAME;
var password = DEFAULT_PASSWORD;
var mode = 'proxy';            // 'proxy' | 'stream' | 'direct'

var CLASSES = [
    { type_id: '1', type_name: 'TV番组' },
    { type_id: '2', type_name: '剧场番组' }
];

// ==================== 初始化 ====================

function init(ext) {
    token = '';
    username = DEFAULT_USERNAME;
    password = DEFAULT_PASSWORD;
    mode = 'proxy';
    try {
        var j = parseExtJson(ext);
        if (j) {
            if (j.token) token = String(j.token);
            if (j.username) username = trimStr(j.username);
            if (j.password) password = String(j.password);
            if (j.mode) {
                var m = String(j.mode).toLowerCase();
                if (m === 'proxy' || m === 'redirect' || m === 'stream' || m === 'direct') {
                    mode = (m === 'redirect') ? 'proxy' : m;
                }
            }
        } else if (typeof ext === 'string' && trimStr(ext)) {
            token = trimStr(ext);   // 纯 token 字符串
        }
    } catch (e) {
        safeLog('init error: ' + e);
    }
    return '';
}

function getName() { return '次元城动画'; }
function name() { return '次元城动画'; }

// ==================== 基础工具 ====================

function trimStr(v) {
    return String(v === null || v === undefined ? '' : v).replace(/^\s+|\s+$/g, '');
}

function safeLog(msg) {
    try {
        if (typeof log === 'function') log('[次元城] ' + msg);
        else if (typeof console !== 'undefined' && console.log) console.log('[次元城] ' + msg);
    } catch (e) {}
}

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

// 播放专用头（防盗链）
function playHeaders() {
    return {
        'User-Agent': UA,
        'Referer': HOST + '/',
        'Origin': HOST
    };
}

// HTTP 请求封装：优先 request()，其次 req()，返回响应文本
function fetchText(url, options) {
    options = options || {};
    var h = {};
    var src = options.headers || baseHeaders();
    for (var k in src) if (src.hasOwnProperty(k)) h[k] = src[k];
    var opt = { headers: h, timeout: options.timeout || 15000 };
    if (options.method) opt.method = options.method;
    if (options.body) { opt.body = options.body; opt.data = options.body; } // 兼容不同引擎参数名
    try {
        if (typeof request === 'function') return request(url, opt);
        if (typeof req === 'function') return req(url, opt);
    } catch (e) {
        safeLog('Fetch error: ' + e + ' url=' + url);
        return '';
    }
    safeLog('当前 JS 环境无 request()/req() 函数');
    return '';
}

// 请求 /api 接口，返回完整响应对象（{code,msg,data}），失败返回 null
function apiGet(path, params, auth, tok, post, body) {
    var url = API + path;
    if (params) {
        var qs = [];
        for (var k in params) {
            if (!params.hasOwnProperty(k)) continue;
            var v = params[k];
            if (v === undefined || v === null) continue;
            qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
        }
        if (qs.length) url += '?' + qs.join('&');
    }
    var h = baseHeaders();
    var opt = { headers: h };
    if (auth) {
        var t = tok || token;
        if (t) h['Authorization'] = 'Bearer ' + t;
    }
    if (post) {
        opt.method = 'POST';
        h['Content-Type'] = 'application/json';
        opt.body = body ? JSON.stringify(body) : '{}';
    }
    var text = fetchText(url, opt);
    if (!text) return null;
    try {
        var obj = JSON.parse(text);
        if (obj && typeof obj === 'object') return obj;
    } catch (e) {}
    return null;
}

// 请求并解出 data 字段（code==0 才返回，否则 null）
function apiData(path, params, auth, tok, post, body) {
    var obj = apiGet(path, params, auth, tok, post, body);
    if (obj && obj.code === 0) return obj.data;
    return null;
}

// extend 解析：JSON 字符串/对象 → object，非 JSON 返回 null
function parseExtJson(ext) {
    if (!ext) return null;
    if (typeof ext === 'object') return ext;
    var s = trimStr(ext);
    if (s.charAt(0) !== '{') return null;
    try {
        var j = JSON.parse(s);
        if (j && typeof j === 'object') return j;
    } catch (e) {}
    return null;
}

// 文本清洗：HTML 实体反转义 + 去标签 + 去控制字符 + 合并空白
function clean(text) {
    if (text === null || text === undefined) return '';
    var t = String(text);
    var entities = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
        hellip: '…', mdash: '—', ndash: '–', ldquo: '\u201C', rdquo: '\u201D',
        lsquo: '\u2018', rsquo: '\u2019', middot: '·', copy: '©', reg: '®', trade: '™'
    };
    t = t.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (all, e) {
        if (entities[e] !== undefined) return entities[e];
        if (e.charAt(0) === '#') {
            var code = (e.charAt(1) === 'x' || e.charAt(1) === 'X')
                ? parseInt(e.substring(2), 16) : parseInt(e.substring(1), 10);
            if (!isNaN(code) && code > 0 && code < 0x110000) {
                try { return String.fromCharCode(code); } catch (ex) {}
            }
        }
        return all;
    });
    t = t.replace(/<[^>]+>/g, '');
    t = t.replace(/[\x00-\x1f\x7f]/g, '');
    t = t.replace(/\s+/g, ' ');
    return trimStr(t);
}

// 封面地址补全
function normalizePic(src) {
    if (!src) return '';
    var s = String(src);
    if (s.indexOf('//') === 0) return 'https:' + s;
    if (s.indexOf('http') === 0) return s;
    if (s.charAt(0) === '/') return HOST + s;
    return s;
}

// ==================== token 自动续期 ====================

// base64url 解码（纯 JS 实现，无环境依赖）
function b64UrlDecode(input) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var s = String(input).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4 !== 0) s += '=';
    var bytes = [];
    var val = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
        var c = chars.indexOf(s.charAt(i));
        if (c < 0) continue;
        val = (val << 6) | c;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((val >> bits) & 0xFF);
        }
    }
    var out = '';
    for (var j = 0; j < bytes.length; ) {
        var b = bytes[j];
        if (b < 0x80) { out += String.fromCharCode(b); j += 1; }
        else if (b < 0xE0) { out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[j + 1] & 0x3F)); j += 2; }
        else if (b < 0xF0) { out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[j + 1] & 0x3F) << 6) | (bytes[j + 2] & 0x3F)); j += 3; }
        else {
            var cp = ((b & 0x07) << 18) | ((bytes[j + 1] & 0x3F) << 12) | ((bytes[j + 2] & 0x3F) << 6) | (bytes[j + 3] & 0x3F);
            cp -= 0x10000;
            out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
            j += 4;
        }
    }
    return out;
}

// 解析 JWT 的 exp，返回剩余秒数（失败返回 null）
function jwtExp(tok) {
    try {
        if (!tok) return null;
        var t = String(tok);
        if (t.indexOf('Bearer ') === 0) t = t.substring(7);
        var parts = t.split('.');
        if (parts.length < 2) return null;
        var payload = JSON.parse(b64UrlDecode(parts[1]));
        if (!payload || !payload.exp) return null;
        return Number(payload.exp) - Math.floor(Date.now() / 1000);
    } catch (e) {
        return null;
    }
}

function stripBearer(tok) {
    var t = String(tok || '');
    return t.indexOf('Bearer ') === 0 ? t.substring(7) : t;
}

// 账号密码登录，成功返回裸 token，失败返回空串
function doLogin() {
    if (!username || !password) return '';
    var obj = apiGet('/auth/login', null, false, null, true, { username: username, password: password });
    if (!obj || obj.code !== 0) {
        safeLog('Login failed (code=' + (obj ? obj.code : 'None') + ')');
        return '';
    }
    var data = obj.data || {};
    return stripBearer(data.token || '');
}

// 旧 token 换新；refresh 失效则回退账号密码登录
function refreshToken(tok) {
    var obj = apiGet('/auth/refresh', null, true, tok, true, {});
    if (obj && obj.code === 0) {
        var data = obj.data || {};
        var t = stripBearer(data.token || '');
        if (t) return t;
    }
    return doLogin();
}

// 确保 token 可用：无 token 则自动登录获取；
// 已有 token 剩余不足 1 天（或解析失败）时自动刷新
function ensureToken() {
    var tok = token;
    if (!tok) {
        var lt = doLogin();
        if (lt) {
            token = lt;
            safeLog('Token acquired by login');
            return lt;
        }
        return '';
    }
    var remain = jwtExp(tok);
    if (remain !== null && remain > 86400) return tok;
    var nt = refreshToken(tok);
    if (nt) {
        token = nt;
        safeLog('Token refreshed');
        return nt;
    }
    return tok;
}

// ==================== 数据标准化 ====================

// 标准化列表项（列表接口字段是 video_id，详情是 id）
// 同时输出 vod_* 与 url/title/pic_url/desc 双字段，兼容新老客户端
function buildItem(v) {
    if (!v) return null;
    var vid = (v.video_id !== undefined && v.video_id !== null) ? v.video_id : v.id;
    if (vid === undefined || vid === null) return null;
    var remark = v.remarks || '';
    if (!remark && v.total) remark = '更新至' + v.total + '集';
    remark = clean(remark);
    var nm = clean(v.title || '');
    var pic = normalizePic(v.cover_url || '');
    return {
        vod_id: String(vid),
        vod_name: nm,
        vod_pic: pic,
        vod_remarks: remark,
        url: String(vid),
        title: nm,
        pic_url: pic,
        desc: remark
    };
}

function joinList(arr) {
    if (!arr || !arr.length) return '';
    var out = [];
    for (var i = 0; i < arr.length; i++) {
        var c = clean(arr[i]);
        if (c) out.push(c);
    }
    return out.join(', ');
}

// ==================== 首页 ====================

function fetchRecommend() {
    var vods = [];
    try {
        var data = apiData('/index/recommend');
        if (data && typeof data === 'object' && data.list && data.list.length) {
            for (var i = 0; i < data.list.length; i++) {
                var videos = data.list[i].videos || [];
                for (var j = 0; j < videos.length; j++) {
                    var item = buildItem(videos[j]);
                    if (item) vods.push(item);
                }
            }
        }
    } catch (e) {
        safeLog('recommend error: ' + e);
    }
    return vods;
}

function home(filter) {
    return JSON.stringify({
        class: CLASSES,
        filters: {},
        list: fetchRecommend().slice(0, 30)
    });
}

function homeVod(params) {
    return JSON.stringify({ list: fetchRecommend().slice(0, 30) });
}

// ==================== 分类 ====================

function category(tid, pg, filter, extend) {
    var page = parseInt(pg, 10);
    if (isNaN(page) || page < 1) page = 1;
    var vods = [];
    var total = 0;
    try {
        var data = apiData('/videos', { zone_id: String(tid), page: page, page_size: PAGE_SIZE });
        if (data && typeof data === 'object') {
            var lst = data.list || [];
            for (var i = 0; i < lst.length; i++) {
                var item = buildItem(lst[i]);
                if (item) vods.push(item);
            }
            var pager = data.pager || {};
            total = parseInt(pager.total, 10) || 0;
        }
    } catch (e) {
        safeLog('category error: ' + e);
    }
    var pagecount = total > 0 ? Math.ceil(total / PAGE_SIZE) : 1;
    return JSON.stringify({
        list: vods,
        page: page,
        pagecount: pagecount,
        limit: PAGE_SIZE,
        total: total
    });
}

// ==================== 搜索 ====================

function search(key, quick, pg) {
    var page = parseInt(pg, 10);
    if (isNaN(page) || page < 1) page = 1;
    var vods = [];
    var total = 0;
    var wd = clean(key);
    if (wd) {
        try {
            var data = apiData('/videos/search', { q: wd, page: page, page_size: PAGE_SIZE });
            if (data && typeof data === 'object') {
                var lst = data.list || [];
                for (var i = 0; i < lst.length; i++) {
                    var item = buildItem(lst[i]);
                    if (item) vods.push(item);
                }
                var pager = data.pager || {};
                total = parseInt(pager.total, 10) || 0;
            }
        } catch (e) {
            safeLog('search error: ' + e);
        }
    }
    var pagecount = total > 0 ? Math.ceil(total / PAGE_SIZE) : 1;
    return JSON.stringify({
        list: vods,
        page: page,
        pagecount: pagecount,
        limit: PAGE_SIZE,
        total: total
    });
}

// ==================== 详情 ====================

function pickVodId(ids) {
    if (ids === null || ids === undefined) return '';
    if (typeof ids === 'string') {
        var s = trimStr(ids);
        if (s.charAt(0) === '[') {
            try {
                var arr = JSON.parse(s);
                if (arr && arr.length) return String(arr[0]);
            } catch (e) {}
        }
        return s;
    }
    if (typeof ids === 'object' && ids.length !== undefined) {
        if (ids.length > 0) return String(ids[0]);
        return '';
    }
    return String(ids);
}

// 循环翻页拉取全部选集（服务端 page_size 上限约 100）
function fetchSections(vid, playerCode) {
    var eps = [];
    var page = 1;
    while (page <= MAX_SECTION_PAGES) {
        var data = apiData('/videos/' + vid + '/sections', {
            player_code: playerCode,
            page: page,
            page_size: SECTION_PAGE_SIZE
        });
        if (!data || typeof data !== 'object') break;
        var lst = data.list || [];
        for (var i = 0; i < lst.length; i++) eps.push(lst[i]);
        var pager = data.pager || {};
        var total = parseInt(pager.total, 10) || 0;
        if (!lst.length || page * SECTION_PAGE_SIZE >= total) break;
        page++;
    }
    return eps;
}

function detail(ids) {
    var vid = pickVodId(ids);
    if (!vid) return JSON.stringify({ list: [] });

    var data = apiData('/videos/' + vid);
    if (!data || typeof data !== 'object') return JSON.stringify({ list: [] });

    var vod = {
        vod_id: vid,
        vod_name: clean(data.title || ''),
        vod_pic: normalizePic(data.cover_url || ''),
        vod_year: (data.year !== undefined && data.year !== null && data.year !== '') ? String(data.year) : '',
        vod_area: clean(data.area || ''),
        vod_actor: joinList(data.actor),
        vod_director: joinList(data.director),
        vod_remarks: clean(data.remarks || ''),
        vod_content: clean(data.description || ''),
        vod_score: ''
    };

    if (data.score !== undefined && data.score !== null) vod.vod_score = String(data.score);

    // 播放线路与选集：线路用 $$$ 分隔，集数用 # 分隔，名与地址用 $ 分隔
    var playFrom = [];
    var playUrl = [];
    var lines = data.play_from || [];
    for (var li = 0; li < lines.length; li++) {
        var line = lines[li] || {};
        var code = line.code || '';
        var lineName = clean(line.title || '') || '默认线路';
        var eps = fetchSections(vid, code);
        var parts = [];
        for (var ei = 0; ei < eps.length; ei++) {
            var ep = eps[ei] || {};
            if (ep.id === undefined || ep.id === null) continue;
            var epTitle = clean(ep.title || '') || ('第' + (ei + 1) + '集');
            parts.push(epTitle + '$' + ep.id);
        }
        if (parts.length) {
            playFrom.push(lineName);
            playUrl.push(parts.join('#'));
        }
    }
    vod.vod_play_from = playFrom.join('$$$');
    vod.vod_play_url = playUrl.join('$$$');
    return JSON.stringify({ list: [vod] });
}

// ==================== 播放 ====================

function play(flag, id, vipFlags) {
    var fallback = JSON.stringify({
        parse: 1, playUrl: '', url: '',
        header: playHeaders(), Header: playHeaders()
    });
    try {
        var sectionId = trimStr(id);
        if (!sectionId) return fallback;

        // token 优先取 vipFlags，其次全局（init 的 extend）
        var tok = '';
        if (vipFlags !== null && vipFlags !== undefined) {
            var vj = parseExtJson(vipFlags);
            if (vj) {
                if (vj.token) tok = String(vj.token);
            } else if (typeof vipFlags === 'string') {
                var vs = trimStr(vipFlags);
                if (vs && vs.charAt(0) !== '{') tok = vs;
            }
        }
        if (!tok) tok = token;
        if (tok === token) tok = ensureToken();

        var path = '/v2/sections/' + sectionId + '/play-url';
        var obj = apiGet(path, null, true, tok);
        var data = obj ? obj.data : null;

        // 401：token 失效，刷新后重试一次
        if (obj && obj.code === 401) {
            var nt = refreshToken(tok);
            if (nt) {
                token = nt;
                obj = apiGet(path, null, true, nt);
                data = obj ? obj.data : null;
            }
        }

        if (data && typeof data === 'object' && data.url) {
            var videoUrl = String(data.url).replace(/\\\//g, '/');
            if (mode === 'direct') {
                // 直连：交给播放器带防盗链头播放（部分客户端可能因 .mp3 后缀误判）
                return JSON.stringify({
                    parse: 0, playUrl: '', url: videoUrl,
                    header: playHeaders(), Header: playHeaders()
                });
            }
            // 本地代理：URL 以 &ext=.mp4 结尾，绕开 .mp3 伪后缀导致的扩展名误判
            return JSON.stringify({
                parse: 0, playUrl: '',
                url: PROXY_BASE + 'url=' + encodeURIComponent(videoUrl) + '&ext=.mp4',
                header: playHeaders(), Header: playHeaders()
            });
        }
        return fallback;
    } catch (e) {
        safeLog('play error: ' + e);
        return fallback;
    }
}

// ==================== 本地代理 ====================

// 从各种可能的代理参数形态中提取真实视频地址
// （不同框架传入格式不同：值数组 / 键值交替数组 / JSON 字符串 / 对象）
function extractProxyUrl(args) {
    var cands = [];
    var i, k, v;
    if (args === null || args === undefined) return '';
    if (typeof args === 'string') {
        var s = trimStr(args);
        if (s.charAt(0) === '{') {
            try {
                var j = JSON.parse(s);
                if (j) {
                    if (j.url) cands.push(String(j.url));
                    if (j.path) cands.push(String(j.path));
                    if (j.proxy) cands.push(String(j.proxy));
                }
            } catch (e) {}
        }
        cands.push(s);
    } else if (typeof args === 'object') {
        if (typeof args.length === 'number') {
            for (i = 0; i < args.length; i++) {
                k = (args[i] === null || args[i] === undefined) ? '' : String(args[i]);
                var lk = k.toLowerCase();
                if (lk === 'url' || lk === 'path' || lk === 'proxy') {
                    if (i + 1 < args.length) {
                        v = (args[i + 1] === null || args[i + 1] === undefined) ? '' : String(args[i + 1]);
                        if (v) cands.push(v);
                    }
                }
                if (k) cands.push(k);
            }
        } else {
            if (args.url) cands.push(String(args.url));
            if (args.path) cands.push(String(args.path));
            if (args.proxy) cands.push(String(args.proxy));
        }
    }
    for (i = 0; i < cands.length; i++) {
        v = cands[i];
        if (!v) continue;
        if (/^https?:\/\//i.test(v)) {
            // 本地代理地址本身不是目标，跳过并交给后面的兜底逻辑从 query 提取
            if (v.indexOf('/proxy?') >= 0 && v.indexOf('url=') > 0) continue;
            return v;
        }
        // 仍处于 URL 编码状态
        if (/^https?%3A/i.test(v)) {
            try {
                var dec = decodeURIComponent(v);
                if (/^https?:\/\//i.test(dec)) return dec;
            } catch (e) {}
        }
    }
    // 兜底：候选本身是本源代理地址（http://127.0.0.1:*/proxy?do=js&url=...）时，
    // 从 query 中抠出真实视频地址
    for (i = 0; i < cands.length; i++) {
        v = cands[i];
        if (v && v.indexOf('/proxy?') >= 0) {
            var m = v.match(/[?&]url=([^&]+)/);
            if (m) {
                var u = m[1];
                try { u = decodeURIComponent(u); } catch (e) {}
                if (/^https?:\/\//i.test(u)) return u;
            }
        }
    }
    return '';
}

// 剥离代理地址里追加的伪装后缀参数（&ext=.mp4 / ?ext=.mp4）
function stripFakeExt(url) {
    var u = String(url || '');
    if (/[?&]ext=\.mp4$/i.test(u)) {
        u = u.replace(/[?&]ext=\.mp4$/i, '');
        u = u.replace(/\?$/, '');
    }
    return u;
}

// 返回 5 元组 [code, mime, body, headers, is_base64]：
// FongMi/TVBox 取前 3 位；webhtv 等框架可识别完整 5 元组
function proxy(segments, headers) {
    try {
        var realUrl = stripFakeExt(extractProxyUrl(segments));
        if (!realUrl) return [500, 'text/plain', 'bad proxy param', {}, 0];
        if (mode === 'stream') {
            // 全量转发：带防盗链头请求真实视频，强制 Content-Type: video/mp4
            // （视频流经 JS 层，大文件较慢，仅在 302 不可用时使用）
            var content = fetchText(realUrl, { headers: playHeaders(), timeout: 60000 });
            if (!content) return [502, 'text/plain', 'fetch failed', {}, 0];
            return [200, 'video/mp4', content, {}, 0];
        }
        // 默认：302 重定向到真实地址，
        // 播放器沿用 play() 返回的防盗链头（Referer/Origin/UA）跟随跳转
        return [302, 'text/plain', realUrl, {}, 0];
    } catch (e) {
        safeLog('proxy error: ' + e);
        return [500, 'text/plain', 'proxy error', {}, 0];
    }
}

// ==================== 占位 / 框架别名 ====================

function isVideoFormat(url) {
    if (!url) return false;
    var u = String(url);
    if (u.indexOf('/proxy?do=js') >= 0) return true; // 本源代理地址一律按视频处理
    return /\.(mp4|m3u8|flv|mkv|avi|mov|webm|ts|mp3)(\?|#|$)/i.test(u);
}

function manualVideoCheck() { return false; }

function liveContent(url) { return ''; }

function destroy() {}

// ---- Python 式函数名别名（webhtv / dr_py 类框架沿用 Python 蜘蛛命名）----

function homeContent(filter) { return home(filter); }
function homeVideoContent() { return homeVod(); }
function categoryContent(tid, pg, filter, extend) { return category(tid, pg, filter, extend); }
function detailContent(ids) { return detail(ids); }
function searchContent(key, quick, pg) { return search(key, quick, pg); }
function playerContent(flag, id, vipFlags) { return play(flag, id, vipFlags); }
function localProxy(param) { return proxy(param); }
