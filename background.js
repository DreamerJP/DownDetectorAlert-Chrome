// Downdetector Monitor — Service Worker (Manifest V3)
// Orquestração principal: lifecycle, alarmes, mensagens do popup,
// loop de checagem e notificações. Lógica auxiliar fica nos módulos:
//   constants.js  - constantes globais
//   utils.js      - helpers genéricos (delay, withTimeout, sanitizers, parsing)
//   normalize.js  - normalização do payload de reportes
//   config.js     - DEFAULT_CONFIG, normalizeConfig, ensureConfig
//   scrape.js     - aba worker, navegação e extração por serviço

importScripts('constants.js', 'utils.js', 'normalize.js', 'config.js', 'scrape.js');

let activeCheckPromise = null;
let activeCheckAbortController = null;

async function addLog(msg, type = "info") {
  try {
    const { logs = [] } = await chrome.storage.local.get("logs");
    const newLog = { ts: Date.now(), msg, type };
    const updatedLogs = [newLog, ...(Array.isArray(logs) ? logs : [])].slice(0, 100);
    await chrome.storage.local.set({ logs: updatedLogs });
  } catch (e) { console.error("Log failed", e); }
}

// Abrevia nomes longos para os logs ficarem alinhados no popup estreito (360px).
// Mantém palavras curtas inteiras e abrevia as longas com ponto final.
// Ex: "Caixa Econômica Federal" → "Caixa Econ. Fed."
function shortName(name, maxLen = 22) {
  if (!name || name.length <= maxLen) return name;
  const parts = name.split(/\s+/);
  if (parts.length === 1) return name.substring(0, maxLen - 1) + "…";

  const abbreviated = parts.map((part, i) => {
    if (i === 0) return part;                  // mantém a primeira palavra
    if (part.length <= 4) return part;          // palavras curtas ficam inteiras
    return part.substring(0, 4) + ".";          // demais viram "Word."
  }).join(" ");

  if (abbreviated.length <= maxLen) return abbreviated;
  return abbreviated.substring(0, maxLen - 1) + "…";
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

    // Primeira checagem após 30s — usamos chrome.alarms (e não setTimeout) porque
    // o service worker pode ser encerrado por inatividade antes do timer disparar.
    // O mínimo seguro em produção é 0.5min (30s).
    if (triggerStartupDelay) {
      chrome.alarms.create("startup-check", { delayInMinutes: 0.5 });
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
    console.log("Última janela fechada. Monitoramento suspenso para economizar recursos.");
  }
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "check" || alarm.name === "startup-check") {
    chrome.storage.local.get("monitoringEnabled").then(data => {
      if (data.monitoringEnabled !== false) {
        checkAllServices(true).catch(error => console.error("Falha na checagem:", error));
      }
    });
  }
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const { workerTabId } = await chrome.storage.local.get(WORKER_TAB_ID_KEY);
  if (workerTabId === tabId) {
    await chrome.storage.local.remove(WORKER_TAB_ID_KEY);
  }
});

async function performCheckAllServices() {
  const startTime = Date.now();
  await chrome.storage.local.set({ logs: [] }); // Limpa logs anteriores para o novo ciclo
  await addLog("Iniciando verificação de todos os serviços...", "info");

  const config = await ensureConfig();
  const { alerted = [], statusMap: previousStatusMap = {} } = await chrome.storage.local.get(["alerted", "statusMap"]);
  const alertedSet = new Set(alerted);
  const statusMap = { ...previousStatusMap };

  const tab = await getOrCreateWorkerTab();
  let workerTabId = tab.id;
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
      workerTabId = await ensureWorkerTabAlive(workerTabId);
      await updateTabAndWait(workerTabId, homeUrl);
      const homeSignals = await readPageSignals(workerTabId);

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
          await addLog(`Home: +${added.length} serviços detectados (${added.map(n => shortName(n, 18)).join(", ")})`, "info");
        } else {
          await addLog("Home: Nenhum serviço novo detectado.", "info");
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
  const abortSignal = activeCheckAbortController?.signal;

  try {
    for (let index = 0; index < servicesToCheck.length; index += 1) {
      if (abortSignal?.aborted) {
        await addLog("Verificação cancelada pelo usuário.", "warn");
        break;
      }

      const service = servicesToCheck[index];
      const threshold = sanitizeThreshold(service.threshold);

      try {
        await addLog(`Checando ${shortName(service.name)}...`);
        workerTabId = await ensureWorkerTabAlive(workerTabId);
        const result = await withTimeout(scrapeServiceWithRetry(workerTabId, service.slug, config.source_site, abortSignal), 25000);
        const isOutage = result.current >= threshold;

        // Se for da home e não atingiu o limiar de reports, remove do statusMap para não exibir no popup
        if (service.isTrending && result.current < threshold) {
          delete statusMap[service.slug];
          const sourceTag = result.source ? ` [${result.source}]` : "";
          await addLog(`${shortName(service.name)}: ${result.current}/${threshold}${sourceTag}`, "success");
          // Se havia alerta ativo para este serviço, notifica recovery e limpa o badge
          if (alertedSet.has(service.slug)) {
            sendNotification(service.name, service.slug, result.current, threshold, "recovery");
            alertedSet.delete(service.slug);
          }
          continue;
        }

        const lastSeenTrending = statusMap[service.slug]?.lastSeenTrending;
        const previousIconUrls = statusMap[service.slug]?.iconUrls;
        // Prioridade: candidatos da página de detalhe (autoritativo) > logo do card da home (trending) > anterior
        let iconUrls = [];
        if (Array.isArray(result.iconUrls) && result.iconUrls.length) {
          iconUrls = result.iconUrls;
        } else if (service.iconUrl) {
          iconUrls = [service.iconUrl];
        } else if (Array.isArray(previousIconUrls) && previousIconUrls.length) {
          iconUrls = previousIconUrls;
        }
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
          iconUrls,
          lastSeenTrending,
          ts: Date.now()
        };

        const sourceTag = result.source ? ` [${result.source}]` : "";
        await addLog(`${shortName(service.name)}: ${result.current}/${threshold}${sourceTag}`, isOutage ? "error" : "success");

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
        const previousIconUrls = statusMap[service.slug]?.iconUrls;
        let iconUrls = [];
        if (service.iconUrl) {
          iconUrls = [service.iconUrl];
        } else if (Array.isArray(previousIconUrls) && previousIconUrls.length) {
          iconUrls = previousIconUrls;
        }
        statusMap[service.slug] = {
          name: service.name,
          threshold,
          sourceSite: config.source_site,
          error: error.message,
          isTrending: service.isTrending === true,
          iconUrls,
          lastSeenTrending,
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
    // 1. Volta para worker.html (página leve da extensão).
    // 2. Descarta a aba: o Chrome libera a memória mantendo a aba na lista.
    //    Na próxima checagem, chrome.tabs.update revive automaticamente.
    //    Reduz o consumo idle de ~400 MB para algumas dezenas.
    try {
      const workerUrl = chrome.runtime.getURL("worker.html");
      const latestTab = await chrome.tabs.get(workerTabId);
      if (latestTab.url !== workerUrl) {
        await chrome.tabs.update(workerTabId, { url: workerUrl });
        await delay(800); // worker.html assentar antes do discard
      }
      try {
        const discarded = await chrome.tabs.discard(workerTabId);
        // O Chrome pode atribuir um novo id à aba descartada.
        if (discarded?.id && discarded.id !== workerTabId) {
          await chrome.storage.local.set({ [WORKER_TAB_ID_KEY]: discarded.id });
        }
      } catch (_discardError) {
        // Discard pode falhar se a aba estiver ativa, em foreground, ou já descartada.
        // Não é crítico — só não economizou memória nesta vez.
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

  activeCheckAbortController = new AbortController();
  activeCheckPromise = performCheckAllServices()
    .finally(() => {
      activeCheckPromise = null;
      activeCheckAbortController = null;
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
        // Cancela checagem em curso para não desperdiçar recursos
        if (activeCheckAbortController) {
          activeCheckAbortController.abort();
        }
      }
      reply({ ok: true, monitoringEnabled: enabled });
    }).catch(error => reply({ ok: false, error: error.message }));
    return true;
  }
});
