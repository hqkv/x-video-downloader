// ==UserScript==
// @name         X 视频下载按钮
// @name:en      X Video Downloader Button
// @namespace    https://github.com/x-video-downloader
// @version      1.0.0
// @description  在 X (Twitter) 视频右下角添加下载按钮，自动选择最高画质的 MP4，没有视频的推文不会出现按钮。
// @author       x-video-downloader
// @license      MIT
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://mobile.twitter.com/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        unsafeWindow
// @connect      x.com
// @connect      twitter.com
// @connect      cdn.syndication.twimg.com
// @connect      api.fxtwitter.com
// @connect      video.twimg.com
// ==/UserScript==

(function () {
  'use strict';

  /* ----------------------------------------------------------------------- *
   * 配置
   * ----------------------------------------------------------------------- */

  const CONFIG = {
    // 抓取页面自身的 GraphQL 响应，通常是最准确、最高画质的来源。
    captureNetwork: true,
    // 官方接口失败后，最后尝试第三方只读 API（只发送推文数字 ID，不发送 Cookie）。
    // 如果你不想请求第三方服务，把这一项改成 false。
    useFxTwitterFallback: true,
    // 按钮距离视频底部的像素。放在原生控制条上方，避免挡住全屏按钮。
    buttonBottom: 52,
    apiTimeout: 12_000,
    pageTimeout: 12_000,
    cacheTTL: 30 * 60_000,
  };

  const PLAYER_SELECTOR = '[data-testid="videoPlayer"]';
  const TWEET_SELECTOR = '[data-testid="tweet"]';
  const UI_ATTR = 'data-xvd-ui';
  const LOG_PREFIX = '[X 视频下载]';

  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  /* ----------------------------------------------------------------------- *
   * 通用小工具
   * ----------------------------------------------------------------------- */

  function log(...args) {
    try {
      console.debug(LOG_PREFIX, ...args);
    } catch (_) {
      /* ignore */
    }
  }

  function warn(...args) {
    try {
      console.warn(LOG_PREFIX, ...args);
    } catch (_) {
      /* ignore */
    }
  }

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function toAbsoluteUrl(value) {
    if (typeof value !== 'string' || !value) return '';
    try {
      return new URL(value, page.location.href).href;
    } catch (_) {
      return '';
    }
  }

  function isHttpUrl(value) {
    return /^https?:\/\//i.test(value);
  }

  function normalizeMediaId(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value !== 'string') return null;
    let result = value.trim();
    // media_key 的格式是 "7_1234567890123456789"
    result = result.replace(/^\d+_/, '');
    if (!/^\d{5,25}$/.test(result)) return null;
    return result;
  }

  function mediaIdFromUrl(value) {
    if (typeof value !== 'string' || !value) return null;
    const match = value.match(
      /(?:amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb|amplify_video|ext_tw_video|tweet_video)\/(\d{5,25})(?:[/?#]|$)/
    );
    return match ? match[1] : null;
  }

  function parseDimensions(url) {
    if (typeof url !== 'string') return {};
    const patterns = [
      /\/vid\/[^/]+\/(\d{2,5})x(\d{2,5})\//i,
      /\/(\d{2,5})x(\d{2,5})\//,
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        const width = Number(match[1]);
        const height = Number(match[2]);
        if (width >= 16 && height >= 16) return { width, height };
      }
    }
    return {};
  }

  function hashString(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function sanitizeFilenamePart(value) {
    const cleaned = String(value || '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 64);
    return cleaned || 'x';
  }

  /* ----------------------------------------------------------------------- *
   * 视频数据：抓取、归一化、选择最高画质
   * ----------------------------------------------------------------------- */

  const capturedMedia = new Map(); // mediaId/hash -> { id, mediaId, variants: Map }
  const capturedByTweet = new Map(); // tweetId -> Set<mediaKey>
  const capturedTweetAuthors = new Map(); // tweetId -> screen_name
  const resolvedCache = new Map(); // cacheKey -> { value, expiresAt }

  function normalizeVariant(raw) {
    if (!isObject(raw)) return null;
    let url = raw.url || raw.src || '';
    if (typeof url !== 'string') return null;
    url = url.trim().replace(/&amp;/g, '&');
    if (!isHttpUrl(url)) return null;

    const contentType = String(
      raw.content_type || raw.contentType || raw.mime_type || raw.mimeType || ''
    );
    const container = String(raw.container || '');
    let bitrate = Number(raw.bitrate || raw.bit_rate || 0);
    if (!Number.isFinite(bitrate) || bitrate < 0) bitrate = 0;

    return {
      url,
      content_type: contentType,
      container,
      bitrate,
    };
  }

  function isMp4Variant(variant) {
    if (!variant || !variant.url) return false;
    if (/\.m3u8(?:[?#]|$)/i.test(variant.url)) return false;
    if (/^video\/mp4/i.test(variant.content_type)) return true;
    if (/^mp4$/i.test(variant.container)) return true;
    return /\.mp4(?:[?#]|$)/i.test(variant.url);
  }

  function normalizeVariants(list) {
    const result = new Map();
    if (!Array.isArray(list)) return result;
    for (const raw of list) {
      const variant = normalizeVariant(raw);
      if (!variant) continue;
      if (!result.has(variant.url)) result.set(variant.url, variant);
    }
    return result;
  }

  function mediaIdFromMediaNode(node) {
    if (!isObject(node)) return null;
    const direct = normalizeMediaId(node.id_str) || normalizeMediaId(node.media_key) || normalizeMediaId(node.id);
    if (direct) return direct;

    const urls = [
      node.media_url_https,
      node.media_url,
      node.preview_image_url,
      node.url,
    ];
    for (const value of urls) {
      const id = mediaIdFromUrl(value);
      if (id) return id;
    }
    return null;
  }

  function registerCapturedMedia({ tweetId, mediaId, variants, source, author }) {
    const normalized = normalizeVariants(variants);
    if (!normalized.size) return null;

    if (tweetId && author) capturedTweetAuthors.set(tweetId, author);

    let normalizedId = normalizeMediaId(mediaId);
    if (!normalizedId) {
      const urls = [...normalized.keys()].sort();
      const syntheticKey = `h_${hashString(urls.join('|'))}`;
      let entry = capturedMedia.get(syntheticKey);
      if (!entry) {
        entry = {
          id: syntheticKey,
          mediaId: null,
          variants: new Map(),
          sources: new Set(),
          tweetIds: new Set(),
        };
        capturedMedia.set(syntheticKey, entry);
      }
      for (const [url, variant] of normalized) entry.variants.set(url, variant);
      if (source) entry.sources.add(source);
      if (tweetId) {
        entry.tweetIds.add(tweetId);
        if (!capturedByTweet.has(tweetId)) capturedByTweet.set(tweetId, new Set());
        capturedByTweet.get(tweetId).add(syntheticKey);
      }
      return entry;
    }

    let entry = capturedMedia.get(normalizedId);
    if (!entry) {
      entry = {
        id: normalizedId,
        mediaId: normalizedId,
        variants: new Map(),
        sources: new Set(),
        tweetIds: new Set(),
      };
      capturedMedia.set(normalizedId, entry);
    }
    for (const [url, variant] of normalized) entry.variants.set(url, variant);
    if (source) entry.sources.add(source);
    if (tweetId) {
      entry.tweetIds.add(tweetId);
      if (!capturedByTweet.has(tweetId)) capturedByTweet.set(tweetId, new Set());
      capturedByTweet.get(tweetId).add(normalizedId);
    }
    return entry;
  }

  function extractTweetAuthor(node) {
    try {
      const users = [
        node.core && node.core.user_results && node.core.user_results.result,
        node.user_results && node.user_results.result,
      ].filter(isObject);
      for (const user of users) {
        const screenName =
          (user.core && user.core.screen_name) ||
          (user.legacy && user.legacy.screen_name) ||
          user.screen_name;
        if (typeof screenName === 'string' && screenName) return screenName;
      }
      const legacyUser = node.legacy && node.legacy.user;
      if (legacyUser && typeof legacyUser.screen_name === 'string') {
        return legacyUser.screen_name;
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function isTweetNode(node) {
    if (!isObject(node)) return false;
    if (node.__typename === 'User' || (node.legacy && node.legacy.screen_name)) return false;
    if (node.__typename === 'Tweet') return true;
    const legacy = node.legacy;
    return Boolean(
      isObject(legacy) &&
        (legacy.full_text !== undefined ||
          legacy.extended_entities ||
          legacy.created_at ||
          legacy.entities)
    );
  }

  function walkForVideoData(root, callback) {
    const seen = new WeakSet();
    let visited = 0;

    function walk(node, inheritedTweetId, inheritedAuthor) {
      if (!isObject(node) || seen.has(node) || visited > 100_000) return;
      seen.add(node);
      visited += 1;

      if (Array.isArray(node)) {
        for (const item of node) walk(item, inheritedTweetId, inheritedAuthor);
        return;
      }

      let tweetId = inheritedTweetId;
      let author = inheritedAuthor;
      if (isTweetNode(node)) {
        const candidate =
          normalizeMediaId(node.rest_id) ||
          normalizeMediaId(node.legacy && node.legacy.id_str);
        if (candidate) tweetId = candidate;
        const nodeAuthor = extractTweetAuthor(node);
        if (nodeAuthor) author = nodeAuthor;
      }

      const videoInfo = node.video_info;
      if (isObject(videoInfo) && Array.isArray(videoInfo.variants)) {
        callback({
          tweetId,
          author,
          mediaId: mediaIdFromMediaNode(node),
          variants: videoInfo.variants,
          duration: videoInfo.duration_millis || node.duration_millis,
        });
        // video_info 内部不会再有推文媒体数据。
        return;
      }

      // 第三方接口有时直接返回 { variants: [...] }。
      if (
        Array.isArray(node.variants) &&
        node.variants.some(
          (variant) =>
            isObject(variant) &&
            (variant.content_type || variant.bitrate || variant.container)
        )
      ) {
        callback({
          tweetId,
          author,
          mediaId: mediaIdFromMediaNode(node),
          variants: node.variants,
        });
        return;
      }

      for (const key of Object.keys(node)) {
        const value = node[key];
        if (isObject(value)) walk(value, tweetId, author);
      }
    }

    walk(root, null, null);
  }

  function ingestPayload(text, sourceUrl) {
    if (typeof text !== 'string' || text.length < 30) return 0;
    if (!text.includes('video_info') && !text.includes('"variants"')) return 0;

    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return 0;
    }

    let count = 0;
    walkForVideoData(data, (media) => {
      const entry = registerCapturedMedia({
        tweetId: media.tweetId,
        author: media.author,
        mediaId: media.mediaId,
        variants: media.variants,
        source: sourceUrl,
      });
      if (entry) count += 1;
    });
    if (count) {
      log(`从接口捕获 ${count} 组视频数据`, sourceUrl);
      // 有些引用推文没有可读的时间戳链接；拿到接口数据后需要重新扫描补按钮。
      try {
        scheduleScan(120);
      } catch (_) {
        /* ignore */
      }
    }
    return count;
  }

  function isTweetApiUrl(value) {
    if (!value) return false;
    const absolute = toAbsoluteUrl(String(value));
    if (!absolute) return false;
    try {
      const url = new URL(absolute);
      const sameOrigin = url.origin === page.location.origin;
      if (
        !sameOrigin &&
        !/(^|\.)x\.com$/i.test(url.hostname) &&
        !/(^|\.)twitter\.com$/i.test(url.hostname)
      ) {
        return false;
      }
      return (
        /\/graphql\//.test(url.pathname) ||
        /\/1\.1\/statuses\/show/.test(url.pathname) ||
        /\/1\.1\/videos\/tweet\/config/.test(url.pathname)
      );
    } catch (_) {
      return false;
    }
  }

  function installNetworkCapture() {
    if (!CONFIG.captureNetwork) return;

    const hookFlag = '__xvdNetworkHookV1';
    try {
      if (page[hookFlag]) return;
      page[hookFlag] = true;
    } catch (_) {
      return;
    }

    // 1) fetch
    try {
      const nativeFetch = page.fetch;
      if (typeof nativeFetch === 'function') {
        const wrappedFetch = function (...args) {
          const promise = nativeFetch.apply(page, args);
          try {
            const input = args[0];
            const requestUrl =
              typeof input === 'string' ? input : input && input.url ? input.url : '';
            if (requestUrl && isTweetApiUrl(requestUrl)) {
              Promise.resolve(promise).then(
                (response) => {
                  try {
                    if (!response || !response.ok || typeof response.clone !== 'function') return;
                    const contentType = response.headers.get('content-type') || '';
                    if (!/json/i.test(contentType)) return;
                    const length = Number(response.headers.get('content-length') || 0);
                    if (length > 16_000_000) return;
                    response
                      .clone()
                      .text()
                      .then((text) => ingestPayload(text, requestUrl))
                      .catch(() => {});
                  } catch (_) {
                    /* ignore */
                  }
                },
                () => {}
              );
            }
          } catch (_) {
            /* ignore */
          }
          return promise;
        };
        page.fetch = wrappedFetch;
      }
    } catch (error) {
      warn('fetch 拦截不可用，将使用接口回退方案', error);
    }

    // 2) XMLHttpRequest
    try {
      const XHR = page.XMLHttpRequest;
      if (XHR && XHR.prototype) {
        const nativeOpen = XHR.prototype.open;
        const nativeSend = XHR.prototype.send;
        XHR.prototype.open = function (method, url, ...rest) {
          try {
            this.__xvdRequestUrl = String(url || '');
          } catch (_) {
            /* ignore */
          }
          return nativeOpen.call(this, method, url, ...rest);
        };
        XHR.prototype.send = function (...args) {
          try {
            const requestUrl = this.__xvdRequestUrl;
            if (requestUrl && isTweetApiUrl(requestUrl)) {
              this.addEventListener('load', () => {
                try {
                  if (this.status < 200 || this.status >= 300) return;
                  let text = '';
                  if (this.responseType === '' || this.responseType === 'text') {
                    text = this.responseText;
                  } else if (this.responseType === 'json' && this.response) {
                    text = JSON.stringify(this.response);
                  }
                  if (text) ingestPayload(text, requestUrl);
                } catch (_) {
                  /* ignore */
                }
              });
            }
          } catch (_) {
            /* ignore */
          }
          return nativeSend.apply(this, args);
        };
      }
    } catch (error) {
      warn('XHR 拦截不可用，将使用接口回退方案', error);
    }
  }

  function bestMp4Variant(variants) {
    if (!variants || typeof variants.values !== 'function') return null;
    const list = [];
    for (const variant of variants.values()) {
      if (!isMp4Variant(variant)) continue;
      const dimensions = parseDimensions(variant.url);
      list.push({
        ...variant,
        ...dimensions,
        area: (dimensions.width || 0) * (dimensions.height || 0),
      });
    }
    if (!list.length) return null;

    list.sort((a, b) => {
      if (b.bitrate !== a.bitrate) return b.bitrate - a.bitrate;
      if (b.area !== a.area) return b.area - a.area;
      return a.url.localeCompare(b.url);
    });

    const best = list[0];
    return {
      url: best.url,
      bitrate: best.bitrate,
      width: best.width || null,
      height: best.height || null,
      qualityLabel:
        best.width && best.height ? `${best.width}×${best.height}` : best.bitrate ? `${Math.round(best.bitrate / 1000)} kbps` : '',
    };
  }

  function pickBestFromSets(sets, record) {
    if (!Array.isArray(sets) || !sets.length) return null;

    const mediaId = record.mediaId || getMediaId(record);
    if (mediaId) {
      const exact = sets.find((set) => set.mediaId === mediaId);
      if (exact) {
        const best = bestMp4Variant(exact.variants);
        if (best) return best;
      }
    }

    if (sets.length === 1) return bestMp4Variant(sets[0].variants);

    if (Number.isInteger(record.index) && record.index >= 0 && record.index < sets.length) {
      const indexedBest = bestMp4Variant(sets[record.index].variants);
      if (indexedBest) return indexedBest;
    }

    // 多视频推文且无法精确对应时，优先第一个确实含 MP4 的视频。
    for (const set of sets) {
      const best = bestMp4Variant(set.variants);
      if (best) return best;
    }
    return null;
  }

  function getCapturedSets(record) {
    const result = [];
    const seen = new Set();

    const mediaId = record.mediaId || getMediaId(record);
    if (mediaId && capturedMedia.has(mediaId)) {
      result.push(capturedMedia.get(mediaId));
      seen.add(mediaId);
    }

    const tweetIds = new Set();
    if (record.statusId) tweetIds.add(record.statusId);
    if (record.mediaTweetId) tweetIds.add(record.mediaTweetId);

    for (const tweetId of tweetIds) {
      const keys = capturedByTweet.get(tweetId);
      if (!keys) continue;
      for (const key of keys) {
        if (seen.has(key)) continue;
        const entry = capturedMedia.get(key);
        if (entry) {
          result.push(entry);
          seen.add(key);
        }
      }
    }
    return result;
  }

  /**
   * 引用推文卡片本身可能没有 href/时间戳，此时用接口里的 mediaId -> tweetId
   * 反向对应，避免把外层推文的编号套到引用视频上。
   */
  function applyCapturedIdentity(record) {
    const mediaId = record.mediaId || getMediaId(record);
    if (!mediaId) return false;
    const entry = capturedMedia.get(mediaId);
    if (!entry || !entry.tweetIds || entry.tweetIds.size !== 1) return false;

    const [tweetId] = entry.tweetIds;
    const author = capturedTweetAuthors.get(tweetId) || null;
    let changed = false;
    if (tweetId !== record.statusId) {
      record.statusId = tweetId;
      changed = true;
    }
    if (author && author !== record.handle) {
      record.handle = author;
      changed = true;
    }
    return changed;
  }

  /* ----------------------------------------------------------------------- *
   * 网络请求（GM_xmlhttpRequest 优先，便于跨域并带上登录 Cookie）
   * ----------------------------------------------------------------------- */

  const gmRequest =
    typeof GM_xmlhttpRequest === 'function'
      ? GM_xmlhttpRequest
      : typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function'
        ? GM.xmlHttpRequest
        : null;

  async function requestText(url, { timeout = CONFIG.apiTimeout, headers = {} } = {}) {
    const requestHeaders = {
      Accept: 'application/json, text/plain, */*',
      ...headers,
    };

    if (gmRequest) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          fn(value);
        };

        try {
          gmRequest({
            method: 'GET',
            url,
            timeout,
            headers: requestHeaders,
            onload(response) {
              if (response.status >= 200 && response.status < 300) {
                finish(resolve, response.responseText || '');
              } else {
                finish(reject, new Error(`HTTP ${response.status || '错误'}`));
              }
            },
            onerror(response) {
              finish(reject, new Error((response && response.error) || '网络错误'));
            },
            ontimeout() {
              finish(reject, new Error('请求超时'));
            },
          });
        } catch (error) {
          finish(reject, error);
        }
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        credentials: 'include',
        headers: requestHeaders,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  function syndicationToken(tweetId) {
    try {
      const value = (Number(tweetId) / 1e15) * Math.PI;
      return value.toString(36).replace(/(0+|\.)/g, '');
    } catch (_) {
      return '';
    }
  }

  function collectVariantSetsFromJson(data) {
    const byKey = new Map();
    const order = [];

    walkForVideoData(data, (media) => {
      const variants = normalizeVariants(media.variants);
      if (!variants.size) return;
      const mediaId = normalizeMediaId(media.mediaId);
      let key = mediaId;
      if (!key) {
        const urls = [...variants.keys()].sort();
        key = `h_${hashString(urls.join('|'))}`;
      }
      let set = byKey.get(key);
      if (!set) {
        set = { mediaId, variants: new Map() };
        byKey.set(key, set);
        order.push(set);
      }
      for (const [url, variant] of variants) set.variants.set(url, variant);
    });

    return order;
  }

  async function fetchSyndicationSets(tweetId) {
    const token = syndicationToken(tweetId);
    const urls = [
      `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(tweetId)}&lang=en&token=${encodeURIComponent(token)}`,
      `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(tweetId)}&lang=en`,
    ];

    for (const url of urls) {
      try {
        const text = await requestText(url, { timeout: CONFIG.apiTimeout });
        if (!text || !text.includes('variants')) continue;
        const data = JSON.parse(text);
        const sets = collectVariantSetsFromJson(data);
        if (sets.length) {
          log('官方 syndication 接口返回视频数据');
          return sets;
        }
      } catch (error) {
        log('syndication 请求失败', error && error.message);
      }
    }
    return [];
  }

  function parseVideoUrlsFromHtml(html) {
    if (typeof html !== 'string' || !html) return [];
    const normalized = html
      .replace(/\\u0026/gi, '&')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&');

    const urls = new Set();
    const add = (value) => {
      if (typeof value !== 'string') return;
      let url = value.trim().replace(/&quot;?$/, '').replace(/[),.;]+$/, '');
      if (!isHttpUrl(url)) return;
      try {
        const parsed = new URL(url);
        if (parsed.hostname !== 'video.twimg.com') return;
        if (!/\.mp4$/i.test(parsed.pathname)) return;
        urls.add(parsed.href);
      } catch (_) {
        /* ignore */
      }
    };

    // 优先读取当前推文的 Open Graph / Twitter Player 元数据。
    const metaPattern =
      /<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:video(?::secure_url|:url)?|twitter:player:stream)["'][^>]*>/gi;
    let metaMatch;
    let foundMeta = false;
    while ((metaMatch = metaPattern.exec(normalized))) {
      const tag = metaMatch[0];
      const contentMatch = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i);
      if (contentMatch) {
        const before = urls.size;
        add(contentMatch[1]);
        if (urls.size > before) foundMeta = true;
      }
    }

    if (!foundMeta) {
      const urlPattern = /https?:\/\/video\.twimg\.com\/[^\s"'<>\\]+/gi;
      let urlMatch;
      let guard = 0;
      while ((urlMatch = urlPattern.exec(normalized)) && guard < 200) {
        guard += 1;
        add(urlMatch[0]);
      }
    }

    return [...urls];
  }

  function setsFromPlainUrls(urls) {
    const sets = [];
    const byId = new Map();
    for (const url of urls) {
      const mediaId = mediaIdFromUrl(url) || `h_${hashString(url)}`;
      let set = byId.get(mediaId);
      if (!set) {
        set = { mediaId: mediaId.startsWith('h_') ? null : mediaId, variants: new Map() };
        byId.set(mediaId, set);
        sets.push(set);
      }
      const variant = normalizeVariant({ url, content_type: 'video/mp4' });
      if (variant) set.variants.set(variant.url, variant);
    }
    return sets.filter((set) => set.variants.size);
  }

  async function fetchPageSets(record) {
    const urls = [
      `https://x.com/i/status/${encodeURIComponent(record.statusId)}`,
    ];
    if (record.handle) {
      urls.push(
        `https://x.com/${encodeURIComponent(record.handle)}/status/${encodeURIComponent(record.statusId)}`
      );
    }

    for (const url of urls) {
      try {
        const html = await requestText(url, {
          timeout: CONFIG.pageTimeout,
          headers: { Accept: 'text/html,application/xhtml+xml' },
        });
        const videoUrls = parseVideoUrlsFromHtml(html);
        if (videoUrls.length) {
          const sets = setsFromPlainUrls(videoUrls);
          if (sets.length) {
            log('推文页面 HTML 中找到视频直链');
            return sets;
          }
        }
      } catch (error) {
        log('页面 HTML 回退失败', error && error.message);
      }
    }
    return [];
  }

  async function fetchFxTwitterSets(tweetId) {
    if (!CONFIG.useFxTwitterFallback) return [];
    try {
      const text = await requestText(
        `https://api.fxtwitter.com/status/${encodeURIComponent(tweetId)}`,
        {
          timeout: CONFIG.apiTimeout,
          headers: { Accept: 'application/json' },
        }
      );
      const data = JSON.parse(text);
      if (!data || data.code !== 200) return [];
      const sets = collectVariantSetsFromJson(data);
      if (sets.length) log('FXTwitter 回退接口返回视频数据');
      return sets;
    } catch (error) {
      log('FXTwitter 回退失败', error && error.message);
      return [];
    }
  }

  /* ----------------------------------------------------------------------- *
   * 下载
   * ----------------------------------------------------------------------- */

  function downloadWithGM(url, filename) {
    const gmDownload =
      typeof GM_download === 'function'
        ? GM_download
        : typeof GM !== 'undefined' && GM && typeof GM.download === 'function'
          ? GM.download
          : null;

    if (gmDownload) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          fn(value);
        };
        try {
          gmDownload({
            url,
            name: filename,
            saveAs: false,
            onload() {
              finish(resolve);
            },
            onerror(error) {
              const detail =
                (error && (error.details || error.error || error.message)) || '下载失败';
              finish(reject, new Error(String(detail)));
            },
            ontimeout() {
              finish(reject, new Error('下载超时'));
            },
          });
        } catch (error) {
          finish(reject, error);
        }
      });
    }

    // 非 Tampermonkey 环境：GM_xmlhttpRequest 取回 Blob 再触发浏览器下载。
    if (gmRequest) {
      return new Promise((resolve, reject) => {
        try {
          gmRequest({
            method: 'GET',
            url,
            responseType: 'blob',
            timeout: 120_000,
            onload(response) {
              try {
                if (response.status < 200 || response.status >= 300) {
                  reject(new Error(`HTTP ${response.status}`));
                  return;
                }
                const blob = response.response;
                if (!(blob instanceof Blob)) {
                  reject(new Error('无法读取视频文件'));
                  return;
                }
                const objectUrl = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = objectUrl;
                anchor.download = filename;
                anchor.style.display = 'none';
                document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();
                setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
                resolve();
              } catch (error) {
                reject(error);
              }
            },
            onerror(error) {
              reject(new Error((error && error.error) || '下载失败'));
            },
            ontimeout() {
              reject(new Error('下载超时'));
            },
          });
        } catch (error) {
          reject(error);
        }
      });
    }

    // 最后的兜底：打开直链，让用户自行另存为。
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    showToast('已打开视频直链，请在页面中右键另存为', 'info', 6000);
    return Promise.resolve();
  }

  /* ----------------------------------------------------------------------- *
   * 状态识别
   * ----------------------------------------------------------------------- */

  function parseStatusHref(value) {
    if (!value) return null;
    let url;
    try {
      url = new URL(value, page.location.href);
    } catch (_) {
      return null;
    }
    if (!/(^|\.)x\.com$/i.test(url.hostname) && !/(^|\.)twitter\.com$/i.test(url.hostname)) {
      return null;
    }
    let match = url.pathname.match(/^\/([^/]+)\/status\/(\d{5,25})(?:\/|$)/);
    if (match && match[1] !== 'i') {
      return { statusId: match[2], handle: decodeURIComponent(match[1]) };
    }
    match = url.pathname.match(/^\/i\/web\/status\/(\d{5,25})(?:\/|$)/) ||
      url.pathname.match(/^\/i\/status\/(\d{5,25})(?:\/|$)/);
    if (match) return { statusId: match[1], handle: null };
    return null;
  }

  function findStatusInfoInScope(scope) {
    if (!scope) return null;

    const isOwnedByScope = (element) => {
      const owner = element.closest(TWEET_SELECTOR) || element.closest('article');
      // 排除嵌套引用推文里的链接，只取当前 scope 自己的时间戳链接。
      return !owner || owner === scope;
    };

    const timedLinks = scope.querySelectorAll('a[href*="/status/"] time');
    for (const time of timedLinks) {
      if (!isOwnedByScope(time)) continue;
      const anchor = time.closest('a');
      const info = anchor && parseStatusHref(anchor.getAttribute('href'));
      if (info) return info;
    }

    const anchors = scope.querySelectorAll('a[href*="/status/"]');
    for (const anchor of anchors) {
      if (!isOwnedByScope(anchor)) continue;
      const href = anchor.getAttribute('href') || '';
      // 排除“分析/转推列表”等非主链接，但仍允许 /video/1。
      if (!/\/status\/\d+/.test(href)) continue;
      const info = parseStatusHref(href);
      if (info) return info;
    }

    return null;
  }

  function findTweetScope(element) {
    return (
      element.closest(TWEET_SELECTOR) ||
      element.closest('article[role="article"]') ||
      element.closest('article') ||
      null
    );
  }

  function getStatusInfo(container, scope) {
    let info = findStatusInfoInScope(scope);

    if (!info) {
      const pageInfo = parseStatusHref(page.location.href);
      if (pageInfo) {
        const rect = container.getBoundingClientRect();
        const inOverlay = Boolean(
          container.closest('[role="dialog"], [data-testid="swipeToDismiss"], [data-testid="mask"]')
        );
        // 详情页的媒体浮层通常不在 article 内；窄屏也要能显示按钮。
        if (inOverlay || !scope || rect.width >= 300) info = pageInfo;
      }
    }

    return info;
  }

  function getMediaId(record) {
    const urls = [];
    const video = record.video;

    if (video) {
      if (video.poster) urls.push(video.poster);
      if (video.currentSrc) urls.push(video.currentSrc);
      if (video.src) urls.push(video.src);
      for (const source of video.querySelectorAll('source')) {
        if (source.src) urls.push(source.src);
      }
    }

    const container = record.container;
    if (container) {
      if (container.getAttribute && container.getAttribute('poster')) {
        urls.push(container.getAttribute('poster'));
      }
      const images = container.querySelectorAll(
        'img[src*="amplify_video_thumb"], img[src*="ext_tw_video_thumb"], img[src*="tweet_video_thumb"]'
      );
      for (const image of images) {
        if (image.currentSrc) urls.push(image.currentSrc);
        if (image.src) urls.push(image.src);
      }
    }

    for (const url of urls) {
      const mediaId = mediaIdFromUrl(url);
      if (mediaId) return mediaId;
    }
    return null;
  }

  function getDirectMp4(record) {
    const video = record.video;
    if (!video) return null;
    const candidates = [];
    if (video.currentSrc) candidates.push(video.currentSrc);
    if (video.src) candidates.push(video.src);
    for (const source of video.querySelectorAll('source')) {
      if (source.src) candidates.push(source.src);
    }
    for (const url of candidates) {
      if (!isHttpUrl(url)) continue;
      if (!isMp4Variant({ url, content_type: '' })) continue;
      const dimensions = parseDimensions(url);
      return {
        url,
        bitrate: 0,
        width: dimensions.width || null,
        height: dimensions.height || null,
        qualityLabel:
          dimensions.width && dimensions.height
            ? `${dimensions.width}×${dimensions.height}`
            : '',
      };
    }
    return null;
  }

  function getPageVideoIndex(container, scope, video) {
    if (!scope) return { index: 0, total: 1 };
    const players = [...scope.querySelectorAll(PLAYER_SELECTOR)].filter(
      (element) => !element.closest(`[${UI_ATTR}]`)
    );
    if (players.length) {
      const index = players.indexOf(container);
      if (index >= 0) return { index, total: players.length };
    }
    const videos = [...scope.querySelectorAll('video')];
    if (video) {
      const index = videos.indexOf(video);
      if (index >= 0) return { index, total: videos.length };
    }
    return { index: 0, total: 1 };
  }

  function buildFilename(record, best) {
    const id = record.statusId || 'unknown';
    let handle = record.handle;
    const pageInfo = parseStatusHref(page.location.href);
    if ((!handle || handle === 'i') && pageInfo && pageInfo.statusId === id) {
      handle = pageInfo.handle;
    }
    const handlePart = handle ? sanitizeFilenamePart(handle) : '';
    const parts = ['x'];
    if (handlePart) parts.push(handlePart);
    parts.push(sanitizeFilenamePart(id));
    if (record.total > 1) parts.push(`v${record.index + 1}`);
    if (best.width && best.height) parts.push(`${best.width}x${best.height}`);
    return `${parts.join('_')}.mp4`;
  }

  /**
   * 轮播/媒体切换时 X 可能复用同一个播放器。点击前重新读取当前 poster，
   * 避免下载成上一个视频。
   */
  function syncRecordTarget(record) {
    if (!record.container) return;
    const currentVideo = findVideoElement(record.container);
    if (currentVideo && currentVideo !== record.video) record.video = currentVideo;
    const freshMediaId = getMediaId(record);
    if (freshMediaId && freshMediaId !== record.mediaId) {
      record.mediaId = freshMediaId;
      applyCapturedIdentity(record);
    }
  }

  /* ----------------------------------------------------------------------- *
   * 解析下载地址（多级回退）
   * ----------------------------------------------------------------------- */

  async function resolveVideo(record) {
    syncRecordTarget(record);
    record.mediaId = record.mediaId || getMediaId(record);
    applyCapturedIdentity(record);
    const cacheKey = `${record.statusId}:${record.index}:${record.mediaId || ''}`;
    const cached = resolvedCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    function remember(value) {
      if (value) resolvedCache.set(cacheKey, { value, expiresAt: Date.now() + CONFIG.cacheTTL });
      return value;
    }

    // 1) 当前页面真实接口响应
    const capturedSets = getCapturedSets(record);
    if (capturedSets.length) {
      const best = pickBestFromSets(capturedSets, record);
      if (best) {
        log('使用页面接口捕获的视频地址', best.url);
        return remember({ ...best, source: 'captured' });
      }
    }

    // 2) video 标签本身就是 MP4 直链
    const direct = getDirectMp4(record);
    if (direct) {
      log('使用 video 标签直链', direct.url);
      return remember({ ...direct, source: 'direct' });
    }

    if (!record.statusId) {
      throw new Error('找不到推文编号，请打开推文详情页后重试');
    }

    // 3) 官方 syndication 接口
    const syndicationSets = await fetchSyndicationSets(record.statusId);
    if (syndicationSets.length) {
      const best = pickBestFromSets(syndicationSets, record);
      if (best) return remember({ ...best, source: 'syndication' });
    }

    // 4) 推文页面 HTML 与第三方只读接口并行回退
    const [pageResult, fxResult] = await Promise.all([
      fetchPageSets(record).catch(() => []),
      fetchFxTwitterSets(record.statusId).catch(() => []),
    ]);

    for (const [sets, source] of [
      [pageResult, 'page'],
      [fxResult, 'fxtwitter'],
    ]) {
      if (!sets.length) continue;
      const best = pickBestFromSets(sets, record);
      if (best) {
        log(`使用 ${source} 回退地址`, best.url);
        return remember({ ...best, source });
      }
    }

    throw new Error('没有找到可下载的 MP4 视频地址（可能只有 HLS 流，或推文不可见）');
  }

  /* ----------------------------------------------------------------------- *
   * UI
   * ----------------------------------------------------------------------- */

  const records = new Set();
  const targetRecords = new WeakMap();
  let toastElement = null;
  let toastTimer = null;
  let scanTimer = null;
  let maintenanceTimer = null;
  let observer = null;
  let uiInstalled = false;

  const BUTTON_ICON_PATH =
    'M11 3a1 1 0 0 1 2 0v10.59l3.3-3.3a1 1 0 0 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V3ZM4 17a1 1 0 0 1 1 1v1h14v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z';

  function createButtonContent() {
    const icon = document.createElement('span');
    icon.className = 'xvd-icon';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', BUTTON_ICON_PATH);
    svg.appendChild(path);
    icon.appendChild(svg);

    const spinner = document.createElement('span');
    spinner.className = 'xvd-spinner';
    spinner.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'xvd-label';
    label.textContent = '下载';

    return { icon, spinner, label };
  }

  const BUTTON_STYLES = `
    .xvd-btn {
      all: unset;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      height: 30px;
      min-width: 58px;
      padding: 0 10px;
      border: 1px solid rgba(255, 255, 255, .32);
      border-radius: 999px;
      background: rgba(15, 20, 25, .82);
      box-shadow: 0 2px 10px rgba(0, 0, 0, .4);
      color: #fff;
      font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Microsoft YaHei", sans-serif;
      letter-spacing: .01em;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      pointer-events: auto;
      transition: background-color .15s ease, border-color .15s ease, transform .15s ease,
        opacity .15s ease;
    }
    .xvd-btn:hover {
      background: #1d9bf0;
      border-color: #1d9bf0;
    }
    .xvd-btn:active {
      transform: scale(.96);
    }
    .xvd-btn:focus-visible {
      outline: 2px solid #fff;
      outline-offset: 2px;
    }
    .xvd-btn[disabled] {
      cursor: default;
      opacity: .95;
    }
    .xvd-btn[data-state="error"] {
      background: #b91c1c;
      border-color: #ef4444;
    }
    .xvd-btn[data-state="success"] {
      background: #15803d;
      border-color: #22c55e;
    }
    .xvd-icon {
      display: inline-flex;
      width: 14px;
      height: 14px;
      flex: none;
    }
    .xvd-icon svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    .xvd-label {
      display: inline-block;
      line-height: 1;
    }
    .xvd-spinner {
      display: none;
      width: 12px;
      height: 12px;
      flex: none;
      box-sizing: border-box;
      border: 2px solid rgba(255, 255, 255, .35);
      border-top-color: #fff;
      border-radius: 50%;
      animation: xvd-spin .7s linear infinite;
    }
    .xvd-btn[data-state="loading"] .xvd-icon,
    .xvd-btn[data-state="working"] .xvd-icon {
      display: none;
    }
    .xvd-btn[data-state="loading"] .xvd-spinner,
    .xvd-btn[data-state="working"] .xvd-spinner {
      display: block;
    }
    @keyframes xvd-spin {
      to { transform: rotate(360deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      .xvd-btn { transition: none; }
      .xvd-spinner { animation-duration: 1.4s; }
    }
  `;

  function ensureToast() {
    if (toastElement && toastElement.isConnected) return toastElement;
    toastElement = document.createElement('div');
    toastElement.setAttribute('role', 'status');
    toastElement.setAttribute('aria-live', 'polite');
    Object.assign(toastElement.style, {
      position: 'fixed',
      left: '50%',
      bottom: '32px',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      maxWidth: 'min(86vw, 520px)',
      padding: '10px 14px',
      borderRadius: '10px',
      background: 'rgba(15, 20, 25, .94)',
      border: '1px solid rgba(255,255,255,.18)',
      boxShadow: '0 8px 30px rgba(0,0,0,.45)',
      color: '#fff',
      font: '13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      textAlign: 'center',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity .18s ease',
    });
    document.body.appendChild(toastElement);
    return toastElement;
  }

  function showToast(message, kind = 'info', duration = 4500) {
    if (!document.body) return;
    const element = ensureToast();
    element.textContent = message;
    element.style.borderColor =
      kind === 'error'
        ? 'rgba(239, 68, 68, .75)'
        : kind === 'success'
          ? 'rgba(34, 197, 94, .75)'
          : 'rgba(255,255,255,.18)';
    clearTimeout(toastTimer);
    requestAnimationFrame(() => {
      element.style.opacity = '1';
    });
    toastTimer = setTimeout(() => {
      element.style.opacity = '0';
    }, duration);
  }

  function setButtonState(record, state, label, detail) {
    const button = record.button;
    if (!button) return;
    button.dataset.state = state;
    button.disabled = state === 'loading' || state === 'working';
    if (record.labelElement) record.labelElement.textContent = label;
    const title = detail || (state === 'error' ? '点击重试' : '下载视频（最佳画质 MP4）');
    button.title = title;
    button.setAttribute('aria-label', state === 'error' ? `下载失败，点击重试` : title);
    button.setAttribute('aria-busy', state === 'loading' || state === 'working' ? 'true' : 'false');
  }

  function resetButtonSoon(record) {
    setTimeout(() => {
      if (record.busy) return;
      if (!record.host || !record.host.isConnected) return;
      setButtonState(record, 'idle', '下载');
    }, 3200);
  }

  async function handleDownload(record) {
    if (record.busy) return;
    record.busy = true;
    setButtonState(record, 'loading', '获取中', '正在解析视频地址…');

    try {
      const best = await resolveVideo(record);
      if (!best || !best.url) throw new Error('没有找到可下载的 MP4 视频地址');

      const filename = buildFilename(record, best);
      setButtonState(record, 'working', '下载中', `正在下载 ${filename}`);
      await downloadWithGM(best.url, filename);

      setButtonState(
        record,
        'success',
        '已保存',
        `${filename}${best.qualityLabel ? `（${best.qualityLabel}）` : ''}`
      );
      showToast(
        `已保存${best.qualityLabel ? ` ${best.qualityLabel}` : ''} MP4：${filename}`,
        'success'
      );
    } catch (error) {
      warn('下载失败', error);
      setButtonState(record, 'error', '失败', (error && error.message) || '下载失败');
      showToast(
        `下载失败：${(error && error.message) || '未知错误'}`,
        'error',
        6500
      );
    } finally {
      record.busy = false;
      resetButtonSoon(record);
    }
  }

  function createButton(record) {
    const host = document.createElement('div');
    host.className = 'xvd-host';
    host.setAttribute(UI_ATTR, '1');
    host.setAttribute('data-xvd-host', '1');
    const bottom = record.containerHeight && record.containerHeight > 0 && record.containerHeight < 170
      ? '8px'
      : `${CONFIG.buttonBottom}px`;
    Object.assign(host.style, {
      position: 'absolute',
      right: '10px',
      bottom,
      zIndex: '2147483000',
      display: 'block',
      width: 'auto',
      height: 'auto',
      margin: '0',
      padding: '0',
      lineHeight: '0',
      pointerEvents: 'none',
    });

    let root = null;
    let button = null;
    try {
      root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = BUTTON_STYLES;
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'xvd-btn';
      button.dataset.state = 'idle';
      const content = createButtonContent();
      button.append(content.icon, content.spinner, content.label);
      button.title = '下载视频（最佳画质 MP4）';
      button.setAttribute('aria-label', '下载视频（最佳画质 MP4）');
      root.append(style, button);
    } catch (_) {
      // 极端情况下没有 Shadow DOM：退回普通 DOM，并保留最基本的可用性。
      host.style.pointerEvents = 'auto';
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'xvd-btn';
      button.dataset.state = 'idle';
      const label = document.createElement('span');
      label.className = 'xvd-label';
      label.textContent = '下载';
      button.appendChild(label);
      button.style.cssText =
        'height:30px;padding:0 12px;border:1px solid rgba(255,255,255,.4);border-radius:999px;background:#000c;color:#fff;font:600 12px/1 sans-serif;cursor:pointer;pointer-events:auto;';
      host.appendChild(button);
    }

    record.host = host;
    record.button = button;
    record.labelElement = (root || host).querySelector('.xvd-label');

    // 阻止事件冒泡到 X 的“点击播放/打开推文”处理器。
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dblclick', 'keydown', 'keyup']) {
      button.addEventListener(type, (event) => event.stopPropagation(), true);
    }
    button.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleDownload(record);
      },
      true
    );

    return host;
  }

  function makePositioned(host) {
    if (!host || host.nodeType !== 1) return;
    try {
      const position = getComputedStyle(host).position;
      if (position === 'static') {
        host.style.position = 'relative';
        host.setAttribute('data-xvd-positioned', '1');
      }
    } catch (_) {
      /* ignore */
    }
  }

  function findHostElement(container, video) {
    let host = null;
    if (container && container.matches && container.matches(PLAYER_SELECTOR)) host = container;
    if (!host && video) {
      const player = video.closest(PLAYER_SELECTOR);
      if (player) host = player;
      if (!host) {
        host = video.closest('[data-testid="videoComponent"]') || video.parentElement || video;
      }
    }
    if (!host) host = container;
    // 万一 data-testid 将来直接挪到 <video> 上，按钮不能成为 video 的子节点。
    if (host && host.tagName === 'VIDEO') host = host.parentElement;
    return host;
  }

  function isElementVisible(element) {
    if (!element || !element.isConnected) return false;
    try {
      const rect = element.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 32) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function findVideoElement(container) {
    if (!container) return null;
    if (container.matches && container.matches('video')) return container;
    if (container.querySelector) {
      return container.querySelector('video');
    }
    return null;
  }

  function bindTarget(container, video) {
    if (!container || !container.isConnected) return null;
    if (container.closest(`[${UI_ATTR}]`)) return null;
    if (!isElementVisible(container) && !(video && isElementVisible(video))) return null;

    const scope = findTweetScope(container) || findTweetScope(video);
    let statusInfo = getStatusInfo(container, scope);
    const mediaId = getMediaId({ video, container });

    const capturedEntry = mediaId ? capturedMedia.get(mediaId) : null;
    if (capturedEntry && capturedEntry.tweetIds && capturedEntry.tweetIds.size === 1) {
      const [capturedTweetId] = capturedEntry.tweetIds;
      if (!statusInfo || statusInfo.statusId !== capturedTweetId) {
        statusInfo = {
          statusId: capturedTweetId,
          handle: capturedTweetAuthors.get(capturedTweetId) || null,
        };
      }
    }

    if (!statusInfo || !statusInfo.statusId) return null;

    const hostElement = findHostElement(container, video);
    if (!hostElement) return null;
    if (
      hostElement.querySelector(`:scope > [${UI_ATTR}]`) ||
      (video && video.parentElement && video.parentElement.querySelector(`:scope > [${UI_ATTR}]`))
    ) {
      return null;
    }

    makePositioned(hostElement);

    const { index, total } = getPageVideoIndex(container, scope, video);
    const rect = container.getBoundingClientRect();
    const record = {
      container,
      video: video || findVideoElement(container),
      scope,
      statusId: statusInfo.statusId,
      handle: statusInfo.handle,
      index,
      total,
      mediaId: mediaId || null,
      containerHeight: rect.height,
      busy: false,
    };

    record.mediaId = record.mediaId || getMediaId(record);
    applyCapturedIdentity(record);
    const host = createButton(record);

    try {
      hostElement.appendChild(host);
    } catch (error) {
      warn('无法插入下载按钮', error);
      return null;
    }

    targetRecords.set(container, record);
    records.add(record);
    return record;
  }

  function ensureRecordAlive(record) {
    if (!record.container || !record.container.isConnected) {
      if (record.host && record.host.isConnected) record.host.remove();
      records.delete(record);
      return false;
    }
    if (record.host && !record.host.isConnected) {
      try {
        record.hostElement = findHostElement(record.container, record.video);
        if (record.hostElement) record.hostElement.appendChild(record.host);
      } catch (_) {
        /* ignore */
      }
    }
    if (!record.video && record.container) {
      record.video = findVideoElement(record.container);
    }
    if (record.host) {
      const height = record.container.getBoundingClientRect().height;
      const bottom =
        height > 0 && height < 170 ? '8px' : `${CONFIG.buttonBottom}px`;
      if (record.host.style.bottom !== bottom) record.host.style.bottom = bottom;
    }
    return true;
  }

  function scan() {
    if (!document.body) return;

    for (const record of [...records]) ensureRecordAlive(record);

    // 只处理真正的视频播放器：没有视频的推文不会出现按钮。
    const players = document.querySelectorAll(PLAYER_SELECTOR);
    for (const player of players) {
      if (player.closest(`[${UI_ATTR}]`)) continue;
      if (targetRecords.has(player)) continue;
      const video = findVideoElement(player);
      // 兼容“先出现裸 video、随后被包进 videoPlayer”的情况，避免挂两个按钮。
      const videoRecord = video ? targetRecords.get(video) : null;
      if (videoRecord && records.has(videoRecord)) continue;
      bindTarget(player, video);
    }

    // 不在标准 videoPlayer 容器里的视频，作为兼容性兜底。
    const videos = document.querySelectorAll('video');
    for (const video of videos) {
      if (video.closest(`[${UI_ATTR}]`)) continue;
      if (video.closest(PLAYER_SELECTOR)) continue;
      if (targetRecords.has(video)) continue;
      bindTarget(video, video);
    }
  }

  function scheduleScan(delay = 160) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, delay);
  }

  function installUi() {
    if (uiInstalled) return;
    if (!document.documentElement) {
      document.addEventListener('DOMContentLoaded', installUi, { once: true });
      return;
    }
    uiInstalled = true;

    try {
      observer = new MutationObserver(() => scheduleScan());
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (error) {
      warn('MutationObserver 初始化失败', error);
    }

    document.addEventListener('fullscreenchange', () => scheduleScan(250));
    page.addEventListener('resize', () => scheduleScan(500), { passive: true });

    // 页面自身的 React 可能重绘播放器内部；定时维护一次，成本很低。
    clearInterval(maintenanceTimer);
    maintenanceTimer = setInterval(() => {
      for (const record of [...records]) {
        if (!record.container.isConnected) {
          records.delete(record);
          continue;
        }
        if (!record.host || !record.host.isConnected) {
          scheduleScan(60);
          break;
        }
        if (!record.video) record.video = findVideoElement(record.container);
      }
      if (document.hidden) return;
      scan();
    }, 2000);

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => scheduleScan(0), { once: true });
    } else {
      scheduleScan(0);
    }
  }

  /* ----------------------------------------------------------------------- *
   * 启动
   * ----------------------------------------------------------------------- */

  installNetworkCapture();
  installUi();
})();
