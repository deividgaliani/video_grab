/**
 * VideoGrab — Controlador de Interface (Popup e Side Panel)
 */

let currentState = {
  tabId: -1,
  mediaList: [],
  activeDownloads: [],
  history: [],
  settings: {}
};

// Mantém escolhas temporárias do usuário nos cards (título customizado e variante escolhida)
const customTitlesByHash = new Map();
const selectedVariantByHash = new Map();

function sendCommand(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "VIDEOGRAB_UI_CMD", action, payload },
      (response) => {
        resolve(response || { ok: false });
      }
    );
  });
}

function formatBytes(bytes) {
  if (!bytes || typeof bytes !== "number" || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let val = bytes;
  let u = 0;
  while (val >= 1024 && u < units.length - 1) {
    val /= 1024;
    u++;
  }
  return `${val.toFixed(u > 1 ? 1 : 0)} ${units[u]}`;
}

function formatDuration(sec) {
  if (!sec || typeof sec !== "number" || sec <= 0) return "";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatTypeBadge(type, isYoutube) {
  if (isYoutube || type === "youtube_format") return "YouTube";
  if (type === "m3u8" || type === "m3u8_playlist") return "HLS / M3U8";
  if (type === "mpd_playlist") return "DASH / MPD";
  return "HTTP / Direto";
}

function renderActiveDownloads(activeDownloads) {
  const container = document.getElementById("active-downloads-container");
  container.replaceChildren();

  if (!activeDownloads || activeDownloads.length === 0) {
    container.classList.add("hidden");
    return;
  }

  container.classList.remove("hidden");

  for (const dl of activeDownloads) {
    const card = document.createElement("div");
    card.className = "download-progress-card";

    const topRow = document.createElement("div");
    topRow.className = "dl-row-top";

    const titleEl = document.createElement("span");
    titleEl.className = "dl-title";
    titleEl.textContent = dl.title;

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-danger";
    cancelBtn.style.padding = "3px 8px";
    cancelBtn.style.fontSize = "10.5px";
    cancelBtn.textContent = "Cancelar";
    cancelBtn.addEventListener("click", () => {
      sendCommand("ABORT_DOWNLOAD", { downloadId: dl.downloadId });
    });

    topRow.append(titleEl, cancelBtn);

    const track = document.createElement("div");
    track.className = "progress-track";
    const fill = document.createElement("div");
    fill.className = "progress-fill";
    fill.style.width = `${dl.percent || 5}%`;
    track.appendChild(fill);

    const metaRow = document.createElement("div");
    metaRow.className = "dl-meta";

    const statusLabel =
      dl.status === "queuing"
        ? "Iniciando FFmpeg..."
        : dl.status === "finalizing"
          ? "Finalizando arquivo..."
          : `Processando (${dl.percent || 0}%)`;

    const leftMeta = document.createElement("span");
    leftMeta.textContent = statusLabel;

    const rightMeta = document.createElement("span");
    const sizeText = formatBytes(dl.fetchedBytes);
    const speedText = dl.bitrate > 0 ? `${formatBytes(dl.bitrate)}/s` : "";
    rightMeta.textContent = [sizeText, speedText].filter(Boolean).join(" • ");

    metaRow.append(leftMeta, rightMeta);
    card.append(topRow, track, metaRow);
    container.appendChild(card);
  }
}

function renderMediaList(mediaList, tabId) {
  const listEl = document.getElementById("media-list");
  const emptyEl = document.getElementById("media-empty");
  const countBadge = document.getElementById("media-count");

  countBadge.textContent = String(mediaList.length);

  // Se o usuário estiver digitando em um input de título, só atualiza os contadores
  if (document.activeElement && document.activeElement.classList.contains("title-input")) {
    return;
  }

  listEl.replaceChildren();

  if (mediaList.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }

  emptyEl.classList.add("hidden");

  for (const media of mediaList) {
    const card = document.createElement("div");
    card.className = "media-card";

    // Linha superior: Miniatura + Título editável + URL
    const top = document.createElement("div");
    top.className = "media-top";

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "thumb-wrap";

    if (media.thumbnailUrl) {
      const img = document.createElement("img");
      img.src = media.thumbnailUrl;
      img.alt = "Thumbnail";
      img.addEventListener("error", () => {
        img.remove();
      });
      thumbWrap.appendChild(img);
    } else {
      const fallbackIcon = document.createElement("span");
      fallbackIcon.style.color = "#64748b";
      fallbackIcon.style.fontSize = "11px";
      fallbackIcon.textContent = media.extension.toUpperCase();
      thumbWrap.appendChild(fallbackIcon);
    }

    const typeBadge = document.createElement("span");
    typeBadge.className = "badge-type";
    typeBadge.textContent = formatTypeBadge(media.type, media.isYoutube);
    thumbWrap.appendChild(typeBadge);

    const durText = formatDuration(media.duration);
    if (durText) {
      const durBadge = document.createElement("span");
      durBadge.className = "badge-duration";
      durBadge.textContent = durText;
      thumbWrap.appendChild(durBadge);
    }

    const info = document.createElement("div");
    info.className = "media-info";

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "title-input";
    titleInput.value = customTitlesByHash.get(media.hash) ?? (media.title || "VideoGrab_Media");
    titleInput.title = "Clique para renomear o arquivo antes de baixar";
    titleInput.addEventListener("input", () => {
      customTitlesByHash.set(media.hash, titleInput.value);
    });

    const urlPreview = document.createElement("div");
    urlPreview.className = "media-url-preview";
    urlPreview.textContent = media.masterUrl || "";
    urlPreview.title = media.masterUrl || "";

    info.append(titleInput, urlPreview);
    top.append(thumbWrap, info);

    // Linha inferior: Seletor de resolução + Botões de ação
    const controls = document.createElement("div");
    controls.className = "media-controls";

    const select = document.createElement("select");
    select.className = "variant-select";

    const variants = media.variants && media.variants.length > 0
      ? media.variants
      : [{ index: 0, label: "Qualidade Original", size: null }];

    for (const v of variants) {
      const opt = document.createElement("option");
      opt.value = String(v.index);
      const sizeStr = formatBytes(v.size);
      opt.textContent = sizeStr ? `${v.label} — ${sizeStr}` : v.label;
      select.appendChild(opt);
    }

    if (selectedVariantByHash.has(media.hash)) {
      select.value = selectedVariantByHash.get(media.hash);
    }
    select.addEventListener("change", () => {
      selectedVariantByHash.set(media.hash, select.value);
    });

    const btnVideo = document.createElement("button");
    btnVideo.className = "btn btn-primary";
    btnVideo.textContent = "Baixar Vídeo";
    btnVideo.addEventListener("click", async () => {
      btnVideo.disabled = true;
      await sendCommand("START_DOWNLOAD", {
        tabId,
        mediaHash: media.hash,
        variantIndex: parseInt(select.value, 10) || 0,
        audioOnly: false,
        customTitle: titleInput.value.trim()
      });
      btnVideo.disabled = false;
    });

    const btnAudio = document.createElement("button");
    btnAudio.className = "btn btn-secondary";
    btnAudio.textContent = "Áudio MP3";
    btnAudio.title = "Extrair e converter apenas o áudio para MP3";
    btnAudio.addEventListener("click", async () => {
      btnAudio.disabled = true;
      await sendCommand("START_DOWNLOAD", {
        tabId,
        mediaHash: media.hash,
        variantIndex: parseInt(select.value, 10) || 0,
        audioOnly: true,
        customTitle: titleInput.value.trim()
      });
      btnAudio.disabled = false;
    });

    const btnCopy = document.createElement("button");
    btnCopy.className = "btn btn-secondary";
    btnCopy.style.padding = "6px 8px";
    btnCopy.title = "Copiar URL da stream";
    btnCopy.textContent = "URL";
    btnCopy.addEventListener("click", async () => {
      if (media.masterUrl) {
        await navigator.clipboard.writeText(media.masterUrl);
        const orig = btnCopy.textContent;
        btnCopy.textContent = "OK!";
        setTimeout(() => {
          btnCopy.textContent = orig;
        }, 1200);
      }
    });

    const btnDismiss = document.createElement("button");
    btnDismiss.className = "btn btn-secondary";
    btnDismiss.style.padding = "6px 8px";
    btnDismiss.title = "Remover da lista";
    btnDismiss.textContent = "✕";
    btnDismiss.addEventListener("click", () => {
      sendCommand("DISMISS_MEDIA", { tabId, mediaHash: media.hash });
    });

    controls.append(select, btnVideo, btnAudio, btnCopy, btnDismiss);
    card.append(top, controls);
    listEl.appendChild(card);
  }
}

function renderHistory(historyList) {
  const listEl = document.getElementById("history-list");
  const countBadge = document.getElementById("history-count");

  countBadge.textContent = String(historyList.length);
  listEl.replaceChildren();

  if (historyList.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Nenhum download registrado no histórico.";
    listEl.appendChild(empty);
    return;
  }

  for (const item of historyList) {
    const row = document.createElement("div");
    row.className = "history-item";

    const info = document.createElement("div");
    info.className = "history-info";

    const title = document.createElement("div");
    title.className = "history-title";
    title.textContent = item.title;

    const meta = document.createElement("div");
    meta.className = "history-meta";
    const dateStr = new Date(item.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
    meta.textContent =
      item.status === "complete"
        ? `Concluído às ${dateStr}`
        : `Falhou: ${item.error || "Erro desconhecido"}`;
    if (item.status !== "complete") {
      meta.style.color = "var(--danger)";
    }

    info.append(title, meta);
    row.appendChild(info);

    if (item.status === "complete" && item.browserDownloadId) {
      const showBtn = document.createElement("button");
      showBtn.className = "btn btn-secondary";
      showBtn.textContent = "Abrir Pasta";
      showBtn.addEventListener("click", () => {
        sendCommand("SHOW_IN_FOLDER", { browserDownloadId: item.browserDownloadId });
      });
      row.appendChild(showBtn);
    }

    listEl.appendChild(row);
  }
}

function syncSettingsUI(settings) {
  if (!settings) return;
  const muxerEl = document.getElementById("set-muxer");
  const subdirEl = document.getElementById("set-subdir");
  const saveAsEl = document.getElementById("set-saveas");
  const ytThrottleEl = document.getElementById("set-yt-throttle");
  const notifEl = document.getElementById("set-notifications");

  if (document.activeElement !== subdirEl) {
    subdirEl.value = settings.subdir || "";
  }
  muxerEl.value = settings.preferredMuxer || "mp4";
  saveAsEl.checked = Boolean(settings.saveAs);
  ytThrottleEl.checked = Boolean(settings.youtubeThrottle);
  notifEl.checked = settings.showNotifications !== false;
}

async function refreshState() {
  const res = await sendCommand("GET_STATE");
  if (!res?.ok || !res.state) return;
  currentState = res.state;

  renderActiveDownloads(currentState.activeDownloads);
  renderMediaList(currentState.mediaList, currentState.tabId);
  renderHistory(currentState.history);
  syncSettingsUI(currentState.settings);
}

// Configura navegação por abas e botões globais
function initUI() {
  const navTabs = document.querySelectorAll(".nav-tab");
  const sections = {
    media: document.getElementById("tab-media"),
    history: document.getElementById("tab-history"),
    settings: document.getElementById("tab-settings")
  };

  navTabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      navTabs.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const target = btn.getAttribute("data-tab");
      for (const [key, sec] of Object.entries(sections)) {
        sec.classList.toggle("hidden", key !== target);
      }
    });
  });

  document.getElementById("btn-force-detect")?.addEventListener("click", () => {
    sendCommand("FORCE_DETECTION", { tabId: currentState.tabId });
  });

  document.getElementById("btn-empty-reload")?.addEventListener("click", () => {
    sendCommand("FORCE_DETECTION", { tabId: currentState.tabId });
  });

  document.getElementById("btn-open-folder")?.addEventListener("click", () => {
    sendCommand("SHOW_IN_FOLDER", {});
  });

  document.getElementById("btn-open-sidepanel")?.addEventListener("click", async () => {
    try {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
      window.close();
    } catch (err) {
      console.error("[VideoGrab] Erro ao abrir Side Panel:", err);
    }
  });

  document.getElementById("btn-clear-history")?.addEventListener("click", () => {
    sendCommand("CLEAR_HISTORY");
  });

  // Listeners de Configurações
  const saveSettings = () => {
    sendCommand("UPDATE_SETTINGS", {
      preferredMuxer: document.getElementById("set-muxer").value,
      subdir: document.getElementById("set-subdir").value.trim(),
      saveAs: document.getElementById("set-saveas").checked,
      youtubeThrottle: document.getElementById("set-yt-throttle").checked,
      showNotifications: document.getElementById("set-notifications").checked
    });
  };

  document.getElementById("set-muxer")?.addEventListener("change", saveSettings);
  document.getElementById("set-subdir")?.addEventListener("change", saveSettings);
  document.getElementById("set-saveas")?.addEventListener("change", saveSettings);
  document.getElementById("set-yt-throttle")?.addEventListener("change", saveSettings);
  document.getElementById("set-notifications")?.addEventListener("change", saveSettings);

  // Escuta atualizações em tempo real vindas do Service Worker
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "VIDEOGRAB_STATE_UPDATED") {
      refreshState();
    }
  });

  refreshState();
}

document.addEventListener("DOMContentLoaded", initUI);
