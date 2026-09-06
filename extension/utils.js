// Utilitários genéricos sem dependências (além de constants.js).
// Carregado pelo service worker via importScripts antes dos demais módulos.

const TRANSIENT_SERVICE_ERROR_PATTERNS = [
  /timeout/i,
  /timed out/i,   // AbortSignal.timeout() lança DOMException("signal timed out")
  /o gr[aá]fico real n[aã]o apareceu/i,
  /n[aã]o consegui transformar o gr[aá]fico renderizado em s[ée]rie/i,
  /receiving end does not exist/i,
  /the message port closed before a response was received/i,
  /frame with id \d+ is showing error page/i,
  /no tab with id/i,
  /tabs cannot be edited right now/i
];

function delay(ms, abortSignal = null) {
  if (!abortSignal) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  if (abortSignal.aborted) {
    return Promise.reject(abortSignal.reason || new DOMException("Operação cancelada.", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    let timeoutId = null;

    const cleanup = () => {
      clearTimeout(timeoutId);
      abortSignal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(abortSignal.reason || new DOMException("Operação cancelada.", "AbortError"));
    };

    timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

function sanitizeSlug(value) {
  const slug = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(slug) ? slug : null;
}

function isRetryableServiceError(error) {
  const message = String(error?.message || error || "").trim();
  if (!message) return false;
  return TRANSIENT_SERVICE_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

function sanitizeThreshold(value) {
  const threshold = parseInt(value, 10);
  return Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_THRESHOLD;
}

function sanitizeSourceSite(value) {
  return value === "com" ? "com" : DEFAULT_SOURCE_SITE;
}

function toCount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed || !/^[\d.,]+$/.test(trimmed)) return null;

  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return null;

  const parsed = parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // Strings compostas só por dígitos são contagens ou timestamps Unix. O
    // Date.parse aceita valores como "100" como o ano 0100, o que fazia uma
    // contagem ser confundida com data e alterava a escolha da série.
    if (/^\d+$/.test(trimmed)) {
      const numeric = toCount(trimmed);
      return Number.isFinite(numeric) ? toTimestamp(numeric) : null;
    }

    const asDate = new Date(trimmed);
    if (!Number.isNaN(asDate.getTime()) &&
      asDate.getUTCFullYear() >= 2020 && asDate.getUTCFullYear() <= 2100) {
      return asDate.toISOString();
    }

    return null;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) return null;

  let milliseconds = null;
  if (value > 100000000000) {
    milliseconds = value;
  } else if (value > 1000000000) {
    milliseconds = value * 1000;
  } else {
    return null;
  }

  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCFullYear() < 2020 || date.getUTCFullYear() > 2100) return null;
  return date.toISOString();
}
