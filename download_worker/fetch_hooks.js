/**
 * VideoGrab — Hooks de fetch do download_worker
 * Envolve `globalThis.fetch` para recalcular cabeçalhos dinâmicos por requisição
 * (ver service/per_request_headers.js) em todas as requisições do motor de download:
 * manifestos HLS, segmentos e chaves AES-128.
 *
 * Deve ser importado ANTES de ./main.js (ver ./bootstrap.js).
 */

import { applyPerRequestHeaders } from "../service/per_request_headers.js";

const nativeFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = function videoGrabFetch(input, init) {
  try {
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const source = init?.headers ?? (isRequest ? input.headers : null);
    if (source) {
      const headers = new Headers(source);
      const url = isRequest ? input.url : input instanceof URL ? input.href : String(input);
      if (applyPerRequestHeaders(headers, url)) {
        init = { ...(init || {}), headers };
      }
    }
  } catch {
    // Em caso de falha, segue com a requisição original sem alterações
  }
  return nativeFetch(input, init);
};
