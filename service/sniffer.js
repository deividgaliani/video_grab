/**
 * VideoGrab — Sniffer de Rede (HTTP, HLS/.m3u8, DASH/.mpd)
 * Intercepta tráfego de mídia nas abas, analisa manifestos HLS/DASH e
 * registra fluxos de vídeo e áudio disponíveis para download.
 */

import { Some, None, hashString } from "./serde.js";
import { addSessionHeaderRules, removeSessionHeaderRules, extractBrowserOnlyHeaders } from "./dnr_headers.js";

const requestHeadersCache = new Map(); // requestId -> { timestamp, headers }
const processedUrlsPerTab = new Map(); // tabId -> Set<string>

// Limpeza periódica do cache de cabeçalhos de requisição
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [reqId, entry] of requestHeadersCache.entries()) {
    if (entry.timestamp < cutoff) {
      requestHeadersCache.delete(reqId);
    }
  }
}, 60 * 1000);

const IGNORED_HOST_DOMAINS = new Set([
  "youtube.com",
  "googlevideo.com",
  "doubleclick.net",
  "googlesyndication.com"
]);

const SEGMENT_EXTENSIONS = /\.(ts|m4s|m2ts|fmp4|cmfv|cmfa|vtt|srt|jpg|jpeg|png|gif|webp|css|js|woff2?)(\?|$)/i;
const HLS_PATTERNS = /\.m3u8(\?|$)|mpegurl/i;
const DASH_PATTERNS = /\.mpd(\?|$)|dash\+xml/i;
const DIRECT_MEDIA_EXTENSIONS = /\.(mp4|webm|mkv|flv|mov|avi|mp3|m4a|aac|flac|ogg|opus|wav)(\?|$)/i;

function parseSafeUrl(str) {
  if (!str || typeof str !== "string") return null;
  try {
    return new URL(str);
  } catch {
    return null;
  }
}

/**
 * Normaliza URL removendo parâmetros de range/chunk temporários para evitar duplicatas.
 */
function normalizeMediaUrl(urlObj) {
  const clean = new URL(urlObj.href);
  clean.searchParams.delete("bytestart");
  clean.searchParams.delete("byteend");
  clean.searchParams.delete("range");
  clean.searchParams.delete("rn");
  clean.searchParams.delete("rbuf");
  return clean;
}

/**
 * Parser leve e rápido de manifestos HLS (.m3u8) para identificar:
 * - Master Playlists (#EXT-X-STREAM-INF e #EXT-X-MEDIA)
 * - Media Playlists (#EXTINF e duração total)
 */
export function parseM3u8Manifest(manifestText, baseUrl) {
  const lines = manifestText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines[0] || !lines[0].startsWith("#EXTM3U")) {
    return null;
  }

  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));
  const hasDrm = lines.some(
    (l) =>
      l.startsWith("#EXT-X-KEY") &&
      /METHOD=(SAMPLE-AES|SAMPLE-AES-CTR|SAMPLE-AES-CENC)/i.test(l)
  );

  if (!isMaster) {
    let duration = 0;
    for (const line of lines) {
      if (line.startsWith("#EXTINF:")) {
        const val = parseFloat(line.slice(8).split(",")[0]);
        if (!Number.isNaN(val)) duration += val;
      }
    }
    return {
      kind: "single",
      duration: duration > 0 ? Math.round(duration) : null,
      hasDrm
    };
  }

  // Coleta grupos de áudio separados (#EXT-X-MEDIA:TYPE=AUDIO)
  const audioGroups = new Map();
  for (const line of lines) {
    if (line.startsWith("#EXT-X-MEDIA:") && /TYPE=AUDIO/i.test(line)) {
      const groupId = line.match(/GROUP-ID="([^"]+)"/i)?.[1];
      const uri = line.match(/URI="([^"]+)"/i)?.[1];
      const lang = line.match(/LANGUAGE="([^"]+)"/i)?.[1] || null;
      if (groupId && uri) {
        try {
          const audioUrl = new URL(uri, baseUrl);
          if (!audioGroups.has(groupId)) {
            audioGroups.set(groupId, { url: audioUrl, language: lang });
          }
        } catch {
          // ignora URI inválida
        }
      }
    }
  }

  // Coleta variantes de vídeo (#EXT-X-STREAM-INF)
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = line.slice(18);
      const resMatch = attrs.match(/RESOLUTION=(\d+)x(\d+)/i);
      const fpsMatch = attrs.match(/FRAME-RATE=([\d.]+)/i);
      const audioGroupId = attrs.match(/AUDIO="([^"]+)"/i)?.[1];

      // Próxima linha que não começa com # é a URI da variante
      let uriLine = null;
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith("#")) {
          uriLine = lines[j];
          i = j;
          break;
        }
      }
      if (!uriLine) continue;

      try {
        const variantUrl = new URL(uriLine, baseUrl);
        const width = resMatch ? parseInt(resMatch[1], 10) : null;
        const height = resMatch ? parseInt(resMatch[2], 10) : null;
        const fps = fpsMatch ? Math.round(parseFloat(fpsMatch[1])) : null;
        const linkedAudio = audioGroupId ? audioGroups.get(audioGroupId) : null;

        variants.push({
          av: {
            video: variantUrl,
            audio: linkedAudio ? linkedAudio.url : false
          },
          demuxer: "hls",
          vcodec: Some("h264"),
          fps: fps ? Some(fps) : None,
          size: None,
          resolution: width && height ? Some({ width, height }) : None,
          audio_language: linkedAudio?.language ? Some(linkedAudio.language) : None
        });
      } catch {
        // ignora variante malformada
      }
    }
  }

  return {
    kind: "master",
    variants,
    hasDrm
  };
}

/**
 * Inicializa os listeners webRequest para capturar cabeçalhos e respostas de mídia.
 */
export function initNetworkSniffer({ onMediaDiscovered, onPlatformConfig }) {
  const filter = {
    urls: ["<all_urls>"],
    types: ["xmlhttprequest", "media", "other"]
  };

  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      if (details.requestHeaders) {
        const headers = new Headers();
        for (const h of details.requestHeaders) {
          if (h.name && h.value) {
            try {
              headers.set(h.name, h.value);
            } catch {
              // cabeçalho inválido
            }
          }
        }
        requestHeadersCache.set(details.requestId, {
          timestamp: Date.now(),
          headers
        });
      }
    },
    filter,
    ["requestHeaders", "extraHeaders"]
  );

  chrome.webRequest.onResponseStarted.addListener(
    async (details) => {
      if (details.statusCode < 200 || details.statusCode > 299) return;
      if (details.tabId <= 0) return;

      const initiatorUrl = parseSafeUrl(details.initiator || details.originUrl);
      if (initiatorUrl && /^(chrome|moz|edge)-extension:/.test(initiatorUrl.href)) {
        return;
      }

      const reqUrl = parseSafeUrl(details.url);
      if (!reqUrl || !reqUrl.protocol.startsWith("http")) return;

      // Ignora segmentos individuais (.ts, .m4s, imagens, scripts)
      if (SEGMENT_EXTENSIONS.test(reqUrl.pathname)) return;

      const reqCached = requestHeadersCache.get(details.requestId);
      const sentHeaders = reqCached ? reqCached.headers : new Headers();

      // Hooks específicos para configuração de players (Vimeo / iQiyi)
      if (reqUrl.host === "player.vimeo.com" && reqUrl.pathname.endsWith("/config")) {
        onPlatformConfig?.(details.tabId, "vimeo_on_config", reqUrl.href, sentHeaders);
        return;
      }
      if (reqUrl.host === "intl-api.iq.com" && reqUrl.pathname.endsWith("/dash")) {
        onPlatformConfig?.(details.tabId, "iqyi_on_config", reqUrl.href, sentHeaders);
        return;
      }

      // Evita duplicar capturas brutas do YouTube/GoogleVideo (tratadas pelo injected/youtube.js)
      const baseDomain = reqUrl.hostname.split(".").slice(-2).join(".");
      const initiatorDomain = initiatorUrl
        ? initiatorUrl.hostname.split(".").slice(-2).join(".")
        : "";
      if (IGNORED_HOST_DOMAINS.has(baseDomain) || IGNORED_HOST_DOMAINS.has(initiatorDomain)) {
        return;
      }

      // Extrai cabeçalhos da resposta
      const respHeaders = new Headers();
      if (details.responseHeaders) {
        for (const h of details.responseHeaders) {
          if (h.name && h.value) {
            try {
              respHeaders.append(h.name, h.value);
            } catch {
              // ignora
            }
          }
        }
      }

      const contentType = (respHeaders.get("content-type") || "").toLowerCase();
      const contentLengthStr = respHeaders.get("content-length");
      const contentRangeStr = respHeaders.get("content-range");
      let totalSize = contentLengthStr ? parseInt(contentLengthStr, 10) : null;
      if (contentRangeStr && contentRangeStr.includes("/")) {
        const rangeTotal = parseInt(contentRangeStr.split("/").pop(), 10);
        if (!Number.isNaN(rangeTotal) && rangeTotal > 0) {
          totalSize = rangeTotal;
        }
      }

      const isHls =
        HLS_PATTERNS.test(reqUrl.pathname) ||
        HLS_PATTERNS.test(contentType) ||
        reqUrl.search.includes(".m3u8");
      const isDash =
        DASH_PATTERNS.test(reqUrl.pathname) ||
        DASH_PATTERNS.test(contentType);
      const isDirectMedia =
        DIRECT_MEDIA_EXTENSIONS.test(reqUrl.pathname) ||
        contentType.startsWith("video/") ||
        contentType.startsWith("audio/");

      if (!isHls && !isDash && !isDirectMedia) return;

      // Deduplicação por aba
      const cleanUrl = normalizeMediaUrl(reqUrl);
      if (!processedUrlsPerTab.has(details.tabId)) {
        processedUrlsPerTab.set(details.tabId, new Set());
      }
      const tabSeen = processedUrlsPerTab.get(details.tabId);
      if (tabSeen.has(cleanUrl.href)) return;

      // 1. Fluxo HLS (.m3u8)
      if (isHls) {
        tabSeen.add(cleanUrl.href);
        await handleHlsDiscovery(details.tabId, reqUrl, initiatorUrl, sentHeaders, onMediaDiscovered);
        return;
      }

      // 2. Fluxo DASH (.mpd)
      if (isDash) {
        tabSeen.add(cleanUrl.href);
        const hash = `media_hash_${hashString(cleanUrl.href)}`;
        onMediaDiscovered(details.tabId, {
          hash,
          type: "mpd_playlist",
          master_url: reqUrl,
          url: reqUrl,
          extension: "mp4",
          is_youtube: false,
          has_drm: false,
          cache: "default",
          discovery_timestamp: Date.now(),
          initiator: initiatorUrl ? Some(initiatorUrl) : None,
          title: None,
          thumbnail_url: None,
          duration: undefined,
          subtitles: None,
          sent_headers: sentHeaders,
          playlist: [
            {
              index: 0,
              demuxer: "dash",
              vcodec: Some("h264"),
              fps: None,
              size: None,
              resolution: None,
              audio_language: None,
              audio_id: None
            }
          ]
        });
        return;
      }

      // 3. Mídia HTTP Direta (MP4, WebM, MP3, etc.)
      if (isDirectMedia) {
        // Ignora pequenos fragmentos de vídeo (< 150 KB) que sejam apenas probes ou gifs
        if (
          contentType.startsWith("video/") &&
          totalSize !== null &&
          !Number.isNaN(totalSize) &&
          totalSize < 150 * 1024
        ) {
          return;
        }

        tabSeen.add(cleanUrl.href);
        const extMatch = cleanUrl.pathname.match(/\.(mp4|webm|mkv|flv|mov|mp3|m4a|aac|ogg|wav)$/i);
        let ext = extMatch ? extMatch[1].toLowerCase() : "mp4";
        if (!extMatch && contentType.startsWith("audio/")) {
          ext = contentType.includes("mp4") || contentType.includes("m4a") ? "m4a" : "mp3";
        } else if (!extMatch && contentType.includes("webm")) {
          ext = "webm";
        }

        const hash = `media_hash_${hashString(cleanUrl.href)}`;
        const acceptRanges = (respHeaders.get("accept-ranges") || "").toLowerCase();
        const supportsByteRanges = acceptRanges === "bytes" || details.statusCode === 206;

        onMediaDiscovered(details.tabId, {
          hash,
          type: "http_playlist",
          url: cleanUrl,
          master_url: cleanUrl,
          extension: ext,
          is_youtube: false,
          has_drm: false,
          supports_byte_ranges: supportsByteRanges,
          libav_demuxer: None,
          cache: "default",
          discovery_timestamp: Date.now(),
          initiator: initiatorUrl ? Some(initiatorUrl) : None,
          title: None,
          thumbnail_url: None,
          duration: undefined,
          subtitles: None,
          sent_headers: sentHeaders,
          playlist: [
            {
              av: {
                video: cleanUrl,
                audio: false
              },
              demuxer: ext,
              vcodec: Some(ext),
              fps: None,
              size: totalSize && !Number.isNaN(totalSize) ? Some(totalSize) : None,
              resolution: None
            }
          ]
        });
      }
    },
    filter,
    ["responseHeaders", "extraHeaders"]
  );
}

async function handleHlsDiscovery(tabId, reqUrl, initiatorUrl, sentHeaders, onMediaDiscovered) {
  let ruleIds = [];
  try {
    const browserHeaders = extractBrowserOnlyHeaders(sentHeaders);
    ruleIds = await addSessionHeaderRules([reqUrl.href], browserHeaders);
    const resp = await fetch(reqUrl.href, { cache: "force-cache" });
    if (!resp.ok) return;
    const text = await resp.text();
    const parsed = parseM3u8Manifest(text, reqUrl.href);
    if (!parsed) return;

    const hash = `media_hash_${hashString(reqUrl.href)}`;

    if (parsed.kind === "master" && parsed.variants.length > 0) {
      onMediaDiscovered(tabId, {
        hash,
        type: "m3u8_playlist",
        master_url: reqUrl,
        url: reqUrl,
        extension: "mp4",
        is_youtube: false,
        has_drm: parsed.hasDrm,
        cache: "default",
        discovery_timestamp: Date.now(),
        initiator: initiatorUrl ? Some(initiatorUrl) : None,
        title: None,
        thumbnail_url: None,
        duration: undefined,
        subtitles: None,
        sent_headers: sentHeaders,
        playlist: parsed.variants
      });
    } else if (parsed.kind === "single") {
      onMediaDiscovered(tabId, {
        hash,
        type: "m3u8",
        url: reqUrl,
        master_url: reqUrl,
        extension: "mp4",
        is_youtube: false,
        has_drm: parsed.hasDrm,
        demuxer: "hls",
        cache: "default",
        discovery_timestamp: Date.now(),
        initiator: initiatorUrl ? Some(initiatorUrl) : None,
        title: None,
        thumbnail_url: None,
        duration: parsed.duration || undefined,
        subtitles: None,
        sent_headers: sentHeaders
      });
    }
  } catch {
    // Caso o fetch direto do m3u8 falhe, registra como m3u8 direto para o worker tentar via jsfetch
    const hash = `media_hash_${hashString(reqUrl.href)}`;
    onMediaDiscovered(tabId, {
      hash,
      type: "m3u8",
      url: reqUrl,
      master_url: reqUrl,
      extension: "mp4",
      is_youtube: false,
      has_drm: false,
      demuxer: "hls",
      cache: "default",
      discovery_timestamp: Date.now(),
      initiator: initiatorUrl ? Some(initiatorUrl) : None,
      title: None,
      thumbnail_url: None,
      duration: undefined,
      subtitles: None,
      sent_headers: sentHeaders
    });
  } finally {
    await removeSessionHeaderRules(ruleIds);
  }
}

export function clearTabSnifferCache(tabId) {
  processedUrlsPerTab.delete(tabId);
}
