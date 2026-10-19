/**
 * VideoGrab — Orquestrador de Downloads e Ponte Offscreen Worker
 * Constrói as estratégias de download (HTTP, HLS, DASH, YouTube), gerencia a fila,
 * comunica com o download_worker (LibAV/FFmpeg WASM) e salva no disco via chrome.downloads.
 */

import { CHANNELS, Some, None, isOption, serialize } from "./serde.js";
import { cloneHeaders, prepareDownloadDnrRules, removeSessionHeaderRules } from "./dnr_headers.js";

const workerBus = new BroadcastChannel("worker_service");
const pendingFilenameOverrides = new Map(); // blobUrl -> targetFilename

let offscreenCreated = false;
let progressListeners = [];

export function onWorkerEvent(listener) {
  progressListeners.push(listener);
  return () => {
    progressListeners = progressListeners.filter((l) => l !== listener);
  };
}

function emitWorkerEvent(event) {
  for (const listener of progressListeners) {
    try {
      listener(event);
    } catch (err) {
      console.error("[VideoGrab Downloader] Erro no listener:", err);
    }
  }
}

workerBus.addEventListener("message", (event) => {
  const { channel, msg } = event.data || {};
  if (channel !== CHANNELS.FromWorkerToService || !msg) return;
  emitWorkerEvent(msg);
});

/**
 * Garante que o documento Offscreen (/factory/factory.html) esteja ativo
 * e que o download_worker responda ao ping `is_ready`.
 */
export async function ensureOffscreenWorker() {
  if (!offscreenCreated) {
    try {
      await chrome.offscreen.createDocument({
        url: "/factory/factory.html",
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "Executar Web Worker com LibAV/FFmpeg WASM e Sandbox Evaluator"
      });
      offscreenCreated = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Only a single offscreen document")) {
        offscreenCreated = true;
      } else {
        throw err;
      }
    }
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("Tempo limite excedido aguardando o Download Worker iniciar."));
    }, 10000);

    const off = onWorkerEvent((msg) => {
      if (msg.name === "is_ready_success") {
        clearTimeout(timer);
        off();
        resolve(true);
      }
    });

    workerBus.postMessage({
      channel: CHANNELS.FromServiceToWorker,
      msg: { name: "is_ready", data: null }
    });
  });
}

/**
 * Executa código dinâmico (ex: decifragem de assinatura do YouTube) no Sandbox Offscreen.
 */
export async function evaluateInSandbox(uid, code) {
  await ensureOffscreenWorker();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve({ uid, error: "Sandbox eval timeout" });
    }, 8000);

    const off = onWorkerEvent((msg) => {
      if (msg.name === "eval_qjs_result" && msg.data?.uid === uid) {
        clearTimeout(timer);
        off();
        resolve(msg.data);
      }
    });

    workerBus.postMessage({
      channel: CHANNELS.FromServiceToWorker,
      msg: { name: "eval_qjs", data: { uid, code } }
    });
  });
}

/**
 * Limpa caracteres inválidos para nomes de arquivos no Windows/macOS/Linux.
 */
export function sanitizeFilename(rawName) {
  if (!rawName || typeof rawName !== "string") return "VideoGrab_Media";
  const cleaned = rawName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim();
  return (cleaned || "VideoGrab_Media").slice(0, 140);
}

function ensureUrlObject(val) {
  if (val instanceof URL) return val;
  if (isOption(val) && val.isSome()) return ensureUrlObject(val.value);
  if (typeof val === "string") return new URL(val);
  if (val && typeof val.href === "string") return new URL(val.href);
  throw new Error(`URL inválida na mídia: ${JSON.stringify(val)}`);
}

/**
 * Constrói o objeto `download_args` esperado pelo download_worker/main.js
 * de acordo com o tipo de mídia, índice da variante selecionada e modo (Vídeo+Áudio vs Áudio).
 */
export function buildDownloadArgs(media, options = {}) {
  const {
    variantIndex = 0,
    audioOnly = false,
    saveAs = false,
    customTitle = null,
    subdir = "",
    preferredMuxer = "mp4",
    youtubeThrottle = false
  } = options;

  const downloadId = `download_${crypto.randomUUID()}`;
  const rawTitle =
    customTitle ||
    (isOption(media.title) && media.title.isSome() ? media.title.value : media.title) ||
    "VideoGrab_Media";
  const goodBasename = sanitizeFilename(rawTitle);
  const normalizedSubdir = subdir
    ? subdir.replace(/^[\\/]+|[\\/]+$/g, "") + "/"
    : "";

  const headers = cloneHeaders(media.sent_headers || new Headers());
  const isYoutube = Boolean(media.is_youtube);
  const throttle = isYoutube && Boolean(youtubeThrottle);
  const cache = media.cache || "default";
  const playlist = Array.isArray(media.playlist) ? media.playlist : [];
  const entry = playlist[variantIndex] || playlist[0];

  // 1. Formato YouTube (youtube_format)
  if (media.type === "youtube_format") {
    if (!entry) throw new Error("Nenhuma variante disponível para este vídeo do YouTube.");
    const hasVideo = entry.av.video !== false;
    const hasAudio = Boolean(entry.av.audio);

    if (!hasVideo || audioOnly) {
      const sourceStream = hasAudio ? entry.av.audio : entry.av.video;
      const streamUrl = ensureUrlObject(sourceStream.url);
      return {
        download_id: downloadId,
        headers,
        good_basename: goodBasename,
        subdir: normalizedSubdir,
        save_as: saveAs,
        will_use_jsfetch: false,
        strategy: "youtube_audio_only",
        muxer: "mp3",
        url: streamUrl,
        carry_get_params: false,
        content_length: sourceStream.content_length ?? None,
        extension: "mp3",
        is_youtube: true,
        throttle,
        cache,
        duration: media.duration,
        audio_language: entry.audio_language ?? None
      };
    }

    const muxer = preferredMuxer === "mkv" ? "mkv" : "mp4";
    const videoUrl = ensureUrlObject(entry.av.video.url);

    if (hasAudio) {
      const audioUrl = ensureUrlObject(entry.av.audio.url);
      return {
        download_id: downloadId,
        headers,
        good_basename: goodBasename,
        subdir: normalizedSubdir,
        muxer,
        save_as: saveAs,
        will_use_jsfetch: false,
        strategy: "youtube_audio_video_two_sources",
        url: videoUrl,
        carry_get_params: false,
        content_length: entry.av.video.content_length ?? None,
        url_audio: audioUrl,
        audio_content_length: entry.av.audio.content_length ?? None,
        extension: muxer,
        is_youtube: true,
        throttle,
        cache,
        subtitles: None,
        audio_language: entry.audio_language ?? None
      };
    }

    return {
      download_id: downloadId,
      headers,
      good_basename: goodBasename,
      subdir: normalizedSubdir,
      muxer,
      save_as: saveAs,
      will_use_jsfetch: false,
      strategy: "youtube_audio_video_one_source",
      url: videoUrl,
      carry_get_params: false,
      content_length: entry.av.video.content_length ?? None,
      extension: muxer,
      is_youtube: true,
      throttle,
      cache,
      subtitles: None,
      audio_language: entry.audio_language ?? None
    };
  }

  // 2. HLS Master Playlist com múltiplas qualidades (m3u8_playlist)
  if (media.type === "m3u8_playlist") {
    if (!entry) throw new Error("Variante HLS não encontrada.");
    const hasVideo = entry.av.video !== false;
    const hasAudio = Boolean(entry.av.audio);

    if (!hasVideo || audioOnly) {
      const targetUrl = ensureUrlObject(hasAudio ? entry.av.audio : entry.av.video);
      return {
        download_id: downloadId,
        headers,
        good_basename: goodBasename,
        subdir: normalizedSubdir,
        duration: media.duration,
        save_as: saveAs,
        will_use_jsfetch: false,
        strategy: "m3u8_audio_only",
        muxer: "mp3",
        url: targetUrl,
        carry_get_params: false,
        extension: "mp3",
        is_youtube: isYoutube,
        throttle,
        cache,
        audio_language: entry.audio_language ?? None
      };
    }

    const muxer = preferredMuxer === "mkv" ? "mkv" : "mp4";
    const videoUrl = ensureUrlObject(entry.av.video);

    if (hasAudio) {
      const audioUrl = ensureUrlObject(entry.av.audio);
      return {
        download_id: downloadId,
        headers,
        good_basename: goodBasename,
        subdir: normalizedSubdir,
        muxer,
        duration: media.duration,
        save_as: saveAs,
        will_use_jsfetch: false,
        strategy: "m3u8_audio_video_two_sources",
        url: videoUrl,
        url_audio: audioUrl,
        carry_get_params: false,
        extension: muxer,
        is_youtube: isYoutube,
        throttle,
        cache,
        subtitles: None,
        audio_language: entry.audio_language ?? None
      };
    }

    return {
      download_id: downloadId,
      headers,
      good_basename: goodBasename,
      subdir: normalizedSubdir,
      muxer,
      duration: media.duration,
      save_as: saveAs,
      will_use_jsfetch: false,
      strategy: "m3u8_audio_video_one_source",
      url: videoUrl,
      carry_get_params: false,
      extension: muxer,
      is_youtube: isYoutube,
      throttle,
      cache,
      subtitles: None,
      audio_language: entry.audio_language ?? None
    };
  }

  // 3. HLS Media Playlist única (m3u8)
  if (media.type === "m3u8") {
    const streamUrl = ensureUrlObject(media.url || media.master_url);
    if (audioOnly) {
      return {
        save_as: saveAs,
        subdir: normalizedSubdir,
        duration: media.duration,
        will_use_jsfetch: true,
        download_id: downloadId,
        headers,
        strategy: "m3u8_audio_only",
        muxer: "mp3",
        url: streamUrl,
        carry_get_params: false,
        good_basename: goodBasename,
        extension: "mp3",
        is_youtube: isYoutube,
        throttle,
        cache,
        audio_language: None
      };
    }

    const muxer = preferredMuxer === "mkv" ? "mkv" : "mp4";
    return {
      download_id: downloadId,
      headers,
      subdir: normalizedSubdir,
      duration: media.duration,
      will_use_jsfetch: true,
      save_as: saveAs,
      strategy: "m3u8_audio_video_one_source",
      muxer,
      url: streamUrl,
      carry_get_params: false,
      good_basename: goodBasename,
      extension: muxer,
      is_youtube: isYoutube,
      throttle,
      cache,
      subtitles: None,
      audio_language: None
    };
  }

  // 4. DASH Manifest (mpd_playlist)
  if (media.type === "mpd_playlist") {
    const masterUrl = ensureUrlObject(media.master_url || media.url);
    const entryIndex = entry?.index ?? 0;

    if (audioOnly) {
      return {
        download_id: downloadId,
        headers,
        good_basename: goodBasename,
        subdir: normalizedSubdir,
        save_as: saveAs,
        will_use_jsfetch: true,
        muxer: "mp3",
        strategy: "mpd_audio_only",
        url: masterUrl,
        carry_get_params: false,
        entry: entryIndex,
        duration: media.duration,
        extension: "mp3",
        is_youtube: isYoutube,
        throttle,
        cache,
        audio_language: entry?.audio_language ?? None,
        audio_track_id: entry?.audio_id ?? None
      };
    }

    const muxer = preferredMuxer === "mkv" ? "mkv" : "mp4";
    return {
      download_id: downloadId,
      headers,
      good_basename: goodBasename,
      subdir: normalizedSubdir,
      save_as: saveAs,
      will_use_jsfetch: true,
      muxer,
      strategy: "mpd_audio_video_one_source",
      url: masterUrl,
      carry_get_params: false,
      entry: entryIndex,
      duration: media.duration,
      extension: muxer,
      is_youtube: isYoutube,
      throttle,
      cache,
      subtitles: None,
      audio_language: entry?.audio_language ?? None,
      audio_track_id: entry?.audio_id ?? None
    };
  }

  // 5. HTTP Playlist / Vídeo Direto (http_playlist)
  const videoUrl = ensureUrlObject(entry?.av?.video || media.url || media.master_url);
  const sizeOpt = entry?.size && isOption(entry.size) ? entry.size : None;

  if (audioOnly) {
    return {
      save_as: saveAs,
      download_id: downloadId,
      subdir: normalizedSubdir,
      will_use_jsfetch: true,
      headers,
      strategy: "http_strip_audio_jsfetch",
      url: videoUrl,
      carry_get_params: false,
      good_basename: goodBasename,
      muxer: "mp3",
      extension: "mp3",
      is_youtube: isYoutube,
      size: sizeOpt,
      throttle,
      cache
    };
  }

  if (entry?.av?.audio) {
    const audioUrl = ensureUrlObject(entry.av.audio);
    const muxer = preferredMuxer === "mkv" ? "mkv" : "mp4";
    return {
      save_as: saveAs,
      download_id: downloadId,
      subdir: normalizedSubdir,
      will_use_jsfetch: true,
      headers,
      strategy: "http_audio_video_two_sources_jsfetch",
      url: videoUrl,
      url_audio: audioUrl,
      carry_get_params: false,
      good_basename: goodBasename,
      muxer,
      extension: muxer,
      size: sizeOpt,
      duration: media.duration,
      is_youtube: isYoutube,
      throttle,
      cache
    };
  }

  return {
    save_as: saveAs,
    download_id: downloadId,
    subdir: normalizedSubdir,
    will_use_jsfetch: false,
    headers,
    strategy: "http_audio_video_one_source",
    url: videoUrl,
    carry_get_params: false,
    good_basename: goodBasename,
    size: sizeOpt,
    extension: media.extension || "mp4",
    is_youtube: isYoutube,
    throttle,
    cache
  };
}

// Listener para garantir o nome correto de arquivos originados de Blob URLs
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId !== chrome.runtime.id) {
    suggest();
    return;
  }
  const targetName = pendingFilenameOverrides.get(item.finalUrl) || pendingFilenameOverrides.get(item.url);
  if (!targetName) {
    suggest();
    return;
  }
  pendingFilenameOverrides.delete(item.finalUrl);
  pendingFilenameOverrides.delete(item.url);
  suggest({ filename: targetName, conflictAction: "uniquify" });
});

function waitForBrowserDownloadComplete(browserDownloadId) {
  return new Promise((resolve, reject) => {
    const onChanged = (delta) => {
      if (delta.id !== browserDownloadId) return;
      if (delta.error) {
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error(delta.error.current || "Erro no download do navegador"));
      } else if (delta.state?.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error("Download interrompido pelo usuário ou falha de disco"));
      } else if (delta.state?.current === "complete") {
        chrome.downloads.onChanged.removeListener(onChanged);
        chrome.downloads.search({ id: browserDownloadId }, (items) => {
          resolve(items?.[0]?.filename || "");
        });
      }
    };

    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: browserDownloadId }, (items) => {
      const item = items?.[0];
      if (!item) return;
      if (item.state === "complete") {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(item.filename || "");
      } else if (item.state === "interrupted") {
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error(item.error || "Download interrompido"));
      }
    });
  });
}

/**
 * Executa o fluxo completo de download no Worker e salva o arquivo final no computador.
 */
export async function executeDownloadTask(downloadArgs) {
  await ensureOffscreenWorker();

  const dnrRuleIds = await prepareDownloadDnrRules(downloadArgs);

  let workerResult;
  try {
    workerResult = await new Promise((resolve, reject) => {
      const off = onWorkerEvent((msg) => {
        if (msg.name === "download_error" && msg.data?.download_id === downloadArgs.download_id) {
          off();
          reject(new Error(msg.data.error || "Falha no processamento da mídia"));
        } else if (msg.name === "download_result" && msg.data?.download_id === downloadArgs.download_id) {
          off();
          resolve(msg.data);
        }
      });

      workerBus.postMessage({
        channel: CHANNELS.FromServiceToWorker,
        msg: {
          name: "download",
          data: {
            download_args: serialize(downloadArgs)
          }
        }
      });
    });
  } finally {
    await removeSessionHeaderRules(dnrRuleIds);
  }

  if (workerResult.aborted_no_partial) {
    return {
      aborted: true,
      reason: workerResult.ending_reason
    };
  }

  const { internal_filename: opfsName, internal_bloburl: blobUrl, ending_reason: endingReason } = workerResult;
  if (!blobUrl) {
    throw new Error("O Worker não retornou um Blob URL válido.");
  }

  const finalFilename = `${downloadArgs.subdir}${downloadArgs.good_basename}.${downloadArgs.extension}`;
  pendingFilenameOverrides.set(blobUrl, finalFilename);

  let browserDownloadId;
  let savedPath = finalFilename;
  try {
    browserDownloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: finalFilename,
      conflictAction: "uniquify",
      saveAs: Boolean(downloadArgs.save_as)
    });
    savedPath = await waitForBrowserDownloadComplete(browserDownloadId);
  } finally {
    // Limpa arquivo temporário no OPFS e revoga o Blob URL da memória
    try {
      const rootDir = await navigator.storage.getDirectory();
      await rootDir.removeEntry(opfsName);
    } catch {
      // ignora caso já tenha sido removido
    }
    workerBus.postMessage({
      channel: CHANNELS.FromServiceToWorker,
      msg: {
        name: "revoke_blob_url",
        data: { blob_url: blobUrl }
      }
    });
  }

  return {
    aborted: false,
    browserDownloadId,
    savedPath,
    endingReason
  };
}

/**
 * Cancela um download em andamento no Worker.
 */
export function abortDownloadTask(downloadId) {
  workerBus.postMessage({
    channel: CHANNELS.FromServiceToWorker,
    msg: {
      name: "abort_download",
      data: { download_id: downloadId }
    }
  });
}
