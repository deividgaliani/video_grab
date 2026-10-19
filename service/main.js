/**
 * VideoGrab — Service Worker Principal (Manifest V3)
 * Gerencia descoberta de mídia por aba, comunicação com scripts injetados,
 * fila de downloads sem limites/bloqueios e sincronização em tempo real com a UI.
 */

import { CHANNELS, Some, None, isOption, deserialize, hashString, mediaToPlainUI } from "./serde.js";
import { addSessionHeaderRules, removeSessionHeaderRules, extractBrowserOnlyHeaders } from "./dnr_headers.js";
import { initNetworkSniffer, clearTabSnifferCache } from "./sniffer.js";
import {
  onWorkerEvent,
  evaluateInSandbox,
  buildDownloadArgs,
  executeDownloadTask,
  abortDownloadTask
} from "./downloader.js";

// Estado em memória do Service Worker
const discoveredByTab = new Map(); // tabId -> { meta: { title, thumbnailUrl, pageUrl, faviconUrl }, media: Map<hash, mediaObj> }
const activeDownloads = new Map(); // downloadId -> { downloadId, mediaHash, title, thumbnailUrl, extension, strategy, status, percent, fetchedBytes, bitrate, lastBytes, lastTick, outputDuration }
let downloadHistory = []; // Array<{ id, browserDownloadId, title, extension, savedPath, timestamp, status, error }>

const DEFAULT_SETTINGS = {
  preferredMuxer: "mp4", // "mp4" | "mkv"
  subdir: "",
  saveAs: false,
  youtubeThrottle: false,
  showNotifications: true
};

let userSettings = { ...DEFAULT_SETTINGS };

// Carrega configurações e histórico salvos
async function loadPersistentState() {
  try {
    const data = await chrome.storage.local.get(["videograb_settings", "videograb_history"]);
    if (data.videograb_settings) {
      userSettings = { ...DEFAULT_SETTINGS, ...data.videograb_settings };
    }
    if (Array.isArray(data.videograb_history)) {
      downloadHistory = data.videograb_history.slice(0, 100);
    }
  } catch (err) {
    console.warn("[VideoGrab] Erro ao carregar storage:", err);
  }
}
loadPersistentState();

async function saveHistory() {
  try {
    await chrome.storage.local.set({ videograb_history: downloadHistory.slice(0, 100) });
  } catch {
    // ignora erro de quota
  }
}

function getOrCreateTabEntry(tabId) {
  if (!discoveredByTab.has(tabId)) {
    discoveredByTab.set(tabId, {
      meta: {
        title: null,
        thumbnailUrl: null,
        pageUrl: null,
        faviconUrl: null
      },
      media: new Map()
    });
  }
  return discoveredByTab.get(tabId);
}

/**
 * Atualiza o ícone e o contador (badge) da extensão para a aba informada.
 */
async function updateTabBadge(tabId) {
  if (!tabId || tabId <= 0) return;
  const entry = discoveredByTab.get(tabId);
  const count = entry ? entry.media.size : 0;

  try {
    await chrome.action.setBadgeText({
      tabId,
      text: count > 0 ? String(count) : ""
    });
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: "#6366f1"
    });
    await chrome.action.setIcon({
      tabId,
      path: count > 0
        ? {
            16: "/icons/icon-16.png",
            48: "/icons/icon-48.png",
            128: "/icons/icon-128.png"
          }
        : {
            128: "/icons/icon-128-grey.png"
          }
    });
  } catch {
    // Aba pode ter sido fechada
  }
}

/**
 * Notifica todas as janelas da UI (Popup / Side Panel) abertas sobre mudanças de estado.
 */
function broadcastStateToUI() {
  chrome.runtime.sendMessage({ type: "VIDEOGRAB_STATE_UPDATED" }).catch(() => {
    // Nenhuma UI aberta no momento
  });
}

/**
 * Registra uma nova mídia descoberta (via Sniffer, DOM ou Injected Script) na aba correspondente.
 */
async function registerMediaForTab(tabId, mediaObj) {
  if (!tabId || tabId <= 0 || !mediaObj || !mediaObj.hash) return;

  const entry = getOrCreateTabEntry(tabId);

  // Enriquece metadados da aba se ainda não existirem
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab) {
      entry.meta.title = entry.meta.title || tab.title || null;
      entry.meta.pageUrl = tab.url || entry.meta.pageUrl;
      entry.meta.faviconUrl = tab.favIconUrl || entry.meta.faviconUrl;
    }
  } catch {
    // ignora
  }

  // Consulta o content script da página para obter título/thumbnail caso ausentes
  const hasTitle = isOption(mediaObj.title) ? mediaObj.title.isSome() : Boolean(mediaObj.title);
  const hasThumb = isOption(mediaObj.thumbnail_url)
    ? mediaObj.thumbnail_url.isSome()
    : Boolean(mediaObj.thumbnail_url);

  if (!hasTitle || !hasThumb) {
    try {
      const pageMeta = await chrome.tabs.sendMessage(tabId, { type: "VIDEOGRAB_GET_PAGE_META" });
      if (pageMeta) {
        if (pageMeta.title) entry.meta.title = pageMeta.title;
        if (pageMeta.thumbnailUrl) entry.meta.thumbnailUrl = pageMeta.thumbnailUrl;
      }
    } catch {
      // content script pode não estar disponível no frame
    }
  }

  if (!hasTitle && entry.meta.title) {
    mediaObj.title = Some(entry.meta.title);
  }
  if (!hasThumb && entry.meta.thumbnailUrl) {
    try {
      mediaObj.thumbnail_url = Some(new URL(entry.meta.thumbnailUrl));
    } catch {
      // ignora
    }
  }

  mediaObj.discovery_timestamp = mediaObj.discovery_timestamp || Date.now();
  entry.media.set(mediaObj.hash, mediaObj);

  await updateTabBadge(tabId);
  broadcastStateToUI();
}

/**
 * Envia mensagem para os scripts injetados (protocolo compatível com injected/*.js).
 */
async function sendToInjectedScript(tabId, msg) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await chrome.tabs.sendMessage(tabId, {
        channel: CHANNELS.FromServiceToInjected,
        msg
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

// 1. Inicializa o Sniffer de Rede (HTTP, HLS, DASH)
initNetworkSniffer({
  onMediaDiscovered: (tabId, mediaObj) => {
    registerMediaForTab(tabId, mediaObj);
  },
  onPlatformConfig: async (tabId, eventName, url, headers) => {
    try {
      const resp = await fetch(url, { headers });
      if (resp.ok) {
        const json = await resp.json();
        await sendToInjectedScript(tabId, { name: eventName, data: json });
      }
    } catch (err) {
      console.warn(`[VideoGrab] Falha ao buscar config de plataforma (${eventName}):`, err);
    }
  }
});

// 2. Escuta eventos de progresso vindos do Download Worker
onWorkerEvent((msg) => {
  if (msg.name === "download_progress" && msg.data) {
    const { download_id: downloadId, progress } = msg.data;
    const item = activeDownloads.get(downloadId);
    if (!item) return;

    item.status = progress.status || item.status;
    if (progress.status === "downloading") {
      if (progress.percent?.is_known && typeof progress.percent.value === "number") {
        item.percent = Math.min(100, Math.max(0, Math.round(progress.percent.value)));
      }
      if (typeof progress.fetched_bytes_count === "number") {
        const now = Date.now();
        const dt = now - (item.lastTick || now);
        if (dt >= 800) {
          const dBytes = Math.max(0, progress.fetched_bytes_count - (item.lastBytes || 0));
          item.bitrate = Math.round((dBytes * 1000) / dt);
          item.lastBytes = progress.fetched_bytes_count;
          item.lastTick = now;
        }
        item.fetchedBytes = progress.fetched_bytes_count;
      }
      if (typeof progress.output_duration_s === "number") {
        item.outputDuration = progress.output_duration_s;
      }
    } else if (progress.status === "finalizing") {
      item.percent = 100;
    }

    broadcastStateToUI();
  }
});

// 3. Inicia uma tarefa de download (sem limites, sem cooldown e sem bloqueios de plataforma)
async function startMediaDownload({ tabId, mediaHash, variantIndex = 0, audioOnly = false, customTitle = null }) {
  const tabEntry = discoveredByTab.get(tabId);
  const media = tabEntry?.media.get(mediaHash);
  if (!media) {
    throw new Error("Mídia não encontrada para esta aba.");
  }
  if (media.has_drm) {
    throw new Error("Esta mídia utiliza proteção DRM (Widevine/EME) e não pode ser processada.");
  }

  const downloadArgs = buildDownloadArgs(media, {
    variantIndex,
    audioOnly,
    saveAs: userSettings.saveAs,
    customTitle: customTitle || tabEntry.meta.title,
    subdir: userSettings.subdir,
    preferredMuxer: userSettings.preferredMuxer,
    youtubeThrottle: userSettings.youtubeThrottle
  });

  const thumbUrl = isOption(media.thumbnail_url) && media.thumbnail_url.isSome()
    ? media.thumbnail_url.value?.href || String(media.thumbnail_url.value)
    : tabEntry.meta.thumbnailUrl || null;

  const activeItem = {
    downloadId: downloadArgs.download_id,
    mediaHash: media.hash,
    title: `${downloadArgs.good_basename}.${downloadArgs.extension}`,
    thumbnailUrl: thumbUrl,
    extension: downloadArgs.extension,
    strategy: downloadArgs.strategy,
    status: "queuing",
    percent: 0,
    fetchedBytes: 0,
    bitrate: 0,
    lastBytes: 0,
    lastTick: Date.now(),
    outputDuration: 0
  };

  activeDownloads.set(downloadArgs.download_id, activeItem);
  broadcastStateToUI();

  // Executa de forma assíncrona para liberar o retorno imediato para a UI
  (async () => {
    try {
      const result = await executeDownloadTask(downloadArgs);
      activeDownloads.delete(downloadArgs.download_id);

      if (!result.aborted) {
        const histEntry = {
          id: downloadArgs.download_id,
          browserDownloadId: result.browserDownloadId,
          title: activeItem.title,
          thumbnailUrl: activeItem.thumbnailUrl,
          extension: downloadArgs.extension,
          savedPath: result.savedPath,
          timestamp: Date.now(),
          status: "complete"
        };
        downloadHistory.unshift(histEntry);
        await saveHistory();

        if (userSettings.showNotifications) {
          chrome.notifications.create(`done_${downloadArgs.download_id}`, {
            type: "basic",
            iconUrl: "/icons/icon-128.png",
            title: "VideoGrab — Download Concluído",
            message: activeItem.title
          });
        }
      }
    } catch (err) {
      activeDownloads.delete(downloadArgs.download_id);
      const errMsg = err instanceof Error ? err.message : String(err);
      downloadHistory.unshift({
        id: downloadArgs.download_id,
        browserDownloadId: null,
        title: activeItem.title,
        thumbnailUrl: activeItem.thumbnailUrl,
        extension: downloadArgs.extension,
        savedPath: null,
        timestamp: Date.now(),
        status: "failed",
        error: errMsg
      });
      await saveHistory();
    } finally {
      broadcastStateToUI();
    }
  })();

  return { downloadId: downloadArgs.download_id };
}

// 4. Roteador Central de Mensagens (Injected Scripts + UI Popup/Sidebar + DOM Detector)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  // A. Mensagens vindas dos extratores em injected/*.js (channel === 0)
  if (message.channel === CHANNELS.FromInjectedToService && message.msg) {
    const tabId = sender.tab?.id;
    const msg = message.msg;
    if (!tabId) return false;

    (async () => {
      if (msg.name === "on_media" && msg.data?.media) {
        const mediaObj = deserialize(msg.data.media);
        await registerMediaForTab(tabId, mediaObj);
      } else if (msg.name === "remove_media" && msg.data?.hash) {
        const entry = discoveredByTab.get(tabId);
        if (entry) {
          entry.media.delete(msg.data.hash);
          await updateTabBadge(tabId);
          broadcastStateToUI();
        }
      } else if (msg.name === "qjs" && msg.data) {
        const { uid, code } = msg.data;
        const evalRes = await evaluateInSandbox(uid, code);
        const payload = evalRes.error
          ? JSON.stringify({ error: evalRes.error, uid })
          : JSON.stringify({ success: evalRes.success, uid });
        await sendToInjectedScript(tabId, { name: "qjs_result", data: payload });
      } else if (msg.name === "do_fetch_from_service" && msg.data) {
        const { url, method, fetch_headers: fetchHeaders, body_params: bodyParams, uid } = msg.data;
        let ruleIds = [];
        try {
          const hdrs = new Headers(fetchHeaders || {});
          ruleIds = await addSessionHeaderRules([url], extractBrowserOnlyHeaders(hdrs));
          const resp = await fetch(url, {
            method: method || "GET",
            headers: fetchHeaders,
            body: bodyParams ? new URLSearchParams(bodyParams) : undefined
          });
          if (resp.ok) {
            const json = await resp.json();
            await sendToInjectedScript(tabId, {
              name: "on_fetch_from_service",
              data: { json, uid }
            });
          } else {
            await sendToInjectedScript(tabId, {
              name: "on_fetch_from_service_failed",
              data: { uid }
            });
          }
        } catch {
          await sendToInjectedScript(tabId, {
            name: "on_fetch_from_service_failed",
            data: { uid }
          });
        } finally {
          await removeSessionHeaderRules(ruleIds);
        }
      }
    })();

    return false;
  }

  // B. Mensagens vindas do detector DOM universal (injected/media_detector.js)
  if (message.type === "VIDEOGRAB_PAGE_META" && sender.tab?.id) {
    const entry = getOrCreateTabEntry(sender.tab.id);
    if (message.payload?.title) entry.meta.title = message.payload.title;
    if (message.payload?.thumbnailUrl) entry.meta.thumbnailUrl = message.payload.thumbnailUrl;
    if (message.payload?.pageUrl) entry.meta.pageUrl = message.payload.pageUrl;
    return false;
  }

  if (message.type === "VIDEOGRAB_DOM_MEDIA" && sender.tab?.id) {
    const { url, title, thumbnailUrl, duration, width, height } = message.payload || {};
    try {
      const urlObj = new URL(url);
      const hash = `media_hash_${hashString(urlObj.href)}`;
      const extMatch = urlObj.pathname.match(/\.(mp4|webm|mkv|flv|mov|mp3|m4a|aac|ogg|wav)$/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : "mp4";
      const isM3u8 = /\.m3u8(\?|$)/i.test(urlObj.href);

      if (isM3u8) {
        registerMediaForTab(sender.tab.id, {
          hash,
          type: "m3u8",
          url: urlObj,
          master_url: urlObj,
          extension: "mp4",
          is_youtube: false,
          has_drm: false,
          demuxer: "hls",
          cache: "default",
          discovery_timestamp: Date.now(),
          initiator: None,
          title: title ? Some(title) : None,
          thumbnail_url: thumbnailUrl ? Some(new URL(thumbnailUrl)) : None,
          duration: duration || undefined,
          subtitles: None,
          sent_headers: new Headers()
        });
      } else {
        registerMediaForTab(sender.tab.id, {
          hash,
          type: "http_playlist",
          url: urlObj,
          master_url: urlObj,
          extension: ext,
          is_youtube: false,
          has_drm: false,
          supports_byte_ranges: true,
          libav_demuxer: None,
          cache: "default",
          discovery_timestamp: Date.now(),
          initiator: None,
          title: title ? Some(title) : None,
          thumbnail_url: thumbnailUrl ? Some(new URL(thumbnailUrl)) : None,
          duration: duration || undefined,
          subtitles: None,
          sent_headers: new Headers(),
          playlist: [
            {
              av: { video: urlObj, audio: false },
              demuxer: ext,
              vcodec: Some(ext),
              fps: None,
              size: None,
              resolution: width && height ? Some({ width, height }) : None
            }
          ]
        });
      }
    } catch {
      // ignora URL inválida
    }
    return false;
  }

  // C. Comandos da Interface do Usuário (Popup / Side Panel)
  if (message.type === "VIDEOGRAB_UI_CMD") {
    (async () => {
      try {
        const { action, payload } = message;

        if (action === "GET_STATE") {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = activeTab?.id || -1;
          const tabEntry = discoveredByTab.get(tabId);
          const mediaList = [];
          if (tabEntry) {
            for (const m of tabEntry.media.values()) {
              const plain = mediaToPlainUI(m);
              if (!plain.title) plain.title = tabEntry.meta.title || activeTab?.title || "Mídia Detectada";
              if (!plain.thumbnailUrl) plain.thumbnailUrl = tabEntry.meta.thumbnailUrl || null;
              mediaList.push(plain);
            }
          }
          // Ordena mais recentes primeiro
          mediaList.sort((a, b) => (b.discoveryTimestamp || 0) - (a.discoveryTimestamp || 0));

          sendResponse({
            ok: true,
            state: {
              tabId,
              tabTitle: activeTab?.title || "",
              tabUrl: activeTab?.url || "",
              mediaList,
              activeDownloads: [...activeDownloads.values()],
              history: downloadHistory,
              settings: userSettings
            }
          });
          return;
        }

        if (action === "START_DOWNLOAD") {
          const res = await startMediaDownload(payload);
          sendResponse({ ok: true, ...res });
          return;
        }

        if (action === "ABORT_DOWNLOAD") {
          abortDownloadTask(payload.downloadId);
          activeDownloads.delete(payload.downloadId);
          broadcastStateToUI();
          sendResponse({ ok: true });
          return;
        }

        if (action === "DISMISS_MEDIA") {
          const entry = discoveredByTab.get(payload.tabId);
          if (entry) {
            entry.media.delete(payload.mediaHash);
            await updateTabBadge(payload.tabId);
          }
          broadcastStateToUI();
          sendResponse({ ok: true });
          return;
        }

        if (action === "CLEAR_TAB_MEDIA") {
          const entry = discoveredByTab.get(payload.tabId);
          if (entry) {
            entry.media.clear();
            await updateTabBadge(payload.tabId);
          }
          clearTabSnifferCache(payload.tabId);
          broadcastStateToUI();
          sendResponse({ ok: true });
          return;
        }

        if (action === "FORCE_DETECTION") {
          const tabId = payload.tabId;
          if (tabId > 0) {
            const entry = discoveredByTab.get(tabId);
            if (entry) entry.media.clear();
            clearTabSnifferCache(tabId);
            await updateTabBadge(tabId);
            await chrome.tabs.reload(tabId, { bypassCache: true });
          }
          sendResponse({ ok: true });
          return;
        }

        if (action === "UPDATE_SETTINGS") {
          userSettings = { ...userSettings, ...payload };
          await chrome.storage.local.set({ videograb_settings: userSettings });
          broadcastStateToUI();
          sendResponse({ ok: true, settings: userSettings });
          return;
        }

        if (action === "CLEAR_HISTORY") {
          downloadHistory = [];
          await saveHistory();
          broadcastStateToUI();
          sendResponse({ ok: true });
          return;
        }

        if (action === "SHOW_IN_FOLDER") {
          if (payload.browserDownloadId) {
            chrome.downloads.show(payload.browserDownloadId);
          } else {
            chrome.downloads.showDefaultFolder();
          }
          sendResponse({ ok: true });
          return;
        }

        sendResponse({ ok: false, error: `Ação desconhecida: ${action}` });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    })();

    return true; // Mantém canal aberto para resposta assíncrona
  }

  return false;
});

// 5. Gerenciamento do ciclo de vida das abas e atalhos de teclado
chrome.tabs.onRemoved.addListener((tabId) => {
  discoveredByTab.delete(tabId);
  clearTabSnifferCache(tabId);
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0 && details.tabId > 0) {
    const entry = discoveredByTab.get(details.tabId);
    if (entry && entry.meta.pageUrl !== details.url) {
      entry.media.clear();
      entry.meta = { title: null, thumbnailUrl: null, pageUrl: details.url, faviconUrl: null };
      clearTabSnifferCache(details.tabId);
      updateTabBadge(details.tabId);
      broadcastStateToUI();
    }
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateTabBadge(tabId);
  broadcastStateToUI();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "quick-download") {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) return;
    const entry = discoveredByTab.get(activeTab.id);
    if (!entry || entry.media.size === 0) return;
    const firstMedia = entry.media.values().next().value;
    if (firstMedia) {
      startMediaDownload({
        tabId: activeTab.id,
        mediaHash: firstMedia.hash,
        variantIndex: 0,
        audioOnly: false
      }).catch((err) => console.error("[VideoGrab QuickDownload]", err));
    }
  }
});
