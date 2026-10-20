/**
 * VideoGrab — Cabeçalhos dinâmicos por requisição
 * Alguns CDNs exigem cabeçalhos cujo valor muda a cada requisição, derivado da própria URL
 * (ex.: `x-content-uri: <nome-do-arquivo>` usado por video.privacy.com.br em manifestos,
 * segmentos .ts e chaves AES-128). Esses cabeçalhos NÃO podem ir para regras DNR estáticas;
 * devem ser recalculados a cada fetch.
 *
 * Módulo sem dependências de `chrome.*` para poder ser importado tanto pelo Service Worker
 * quanto pelo download_worker.
 */

/**
 * Mapa: nome do cabeçalho (minúsculo) -> função que deriva o valor a partir da URL requisitada.
 */
const PER_REQUEST_HEADER_RESOLVERS = {
  // Último segmento do caminho da URL (nome do arquivo), sem query string.
  "x-content-uri": (url) => url.pathname.split("/").pop() || ""
};

export function isPerRequestHeader(name) {
  return typeof name === "string" && name.toLowerCase() in PER_REQUEST_HEADER_RESOLVERS;
}

export function hasPerRequestHeaders(headers) {
  if (!headers || typeof headers.keys !== "function") return false;
  for (const key of headers.keys()) {
    if (isPerRequestHeader(key)) return true;
  }
  return false;
}

/**
 * Remove (in-place) os cabeçalhos dinâmicos de um objeto Headers.
 */
export function stripPerRequestHeaders(headers) {
  if (!headers) return;
  const toDelete = [];
  for (const key of headers.keys()) {
    if (isPerRequestHeader(key)) toDelete.push(key);
  }
  for (const key of toDelete) headers.delete(key);
}

/**
 * Reescreve (in-place) os cabeçalhos dinâmicos presentes em `headers` com o valor
 * correto para `url`. Cabeçalhos dinâmicos ausentes não são adicionados.
 * Retorna `true` se algum cabeçalho foi reescrito.
 */
export function applyPerRequestHeaders(headers, url) {
  if (!headers || !hasPerRequestHeaders(headers)) return false;
  let urlObj;
  try {
    urlObj = url instanceof URL ? url : new URL(String(url));
  } catch {
    return false;
  }
  let changed = false;
  for (const [name, resolve] of Object.entries(PER_REQUEST_HEADER_RESOLVERS)) {
    if (!headers.has(name)) continue;
    const value = resolve(urlObj);
    if (value) {
      headers.set(name, value);
      changed = true;
    }
  }
  return changed;
}
