// Downdetector Monitor — Service Worker (Manifest V3)

importScripts('constants.js');
const WORKER_TAB_ID_KEY = "workerTabId";
const DEFAULT_CONFIG = {
  interval_minutes: 10,
  source_site: DEFAULT_SOURCE_SITE,
  services: [
    { slug: "youtube", name: "YouTube", threshold: DEFAULT_THRESHOLD },
    { slug: "netflix", name: "Netflix", threshold: DEFAULT_THRESHOLD },
    { slug: "instagram", name: "Instagram", threshold: DEFAULT_THRESHOLD },
    { slug: "whatsapp", name: "WhatsApp", threshold: DEFAULT_THRESHOLD },
    { slug: "twitch", name: "Twitch", threshold: DEFAULT_THRESHOLD },
    { slug: "cloudflare", name: "Cloudflare", threshold: DEFAULT_THRESHOLD },
    { slug: "steam", name: "Steam", threshold: DEFAULT_THRESHOLD },
  ]
};

const LEGACY_DEFAULT_THRESHOLDS = {
  youtube: 50,
  netflix: 30,
  instagram: 50,
  whatsapp: 100,
  twitch: 30,
  cloudflare: 20,
  steam: 40
};

let activeCheckPromise = null;
const TRANSIENT_SERVICE_ERROR_PATTERNS = [
  /timeout/i,
  /o gr[aá]fico real n[aã]o apareceu/i,
  /n[aã]o consegui transformar o gr[aá]fico renderizado em s[ée]rie/i,
  /receiving end does not exist/i,
  /the message port closed before a response was received/i,
  /frame with id \d+ is showing error page/i,
  /no tab with id/i,
  /tabs cannot be edited right now/i
];

function sanitizeThreshold(value) {
  const threshold = parseInt(value, 10);
  return Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_THRESHOLD;
}

function sanitizeSourceSite(value) {
  return value === "com" ? "com" : DEFAULT_SOURCE_SITE;
}

function upgradeLegacyConfig(config) {
  if (!config || !Array.isArray(config.services)) return config;
  if (config.services.length !== Object.keys(LEGACY_DEFAULT_THRESHOLDS).length) return config;

  const matchedLegacy = config.services.every(service => {
    const slug = String(service.slug || "").trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(LEGACY_DEFAULT_THRESHOLDS, slug) &&
      sanitizeThreshold(service.threshold) === LEGACY_DEFAULT_THRESHOLDS[slug];
  });

  if (!matchedLegacy) return config;

  return {
    ...config,
    services: config.services.map(service => ({
      ...service,
      threshold: DEFAULT_THRESHOLD
    }))
  };
}

function normalizeConfig(config) {
  const upgraded = upgradeLegacyConfig(config || DEFAULT_CONFIG) || DEFAULT_CONFIG;
  const fallbackServices = Array.isArray(DEFAULT_CONFIG.services) ? DEFAULT_CONFIG.services : [];
  const inputServices = Array.isArray(upgraded.services) && upgraded.services.length
    ? upgraded.services
    : fallbackServices;

  const seen = new Set();
  return {
    interval_minutes: Math.max(1, Math.min(60, parseInt(upgraded.interval_minutes, 10) || DEFAULT_CONFIG.interval_minutes)),
    source_site: sanitizeSourceSite(upgraded.source_site),
    services: inputServices
      .filter(service => service && service.slug)
      .map(service => ({
        slug: String(service.slug).trim().toLowerCase(),
        name: String(service.name || service.slug).trim(),
        threshold: sanitizeThreshold(service.threshold)
      }))
      .filter(service => {
        if (seen.has(service.slug)) return false;
        seen.add(service.slug);
        return true;
      })
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableServiceError(error) {
  const message = String(error?.message || error || "").trim();
  if (!message) return false;
  return TRANSIENT_SERVICE_ERROR_PATTERNS.some(pattern => pattern.test(message));
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

async function ensureConfig() {
  const { config } = await chrome.storage.sync.get("config");
  const nextConfig = normalizeConfig(config || DEFAULT_CONFIG);

  if (!config || JSON.stringify(nextConfig) !== JSON.stringify(config)) {
    await chrome.storage.sync.set({ config: nextConfig });
  }

  return nextConfig;
}

async function scheduleAlarm() {
  const config = await ensureConfig();
  await chrome.alarms.clearAll();
  chrome.alarms.create("check", {
    delayInMinutes: 0.1,
    periodInMinutes: config.interval_minutes
  });
}

async function initializeExtension() {
  await ensureConfig();
  await scheduleAlarm();
}

chrome.runtime.onInstalled.addListener(() => {
  initializeExtension().catch(error => console.error("Falha ao inicializar:", error));
});

chrome.runtime.onStartup.addListener(() => {
  initializeExtension().catch(error => console.error("Falha ao iniciar:", error));
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "check") {
    checkAllServices().catch(error => console.error("Falha na checagem:", error));
  }
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const { workerTabId } = await chrome.storage.local.get(WORKER_TAB_ID_KEY);
  if (workerTabId === tabId) {
    await chrome.storage.local.remove(WORKER_TAB_ID_KEY);
  }
});

async function getOrCreateWorkerTab() {
  const { workerTabId } = await chrome.storage.local.get(WORKER_TAB_ID_KEY);

  if (Number.isInteger(workerTabId)) {
    try {
      const existingTab = await chrome.tabs.get(workerTabId);
      if (!existingTab.pinned) {
        await chrome.tabs.update(existingTab.id, { pinned: true, muted: true });
      } else {
        await chrome.tabs.update(existingTab.id, { muted: true });
      }
      return existingTab;
    } catch (_error) {
      await chrome.storage.local.remove(WORKER_TAB_ID_KEY);
    }
  }

  const createdTab = await chrome.tabs.create({
    url: "about:blank",
    active: false,
    pinned: true
  });

  try {
    await chrome.tabs.update(createdTab.id, { muted: true });
  } catch (_e) {}

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules: [{
        id: 1,
        priority: 1,
        action: { type: "block" },
        condition: {
          tabIds: [createdTab.id],
          requestDomains: [
            "googlesyndication.com",
            "doubleclick.net",
            "pubmatic.com",
            "rubiconproject.com",
            "criteo.com",
            "quantserve.com",
            "scorecardresearch.com",
            "amazon-adsystem.com",
            "taboola.com",
            "outbrain.com",
            "teads.tv"
          ]
        }
      }]
    });
  } catch (_error) {
    console.warn("Falha ao aplicar adblock na aba.");
  }

  await chrome.storage.local.set({ [WORKER_TAB_ID_KEY]: createdTab.id });
  return createdTab;
}

async function updateTabAndWait(tabId, url) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url === url && tab.status === "complete") {
    return;
  }

  await chrome.tabs.update(tabId, { url });

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timeout ao carregar a página."));
    }, 20000);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;

      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function readPageSignals(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: ["page_reader.js"]
  });

  return results[0]?.result || {
    cloudflareBlocked: false,
    reportUrl: null,
    reportPayload: null,
    peak: null,
    svgHistory: [],
    tickLabels: [],
    periodLabel: "24h",
    yAxisMax: null
  };
}

async function waitForPageSignals(tabId) {
  let lastSignals = null;
  let notifiedCloudflare = false;
  let hasReloaded = false;
  let cloudflareBlockedCount = 0;
  let previousActiveTabId = null;

  for (let attempt = 0; attempt < 45; attempt += 1) {
    try {
      lastSignals = await readPageSignals(tabId);
    } catch (_error) {
      lastSignals = null;
    }

    if (lastSignals?.cloudflareBlocked) {
      if (!hasReloaded) {
        hasReloaded = true;
        chrome.tabs.reload(tabId).catch(() => {});
        await delay(5000); // Aguarda 5 segundos para a página recarregar e o Cloudflare processar
        continue;
      }

      cloudflareBlockedCount += 1;

      if (!notifiedCloudflare && cloudflareBlockedCount > 5) {
        notifiedCloudflare = true;
        
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab && tab.windowId) {
            const activeTabs = await chrome.tabs.query({ active: true, windowId: tab.windowId });
            if (activeTabs.length > 0 && activeTabs[0].id !== tabId) {
              previousActiveTabId = activeTabs[0].id;
            }
            await chrome.windows.update(tab.windowId, { focused: true });
            await chrome.tabs.update(tabId, { active: true });
          }
        } catch (_e) {}
        
        chrome.notifications.create("dd-cf", {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "Ação Necessária",
          message: "O Downdetector pediu verificação de segurança. Por favor, resolva o captcha na aba aberta.",
          priority: 2
        });
      }
    } else if (lastSignals?.reportPayload || (Array.isArray(lastSignals?.svgHistory) && lastSignals.svgHistory.length >= 24)) {
      
      if (notifiedCloudflare && previousActiveTabId) {
         try {
           const currentTab = await chrome.tabs.get(tabId);
           if (currentTab.active) {
             await chrome.tabs.update(previousActiveTabId, { active: true });
           }
         } catch (_e) {}
      }

      return lastSignals;
    }

    await delay(1000);
  }

  return lastSignals;
}

function getServiceUrls(slug, sourceSite) {
  if (sanitizeSourceSite(sourceSite) === "com") {
    return [
      `https://downdetector.com/status/${slug}/`
    ];
  }

  return [
    `https://downdetector.com.br/fora-do-ar/${slug}/`,
    `https://downdetector.com.br/status/${slug}/`
  ];
}

function extractHistoryFromSignals(signals) {
  const payload = signals?.reportPayload || null;
  let history = payload ? extractHistoryFromPayload(payload) : [];

  if (!history.length && Array.isArray(signals?.svgHistory) && signals.svgHistory.length >= 24) {
    history = signals.svgHistory.slice(-96);
  }

  return { payload, history };
}

async function scrapeService(tabId, slug, sourceSite) {
  const urls = getServiceUrls(slug, sourceSite);

  let lastError = null;

  for (const url of urls) {
    try {
      await updateTabAndWait(tabId, url);

      let signals = await waitForPageSignals(tabId);
      if (signals?.cloudflareBlocked) {
        throw new Error("Cloudflare bloqueou o carregamento da página.");
      }

      let { payload, history } = extractHistoryFromSignals(signals);

      if (!history.length) {
        for (let attempt = 0; attempt < 4 && !history.length; attempt += 1) {
          await delay(450);
          signals = await readPageSignals(tabId);
          const extracted = extractHistoryFromSignals(signals);
          payload = extracted.payload || payload;
          history = extracted.history;
        }
      }

      if (!history.length) {
        if (!signals?.reportUrl && !signals?.reportPayload) {
          throw new Error("O gráfico real não apareceu na página.");
        }
        throw new Error("Não consegui transformar o gráfico renderizado em série.");
      }

      const current = history[history.length - 1].value;
      const peak = Math.max(...history.map(point => point.value), signals?.peak ?? 0);
      const baselineCurrent = Number.isFinite(history[history.length - 1]?.baseline)
        ? history[history.length - 1].baseline
        : null;

      return {
        current,
        peak,
        baselineCurrent,
        history,
        periodLabel: signals?.periodLabel || "24h",
        tickLabels: Array.isArray(signals?.tickLabels) ? signals.tickLabels : []
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Não foi possível ler os dados do serviço.");
}

async function scrapeServiceWithRetry(tabId, slug, sourceSite) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await scrapeService(tabId, slug, sourceSite);
    } catch (error) {
      lastError = error;

      const shouldRetry = attempt === 0 && isRetryableServiceError(error);
      if (!shouldRetry) {
        throw error;
      }

      console.warn(`Retry inteligente para ${slug}:`, error?.message || error);
      await delay(900);
    }
  }

  throw lastError || new Error("Não foi possível ler os dados do serviço.");
}

async function performCheckAllServices() {
  const config = await ensureConfig();
  const { alerted = [], statusMap: previousStatusMap = {} } = await chrome.storage.local.get(["alerted", "statusMap"]);
  const alertedSet = new Set(alerted);
  const statusMap = { ...previousStatusMap };
  const totalServices = config.services.length;

  await persistProgress(statusMap, alertedSet, {
    isChecking: true,
    checkCompleted: 0,
    checkTotal: totalServices
  });

  const tab = await getOrCreateWorkerTab();

  // Remove stale services no longer in config
  const activeSlugs = new Set(config.services.map(s => s.slug));
  for (const key of Object.keys(statusMap)) {
    if (!activeSlugs.has(key)) delete statusMap[key];
  }

  try {
    for (let index = 0; index < config.services.length; index += 1) {
      const service = config.services[index];
      const threshold = sanitizeThreshold(service.threshold);

      try {
        const result = await scrapeServiceWithRetry(tab.id, service.slug, config.source_site);
        const isOutage = result.current >= threshold;

        statusMap[service.slug] = {
          name: service.name,
          current: result.current,
          peak: result.peak,
          baselineCurrent: result.baselineCurrent,
          history: result.history,
          periodLabel: result.periodLabel,
          tickLabels: result.tickLabels,
          sourceSite: config.source_site,
          threshold,
          outage: isOutage,
          ts: Date.now()
        };

        if (isOutage) {
          if (!alertedSet.has(service.slug)) {
            sendNotification(service.name, service.slug, result.current, threshold, "outage");
            alertedSet.add(service.slug);
          }
        } else {
          if (alertedSet.has(service.slug)) {
            sendNotification(service.name, service.slug, result.current, threshold, "recovery");
            alertedSet.delete(service.slug);
          }
        }
      } catch (error) {
        console.error(`Erro ao checar ${service.slug}:`, error);
        statusMap[service.slug] = {
          name: service.name,
          threshold,
          sourceSite: config.source_site,
          error: error.message,
          ts: Date.now()
        };
        alertedSet.delete(service.slug);
      }

      await persistProgress(statusMap, alertedSet, {
        isChecking: true,
        checkCompleted: index + 1,
        checkTotal: totalServices,
        lastCheck: Date.now()
      });

      await delay(250);
    }
  } finally {
    try {
      const latestTab = await chrome.tabs.get(tab.id);
      if (latestTab.url !== "about:blank") {
        await chrome.tabs.update(tab.id, { url: "about:blank" });
      }
    } catch (_error) {}
  }

  await persistProgress(statusMap, alertedSet, {
    isChecking: false,
    checkCompleted: totalServices,
    checkTotal: totalServices,
    lastCheck: Date.now()
  });
}

function checkAllServices() {
  if (!activeCheckPromise) {
    activeCheckPromise = performCheckAllServices()
      .finally(() => {
        activeCheckPromise = null;
      });
  }

  return activeCheckPromise;
}

async function persistProgress(statusMap, alertedSet, extra = {}) {
  await chrome.storage.local.set({
    alerted: [...alertedSet],
    statusMap: { ...statusMap },
    ...extra
  });

  const count = alertedSet.size;
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: "#000000" }); // Preto contrasta bem com o vermelho
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

function sendNotification(name, slug, current, threshold, eventType = "outage") {
  const isRecovery = eventType === "recovery";
  chrome.notifications.create(`dd-${slug}-${eventType}-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: isRecovery ? `✅ Normalizado: ${name}` : `⚠️ Queda: ${name}`,
    message: isRecovery 
      ? `Reclamações baixaram para ${current} (Abaixo do limiar de ${threshold}). O serviço parece estar estável novamente.`
      : `${current} reportes detectados (Acima do limiar de ${threshold}). Problema provável no serviço.`,
    priority: 2
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "GET_STATUS") {
    chrome.storage.local.get(["statusMap", "lastCheck"]).then(reply);
    return true;
  }

  if (msg.type === "FORCE_CHECK") {
    checkAllServices()
      .then(() => reply({ ok: true }))
      .catch(error => reply({ ok: false, error: error.message }));
    return true;
  }

  if (msg.type === "SAVE_CONFIG") {
    const config = normalizeConfig(msg.config || DEFAULT_CONFIG);

    chrome.storage.sync.set({ config }).then(async () => {
      await scheduleAlarm();
      reply({ ok: true });
    }).catch(error => reply({ ok: false, error: error.message }));

    return true;
  }
});
