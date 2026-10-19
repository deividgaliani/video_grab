/**
 * VideoGrab — Detector Universal de Mídia e Metadados de Página (Content Script)
 * Coleta metadados da página (título, miniatura OpenGraph, poster de vídeo) e
 * detecta elementos <video> / <audio> com URLs HTTP diretas ou HLS/DASH no DOM.
 */

(function () {
  const reportedUrls = new Set();

  function getBestThumbnail() {
    const selectors = [
      { sel: "video[poster]", attr: "poster" },
      { sel: "meta[property='og:image']", attr: "content" },
      { sel: "meta[name='twitter:image']", attr: "content" },
      { sel: "link[rel='image_src']", attr: "href" }
    ];
    for (const { sel, attr } of selectors) {
      const el = document.querySelector(sel);
      const val = el?.getAttribute(attr);
      if (val && typeof val === "string") {
        try {
          return new URL(val, window.location.href).href;
        } catch {
          // ignora URL inválida
        }
      }
    }
    return null;
  }

  function getCleanPageTitle() {
    const ogTitle = document.querySelector("meta[property='og:title']")?.getAttribute("content");
    const h1 = document.querySelector("h1")?.textContent?.trim();
    return (ogTitle || document.title || h1 || window.location.hostname).trim();
  }

  function scanDomMediaElements() {
    // Evita enviar blobs do YouTube/Vimeo que já têm extratores dedicados
    const host = window.location.hostname;
    if (host.includes("youtube.com") || host.includes("vimeo.com")) return;

    const mediaElements = document.querySelectorAll("video, audio");
    const title = getCleanPageTitle();
    const thumbnail = getBestThumbnail();

    mediaElements.forEach((el) => {
      const candidates = [];
      if (el.currentSrc) candidates.push(el.currentSrc);
      if (el.src) candidates.push(el.src);
      el.querySelectorAll("source").forEach((s) => {
        if (s.src) candidates.push(s.src);
      });

      for (const rawUrl of candidates) {
        if (!rawUrl || rawUrl.startsWith("blob:") || rawUrl.startsWith("data:")) continue;
        if (reportedUrls.has(rawUrl)) continue;
        reportedUrls.add(rawUrl);

        chrome.runtime.sendMessage({
          type: "VIDEOGRAB_DOM_MEDIA",
          payload: {
            url: rawUrl,
            title,
            thumbnailUrl: el.getAttribute("poster") || thumbnail,
            duration: Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration) : null,
            width: el.videoWidth || null,
            height: el.videoHeight || null
          }
        }).catch(() => {});
      }
    });
  }

  function sendPageMetadataUpdate() {
    chrome.runtime.sendMessage({
      type: "VIDEOGRAB_PAGE_META",
      payload: {
        title: getCleanPageTitle(),
        thumbnailUrl: getBestThumbnail(),
        pageUrl: window.location.href
      }
    }).catch(() => {});
  }

  // Responde a consultas diretas do Service Worker
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "VIDEOGRAB_GET_PAGE_META") {
      sendResponse({
        title: getCleanPageTitle(),
        thumbnailUrl: getBestThumbnail(),
        pageUrl: window.location.href
      });
      return false;
    }
  });

  // Executa varredura inicial e observa mutações dinâmicas (SPAs)
  sendPageMetadataUpdate();
  scanDomMediaElements();

  document.addEventListener("loadedmetadata", () => {
    sendPageMetadataUpdate();
    scanDomMediaElements();
  }, true);

  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      scanDomMediaElements();
    }, 1200);
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }
})();
