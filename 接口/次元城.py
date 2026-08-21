# -*- coding: utf-8 -*-
# 次元城动画（cycani.org）采集源
# 架构：React SPA + JSON API（/api 前缀，统一 {code,msg,data} 响应）
# 播放需登录 token：从 extend 或 vipFlags 传入，默认见 DEFAULT_TOKEN
# token 过期后会自动用账号密码登录续期（见 DEFAULT_USERNAME / DEFAULT_PASSWORD），
# 若登录也失败，请登录网站 F12 抓任意 Authorization: Bearer xxx 请求替换 token，
# 或在配置源 extend / vipFlags 里填入 {"username":"xx","password":"yy"} 覆盖默认账号。

import sys
import re
import json
import base64
import time
import html as html_mod
import urllib.parse
from urllib.parse import quote

sys.path.append('..')
from base.spider import Spider


class Spider(Spider):

    # 默认登录 token（会过期，播放失败会自动登录续期）
    DEFAULT_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoxNDY1MzA5LCJ1c2VybmFtZSI6ImFjc2ZyZWVlIiwidG9rZW5faWQiOiIwMUtaVEVCTTEwRTlHR0hHQlRSNFpUMkdKNSIsInRva2VuX3ZlcnNpb24iOjEsImlzcyI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODA5MCIsImF1ZCI6WyIiXSwiZXhwIjoxNzg3MTI0OTI5LCJuYmYiOjE3ODY1MjAxMjksImlhdCI6MTc4NjUyMDEyOX0.3_s-n68PMi4unDW_aJNLRmmmteQN8V9e9IYfSP64KJA"

    # 默认登录账号密码：token 过期后自动调用 /auth/login 重新登录（登录接口 POST /auth/login）
    DEFAULT_USERNAME = "acsfreee"
    DEFAULT_PASSWORD = "zxc123qwe"

    def init(self, extend=""):
        self.host = "https://www.cycani.org"
        self.api = self.host + "/api"
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'X-App-Name': 'cyc_web',
            'X-Time-Zone': 'Asia/Shanghai',
            'X-App-Version': 'cycweb',
            'Referer': self.host + '/',
            'Origin': self.host,
        }
        # 播放专用头（防盗链）
        self.play_headers = {
            'User-Agent': self.headers['User-Agent'],
            'Referer': self.host + '/',
            'Origin': self.host,
        }
        # 登录信息：extend 支持 "xxx"（纯token）、{"token":"xxx"}、
        # {"username":"xx","password":"yy"} 或 {"token":"xxx","username":"xx","password":"yy"}
        self.username = self.DEFAULT_USERNAME
        self.password = self.DEFAULT_PASSWORD
        self.token = self._parse_token(extend) or self.DEFAULT_TOKEN
        ext_cred = self._parse_cred(extend)
        if ext_cred:
            self.username = ext_cred[0] or self.username
            self.password = ext_cred[1] or self.password
        # 分区：次元城只有 TV番组 / 剧场番组
        self.classes = [
            {"type_id": "1", "type_name": "TV番组"},
            {"type_id": "2", "type_name": "剧场番组"},
        ]
        self.page_size = 24

    def getName(self):
        return "次元城动画"

    # ==================== 工具函数 ====================
    def _parse_token(self, extend):
        if not extend:
            return ""
        ext = str(extend).strip()
        if ext.startswith('{'):
            try:
                j = json.loads(ext)
                return j.get('token', '') or ''
            except Exception:
                return ext
        return ext

    def _parse_cred(self, extend):
        """从 extend 解析 (username, password)，非 JSON 或缺少字段时返回 None"""
        if not extend:
            return None
        ext = str(extend).strip()
        if not ext.startswith('{'):
            return None
        try:
            j = json.loads(ext)
        except Exception:
            return None
        if not isinstance(j, dict):
            return None
        u = str(j.get('username', '') or '').strip()
        p = str(j.get('password', '') or '')
        if u and p:
            return (u, p)
        return None

    def clean(self, text):
        if not text:
            return ""
        text = html_mod.unescape(str(text))
        text = re.sub(r'<[^>]+>', '', text)
        text = re.sub(r'[\x00-\x1f\x7f]', '', text)
        text = re.sub(r'\s+', ' ', text)
        return text.strip()

    def normalize_pic(self, src):
        if not src:
            return ""
        if src.startswith('//'):
            return 'https:' + src
        if src.startswith('http'):
            return src
        if src.startswith('/'):
            return self.host + src
        return src

    def fetch_page(self, url, headers=None, timeout=15):
        try:
            resp = self.fetch(url, headers=headers or self.headers, timeout=timeout)
            if hasattr(resp, 'text'):
                return resp.text
            return str(resp)
        except Exception as e:
            try:
                self.log("Fetch error: %s" % e)
            except Exception:
                pass
            return ""

    def api_get(self, path, params=None, auth=False, token=None, post=False, body=None):
        """请求 /api 接口，返回完整响应 dict（含 code/msg/data），失败返回 None"""
        url = self.api + path
        if params:
            url += '?' + urllib.parse.urlencode(params)
        headers = dict(self.headers)
        if auth:
            tok = token or self.token
            if tok:
                headers['Authorization'] = 'Bearer ' + tok
        if post:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body) if body is not None else '{}'
            text = self.post_page(url, headers=headers, data=data)
        else:
            text = self.fetch_page(url, headers=headers)
        if not text:
            return None
        try:
            obj = json.loads(text)
        except Exception:
            return None
        if not isinstance(obj, dict):
            return None
        return obj

    def api_data(self, path, params=None, auth=False, token=None, post=False, body=None):
        """请求并解出 data 字段（code==0 才返回 data，否则 None）"""
        obj = self.api_get(path, params=params, auth=auth, token=token, post=post, body=body)
        if obj and obj.get('code') == 0:
            return obj.get('data')
        return None

    def post_page(self, url, headers=None, data=None, timeout=15):
        """POST 请求"""
        try:
            resp = self.fetch(url, headers=headers or self.headers, data=data, timeout=timeout)
            if hasattr(resp, 'text'):
                return resp.text
            return str(resp)
        except Exception as e:
            try:
                self.log("Post error: %s" % e)
            except Exception:
                pass
            return ""

    # ==================== token 自动续期 ====================
    def _jwt_exp(self, token):
        """解析 JWT 的 exp 字段，返回剩余秒数（解析失败返回 None）"""
        try:
            tok = token
            if tok.startswith('Bearer '):
                tok = tok[7:]
            parts = tok.split('.')
            if len(parts) < 2:
                return None
            payload = parts[1]
            payload += '=' * (-len(payload) % 4)
            obj = json.loads(base64.urlsafe_b64decode(payload).decode('utf-8'))
            exp = obj.get('exp')
            if not exp:
                return None
            return int(exp) - int(time.time())
        except Exception:
            return None

    def _login(self, username=None, password=None):
        """用账号密码登录获取新 token，返回裸 token（去掉 Bearer 前缀），失败返回 None"""
        u = username or self.username
        p = password or self.password
        if not u or not p:
            return None
        obj = self.api_get('/auth/login', auth=False, post=True, body={
            'username': u,
            'password': p,
        })
        if not obj or obj.get('code') != 0:
            try:
                self.log("Login failed (code=%s)" % (obj.get('code') if obj else 'None'))
            except Exception:
                pass
            return None
        data = obj.get('data') or {}
        new_tok = data.get('token') or ''
        if new_tok.startswith('Bearer '):
            new_tok = new_tok[7:]
        return new_tok or None

    def _refresh_token(self, token):
        """用旧 token 换新 token；refresh 失效时回退到账号密码登录。返回新 token（失败返回 None）"""
        obj = self.api_get('/auth/refresh', auth=True, token=token, post=True, body={})
        if obj and obj.get('code') == 0:
            data = obj.get('data') or {}
            new_tok = data.get('token') or ''
            if new_tok.startswith('Bearer '):
                new_tok = new_tok[7:]
            if new_tok:
                return new_tok
        # refresh 失败（token 已彻底过期），改用账号密码登录续期
        return self._login()

    def ensure_token(self):
        """确保 token 有效：过期或快过期则自动刷新。返回可用 token（失败返回原 token）"""
        tok = self.token
        if not tok:
            return tok
        remain = self._jwt_exp(tok)
        # 剩余不足 1 天就刷新（防止跨 0 点后过期），解析失败也尝试刷新
        if remain is not None and remain > 86400:
            return tok
        new_tok = self._refresh_token(tok)
        if new_tok:
            self.token = new_tok
            try:
                self.log("Token refreshed (remain=%s)" % self._jwt_exp(new_tok))
            except Exception:
                pass
            return new_tok
        return tok

    def _build_item(self, v):
        """标准化列表项（列表接口字段是 video_id，详情是 id）"""
        if not v:
            return None
        vid = v.get('video_id') or v.get('id')
        if vid is None:
            return None
        total = v.get('total')
        remark = v.get('remarks') or ''
        if not remark and total:
            remark = '更新至%d集' % total
        return {
            'vod_id': str(vid),
            'vod_name': self.clean(v.get('title', '')),
            'vod_pic': self.normalize_pic(v.get('cover_url', '')),
            'vod_remarks': self.clean(remark),
        }

    # ==================== 首页 ====================
    def homeContent(self, filter):
        result = {
            'class': self.classes,
            'filters': {},
            'list': [],
        }
        data = self.api_data('/index/recommend')
        if isinstance(data, dict):
            vods = []
            sections = data.get('list', []) if isinstance(data.get('list'), list) else []
            for sec in sections:
                for v in (sec.get('videos') or []):
                    item = self._build_item(v)
                    if item:
                        vods.append(item)
            result['list'] = vods[:30]
        return result

    def homeVideoContent(self):
        data = self.api_data('/index/recommend')
        vods = []
        if isinstance(data, dict):
            sections = data.get('list', []) if isinstance(data.get('list'), list) else []
            for sec in sections:
                for v in (sec.get('videos') or []):
                    item = self._build_item(v)
                    if item:
                        vods.append(item)
        return {'list': vods[:30]}

    # ==================== 分类 ====================
    def categoryContent(self, tid, pg, filter, extend):
        pg = int(pg) if str(pg).isdigit() and int(pg) > 0 else 1
        tid = str(tid)
        page_size = self.page_size
        data = self.api_data('/videos', params={
            'zone_id': tid,
            'page': pg,
            'page_size': page_size,
        })
        vods = []
        total = 0
        if isinstance(data, dict):
            for v in (data.get('list') or []):
                item = self._build_item(v)
                if item:
                    vods.append(item)
            pager = data.get('pager') or {}
            total = int(pager.get('total') or 0)
        pagecount = (total + page_size - 1) // page_size if total else 1
        return {
            'list': vods,
            'page': pg,
            'pagecount': pagecount,
            'limit': page_size,
            'total': total,
        }

    # ==================== 搜索 ====================
    def searchContent(self, key, quick, pg="1"):
        pg = int(pg) if str(pg).isdigit() and int(pg) > 0 else 1
        page_size = self.page_size
        wd = self.clean(key)
        data = self.api_data('/videos/search', params={
            'q': wd,
            'page': pg,
            'page_size': page_size,
        })
        vods = []
        total = 0
        if isinstance(data, dict):
            for v in (data.get('list') or []):
                item = self._build_item(v)
                if item:
                    vods.append(item)
            pager = data.get('pager') or {}
            total = int(pager.get('total') or 0)
        pagecount = (total + page_size - 1) // page_size if total else 1
        return {
            'list': vods,
            'page': pg,
            'pagecount': pagecount,
            'limit': page_size,
            'total': total,
        }

    # ==================== 详情 ====================
    def detailContent(self, ids):
        vid = str(ids[0]) if isinstance(ids, list) else str(ids)
        data = self.api_data('/videos/' + vid)
        if not isinstance(data, dict):
            return {'list': []}

        vod = {
            'vod_id': vid,
            'vod_name': '',
            'vod_pic': '',
            'vod_year': '',
            'vod_area': '',
            'vod_actor': '',
            'vod_director': '',
            'vod_remarks': '',
            'vod_content': '',
            'vod_score': '',
            'vod_play_from': '',
            'vod_play_url': '',
        }
        vod['vod_name'] = self.clean(data.get('title', ''))
        vod['vod_pic'] = self.normalize_pic(data.get('cover_url', ''))
        vod['vod_year'] = str(data.get('year') or '')
        vod['vod_area'] = self.clean(data.get('area', ''))
        vod['vod_remarks'] = self.clean(data.get('remarks', ''))
        vod['vod_content'] = self.clean(data.get('description', ''))
        if data.get('score') is not None:
            vod['vod_score'] = str(data.get('score'))

        actor = data.get('actor') or []
        if isinstance(actor, list):
            vod['vod_actor'] = ', '.join(self.clean(a) for a in actor)
        director = data.get('director') or []
        if isinstance(director, list):
            vod['vod_director'] = ', '.join(self.clean(d) for d in director)

        # ---- 播放线路与选集 ----
        play_from = data.get('play_from') or []
        play_from_list = []
        play_url_list = []
        for line in play_from:
            code = line.get('code') or ''
            name = self.clean(line.get('title', '')) or '默认线路'
            eps = self._fetch_sections(vid, code)
            parts = []
            for i, ep in enumerate(eps):
                ep_id = ep.get('id')
                ep_title = self.clean(ep.get('title', '')) or ('第%d集' % (i + 1))
                if ep_id is not None:
                    parts.append('%s$%s' % (ep_title, ep_id))
            if parts:
                play_from_list.append(name)
                play_url_list.append('#'.join(parts))

        vod['vod_play_from'] = '$$$'.join(play_from_list)
        vod['vod_play_url'] = '$$$'.join(play_url_list)
        return {'list': [vod]}

    def _fetch_sections(self, vid, player_code):
        """循环翻页拉取全部选集（服务端 page_size 上限约 100）"""
        eps = []
        page = 1
        page_size = 100
        while True:
            data = self.api_data('/videos/%s/sections' % vid, params={
                'player_code': player_code,
                'page': page,
                'page_size': page_size,
            })
            if not isinstance(data, dict):
                break
            lst = data.get('list') or []
            eps.extend(lst)
            pager = data.get('pager') or {}
            total = int(pager.get('total') or 0)
            if not lst or page * page_size >= total:
                break
            page += 1
        return eps

    # ==================== 播放 ====================
    def playerContent(self, flag, id, vipFlags):
        try:
            section_id = str(id or '').strip()
            # token 优先取 vipFlags，其次 init 里的 extend
            token = self._parse_token(vipFlags) or self.token

            # 快过期时先刷新 token
            token = self.ensure_token() if token == self.token else token

            path = '/v2/sections/%s/play-url' % section_id
            obj = self.api_get(path, auth=True, token=token)
            data = obj.get('data') if obj else None

            # 401 说明 token 失效，尝试刷新后重试一次
            if obj and obj.get('code') == 401:
                new_tok = self._refresh_token(token)
                if new_tok:
                    self.token = new_tok
                    obj = self.api_get(path, auth=True, token=new_tok)
                    data = obj.get('data') if obj else None

            if isinstance(data, dict) and data.get('url'):
                video_url = str(data['url']).replace('\\/', '/')
                # 播放地址是 .mp3 伪后缀（实际为 video/mp4）。
                # FongMi/TVBox 对 parse:0 直链会按 .mp3 扩展名误判为音频导致"无有效播放地址"，
                # 故改用 parse:1 走嗅探：FongMi 会实际请求该 url 并按响应 content-type(video/mp4)识别。
                # header 带上防盗链 Referer/Origin，保证嗅探请求不被 403。
                return {
                    'parse': 1,
                    'url': video_url,
                    'header': self.play_headers,
                    'Header': self.play_headers,
                }
            return {'parse': 1, 'url': '', 'header': self.play_headers}
        except Exception as e:
            try:
                self.log("Play error: %s" % e)
            except Exception:
                pass
            return {'parse': 1, 'url': '', 'header': self.play_headers}

    # ==================== 占位方法 ====================
    def isVideoFormat(self, url):
        pass

    def manualVideoCheck(self):
        pass

    def localProxy(self, param):
        pass

    def liveContent(self, url):
        pass
