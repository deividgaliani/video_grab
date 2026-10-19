/**
 * VideoGrab — Gerenciador de Cabeçalhos via DeclarativeNetRequest (DNR)
 * Injeta cabeçalhos restritos do navegador (Referer, Origin, Cookie, Sec-*)
 * nas requisições feitas pelo download_worker durante o download de streams protegidos.
 */

const BROWSER_ONLY_HEADERS = [/^Sec-/i, /^Cookie$/i, /^Date$/i, /^Origin$/i, /^Referer$/i];
const FORBIDDEN_FETCH_HEADERS = [
  /Range/i,
  /^Proxy-/i,
  /^User-Agent$/i,
  /^Accept-Charset$/i,
  /^Accept-Encoding$/i,
  /^Access-Control-Request-Headers$/i,
  /^Access-Control-Request-Method$/i,
  /^Connection$/i,
  /^Content-Length$/i,
  /^DNT$/i,
  /^Expect$/i,
  /^Keep-Alive$/i,
  /^Permissions-Policy$/i,
  /^TE$/i,
  /^Trailer$/i,
  /^Transfer-Encoding$/i,
  /^Upgrade$/i,
  /^Via$/i,
  /^Host/i
];

export function cloneHeaders(headers) {
  const out = new Headers();
  if (!headers) return out;
  headers.forEach((val, key) => {
    try {
      out.set(key, val);
    } catch {
      // ignora cabeçalhos inválidos
    }
  });
  return out;
}

export function extractBrowserOnlyHeaders(headers) {
  const out = new Headers();
  if (!headers) return out;
  headers.forEach((val, key) => {
    if (BROWSER_ONLY_HEADERS.some((rx) => rx.test(key))) {
      out.set(key, val);
    }
  });
  return out;
}

export function stripForbiddenFetchHeaders(headers) {
  if (!headers) return;
  const toDelete = [];
  for (const key of headers.keys()) {
    if (FORBIDDEN_FETCH_HEADERS.some((rx) => rx.test(key))) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) {
    headers.delete(key);
  }
}

export function sanitizeWorkerHeaders(headers) {
  if (!headers) return;
  const toDelete = [];
  for (const key of headers.keys()) {
    if (
      FORBIDDEN_FETCH_HEADERS.some((rx) => rx.test(key)) ||
      BROWSER_ONLY_HEADERS.some((rx) => rx.test(key))
    ) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) {
    headers.delete(key);
  }
}

/**
 * Adiciona regras temporárias na sessão do declarativeNetRequest para os filtros de URL.
 * Retorna a lista de IDs de regras criadas para remoção posterior.
 */
export async function addSessionHeaderRules(urlFilters, headers) {
  const requestHeaders = [];
  if (headers) {
    headers.forEach((value, header) => {
      if (value) {
        requestHeaders.push({ operation: "set", header, value });
      }
    });
  }
  if (requestHeaders.length === 0 || !urlFilters || urlFilters.length === 0) {
    return [];
  }

  const ruleIds = [];
  const rules = [];

  for (const urlFilter of urlFilters) {
    const id = Math.floor(100000 + Math.random() * 90000000);
    ruleIds.push(id);
    rules.push({
      id,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders
      },
      condition: {
        urlFilter,
        resourceTypes: ["xmlhttprequest", "media", "other"]
      }
    });
  }

  try {
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
  } catch (err) {
    console.warn("[VideoGrab DNR] Falha ao configurar regras de cabeçalho:", err);
    return [];
  }

  return ruleIds;
}

/**
 * Remove as regras temporárias após o término do download.
 */
export async function removeSessionHeaderRules(ruleIds) {
  if (!ruleIds || ruleIds.length === 0) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds });
  } catch (err) {
    console.warn("[VideoGrab DNR] Erro ao remover regras de sessão:", err);
  }
}

/**
 * Prepara as regras DNR adequadas para os URLs envolvidos em um download_args.
 */
export async function prepareDownloadDnrRules(downloadArgs) {
  const urls = [];
  if (downloadArgs.url instanceof URL) {
    if (downloadArgs.url.protocol === "data:" || downloadArgs.url.protocol === "blob:") {
      return [];
    }
    // Regra para a pasta base (útil para segmentos HLS/DASH no mesmo diretório)
    const dirWildcard = new URL(".", downloadArgs.url).href + "*";
    urls.push(dirWildcard);
    urls.push(downloadArgs.url.href);
  }
  if (downloadArgs.url_audio instanceof URL) {
    const audioDirWildcard = new URL(".", downloadArgs.url_audio).href + "*";
    urls.push(audioDirWildcard);
    urls.push(downloadArgs.url_audio.href);
  }

  const uniqueFilters = [...new Set(urls)];
  const headersToInject = downloadArgs.will_use_jsfetch
    ? cloneHeaders(downloadArgs.headers)
    : extractBrowserOnlyHeaders(downloadArgs.headers);

  if (downloadArgs.will_use_jsfetch) {
    stripForbiddenFetchHeaders(headersToInject);
  }

  const ruleIds = await addSessionHeaderRules(uniqueFilters, headersToInject);
  sanitizeWorkerHeaders(downloadArgs.headers);
  return ruleIds;
}
