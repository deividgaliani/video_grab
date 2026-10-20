/**
 * VideoGrab — Gerenciador de Cabeçalhos via DeclarativeNetRequest (DNR)
 * Injeta cabeçalhos restritos do navegador (Referer, Origin, Cookie, Sec-*)
 * nas requisições feitas pelo download_worker durante o download de streams protegidos.
 */

import { stripPerRequestHeaders, applyPerRequestHeaders } from "./per_request_headers.js";

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
 * Monta os cabeçalhos que podem ser enviados diretamente via fetch() a partir dos cabeçalhos
 * capturados da página (ex.: tokens customizados como `content`), recalculando os
 * cabeçalhos dinâmicos para `url`. Cabeçalhos restritos devem ir via DNR.
 */
export function buildFetchHeaders(headers, url) {
  const out = cloneHeaders(headers);
  sanitizeWorkerHeaders(out);
  applyPerRequestHeaders(out, url);
  return out;
}

/**
 * Adiciona regras temporárias na sessão do declarativeNetRequest para os filtros de URL.
 * Retorna a lista de IDs de regras criadas para remoção posterior.
 */
export async function addSessionHeaderRules(urlFilters, headers, extraCondition = {}) {
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
        resourceTypes: ["xmlhttprequest", "media", "other"],
        ...extraCondition
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
  // Cabeçalhos dinâmicos (ex.: x-content-uri) são recalculados pelo worker a cada fetch;
  // uma regra DNR estática sobrescreveria o valor correto.
  stripPerRequestHeaders(headersToInject);

  const ruleIds = await addSessionHeaderRules(uniqueFilters, headersToInject);

  // Origin/Referer também para subdomínios irmãos do mesmo site (ex.: servidor de chaves
  // AES-128 em keyaes.privacy.com.br quando o vídeo está em video.privacy.com.br).
  // Restrito a requisições fora de abas (worker da extensão) para não afetar a página.
  const siteHeaders = pickHeaders(downloadArgs.headers, SITE_WIDE_HEADERS);
  const siteFilters = [downloadArgs.url, downloadArgs.url_audio]
    .filter((u) => u instanceof URL && u.protocol.startsWith("http"))
    .map((u) => `||${getSiteDomain(u.hostname)}^`);
  if (siteFilters.length > 0) {
    const siteRuleIds = await addSessionHeaderRules([...new Set(siteFilters)], siteHeaders, {
      tabIds: [chrome.tabs.TAB_ID_NONE]
    });
    ruleIds.push(...siteRuleIds);
  }

  sanitizeWorkerHeaders(downloadArgs.headers);
  return ruleIds;
}

const SITE_WIDE_HEADERS = [/^Origin$/i, /^Referer$/i];
const COMMON_SECOND_LEVEL = new Set(["com", "net", "org", "gov", "edu", "co", "ac", "or", "ne", "go"]);

function pickHeaders(headers, patterns) {
  const out = new Headers();
  if (!headers) return out;
  headers.forEach((val, key) => {
    if (patterns.some((rx) => rx.test(key))) out.set(key, val);
  });
  return out;
}

/**
 * Heurística leve de domínio registrável (eTLD+1), cobrindo ccSLDs comuns como `.com.br`.
 */
export function getSiteDomain(hostname) {
  const labels = hostname.split(".");
  if (labels.length <= 2 || /^[\d.]+$/.test(hostname) || hostname.includes(":")) return hostname;
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const take = tld.length === 2 && COMMON_SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-take).join(".");
}
