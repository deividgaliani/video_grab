/**
 * VideoGrab — Protocolo de Serialização (Serde) e Tipos Funcionais (Option/Result)
 * Garante compatibilidade binária e estrutural com o motor download_worker (LibAV WASM)
 * e com os extratores de plataforma em injected/*.js.
 */

export const CHANNELS = {
  FromInjectedToService: 0,
  FromContentToService: 1,
  FromServiceToWorker: 2,
  FromWorkerToService: 3,
  FromUntrustedInjectedToTrusted: 4,
  FromTrustedInjectedToUntrusted: 5,
  FromServiceToContent: 6,
  FromServiceToInjected: 7,
  FromServiceToService: 8
};

export class OptionSome {
  constructor(value) {
    this.value = value;
  }
  isSome() { return true; }
  isNone() { return false; }
  unwrap() { return this.value; }
  unwrapOr(_def) { return this.value; }
  map(fn) { return Some(fn(this.value)); }
  andThen(fn) { return fn(this.value); }
}

export class OptionNone {
  isSome() { return false; }
  isNone() { return true; }
  unwrap() { throw new Error("Tried to unwrap None"); }
  unwrapOr(def) { return def; }
  map(_fn) { return this; }
  andThen(_fn) { return this; }
}

export const None = Object.freeze(new OptionNone());
export function Some(value) {
  return new OptionSome(value);
}
export function isOption(val) {
  return val instanceof OptionSome || val instanceof OptionNone || val === None;
}

export class ResultOk {
  constructor(value) {
    this.value = value;
  }
  isOk() { return true; }
  isErr() { return false; }
  unwrap() { return this.value; }
  unwrapOr(_def) { return this.value; }
  map(fn) { return Ok(fn(this.value)); }
}

export class ResultErr {
  constructor(error) {
    this.error = error;
  }
  isOk() { return false; }
  isErr() { return true; }
  unwrap() { throw new Error(`Tried to unwrap Err: ${this.error}`); }
  unwrapOr(def) { return def; }
  map(_fn) { return this; }
}

export function Ok(value) {
  return new ResultOk(value);
}
export function Err(error) {
  return new ResultErr(error);
}
export function isResult(val) {
  return val instanceof ResultOk || val instanceof ResultErr;
}

/**
 * Hash de 53 bits rápido (cyrb53) usado para gerar identificadores determinísticos de mídia.
 */
export function hashString(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Serializa estruturas complexas (URL, Headers, Map, Set, Option, Result)
 * no formato esperado pelo download_worker/main.js.
 */
export function serialize(val) {
  if (
    typeof val === "string" ||
    typeof val === "number" ||
    typeof val === "boolean" ||
    typeof val === "undefined" ||
    val === null
  ) {
    return { __serde_tag: "primitive", __serde_val: val };
  }
  if (Array.isArray(val)) {
    return { __serde_tag: "array", __serde_val: val.map((item) => serialize(item)) };
  }
  if (val instanceof URL) {
    return { __serde_tag: "url", __serde_val: val.href };
  }
  if (val instanceof Headers) {
    const pairs = [];
    val.forEach((v, k) => pairs.push([k, v]));
    return { __serde_tag: "headers", __serde_val: pairs };
  }
  if (val instanceof Set) {
    return { __serde_tag: "set", __serde_val: [...val.values()].map(serialize) };
  }
  if (val instanceof Map) {
    return {
      __serde_tag: "map",
      __serde_val: [...val.entries()].map(([k, v]) => [serialize(k), serialize(v)])
    };
  }
  if (val instanceof RegExp) {
    return { __serde_tag: "regex", __serde_val: [val.source, val.flags] };
  }
  if (isOption(val)) {
    return val.isSome()
      ? { __serde_tag: "some", __serde_val: serialize(val.value) }
      : { __serde_tag: "none" };
  }
  if (isResult(val)) {
    return val.isOk()
      ? { __serde_tag: "ok", __serde_val: serialize(val.value) }
      : { __serde_tag: "err", __serde_val: serialize(val.error) };
  }
  if (typeof val === "object") {
    const obj = {};
    for (const [k, v] of Object.entries(val)) {
      obj[k] = serialize(v);
    }
    return { __serde_tag: "object", __serde_val: obj };
  }
  throw new Error(`Unsupported value in serialize: ${typeof val}`);
}

/**
 * Deserializa estruturas vindas dos scripts injetados (injected/*.js) ou do worker.
 */
export function deserialize(raw) {
  if (!raw || typeof raw !== "object" || !("__serde_tag" in raw)) {
    return raw;
  }
  switch (raw.__serde_tag) {
    case "primitive":
      return raw.__serde_val;
    case "object": {
      const out = {};
      for (const [k, v] of Object.entries(raw.__serde_val)) {
        out[k] = deserialize(v);
      }
      return out;
    }
    case "map":
      return new Map(raw.__serde_val.map(([k, v]) => [deserialize(k), deserialize(v)]));
    case "set":
      return new Set(raw.__serde_val.map(deserialize));
    case "url":
      return new URL(raw.__serde_val);
    case "array":
      return raw.__serde_val.map(deserialize);
    case "headers":
      return new Headers(raw.__serde_val);
    case "regex":
      return new RegExp(raw.__serde_val[0], raw.__serde_val[1]);
    case "some":
      return Some(deserialize(raw.__serde_val));
    case "none":
      return None;
    case "ok":
      return Ok(deserialize(raw.__serde_val));
    case "err":
      return Err(deserialize(raw.__serde_val));
    default:
      return raw.__serde_val;
  }
}

/**
 * Converte um objeto de mídia rico (com URLs, Options, Headers) em um objeto JSON plano
 * para renderização rápida na UI (Popup / Side Panel).
 */
export function mediaToPlainUI(media) {
  const unwrapOpt = (v) => (isOption(v) ? (v.isSome() ? unwrapOpt(v.value) : null) : v instanceof URL ? v.href : v);

  const variants = [];
  if (Array.isArray(media.playlist)) {
    media.playlist.forEach((item, idx) => {
      const res = unwrapOpt(item.resolution);
      const height = res && typeof res === "object" ? res.height : typeof item.height === "number" ? item.height : null;
      const width = res && typeof res === "object" ? res.width : typeof item.width === "number" ? item.width : null;
      const size = unwrapOpt(item.size);
      const fps = unwrapOpt(item.fps);
      const vcodec = unwrapOpt(item.vcodec) || unwrapOpt(item.demuxer) || media.extension || "mp4";
      const hasVideo = item.av ? item.av.video !== false : true;
      const hasAudio = item.av ? Boolean(item.av.audio) : true;

      let label = height ? `${height}p` : hasVideo ? "Vídeo Padrão" : "Somente Áudio";
      if (width && height) label = `${height}p (${width}×${height})`;
      if (fps && fps > 30) label += ` ${fps}fps`;

      let videoContentLength = null;
      if (item.av?.video && typeof item.av.video === "object" && item.av.video.content_length) {
        videoContentLength = unwrapOpt(item.av.video.content_length);
      }

      variants.push({
        index: idx,
        label,
        height: height || 0,
        width: width || 0,
        size: size || videoContentLength || null,
        container: typeof vcodec === "string" ? vcodec : "mp4",
        hasVideo,
        hasAudio
      });
    });
  } else {
    variants.push({
      index: 0,
      label: media.type === "m3u8" ? "Stream HLS (Auto)" : "Qualidade Original",
      height: 0,
      width: 0,
      size: unwrapOpt(media.size) || null,
      container: media.extension || "mp4",
      hasVideo: true,
      hasAudio: true
    });
  }

  // Ordenar variantes da maior resolução para a menor
  variants.sort((a, b) => (b.height || 0) - (a.height || 0));

  const masterUrl =
    unwrapOpt(media.master_url) ||
    unwrapOpt(media.url) ||
    (media.playlist?.[0]?.av?.video ? unwrapOpt(media.playlist[0].av.video.url || media.playlist[0].av.video) : "");

  return {
    hash: media.hash,
    type: media.type, // http_playlist, m3u8, m3u8_playlist, mpd_playlist, youtube_format
    title: unwrapOpt(media.title) || null,
    thumbnailUrl: unwrapOpt(media.thumbnail_url) || null,
    duration: typeof media.duration === "number" ? media.duration : unwrapOpt(media.duration) || null,
    extension: media.extension || "mp4",
    isYoutube: Boolean(media.is_youtube),
    hasDrm: Boolean(media.has_drm),
    masterUrl: typeof masterUrl === "string" ? masterUrl : masterUrl?.href || "",
    discoveryTimestamp: media.discovery_timestamp || Date.now(),
    variants
  };
}
