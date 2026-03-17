# 我的直播源 TXT 合集


# 酷九使用 GitHub TXT 列表订阅教程
本文详细说明酷九如何通过 GitHub 上的 TXT 格式源列表实现订阅，适用于各类电视/盒子端酷九版本。

## 核心步骤
### 第一步：获取 GitHub TXT 源的 Raw 链接
> ⚠️ 关键：必须使用 Raw 链接（普通链接无法订阅），步骤如下：
1. 打开存放 TXT 源的 GitHub 仓库，找到目标 TXT 文件（如 `沧海TV源.txt`）；
2. 点击文件进入详情页，点击页面右上角/中部的「Raw」按钮；
3. 页面跳转到纯文本展示页后，复制浏览器地址栏的**完整 URL**（格式示例：`https://raw.githubusercontent.com/用户名/仓库名/分支名/文件名.txt`）。由于 Raw 链接直连可能较慢，推荐通过 `ghproxy` 加速访问，转换方法如下：

#### 方法 1：手动拼接（核心逻辑）
ghproxy 加速链接的格式为：  
`https://ghfast.top/` + **Raw 原始链接**  

#### 方法 2：一键转换工具（懒人版）
使用在线工具快速转换，无需手动拼接：
1. 打开 ghproxy 官方转换页：https://ghproxy.com/
2. 将 Raw 原始链接粘贴到输入框
3. 点击「生成加速链接」按钮，直接复制结果即可

### 第二步：酷九内添加订阅
1.打开列表订阅
2.输入后点击确定

### 第三步：验证订阅效果
1. 返回酷九首页，查看是否已加载出订阅的频道/源列表；
2. 若订阅失败，排查以下问题：
   - ✅ Raw 链接是否正确（必须以 `raw.githubusercontent.com` 开头）；
   - ✅ 网络是否可访问 GitHub（或切换网络/使用代理）；
   - ✅ TXT 文件格式是否符合要求（推荐格式：`频道名,播放链接,分类`，每行一个）。

## 链接直接复制版本
- 韭菜专用：   https://ghfast.top/https://raw.githubusercontent.com/acsfreerun/my-IPTV-source-txt/refs/heads/main/%E9%9F%AD%E8%8F%9C%E4%B8%93%E7%94%A8.txt
- 酒店源：   https://ghfast.top/https://raw.githubusercontent.com/acsfreerun/my-IPTV-source-txt/refs/heads/main/%E5%B9%BF%E4%B8%9C%E8%81%94%E9%80%9A%20%E9%85%92%E5%BA%97%E6%BA%90.txt
