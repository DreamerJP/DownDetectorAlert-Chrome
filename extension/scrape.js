// Gerência da aba worker, navegação e extração de dados de cada serviço.
// Depende de utils.js (delay, sanitizeSourceSite, isRetryableServiceError)
// e normalize.js (extractHistoryFromPayload).

const WORKER_TAB_ID_KEY = "workerTabId";
const ADBLOCK_RULE_ID = 1;

const AD_DOMAINS = [
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
];

// A regra é presa a um tabId, e o id da aba MUDA a cada chrome.tabs.discard.
// Session rules também somem quando o navegador reinicia. Por isso o adblock
// precisa ser reaplicado em todo ponto onde o id do worker é definido ou muda,
// e não só na criação da aba.
async function applyAdblockRule(tabId) {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ADBLOCK_RULE_ID],
      addRules: [{
        id: ADBLOCK_RULE_ID,
        priority: 1,
        action: { type: "block" },
        condition: { tabIds: [tabId], requestDomains: AD_DOMAINS }
      }]
    });
  } catch (_error) {
    console.warn("Falha ao aplicar adblock na aba.");
  }
}

async function ensureWorkerTabAlive(currentTabId) {
  // Se a aba foi fechada manualmente entre serviços, a próxima chamada a
  // chrome.tabs.update/get falharia com "no tab with id". Recria proativamente.
  try {
    await chrome.tabs.get(currentTabId);
    return currentTabId;
  } catch (_error) {
    await chrome.storage.session.remove(WORKER_TAB_ID_KEY);
    const recreated = await getOrCreateWorkerTab();
    return recreated.id;
  }
}

async function getOrCreateWorkerTab() {
  const workerUrl = chrome.runtime.getURL("worker.html");
  const { workerTabId } = await chrome.storage.session.get(WORKER_TAB_ID_KEY);

  if (Number.isInteger(workerTabId)) {
    try {
      const existingTab = await chrome.tabs.get(workerTabId);
      if (!existingTab.pinned) {
        await chrome.tabs.update(existingTab.id, { pinned: true, muted: true });
      } else {
        await chrome.tabs.update(existingTab.id, { muted: true });
      }
      await applyAdblockRule(existingTab.id);
      return existingTab;
    } catch (_error) {
      await chrome.storage.session.remove(WORKER_TAB_ID_KEY);
    }
  }

  // Tenta encontrar uma aba existente que seja o nosso worker (útil após reiniciar o navegador)
  const tabs = await chrome.tabs.query({ url: workerUrl });
  if (tabs.length > 0) {
    const foundTab = tabs[0];
    await chrome.storage.session.set({ [WORKER_TAB_ID_KEY]: foundTab.id });

    // Garante que está pinada e mutada
    try {
      await chrome.tabs.update(foundTab.id, { pinned: true, muted: true });
    } catch (_e) { }

    await applyAdblockRule(foundTab.id);
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

  await applyAdblockRule(createdTab.id);
  await chrome.storage.session.set({ [WORKER_TAB_ID_KEY]: createdTab.id });
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
    } else if (
      lastSignals?.reportPayload ||
      // Mín 50 pontos: o React costuma popular o array completo de uma vez (96
      // pontos), mas em alguns SSRs ele aparece parcial (10-30) e completa
      // em ms. Aceitar parcial fazia o "current" ser um ponto velho do gráfico.
      (Array.isArray(lastSignals?.reactChartData) && lastSignals.reactChartData.length >= 50) ||
      (Array.isArray(lastSignals?.svgHistory) && lastSignals.svgHistory.length >= 24)
    ) {

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

// Extrai a história de reportes a partir dos sinais lidos da página, em ordem
// de preferência. O campo `source` permite o caller saber qual método foi usado
// (útil para logs e otimizações de timing — react/api não dependem de animação).
function extractHistoryFromSignals(signals) {
  // 1ª escolha: dados exatos lidos do estado React do componente.
  // Formato: [{ timestamp: <ms>, value: <int>, baseline: <int> }, ...]
  // Mín 50 pontos: array parcial faz o "current" virar um ponto velho do gráfico.
  if (Array.isArray(signals?.reactChartData) && signals.reactChartData.length >= 50) {
    const history = signals.reactChartData
      .filter(p => p && Number.isFinite(p.value))
      .map(p => {
        const out = { value: Math.max(0, Math.round(p.value)) };
        if (Number.isFinite(p.timestamp)) {
          // Aceita tanto Unix seconds quanto Unix ms
          const ms = p.timestamp > 1e12 ? p.timestamp : p.timestamp * 1000;
          out.timestamp = new Date(ms).toISOString();
        }
        if (Number.isFinite(p.baseline)) {
          out.baseline = Math.max(0, Math.round(p.baseline));
        }
        return out;
      });
    if (history.length >= 12) {
      return { payload: null, history, source: "react" };
    }
  }

  // 2ª escolha: payload da API capturado via fetch/XHR
  const payload = signals?.reportPayload || null;
  if (payload) {
    const history = extractHistoryFromPayload(payload);
    if (history.length) {
      return { payload, history, source: "api" };
    }
  }

  // 3ª escolha: reconstrução do SVG (estimativa, não exato)
  if (Array.isArray(signals?.svgHistory) && signals.svgHistory.length >= 24) {
    return { payload, history: signals.svgHistory.slice(-96), source: "svg" };
  }

  return { payload, history: [], source: null };
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

      // Tenta extrair imediatamente. React (chartData) e API (payload) ficam
      // disponíveis assim que o componente monta — não dependem de animação.
      let extracted = extractHistoryFromSignals(signals);
      let { payload, history, source } = extracted;

      // Apenas o método SVG depende da animação Recharts terminar (~2s para
      // o path se estabilizar). Se a melhor fonte disponível é o SVG (ou
      // nada), aguardamos e tentamos de novo.
      if (!history.length || source === "svg") {
        await delay(2000);
        signals = await readPageSignals(tabId);
        extracted = extractHistoryFromSignals(signals);
        ({ payload, history, source } = extracted);

        // Tentativas extras se ainda não veio nada (raro, página muito lenta)
        for (let attempt = 0; attempt < 3 && !history.length; attempt += 1) {
          await delay(800);
          signals = await readPageSignals(tabId);
          extracted = extractHistoryFromSignals(signals);
          ({ payload, history, source } = extracted);
        }
      }

      if (!history.length) {
        if (!signals?.reportUrl && !signals?.reportPayload && !signals?.reactChartData?.length) {
          throw new Error("O gráfico real não apareceu na página.");
        }
        throw new Error("Não consegui transformar o gráfico renderizado em série.");
      }

      const current = history[history.length - 1].value;
      const peak = Math.max(...history.map(p => p.value), signals?.peak ?? 0);
      const baselineCurrent = Number.isFinite(history[history.length - 1]?.baseline)
        ? history[history.length - 1].baseline
        : null;

      return {
        current,
        peak,
        baselineCurrent,
        history,
        source,
        iconUrls: Array.isArray(signals?.serviceIconUrls) ? signals.serviceIconUrls : [],
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
