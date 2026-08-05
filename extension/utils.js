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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

    const asDate = new Date(trimmed);
    if (!Number.isNaN(asDate.getTime())) {
      return asDate.toISOString();
    }

    const numeric = toCount(trimmed);
    return Number.isFinite(numeric) ? toTimestamp(numeric) : null;
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
