# X 视频下载按钮（Tampermonkey 油猴脚本）

在 X（Twitter）网页版的视频右下角加一个“下载”按钮。只有真正包含视频的推文才会出现按钮，纯图片推文不会。

- 适用页面：`x.com`、`twitter.com`
- 示例推文：<https://x.com/kct2507/status/2118177522366226735>
- 脚本文件：[x-video-downloader.user.js](x-video-downloader.user.js)
- 测试用例：13 个浏览器测试，全部通过（使用模拟的 X 页面，不连接真实 X）

## 功能

- 只在视频播放器右下角插入按钮，位置在 X 原生控制条上方（默认距底部 52px，避免挡住全屏/设置按钮）。
- 图片、文字、链接卡片等没有视频的推文不会出现按钮。
- 点击后自动选择**可用的最高码率 MP4**，生成类似下面的文件名：

  ```text
  x_kct2507_2118177522366226735_720x720.mp4
  ```

- 支持时间线、推文详情页、视频浮层、引用推文中的视频。
- X 是单页应用，脚本会监听 DOM 变化，在 React 重绘后补回按钮，也能处理滚动加载出来的新视频。
- 默认交给 Tampermonkey 的 `GM_download` 下载，自动保存到浏览器下载目录。
- 如果最高画质只有 HLS（`.m3u8`）而没有 MP4，脚本会明确提示失败，不会把播放列表伪装成视频文件下载。

> 示例推文的公开媒体元数据中，MP4 最高为 **720×720 / 约 1.28 Mbps**；脚本会选择该最高 MP4。更高画质若只以 HLS 提供，不在本脚本的处理范围内。

## 安装

1. 在 Chrome / Edge 安装 [Tampermonkey](https://www.tampermonkey.net/)（油猴）扩展。
2. 安装脚本，任选一种：
   - 把 `x-video-downloader.user.js` 拖进安装了 Tampermonkey 的浏览器窗口，在打开的页面点“安装”；
   - 或打开 Tampermonkey 管理面板 → **实用工具 / Utilities** → **从文件导入 / Import from file**，选择该文件；
   - 或新建脚本，把文件内容全部粘贴进去后保存。
3. **刷新已经打开的 x.com 页面**（脚本在 `document-start` 注入，安装前已加载的页面需要刷新）。
4. 打开含视频的推文。视频右下角出现“下载”按钮即安装成功。

首次点击时，如果 Tampermonkey 询问是否允许跨域访问或下载文件，请选择允许。需要授权的域名已写在脚本头部：

```text
x.com
twitter.com
cdn.syndication.twimg.com
api.fxtwitter.com
video.twimg.com
```

## 使用

1. 打开视频推文，等待按钮出现在视频右下角。
2. 点“下载”。按钮会依次显示：`获取中` → `下载中` → `已保存`。
3. 文件默认保存到浏览器下载目录；如果 Tampermonkey 设置了“每次询问保存位置”，会弹出保存对话框。

失败时按钮会变红并显示“失败”，页面底部同时出现错误提示。常见处理方式是打开该推文的详情页后刷新重试。

## 解析策略

脚本按以下顺序寻找视频直链，前一级成功就不会继续请求后面的：

1. **页面自身接口数据**（最优先）
   - 在页面上下文拦截 X 的 GraphQL / `statuses/show` 响应，提取 `video_info.variants`。
   - 这是画质最高、最准确的来源，也适用于需要登录才能看的推文。
   - 同时利用 `mediaId ↔ tweetId` 反查引用卡片里没有时间戳链接的视频。
2. **页面 `<video>` 标签直链**
   - 如果视频元素本身就是 `https://...mp4`，直接使用。
3. **官方 syndication 接口**
   - `https://cdn.syndication.twimg.com/tweet-result?...`
   - 自动计算 token，token 失败时再尝试无 token 请求。
4. **推文页面 HTML**
   - 读取 `og:video`、`twitter:player:stream` 或页面内嵌的 `video.twimg.com/*.mp4` 地址。
5. **FXTwitter 只读接口**（最后兜底）
   - `https://api.fxtwitter.com/status/<tweetId>`
   - 只在前面所有官方方式都失败后请求；只发送推文数字 ID，不发送 X 登录 Cookie。
   - 如果不希望使用第三方服务，把脚本里的 `CONFIG.useFxTwitterFallback` 改成 `false`。

选择 MP4 时按 `bitrate` 降序，码率相同则按分辨率面积降序，所以不会因为接口顺序而误选低画质。

## 常见问题

### 按钮没有出现

- 确认当前页面是含视频的推文，而不是纯图片推文。
- 安装或更新脚本后刷新页面。
- 私信、个人主页头图、广告等没有推文编号的视频会被跳过，这是有意设计。
- 打开开发者工具 Console，筛选 `[X 视频下载]`，能看到解析与失败原因。

### 点击后提示“没有找到可下载的 MP4”

- 该视频可能只有 HLS 流，或当前账号无权查看。
- 打开推文详情页后刷新重试，让脚本有机会捕获页面接口数据。
- 如果网络无法访问 `cdn.syndication.twimg.com` 和 `api.fxtwitter.com`，可以尝试换网络环境。

### 下载没有开始 / 被浏览器拦截

- 在 Tampermonkey 设置中允许脚本下载文件。
- Chrome 首次连续下载多个文件时可能弹出“是否允许下载多个文件”，请允许。
- 如果 `GM_download` 不可用，脚本会尝试 Blob 下载或打开直链另存为。

### 会不会自动下载非视频内容？

不会。按钮只在 `data-testid="videoPlayer"` 视频播放器（或没有标准容器但确实存在的 `<video>`）上尝试插入，并且必须能找到推文身份；纯图片区域没有视频播放器，不会插入按钮。

## 配置

脚本开头有少量可调参数：

```js
const CONFIG = {
  captureNetwork: true,          // 是否抓取页面自身的视频接口响应
  useFxTwitterFallback: true,    // 官方方式都失败后，是否使用 FXTwitter
  buttonBottom: 52,              // 按钮距视频底部的像素
  apiTimeout: 12_000,
  pageTimeout: 12_000,
  cacheTTL: 30 * 60_000,
};
```

如果把 `buttonBottom` 改小（例如 `12`），按钮会更贴近视频角落，但可能挡住 X 原生的全屏/设置按钮。

## 开发与测试

测试用 Playwright 驱动本机 Chrome，并拦截 `https://x.com` 请求来模拟推文页面，**不会访问真实 X，也不会下载真实视频**。

环境要求：Node.js 20+、Chrome、pnpm。

```bash
pnpm install
pnpm test
```

默认使用 `C:\Program Files\Google\Chrome\Application\chrome.exe`。Chrome 装在别处时：

```powershell
$env:CHROME_PATH = 'D:\path\to\chrome.exe'
pnpm test
```

测试覆盖：

- 只在视频上显示按钮，位置在视频右下角，纯图片推文无按钮；
- 点击后通过官方接口选择最高码率 MP4，且不触发页面点击；
- fetch / XHR 两种页面接口数据捕获；
- 只有缩略图、尚无 `<video>` 标签的播放器；
- 播放器复用并切换媒体时按当前视频下载；
- DOM 被 React 重建后补回按钮，新加载视频出现按钮；
- 引用推文自己的编号；
- 引用卡片缺少时间戳时的 `mediaId → tweetId` 反查；
- HTML 元数据回退、FXTwitter 回退；
- 只有 HLS 时的明确失败。

## 文件结构

```text
.
├─ x-video-downloader.user.js   # 油猴脚本（安装这个）
├─ README.md
├─ package.json
├─ pnpm-lock.yaml
└─ test/
   └─ run-tests.mjs             # 浏览器自动化测试
```

## 声明

- 脚本仅用于下载你有权访问、且用于个人存档或合理用途的视频。
- 下载内容的版权归原作者所有；请遵守 X 的服务条款和当地法律，不要用于大规模抓取、转售或侵权传播。
- 解析依赖 X 的页面结构与非公开网页接口，X 改版后可能失效；脚本已提供多级回退，但不能保证长期可用。
