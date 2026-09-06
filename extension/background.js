// Downdetector Monitor — Service Worker (Manifest V3)
// Orquestração principal: lifecycle, alarmes, mensagens do popup,
// loop de checagem e notificações. Lógica auxiliar fica nos módulos:
//   constants.js  - constantes globais
//   utils.js      - helpers genéricos (delay, sanitizers, parsing)
//   normalize.js  - normalização do payload de reportes
//   config.js     - DEFAULT_CONFIG, normalizeConfig, ensureConfig
//   scrape.js     - aba worker, navegação e extração por serviço

importScripts('constants.js', 'utils.js', 'normalize.js', 'config.js', 'scrape.js');

let activeCheckPromise = null;
let activeCheckAbortController = null;

// Autocorreção de estado preso: o service worker pode ser encerrado no meio de
// um ciclo, deixando isChecking=true gravado para sempre — o popup esconde o
// botão ↺ e mostra spinner eterno, sem saída pela UI. Se este módulo está sendo
// avaliado, o worker acabou de subir e nenhuma checagem pode estar em curso.
(async () => {
  try {
    const { isChecking } = await chrome.storage.session.get("isChecking");
    if (isChecking) await chrome.storage.session.set({ isChecking: false });
  } catch (_error) { }
})();

// Logs e progresso vivem em storage.session (memória) e não em storage.local
// (LevelDB, disco). addLog reescreve o array inteiro a cada linha e persistProgress
// roda a cada serviço — em disco isso dava dezenas de gravações por ciclo, a cada
// 10 minutos, o dia inteiro. Nada aqui precisa sobreviver a um restart do navegador.
// addLog faz ler-alterar-gravar do array inteiro, então duas chamadas que se
// cruzem perderiam uma linha. A fila garante que cada gravação veja a anterior.
let logWriteQueue = Promise.resolve();

async function addLog(msg, type = "info") {
  logWriteQueue = logWriteQueue.then(async () => {
    try {
      const { logs = [] } = await chrome.storage.session.get("logs");
      const newLog = { ts: Date.now(), msg, type };
      const updatedLogs = [newLog, ...(Array.isArray(logs) ? logs : [])].slice(0, 100);
      await chrome.storage.session.set({ logs: updatedLogs });
    } catch (e) { console.error("Log failed", e); }
  });
  return logWriteQueue;
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

// Aviso de que o monitoramento de um serviço ficou cego: o número exato parou
// de aparecer e só sobrou a estimativa tirada do desenho do gráfico, que não
// tem precisão para abrir nem encerrar aviso.
function sendBlindNotification(name, slug) {
  chrome.notifications.create(`dd-${slug}-blind-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `❓ Sem dado exato: ${name}`,
    message: "O Downdetector parou de publicar o número exato deste serviço. Só resta uma estimativa do gráfico, e por isso os avisos de queda estão suspensos.",
    priority: 2
  });
}

async function scheduleAlarm(triggerStartupDelay = false, forceReschedule = false) {
  const config = await ensureConfig();
  const { monitoringEnabled = true } = await chrome.storage.local.get("monitoringEnabled");

  if (!monitoringEnabled) {
    await chrome.alarms.clearAll();
    return;
  }

  // chrome.alarms.create sobre um alarme existente REINICIA a contagem do zero.
  // Como scheduleAlarm roda a cada janela nova, recriar incondicionalmente fazia
  // a checagem periódica nunca disparar para quem abre janelas com frequência
  // maior que o intervalo. Só recriamos se ainda não existe ou se o intervalo mudou.
  const existing = await chrome.alarms.get("check");
  if (forceReschedule || !existing || existing.periodInMinutes !== config.interval_minutes) {
    chrome.alarms.create("check", {
      delayInMinutes: config.interval_minutes,
      periodInMinutes: config.interval_minutes
    });
  }

  // Primeira checagem após 30s — usamos chrome.alarms (e não setTimeout) porque
  // o service worker pode ser encerrado por inatividade antes do timer disparar.
  // O mínimo seguro em produção é 0.5min (30s).
  if (triggerStartupDelay && !(await chrome.alarms.get("startup-check"))) {
    chrome.alarms.create("startup-check", { delayInMinutes: 0.5 });
  }
}

async function updateExtensionIcon(enabled) {
  const paths = enabled ? {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  } : {
    "16": "icons/icon16_gray.png",
    "48": "icons/icon48_gray.png",
    "128": "icons/icon128_gray.png"
  };

  try {
    await chrome.action.setIcon({ path: paths });
  } catch (e) {
    console.error("Falha ao definir o ícone da extensão:", e);
  }
}

async function initializeExtension() {
  await ensureConfig();
  const { monitoringEnabled = true } = await chrome.storage.local.get("monitoringEnabled");
  await updateExtensionIcon(monitoringEnabled);

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
  const stored = await chrome.storage.session.get(WORKER_TAB_ID_KEY);
  if (stored[WORKER_TAB_ID_KEY] === tabId) {
    await chrome.storage.session.remove(WORKER_TAB_ID_KEY);
  }
});

// Ordem de preferência do ícone: o que veio da página do serviço (autoritativo)
// > o logo do card da home (trending) > o que já estava guardado.
function resolveIconUrls(service, statusMap, resultIconUrls) {
  if (Array.isArray(resultIconUrls) && resultIconUrls.length) return resultIconUrls;
  if (service.iconUrl) return [service.iconUrl];

  const previous = statusMap[service.slug]?.iconUrls;
  if (Array.isArray(previous) && previous.length) return previous;
  return [];
}

async function applyServiceResult(service, result, context) {
  const { statusMap, alertedSet, config } = context;
  const previous = statusMap[service.slug] || null;
  const threshold = sanitizeThreshold(service.threshold);
  const isOutage = result.current >= threshold;
  const authoritative = result.authoritative === true;
  const wasAlerted = alertedSet.has(service.slug);
  const sourceTag = result.source ? ` [${result.source}]` : "";
  const now = Date.now();

  // Contagem de ciclos seguidos em que só a estimativa do desenho apareceu.
  // Sem ela, o site poderia mudar de formato e o monitoramento ficaria mudo
  // sem que nada na tela indicasse isso.
  const exactMissStreak = authoritative ? 0 : (previous?.exactMissStreak || 0) + 1;
  const isBlind = exactMissStreak >= MAX_CYCLES_WITHOUT_EXACT_READING;
  const wasBlind = (previous?.exactMissStreak || 0) >= MAX_CYCLES_WITHOUT_EXACT_READING;

  if (isBlind && !wasBlind) {
    await addLog(`${shortName(service.name)}: sem leitura exata há ${exactMissStreak} ciclos. Avisos suspensos.`, "warn");
    sendBlindNotification(service.name, service.slug);
  } else if (wasBlind && authoritative) {
    await addLog(`${shortName(service.name)}: leitura exata voltou. Avisos religados.`, "success");
  }

  // Trending que não atingiu o limiar sai do popup para não poluir a lista.
  // Só uma leitura exata pode tirá-lo: a estimativa do desenho erra o valor e
  // faria o serviço piscar dentro e fora da lista a cada ciclo.
  if (service.isTrending && result.current < threshold && authoritative) {
    delete statusMap[service.slug];
    await addLog(`${shortName(service.name)}: ${result.current}/${threshold}${sourceTag}`, "success");
    if (wasAlerted) {
      sendNotification(service.name, service.slug, result.current, threshold, "recovery");
      alertedSet.delete(service.slug);
    }
    return;
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
    // Enquanto uma recuperação estiver apenas estimada, preservamos o estado
    // de alerta até a confirmação por React/payload. Assim o badge não some e
    // não há falsa recuperação.
    outage: authoritative ? isOutage : (wasAlerted ? true : isOutage),
    observedOutage: isOutage,
    dataQuality: authoritative ? "exact" : "estimated",
    needsExactConfirmation: !authoritative && wasAlerted !== isOutage,
    exactMissStreak,
    isBlind,
    failureStreak: 0,
    source: result.source || null,
    isTrending: service.isTrending === true,
    iconUrls: resolveIconUrls(service, statusMap, result.iconUrls),
    lastSeenTrending: previous?.lastSeenTrending,
    lastError: null,
    lastErrorAt: null,
    lastAttemptAt: now,
    lastSuccessfulAt: authoritative ? now : previous?.lastSuccessfulAt || null,
    ts: now
  };

  await addLog(
    `${shortName(service.name)}: ${result.current}/${threshold}${sourceTag}${authoritative ? "" : " (estimativa; avisos preservados)"}`,
    isOutage ? "error" : "success"
  );

  if (!authoritative) return;

  if (isOutage && !wasAlerted) {
    sendNotification(service.name, service.slug, result.current, threshold, "outage");
    alertedSet.add(service.slug);
  } else if (!isOutage && wasAlerted) {
    sendNotification(service.name, service.slug, result.current, threshold, "recovery");
    alertedSet.delete(service.slug);
  }
}

async function applyServiceError(service, error, context) {
  const { statusMap, alertedSet, config } = context;
  const previous = statusMap[service.slug] || null;
  const hasPreviousReading = Number.isFinite(previous?.current);
  const failureStreak = (previous?.failureStreak || 0) + 1;
  const now = Date.now();

  await addLog(`Erro ao checar ${service.slug}: ${error.message}`, "error");
  console.error(`Erro ao checar ${service.slug}:`, error);

  const nextStatus = {
    ...(previous || {}),
    name: service.name,
    threshold: sanitizeThreshold(service.threshold),
    sourceSite: config.source_site,
    isTrending: service.isTrending === true,
    iconUrls: resolveIconUrls(service, statusMap, null),
    lastSeenTrending: previous?.lastSeenTrending,
    lastError: error.message,
    lastErrorAt: now,
    lastAttemptAt: now,
    failureStreak,
    // ts é a hora do dado, não da tentativa. Atualizá-lo aqui faria o gráfico
    // antigo aparecer com carimbo de agora.
    ts: previous?.ts || now
  };

  // Um erro de transporte/leitura não é recuperação. Mantemos a última leitura
  // confiável e o conjunto de avisos em aberto para evitar tanto aviso
  // duplicado quanto recuperação silenciosa no ciclo seguinte.
  if (!hasPreviousReading) nextStatus.error = error.message;
  else delete nextStatus.error;

  // Preservar para sempre trava o contador do ícone num serviço que quebrou de
  // vez (endereço morto, página que sumiu). Passado o teto de falhas seguidas,
  // o aviso é solto e o serviço volta a desconhecido.
  if (failureStreak >= MAX_CONSECUTIVE_READ_FAILURES) {
    nextStatus.error = error.message;
    nextStatus.outage = false;
    delete nextStatus.current;
    delete nextStatus.history;

    if (alertedSet?.has(service.slug)) {
      alertedSet.delete(service.slug);
      await addLog(`${shortName(service.name)}: ${failureStreak} falhas seguidas. Aviso encerrado por falta de leitura.`, "warn");
    }
  }

  statusMap[service.slug] = nextStatus;
}

async function performCheckAllServices() {
  const startTime = Date.now();
  const abortSignal = activeCheckAbortController?.signal;
  let config = null;
  let alertedSet = new Set();
  let statusMap = {};
  let servicesToCheck = [];
  let totalServices = 0;
  let completed = 0;
  let workerTabId = null;
  let cancelled = false;
  let fatalError = null;

  const markCancelled = async () => {
    if (cancelled) return;
    cancelled = true;
    await addLog("Verificação cancelada. Nenhum estado de alerta foi alterado.", "warn");
  };

  // A aba é criada sob demanda, na primeira vez que alguém precisar dela.
  const ensureTab = async () => {
    if (workerTabId === null) {
      const tab = await getOrCreateWorkerTab();
      workerTabId = tab.id;
    }
    workerTabId = await ensureWorkerTabAlive(workerTabId);
    return workerTabId;
  };

  try {
    await chrome.storage.session.set({ logs: [] }); // Limpa logs anteriores para o novo ciclo
    await addLog("Iniciando verificação de todos os serviços...", "info");

    const stored = await chrome.storage.local.get(["alerted", "statusMap"]);
    alertedSet = new Set(stored.alerted || []);
    statusMap = { ...(stored.statusMap || {}) };
    config = await ensureConfig();
    servicesToCheck = [...config.services];

    // Busca serviços em destaque (Trending) se habilitado.
    if (config.top_services_enabled) {
      await addLog("Buscando serviços em destaque na home page...", "info");
      await persistProgress(statusMap, alertedSet, {
        isChecking: true,
        checkCompleted: 0,
        checkTotal: servicesToCheck.length,
        statusText: "Buscando tendências..."
      });

      let trendingServices = null;
      try {
        const baseHomeUrl = config.source_site === "com" ? "https://downdetector.com/" : "https://downdetector.com.br/";
        const tabId = await ensureTab();
        await updateTabAndWait(tabId, withWorkerMarker(baseHomeUrl, true), abortSignal);
        const homeSignals = await waitForHomeSignals(tabId, abortSignal);
        if (Array.isArray(homeSignals?.trendingServices)) trendingServices = homeSignals.trendingServices;
      } catch (error) {
        if (abortSignal?.aborted) {
          await markCancelled();
        } else {
          await addLog(`Erro ao buscar tendências: ${error.message}`, "error");
          console.error("Erro ao buscar serviços em destaque:", error);
        }
      }

      if (!cancelled && Array.isArray(trendingServices)) {
        const topCount = config.top_services_count || DEFAULT_TOP_SERVICES_COUNT;
        const added = [];
        for (const candidate of trendingServices) {
          const slug = sanitizeSlug(candidate.slug);
          if (added.length >= topCount) break;
          if (!slug || servicesToCheck.some(existing => existing.slug === slug)) continue;
          servicesToCheck.push({
            ...candidate,
            slug,
            threshold: config.top_services_threshold || DEFAULT_TOP_SERVICES_THRESHOLD,
            isTrending: true
          });
          added.push(candidate.name);
        }

        await addLog(
          added.length > 0
            ? `Home: +${added.length} serviços detectados (${added.map(name => shortName(name, 18)).join(", ")})`
            : "Home: Nenhum serviço novo detectado.",
          "info"
        );
      }
    }

    if (abortSignal?.aborted) await markCancelled();

    // Limpeza de Trending antigo. Nunca a executamos em ciclo cancelado: a
    // ausência de uma leitura completa não é evidência de que um item sumiu.
    if (!cancelled) {
      const now = Date.now();
      const GRACE_PERIOD_MS = 30 * 60 * 1000;

      for (const key of Object.keys(statusMap)) {
        const info = statusMap[key];
        if (config.services.some(service => service.slug === key)) continue;

        // Só itens que nasceram da home participam do ciclo de retenção. Um
        // serviço manual removido não pode ser reclassificado como Trending e
        // continuar sendo monitorado indefinidamente.
        if (info.isTrending !== true) {
          delete statusMap[key];
          alertedSet.delete(key);
          continue;
        }

        const isCurrentlyTrending = servicesToCheck.some(service => service.slug === key && service.isTrending);
        if (isCurrentlyTrending) {
          info.lastSeenTrending = now;
          continue;
        }

        if (info.outage || (Number.isFinite(info.current) && info.current >= info.threshold * WARNING_RATIO)) {
          servicesToCheck.push({ slug: key, name: info.name, threshold: info.threshold, isTrending: true });
          continue;
        }

        const lastSeen = info.lastSeenTrending || 0;
        if (lastSeen === 0 || now - lastSeen > GRACE_PERIOD_MS) delete statusMap[key];
        else servicesToCheck.push({ slug: key, name: info.name, threshold: info.threshold, isTrending: true });
      }
    }

    totalServices = servicesToCheck.length;
    await persistProgress(statusMap, alertedSet, {
      isChecking: true,
      checkCompleted: 0,
      checkTotal: totalServices,
      statusText: ""
    });

    const context = { statusMap, alertedSet, config };
    for (const service of servicesToCheck) {
      if (abortSignal?.aborted) {
        await markCancelled();
        break;
      }

      try {
        await addLog(`Checando ${shortName(service.name)}...`);
        const tabId = await ensureTab();
        // O timeout entra como signal (e não como Promise.race) para que o
        // estouro realmente aborte o scrape. Antes, o loop de leitura continuava
        // rodando na aba depois do timeout e se sobrepunha ao serviço seguinte.
        const serviceSignal = abortSignal
          ? AbortSignal.any([abortSignal, AbortSignal.timeout(SERVICE_TIMEOUT_MS)])
          : AbortSignal.timeout(SERVICE_TIMEOUT_MS);
        const result = await scrapeServiceWithRetry(tabId, service.slug, config.source_site, serviceSignal);
        await applyServiceResult(service, result, context);
      } catch (error) {
        if (abortSignal?.aborted) {
          await markCancelled();
          break;
        }
        await applyServiceError(service, error, context);
      }

      completed += 1;
      await persistProgress(statusMap, alertedSet, {
        isChecking: true,
        checkCompleted: completed,
        checkTotal: totalServices
      });

      try {
        await delay(250, abortSignal);
      } catch (error) {
        if (abortSignal?.aborted) {
          await markCancelled();
          break;
        }
        throw error;
      }
    }
  } catch (error) {
    if (abortSignal?.aborted) await markCancelled();
    else {
      fatalError = error;
      await addLog(`Falha no ciclo: ${error.message}`, "error");
      console.error("Falha no ciclo de verificação:", error);
    }
  } finally {
    // A aba pode não ter sido criada (lista vazia, ou cancelamento logo no início).
    if (workerTabId !== null) {
      // 1. Volta para worker.html (página leve da extensão).
      // 2. Descarta a aba: o Chrome libera a memória mantendo a aba na lista.
      //    Na próxima checagem, chrome.tabs.update revive automaticamente.
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
            await chrome.storage.session.set({ [WORKER_TAB_ID_KEY]: discarded.id });
            await applyAdblockRule(discarded.id);
          }
        } catch (_discardError) {
          // Discard pode falhar se a aba estiver ativa, em foreground, ou já descartada.
          // Não é crítico — só não economizou memória nesta vez.
        }
      } catch (_error) { }
    }
  }

  // Interrupção e falha não escrevem texto no cabeçalho: ele voltaria a exibir
  // "Verificação cancelada." toda vez que a janela fosse aberta, no lugar da
  // hora da última checagem, até um ciclo inteiro terminar. O que aconteceu
  // fica no registro de atividade.
  if (cancelled) {
    await persistProgress(statusMap, alertedSet, {
      isChecking: false,
      checkCompleted: completed,
      checkTotal: totalServices,
      statusText: ""
    });
    return { cancelled: true };
  }

  if (fatalError) {
    await persistProgress(statusMap, alertedSet, {
      isChecking: false,
      checkCompleted: completed,
      checkTotal: totalServices,
      statusText: ""
    });
    throw fatalError;
  }

  // Poda slugs que saíram da lista monitorada (ex: serviço removido da config
  // enquanto estava em falha). Sem isso o badge segue contando um serviço que
  // não é mais checado, e o número nunca volta a zero.
  const monitoredSlugs = new Set(servicesToCheck.map(service => service.slug));
  for (const slug of [...alertedSet]) {
    if (!monitoredSlugs.has(slug)) alertedSet.delete(slug);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  await addLog(`Verificação concluída em ${duration}s.`, "info");

  await persistProgress(statusMap, alertedSet, {
    isChecking: false,
    checkCompleted: totalServices,
    checkTotal: totalServices,
    lastCheck: Date.now(),
    statusText: ""
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

// Dispara a interrupção e devolve a promessa do ciclo morrendo, sem esperar.
// Quem chama responde ao usuário na hora: a limpeza da aba leva segundos e
// travava o botão de ligar/desligar e o de salvar até ela terminar.
// Devolve null quando não havia nada em curso.
function cancelActiveCheck(message) {
  const runningPromise = activeCheckPromise;
  if (!activeCheckAbortController || !runningPromise) return null;

  activeCheckAbortController.abort(new DOMException(message, "AbortError"));
  return runningPromise.catch(() => { });
}

// Campos voláteis de progresso — vão para storage.session (memória).
// statusMap, alerted e lastCheck continuam em storage.local porque precisam
// sobreviver ao restart do navegador (é o que o popup mostra antes da 1ª checagem).
const SESSION_PROGRESS_KEYS = new Set(["isChecking", "checkCompleted", "checkTotal", "statusText"]);

async function persistProgress(statusMap, alertedSet, extra = {}) {
  const localPatch = {
    alerted: [...alertedSet],
    statusMap: { ...statusMap }
  };
  const sessionPatch = {};

  for (const [key, value] of Object.entries(extra)) {
    if (SESSION_PROGRESS_KEYS.has(key)) sessionPatch[key] = value;
    else localPatch[key] = value;
  }

  await Promise.all([
    chrome.storage.local.set(localPatch),
    Object.keys(sessionPatch).length > 0
      ? chrome.storage.session.set(sessionPatch)
      : Promise.resolve()
  ]);

  const count = alertedSet.size;
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: "#000000" }); // Preto contrasta bem com o vermelho
    // Explícito: sem isso o Chrome escolhe a cor do texto pelo tema, e no tema
    // claro ele pode cair para preto sobre preto.
    chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

async function pruneRemovedManualStatuses(config) {
  const { alerted = [], statusMap = {} } = await chrome.storage.local.get(["alerted", "statusMap"]);
  const configuredSlugs = new Set(config.services.map(service => service.slug));
  const alertedSet = new Set(alerted);
  let changed = false;

  for (const [slug, info] of Object.entries(statusMap)) {
    if (info?.isTrending === true || configuredSlugs.has(slug)) continue;
    delete statusMap[slug];
    alertedSet.delete(slug);
    changed = true;
  }

  if (changed) await persistProgress(statusMap, alertedSet);
}

// Clicar na notificação abre a página do serviço. As notificações de Cloudflare
// (dd-cf-*) não casam com o padrão e são ignoradas de propósito — nesse caso a
// aba já é trazida para o foco por waitForPageSignals.
chrome.notifications.onClicked.addListener(async notificationId => {
  const match = /^dd-(.+)-(?:outage|recovery|blind)-\d+$/.exec(notificationId);
  if (!match) return;

  try {
    const config = await ensureConfig();
    const [url] = getServiceUrls(match[1], config.source_site);
    await chrome.tabs.create({ url, active: true });
    chrome.notifications.clear(notificationId);
  } catch (error) {
    console.error("Falha ao abrir a página do serviço:", error);
  }
});

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
    const rejectedServices = listRejectedServices(msg.config, config);

    // O ciclo em andamento trabalha com uma cópia da configuração de quando
    // começou. Interrompê-lo evita que ele grave resultado com limiar antigo.
    const dyingCheck = cancelActiveCheck("Configuração alterada pelo usuário.");

    chrome.storage.sync.set({ config })
      .then(() => scheduleAlarm(false, true)) // Forçado: o intervalo pode ter mudado.
      .then(() => reply({ ok: true, config, rejectedServices }))
      .catch(error => reply({ ok: false, error: error.message }));

    // Limpeza e retomada acontecem depois que o ciclo interrompido termina de
    // gravar, senão ele ressuscitaria os serviços que acabaram de sair da lista.
    Promise.resolve(dyingCheck)
      .then(() => pruneRemovedManualStatuses(config))
      .then(async () => {
        if (!dyingCheck) return;
        const { monitoringEnabled = true } = await chrome.storage.local.get("monitoringEnabled");
        if (monitoringEnabled) await checkAllServices();
      })
      .catch(error => console.error("Falha ao aplicar a nova configuração:", error));

    return true;
  }

  if (msg.type === "TOGGLE_MONITORING") {
    const enabled = msg.enabled === true;
    chrome.storage.local.set({ monitoringEnabled: enabled }).then(async () => {
      await updateExtensionIcon(enabled);
      if (enabled) {
        await scheduleAlarm();
      } else {
        await chrome.alarms.clearAll();
        cancelActiveCheck("Monitoramento desativado pelo usuário.");
      }
      reply({ ok: true, monitoringEnabled: enabled });
    }).catch(error => reply({ ok: false, error: error.message }));
    return true;
  }
});
