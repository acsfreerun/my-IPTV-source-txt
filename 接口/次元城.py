#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
源名称：次元城动画 (cycani.org)
生成方式：AI 自动生成
站点类型：现代 SPA + 自研 JSON API（需登录获取播放地址）
适配环境：py-drpy / TVBox / 影视仓
登录机制：每次调用前自动检查登录态，未登录则用内置账号密码自动登录
"""

import re
import json
import time
import requests
from base.spider import Spider


class Spider(Spider):
    # ==================== 基础配置 ====================
    name = "次元城动画"
    base_url = "https://www.cycani.org"
    site_url = "https://www.cycani.org"
    api_prefix = "/api"

    # ==================== 登录配置（请填写你的账号密码） ====================
    # 注意：该站点用户名是 acsfreee（3 个 e），不是 acsfree
    USERNAME = "acsfreee"
    PASSWORD = "zxc123qwe"

    # ==================== 分类映射（zone_id） ====================
    class_name = ["TV番组", "剧场番组"]
    class_url = ["1", "2"]

    # ==================== 请求头常量 ====================
    APP_NAME = "cyc_web"      # X-App-Name
    APP_VERSION = "cycweb"    # X-App-Version
    page_size = 20

    def __init__(self):
        # 登录态：token 与过期时间戳（秒）
        self._token = None
        self._token_expiry = 0

        self._session = requests.Session()
        self._session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            "Accept": "application/json",
            "X-App-Name": self.APP_NAME,
            "X-App-Version": self.APP_VERSION,
            "X-Time-Zone": "Asia/Shanghai",
            "Origin": self.base_url,
            "Referer": self.base_url + "/",
        })

    # ==================== 工具函数层 ====================

    def _build_headers(self):
        """构建请求头，已登录则附带 Authorization"""
        h = dict(self._session.headers)
        if self._token:
            h["Authorization"] = "Bearer " + self._token
        return h

    def _api(self, path):
        """拼接完整 API URL"""
        prefix = self.api_prefix
        if not prefix.startswith("/"):
            prefix = "/" + prefix
        return self.base_url + prefix + path

    # ==================== 自动登录 ====================

    def _ensure_login(self):
        """检查登录态，未登录或已过期则自动登录。返回是否可用。"""
        if self._token and time.time() < self._token_expiry - 60:
            return True
        return self._login()

    def _login(self):
        """执行登录，保存 token 与过期时间。返回是否成功。"""
        try:
            url = self._api("/auth/login")
            data = {"username": self.USERNAME, "password": self.PASSWORD}
            resp = self._session.post(url, json=data, headers=self._build_headers(), timeout=15)
            js = resp.json()
            if resp.status_code == 200 and js.get("code") == 0:
                d = js.get("data") or {}
                token = d.get("token") or ""
                # token 可能自带 "Bearer " 前缀，去掉以便统一加前缀
                if token.startswith("Bearer "):
                    token = token[7:]
                self._token = token
                # expires_at 可能为 ISO 字符串或时间戳，统一换算成绝对时间戳
                expires_at = d.get("expires_at")
                self._token_expiry = self._parse_expiry(expires_at)
                return bool(self._token)
            else:
                print(f"[{self.name}] 登录失败: {js.get('msg')} (请检查账号密码)")
                return False
        except Exception as e:
            print(f"[{self.name}] 登录异常: {e}")
            return False

    def _parse_expiry(self, expires_at):
        """解析过期时间，返回绝对时间戳(秒)。兼容时间戳、ISO 字符串、带时区偏移 ISO"""
        if not expires_at:
            return time.time() + 3600
        try:
            if isinstance(expires_at, (int, float)):
                # 可能是毫秒
                if expires_at > 1e12:
                    expires_at = expires_at / 1000
                return float(expires_at)
            s = str(expires_at).strip()
            # 去尾时区偏移（如 +08:00）和末尾 Z，再去小数秒
            if s.endswith("Z"):
                s = s[:-1]
            else:
                s = re.sub(r"(\+|\-)\d{2}:\d{2}$", "", s)
            if "." in s:
                s = s.split(".")[0]
            ts = time.mktime(time.strptime(s, "%Y-%m-%dT%H:%M:%S"))
            return ts
        except Exception:
            return time.time() + 3600

    # ==================== 请求封装 ====================

    def _get_json(self, path, params=None, need_auth=False):
        """GET JSON，need_auth=True 时先确保已登录"""
        try:
            if need_auth and not self._ensure_login():
                return None
            resp = self._session.get(
                self._api(path),
                params=params,
                headers=self._build_headers(),
                timeout=15,
            )
            js = resp.json()
            return js.get("data") if js.get("code") == 0 else None
        except Exception as e:
            print(f"[{self.name}] GET 异常 {path}: {e}")
            return None

    # ==================== 数据标准化 ====================

    def _build_vod_item(self, v):
        """标准化影片列表条目（视频列表/搜索/推荐通用）"""
        vod_id = v.get("video_id") or v.get("id") or ""
        vod_name = v.get("title") or ""
        vod_pic = v.get("cover_url") or ""
        vod_remarks = v.get("remarks") or ""
        vod_year = str(v.get("year") or "")
        vod_area = v.get("area") or ""
        vod_score = str(v.get("score") or "") if v.get("score") else ""
        # 标签拼到类型
        tags = v.get("tags") or []
        vod_type = "、".join(str(x) for x in tags) if tags else (v.get("version") or "")
        return {
            "vod_id": str(vod_id),
            "vod_name": vod_name,
            "vod_pic": vod_pic,
            "vod_remarks": vod_remarks,
            "vod_year": vod_year,
            "vod_area": vod_area,
            "vod_type": vod_type,
            "vod_score": vod_score,
        }

    # ==================== 五大核心方法 ====================

    def homeContent(self, filter=False):
        """首页：返回分类 + 推荐番剧"""
        result = {"class": [], "list": []}
        # 分类
        for i, n in enumerate(self.class_name):
            result["class"].append({"type_id": self.class_url[i], "type_name": n})
        # 推荐内容
        try:
            data = self._get_json("/index/recommend")
            if data and data.get("list"):
                seen = set()
                for section in data["list"]:
                    for v in (section.get("videos") or []):
                        vid = str(v.get("video_id") or "")
                        if vid and vid not in seen:
                            seen.add(vid)
                            item = self._build_vod_item(v)
                            if item["vod_id"]:
                                result["list"].append(item)
        except Exception as e:
            print(f"[{self.name}] 首页异常: {e}")
        return result

    def categoryContent(self, tid, pg, filter=False, extend=None):
        """分类列表（分页）"""
        result = {
            "list": [],
            "page": pg,
            "pagecount": 0,
            "limit": self.page_size,
            "total": 0,
        }
        try:
            params = {
                "zone_id": str(tid),
                "page": str(pg),
                "page_size": str(self.page_size),
            }
            # 支持年份/类型筛选
            if extend:
                if extend.get("year"):
                    params["year"] = str(extend["year"])
                if extend.get("category"):
                    params["category"] = str(extend["category"])
            data = self._get_json("/videos", params=params)
            if data and data.get("list"):
                for v in data["list"]:
                    item = self._build_vod_item(v)
                    if item["vod_id"]:
                        result["list"].append(item)
                pager = data.get("pager") or {}
                result["pagecount"] = self._calc_pagecount(pager)
                result["total"] = pager.get("total") or len(result["list"])
        except Exception as e:
            print(f"[{self.name}] 分类异常: {e}")
        return result

    def _calc_pagecount(self, pager):
        try:
            total = pager.get("total") or 0
            return (total + self.page_size - 1) // self.page_size
        except Exception:
            return 1

    def detailContent(self, ids):
        """影片详情（含选集）"""
        result = []
        vod_id = ids if isinstance(ids, str) else (ids[0] if ids else "")
        if not vod_id:
            return result
        try:
            data = self._get_json("/videos/" + str(vod_id))
            if not data:
                return result

            vod = {
                "vod_id": str(data.get("id") or vod_id),
                "vod_name": data.get("title") or "",
                "vod_pic": data.get("cover_url") or "",
                "vod_year": str(data.get("year") or ""),
                "vod_area": data.get("area") or "",
                "vod_score": str(data.get("score") or "") if data.get("score") else "",
                "vod_remarks": data.get("remarks") or "",
                "vod_director": "、".join(data.get("director") or []),
                "vod_actor": "、".join(data.get("actor") or []),
                "vod_type": "、".join(data.get("tags") or []),
                "vod_content": (data.get("description") or "").replace("\r\n", "\n"),
            }

            # 播放线路（play_from）
            play_from = data.get("play_from") or []
            line_names = []
            line_sections = []
            if play_from:
                for pf in play_from:
                    code = pf.get("code")
                    title = pf.get("title") or "默认线路"
                    if not code:
                        continue
                    sections = self._get_sections(vod_id, code)
                    line_names.append(title)
                    line_sections.append(sections)
            # 兜底：无 play_from 时尝试常见线路
            if not line_names:
                code = "cychub"
                sections = self._get_sections(vod_id, code)
                if sections:
                    line_names.append("CYC_Main")
                    line_sections.append(sections)

            line_urls = []
            for sec in line_sections:
                parts = []
                for s in sec:
                    ep_title = s.get("title") or f"第{len(parts)+1}集"
                    parts.append(f"{ep_title}${s['id']}")
                line_urls.append("#".join(parts))

            vod["vod_play_from"] = "$$$".join(line_names)
            vod["vod_play_url"] = "$$$".join(line_urls)
            result.append(vod)
        except Exception as e:
            print(f"[{self.name}] 详情异常: {e}")
        return result

    def _get_sections(self, video_id, player_code):
        """获取某线路的全部选集"""
        sections = []
        page = 1
        try:
            while page <= 10:
                params = {
                    "player_code": player_code,
                    "page": str(page),
                    "page_size": str(100),
                }
                data = self._get_json(f"/videos/{video_id}/sections", params=params)
                if not data or not data.get("list"):
                    break
                sections.extend(data["list"])
                pager = data.get("pager") or {}
                total = pager.get("total") or len(sections)
                if len(sections) >= total:
                    break
                page += 1
        except Exception as e:
            print(f"[{self.name}] 选集异常: {e}")
        return sections

    def playerContent(self, flag, id, vipFlags=""):
        """播放地址解析：用选集 id 换取真实播放地址（需登录）"""
        try:
            section_id = str(id).split("$")[0].strip()
            if not section_id:
                return {"parse": 0, "url": "", "header": {}}
            # 直接是播放链接则原样返回
            if ".m3u8" in section_id or ".mp4" in section_id or ".mpd" in section_id:
                return {
                    "parse": 0,
                    "url": section_id,
                    "header": {"User-Agent": self._session.headers["User-Agent"]},
                }
            data = self._get_json(
                f"/v2/sections/{section_id}/play-url",
                need_auth=True,
            )
            if data and data.get("url"):
                return {
                    "parse": 0,
                    "url": data["url"],
                    "header": {"User-Agent": self._session.headers["User-Agent"]},
                }
            return {"parse": 0, "url": "", "header": {}}
        except Exception as e:
            print(f"[{self.name}] 播放异常: {e}")
            return {"parse": 0, "url": "", "header": {}}

    def searchContent(self, key, quick, pg="1"):
        """关键词搜索"""
        result = {
            "list": [],
            "page": int(pg),
            "pagecount": 0,
            "limit": self.page_size,
            "total": 0,
        }
        if not key:
            return result
        try:
            params = {
                "q": str(key),
                "page": str(pg),
                "page_size": str(self.page_size),
            }
            data = self._get_json("/videos/search", params=params)
            if data and data.get("list"):
                for v in data["list"]:
                    item = self._build_vod_item(v)
                    if item["vod_id"]:
                        result["list"].append(item)
                pager = data.get("pager") or {}
                result["pagecount"] = self._calc_pagecount(pager)
                result["total"] = pager.get("total") or len(result["list"])
        except Exception as e:
            print(f"[{self.name}] 搜索异常: {e}")
        return result

    def localProxy(self, param):
        return []

    # ==================== 手动测试入口 ====================
    def _self_test(self):
        """本地自检（不走 TVBox 框架）"""
        print("== 登录测试 ==")
        ok = self._ensure_login()
        print("登录结果:", ok, "| token:", (self._token[:20] + "...") if self._token else None)
        print("\n== 首页 ==")
        home = self.homeContent()
        print("分类:", [(c["type_id"], c["type_name"]) for c in home.get("class", [])])
        print("推荐数:", len(home.get("list", [])))
        if home.get("list"):
            print("首条:", home["list"][0]["vod_name"], home["list"][0]["vod_id"])
        print("\n== 分类(zone=1) ==")
        cat = self.categoryContent("1", "1")
        print("条数:", len(cat.get("list", [])), "| total:", cat.get("total"))
        if cat.get("list"):
            print("首条:", cat["list"][0]["vod_name"], "id=", cat["list"][0]["vod_id"])
            vid = cat["list"][0]["vod_id"]
            print("\n== 详情 ==")
            d = self.detailContent([vid])
            if d:
                vod = d[0]
                print("片名:", vod["vod_name"])
                print("线路:", vod.get("vod_play_from"))
                print("选集数:", len(vod.get("vod_play_url", "").split("#")) if vod.get("vod_play_url") else 0)
                print("前2集:", vod.get("vod_play_url", "").split("#")[:2])
                first_sec = vod.get("vod_play_url", "").split("#")[0].split("$")[-1] if vod.get("vod_play_url") else ""
                if first_sec:
                    print("\n== 播放 ==")
                    pl = self.playerContent("", first_sec)
                    print("播放地址:", pl.get("url"))
        print("\n== 搜索『无职』 ==")
        sres = self.searchContent("无职", "1", "1")
        print("搜索数:", len(sres.get("list", [])))
        if sres.get("list"):
            print("首条:", sres["list"][0]["vod_name"])


if __name__ == "__main__":
    sp = Spider()
    sp._self_test()
