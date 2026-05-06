// Downdetector Monitor — Service Worker (Manifest V3)

importScripts('constants.js');
const WORKER_TAB_ID_KEY = "workerTabId";
const DEFAULT_CONFIG = {
  interval_minutes: 10,
  source_site: DEFAULT_SOURCE_SITE,
  top_services_enabled: DEFAULT_TOP_SERVICES_ENABLED,
  top_services_count: DEFAULT_TOP_SERVICES_COUNT,
  top_services_threshold: DEFAULT_TOP_SERVICES_THRESHOLD,
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

async function addLog(msg, type = "info") {
  try {
    const { logs = [] } = await chrome.storage.local.get("logs");
    const newLog = { ts: Date.now(), msg, type };
    const updatedLogs = [newLog, ...(Array.isArray(logs) ? logs : [])].slice(0, 100);
    await chrome.storage.local.set({ logs: updatedLogs });
  } catch (e) { console.error("Log failed", e); }
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
    top_services_enabled: upgraded.top_services_enabled === true,
    top_services_count: Math.max(1, Math.min(20, parseInt(upgraded.top_services_count, 10) || DEFAULT_TOP_SERVICES_COUNT)),
    top_services_threshold: Math.max(1, parseInt(upgraded.top_services_threshold, 10) || DEFAULT_TOP_SERVICES_THRESHOLD),
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

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout máximo atingido para o serviço.")), timeoutMs))
  ]);
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

let startupTimeout = null;

async function scheduleAlarm(triggerStartupDelay = false) {
  const config = await ensureConfig();
  const { monitoringEnabled = true } = await chrome.storage.local.get("monitoringEnabled");
  await chrome.alarms.clearAll();
  
  if (monitoringEnabled) {
    // Alarme periódico: o primeiro disparo ocorrerá apenas no próximo ciclo (ex: daqui a 10 min)
    chrome.alarms.create("check", {
      delayInMinutes: config.interval_minutes,
      periodInMinutes: config.interval_minutes
    });

    // Se for inicialização ou abertura da primeira janela, fazemos a primeira checagem com 20s de delay via setTimeout
    if (triggerStartupDelay) {
      if (startupTimeout) clearTimeout(startupTimeout);
      startupTimeout = setTimeout(() => {
        chrome.storage.local.get("monitoringEnabled").then(data => {
          if (data.monitoringEnabled !== false) {
            checkAllServices(true).catch(e => console.error("Falha na checagem inicial:", e));
          }
        });
      }, 20000);
    }
  }
}

async function initializeExtension() {
  await ensureConfig();
  // Só agenda o alarme se já houver alguma janela aberta para este perfil
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  if (windows.length > 0) {
    await scheduleAlarm(true);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initializeExtension().catch(error => console.error("Falha ao inicializar:", error));
});

chrome.runtime.onStartup.addListener(() => {
  initializeExtension().catch(error => console.error("Falha ao iniciar:", error));
});

// Quando uma janela é aberta, garante que o monitoramento está ativo
chrome.windows.onCreated.addListener(async (window) => {
  if (window.type === 'normal') {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const isFirstWindow = windows.length <= 1;
    await scheduleAlarm(isFirstWindow);
  }
});

// Quando a última janela é fechada, removemos todos os alarmes para poupar recursos do sistema
chrome.windows.onRemoved.addListener(async () => {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  if (windows.length === 0) {
    await chrome.alarms.clearAll();
    if (startupTimeout) clearTimeout(startupTimeout);
    console.log("Última janela fechada. Monitoramento suspenso para economizar recursos.");
  }
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "check") {
    checkAllServices(true).catch(error => console.error("Falha na checagem:", error));
  }
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const { workerTabId } = await chrome.storage.local.get(WORKER_TAB_ID_KEY);
  if (workerTabId === tabId) {
    await chrome.storage.local.remove(WORKER_TAB_ID_KEY);
  }
});

async function getOrCreateWorkerTab() {
  const workerUrl = chrome.runtime.getURL("worker.html");
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

  // Tenta encontrar uma aba existente que seja o nosso worker (útil após reiniciar o navegador)
  const tabs = await chrome.tabs.query({ url: workerUrl });
  if (tabs.length > 0) {
    const foundTab = tabs[0];
    await chrome.storage.local.set({ [WORKER_TAB_ID_KEY]: foundTab.id });
    
    // Garante que está pinada e mutada
    try {
      await chrome.tabs.update(foundTab.id, { pinned: true, muted: true });
    } catch (_e) { }

    return foundTab;
  }

  const createdTab = await chrome.tabs.create({
    url: workerUrl,
    active: false,
    pinned: true
  });

  try {
    await chrome.tabs.update(createdTab.id, { muted: true });
  } catch (_e) { }

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

async function updateTabAndWait(tabId, url, abortSignal) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url === url && tab.status === "complete") {
    return;
  }

  await chrome.tabs.update(tabId, { url });

  return new Promise((resolve, reject) => {
    let timeoutId;
    let listener;

    const cleanup = () => {
      clearTimeout(timeoutId);
      if (listener) chrome.tabs.onUpdated.removeListener(listener);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new Error("Abortado"));
    };

    if (abortSignal) {
      if (abortSignal.aborted) return onAbort();
      abortSignal.addEventListener("abort", onAbort);
    }

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Timeout ao carregar a página."));
    }, 20000);

    listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      cleanup();
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

async function waitForPageSignals(tabId, abortSignal) {
  let lastSignals = null;
  let notifiedCloudflare = false;
  let hasReloaded = false;
  let cloudflareBlockedCount = 0;
  let previousActiveTabId = null;

  for (let attempt = 0; attempt < 45; attempt += 1) {
    if (abortSignal?.aborted) throw new Error("Abortado");
    
    try {
      lastSignals = await readPageSignals(tabId);
    } catch (_error) {
      lastSignals = null;
    }

    if (lastSignals?.cloudflareBlocked) {
      if (!hasReloaded) {
        hasReloaded = true;
        chrome.tabs.reload(tabId).catch(() => { });
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
        } catch (_e) { }

        chrome.notifications.create(`dd-cf-${Date.now()}`, {
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
        } catch (_e) { }
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

async function scrapeService(tabId, slug, sourceSite, abortSignal) {
  const urls = getServiceUrls(slug, sourceSite);

  let lastError = null;

  for (const url of urls) {
    if (abortSignal?.aborted) throw new Error("Abortado");
    try {
      await updateTabAndWait(tabId, url, abortSignal);

      let signals = await waitForPageSignals(tabId, abortSignal);
      
      if (signals?.cloudflareBlocked) {
        throw new Error("Cloudflare bloqueou o carregamento da página.");
      }

      // Aguarda as animações de entrada do gráfico (Recharts pode ser lento em algumas máquinas)
      // Esperamos 3 segundos para garantir que a linha chegou no topo real
      await delay(3000);

      let { payload, history } = extractHistoryFromSignals(signals);

      if (!history.length) {
        for (let attempt = 0; attempt < 4 && !history.length; attempt += 1) {
          await delay(1000);
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

async function scrapeServiceWithRetry(tabId, slug, sourceSite, abortSignal) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (abortSignal?.aborted) throw new Error("Abortado");
    try {
      return await scrapeService(tabId, slug, sourceSite, abortSignal);
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
  const startTime = Date.now();
  await chrome.storage.local.set({ logs: [] }); // Limpa logs anteriores para o novo ciclo
  await addLog("Iniciando verificação de todos os serviços...", "info");

  const config = await ensureConfig();
  const { alerted = [], statusMap: previousStatusMap = {} } = await chrome.storage.local.get(["alerted", "statusMap"]);
  const alertedSet = new Set(alerted);
  const statusMap = { ...previousStatusMap };

  const tab = await getOrCreateWorkerTab();
  const servicesToCheck = [...config.services];

  // Busca serviços em destaque (Trending) se habilitado
  if (config.top_services_enabled) {
    await addLog("Buscando serviços em destaque na home page...", "info");
    
    await persistProgress(statusMap, alertedSet, {
      isChecking: true,
      checkCompleted: 0,
      checkTotal: servicesToCheck.length,
      statusText: "Buscando tendências..."
    });

    try {
      const homeUrl = config.source_site === "com" ? "https://downdetector.com/" : "https://downdetector.com.br/";
      await updateTabAndWait(tab.id, homeUrl);
      const homeSignals = await readPageSignals(tab.id);

      if (homeSignals && Array.isArray(homeSignals.trendingServices)) {
        const topCount = config.top_services_count || DEFAULT_TOP_SERVICES_COUNT;

        // Percorre a lista da home em ordem de posição.
        // Pula serviços que já estão na lista manual (evita checagem dupla).
        // Para quando atingir topCount serviços únicos adicionados.
        const added = [];
        for (const s of homeSignals.trendingServices) {
          if (added.length >= topCount) break;
          if (servicesToCheck.find(existing => existing.slug === s.slug)) continue;
          servicesToCheck.push({
            ...s,
            threshold: config.top_services_threshold || DEFAULT_TOP_SERVICES_THRESHOLD,
            isTrending: true
          });
          added.push(s.name);
        }

        if (added.length > 0) {
          await addLog(`Top ${added.length} da home adicionados para checagem: ${added.join(", ")}`, "info");
        } else {
          await addLog("Todos os serviços do topo da home já estão na lista manual.", "info");
        }
      }
    } catch (error) {
      await addLog(`Erro ao buscar tendências: ${error.message}`, "error");
      console.error("Erro ao buscar serviços em destaque:", error);
    }
  }

  await persistProgress(statusMap, alertedSet, {
    isChecking: true,
    checkCompleted: 0,
    checkTotal: servicesToCheck.length,
    statusText: "" // Limpa o texto customizado para mostrar a contagem normal
  });

  // Limpeza inteligente de serviços antigos (Stale)
  const now = Date.now();
  const GRACE_PERIOD_MS = 30 * 60 * 1000; // 30 minutos de retenção após normalizar
  
  for (const key of Object.keys(statusMap)) {
    const info = statusMap[key];
    const isManual = config.services.some(s => s.slug === key);
    
    if (isManual) continue; // Nunca remove manuais
    
    const isCurrentlyTrending = servicesToCheck.some(s => s.slug === key && s.isTrending);
    
    if (isCurrentlyTrending) {
      // Atualiza o timestamp de última vez visto como trending
      info.lastSeenTrending = now;
      continue;
    }

    // Se era trending mas sumiu da home:
    // 1. Se ainda está em falha/alerta, mantém (precisamos monitorar até normalizar)
    if (info.outage || (info.current >= info.threshold * WARNING_RATIO)) {
      if (!servicesToCheck.some(s => s.slug === key)) {
         servicesToCheck.push({ slug: key, name: info.name, threshold: info.threshold, isTrending: true });
      }
      continue;
    }

    // 2. Se já normalizou, verifica se passou o período de carência
    const lastSeen = info.lastSeenTrending || 0;
    if (lastSeen === 0 || now - lastSeen > GRACE_PERIOD_MS) {
      delete statusMap[key];
    } else {
      // Mantém na lista de checagem para garantir que o status 'Normal' seja atualizado no popup
      if (!servicesToCheck.some(s => s.slug === key)) {
        servicesToCheck.push({ slug: key, name: info.name, threshold: info.threshold, isTrending: true });
      }
    }
  }

  const totalServices = servicesToCheck.length;

  try {
    for (let index = 0; index < servicesToCheck.length; index += 1) {
      const service = servicesToCheck[index];
      const threshold = sanitizeThreshold(service.threshold);

      const abortController = new AbortController();
      try {
        await addLog(`Checando: ${service.name} (${service.slug})...`);
        const result = await withTimeout(scrapeServiceWithRetry(tab.id, service.slug, config.source_site, abortController.signal), 40000);
        const isOutage = result.current >= threshold;

        // Se for da home e não atingiu o limiar de reports, remove do statusMap para não exibir no popup
        if (service.isTrending && result.current < threshold) {
          delete statusMap[service.slug];
          await addLog(`${service.name}: ${result.current} reportes (abaixo do limiar de ${threshold}) — sem problema.`, "info");
          // Se havia alerta ativo para este serviço, notifica recovery e limpa o badge
          if (alertedSet.has(service.slug)) {
            sendNotification(service.name, service.slug, result.current, threshold, "recovery");
            alertedSet.delete(service.slug);
          }
          continue;
        }

        const lastSeenTrending = statusMap[service.slug]?.lastSeenTrending;
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
          isTrending: service.isTrending === true,
          lastSeenTrending,
          ts: Date.now()
        };
        
        await addLog(`Checado: ${service.name} (${result.current}/${threshold})`, isOutage ? "error" : "success");

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
        await addLog(`Erro ao checar ${service.slug}: ${error.message}`, "error");
        console.error(`Erro ao checar ${service.slug}:`, error);
        const lastSeenTrending = statusMap[service.slug]?.lastSeenTrending;
        statusMap[service.slug] = {
          name: service.name,
          threshold,
          sourceSite: config.source_site,
          error: error.message,
          lastSeenTrending,
          ts: Date.now()
        };
        alertedSet.delete(service.slug);
      } finally {
        abortController.abort();
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
      const workerUrl = chrome.runtime.getURL("worker.html");
      const latestTab = await chrome.tabs.get(tab.id);
      if (latestTab.url !== workerUrl) {
        await chrome.tabs.update(tab.id, { url: workerUrl });
      }
    } catch (_error) { }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  await addLog(`Verificação concluída em ${duration}s.`, "info");

  await persistProgress(statusMap, alertedSet, {
    isChecking: false,
    checkCompleted: totalServices,
    checkTotal: totalServices,
    lastCheck: Date.now()
  });
}

async function checkAllServices(isAutomated = false) {
  if (isAutomated) {
    try {
      const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      if (windows.length === 0) {
        // Silenciosamente ignora a verificação automática se não houver janelas do navegador abertas para este perfil.
        // Isso evita que a extensão "acorde" o perfil e abra abas de worker indesejadas.
        return;
      }
    } catch (e) {
      console.error("Falha ao verificar janelas abertas:", e);
    }

    // Não executa checagem automática se o monitoramento estiver desativado
    try {
      const { monitoringEnabled = true } = await chrome.storage.local.get("monitoringEnabled");
      if (!monitoringEnabled) return;
    } catch (e) {
      console.error("Falha ao verificar estado do monitoramento:", e);
    }
  }

  if (activeCheckPromise) {
    return activeCheckPromise;
  }

  activeCheckPromise = performCheckAllServices()
    .finally(() => {
      activeCheckPromise = null;
    });

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
    chrome.storage.local.get(["statusMap", "lastCheck", "monitoringEnabled"]).then(reply);
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

  if (msg.type === "TOGGLE_MONITORING") {
    const enabled = msg.enabled === true;
    chrome.storage.local.set({ monitoringEnabled: enabled }).then(async () => {
      if (enabled) {
        await scheduleAlarm();
      } else {
        await chrome.alarms.clearAll();
      }
      reply({ ok: true, monitoringEnabled: enabled });
    }).catch(error => reply({ ok: false, error: error.message }));
    return true;
  }
});