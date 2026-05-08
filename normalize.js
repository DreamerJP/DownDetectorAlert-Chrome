// Normalização de séries históricas vindas do payload da API do Downdetector.
// Depende de utils.js (toCount, toTimestamp).

function normalizePoint(point) {
  if (typeof point === "number" && Number.isFinite(point)) {
    return { value: Math.max(0, Math.round(point)) };
  }

  if (Array.isArray(point)) {
    const entries = point.map((item, index) => ({
      index,
      timestamp: toTimestamp(item),
      numeric: typeof item === "number" ? item : toCount(item)
    }));

    const timestampEntry = entries.find(entry => entry.timestamp && entry.index === 0) ||
      entries.find(entry => entry.timestamp);

    const numericEntries = entries.filter(entry => Number.isFinite(entry.numeric));
    let valueEntry = null;
    let baselineEntry = null;

    if (timestampEntry) {
      valueEntry = numericEntries.find(entry => entry.index !== timestampEntry.index) || numericEntries[0];
      baselineEntry = numericEntries.find(entry =>
        entry.index !== valueEntry?.index &&
        entry.index !== timestampEntry.index
      );
    } else if (numericEntries.length >= 2) {
      valueEntry = numericEntries[1];
      baselineEntry = numericEntries[2] || null;
    } else {
      valueEntry = numericEntries[0];
    }

    if (!valueEntry) return null;

    const normalized = { value: Math.max(0, Math.round(valueEntry.numeric)) };
    if (timestampEntry?.timestamp) normalized.timestamp = timestampEntry.timestamp;
    if (baselineEntry && Number.isFinite(baselineEntry.numeric)) {
      normalized.baseline = Math.max(0, Math.round(baselineEntry.numeric));
    }
    return normalized;
  }

  if (!point || typeof point !== "object") return null;

  const valueKeys = [
    "value", "total", "y", "reports", "report", "count", "current",
    "sum", "volume", "report_count", "number_of_reports"
  ];
  const baselineKeys = ["baseline", "expected", "typical", "average", "avg", "normal"];
  const timestampKeys = [
    "timestamp", "point_in_time", "pointInTime", "datetime",
    "date", "time", "x", "at", "created_at"
  ];

  let value = null;
  for (const key of valueKeys) {
    const numeric = toCount(point[key]);
    if (Number.isFinite(numeric)) {
      value = numeric;
      break;
    }
  }

  if (!Number.isFinite(value)) {
    for (const [key, rawValue] of Object.entries(point)) {
      if (/time|date|stamp|point_in_time|created|updated|^id$|company|slug|name|label|peak|max|min|percent|share|ratio/i.test(key)) {
        continue;
      }
      if (/baseline|expected|typical|average|avg|normal/i.test(key)) {
        continue;
      }
      const numeric = toCount(rawValue);
      if (Number.isFinite(numeric) && numeric < 1000000000) {
        value = Math.max(value ?? 0, numeric);
      }
    }
  }

  if (!Number.isFinite(value)) return null;

  let baseline = null;
  for (const key of baselineKeys) {
    const numeric = toCount(point[key]);
    if (Number.isFinite(numeric)) {
      baseline = numeric;
      break;
    }
  }

  let timestamp = null;
  for (const key of timestampKeys) {
    timestamp = toTimestamp(point[key]);
    if (timestamp) break;
  }

  const normalized = { value: Math.max(0, Math.round(value)) };
  if (timestamp) normalized.timestamp = timestamp;
  if (Number.isFinite(baseline)) normalized.baseline = Math.max(0, Math.round(baseline));
  return normalized;
}

function scoreCandidate(points, path) {
  if (!Array.isArray(points) || points.length < 12) return -1;

  const values = points.map(point => point.value);
  const uniqueCount = new Set(values).size;
  const nonZeroCount = values.filter(value => value > 0).length;
  const timedCount = points.filter(point => point.timestamp).length;
  const spread = Math.max(...values) - Math.min(...values);
  const pathText = path.join(".").toLowerCase();

  let score = (points.length * 10) + uniqueCount + nonZeroCount + spread + (timedCount * 5);
  if (/(report|reports|history|timeline|series|point|chart|data)/i.test(pathText)) score += 100;
  if (/(breakdown|problem|issue|message|comment|avatar|disqus|percentage|share)/i.test(pathText)) score -= 120;
  if (uniqueCount <= 2) score -= 60;

  return score;
}

function pushCandidate(candidates, path, points) {
  if (!Array.isArray(points) || points.length < 12) return;

  const normalized = points
    .map(normalizePoint)
    .filter(Boolean);

  if (normalized.length < 12) return;

  if (normalized.filter(point => point.timestamp).length >= Math.max(4, Math.floor(normalized.length / 2))) {
    normalized.sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
  }

  candidates.push({
    path: [...path],
    points: normalized,
    score: scoreCandidate(normalized, path)
  });
}

function collectPairedCandidates(node, path, candidates) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;

  const entries = Object.entries(node).filter(([, value]) => Array.isArray(value));
  if (entries.length < 2) return;

  const timeEntry = entries.find(([, value]) => value.length >= 12 && value.some(item => toTimestamp(item)));
  const valueEntry = entries.find(([key, value]) =>
    key !== timeEntry?.[0] &&
    value.length >= 12 &&
    value.some(item => Number.isFinite(typeof item === "number" ? item : toCount(item)))
  );

  if (!timeEntry || !valueEntry || timeEntry[1].length !== valueEntry[1].length) return;

  const baselineEntry = entries.find(([key, value]) =>
    key !== timeEntry[0] &&
    key !== valueEntry[0] &&
    value.length === valueEntry[1].length
  );

  const points = valueEntry[1].map((value, index) => {
    const numeric = typeof value === "number" ? value : toCount(value);
    if (!Number.isFinite(numeric)) return null;

    const normalized = { value: Math.max(0, Math.round(numeric)) };
    const timestamp = toTimestamp(timeEntry[1][index]);
    const baseline = baselineEntry ? toCount(baselineEntry[1][index]) : null;

    if (timestamp) normalized.timestamp = timestamp;
    if (Number.isFinite(baseline)) normalized.baseline = Math.max(0, Math.round(baseline));
    return normalized;
  }).filter(Boolean);

  if (points.length >= 12) {
    candidates.push({
      path: [...path, `${timeEntry[0]}+${valueEntry[0]}`],
      points,
      score: scoreCandidate(points, [...path, timeEntry[0], valueEntry[0]]) + 25
    });
  }
}

function collectHistoryCandidates(node, path = [], candidates = []) {
  if (!node) return candidates;

  if (Array.isArray(node)) {
    pushCandidate(candidates, path, node);
    node.forEach((item, index) => collectHistoryCandidates(item, [...path, String(index)], candidates));
    return candidates;
  }

  if (typeof node !== "object") return candidates;

  collectPairedCandidates(node, path, candidates);

  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      pushCandidate(candidates, [...path, key], value);
    }
    collectHistoryCandidates(value, [...path, key], candidates);
  }

  return candidates;
}

function extractHistoryFromPayload(payload) {
  const candidates = collectHistoryCandidates(payload);
  if (!candidates.length) return [];

  candidates.sort((left, right) => right.score - left.score);
  return candidates[0].points.slice(-96);
}
