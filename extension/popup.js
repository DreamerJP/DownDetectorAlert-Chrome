let chartGradientCounter = 0;

// Ícones SVG inline para substituir emojis dinâmicos no popup.
// Cada um herda currentColor — basta colorir o elemento pai.
const SVG_ICONS = {
  refresh: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>',
  warning: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>'
};

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}

function escapeAttr(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;
    document.querySelectorAll(".tab, .panel").forEach(el => el.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`panel-${target}`).classList.add("active");
    
    if (target === "config") loadConfig();
    if (target === "logs") renderLogs();
  });
});

// ── Status ────────────────────────────────────────────────────────────────────
function normalizeChartPoint(point, index, total) {
  if (typeof point === "number") {
    return {
      value: Math.max(0, point),
      baseline: null,
      timestamp: new Date(Date.now() - ((total - 1 - index) * 15 * 60 * 1000)),
      label: null,
    };
  }

  if (Array.isArray(point)) {
    const value = Number(point[1] ?? point[0]);
    const baseline = Number(point[2]);
    const timestamp = new Date(point[0]);
    if (!Number.isFinite(value)) return null;

    return {
      value: Math.max(0, value),
      baseline: Number.isFinite(baseline) ? Math.max(0, baseline) : null,
      timestamp: Number.isNaN(timestamp.getTime())
        ? new Date(Date.now() - ((total - 1 - index) * 15 * 60 * 1000))
        : timestamp,
      label: typeof point[3] === "string" ? point[3] : null,
    };
  }

  if (!point || typeof point !== "object") return null;

  const value = Number(point.value ?? point.total ?? point.y ?? point.reports ?? point.current);
  const baseline = Number(point.baseline);
  const timestamp = new Date(point.timestamp ?? point.point_in_time ?? point.date ?? point.time);

  if (!Number.isFinite(value)) return null;

  return {
    value: Math.max(0, value),
    baseline: Number.isFinite(baseline) ? Math.max(0, baseline) : null,
    timestamp: Number.isNaN(timestamp.getTime())
      ? new Date(Date.now() - ((total - 1 - index) * 15 * 60 * 1000))
      : timestamp,
    label: typeof point.label === "string" ? point.label : null,
  };
}

function formatShortTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "—";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTickLabel(label) {
  if (typeof label !== "string") return "—";
  const normalized = label.trim().replace(/\s+/g, " ");
  if (!normalized) return "—";

  const amPmMatch = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (amPmMatch) {
    let hour = parseInt(amPmMatch[1], 10);
    const minute = amPmMatch[2] || "00";
    const suffix = amPmMatch[3].toUpperCase();

    if (suffix === "AM" && hour === 12) hour = 0;
    if (suffix === "PM" && hour !== 12) hour += 12;

    return `${pad(hour)}:${minute}`;
  }

  const hourOnlyMatch = normalized.match(/^(\d{1,2})$/);
  if (hourOnlyMatch) {
    return `${pad(parseInt(hourOnlyMatch[1], 10))}:00`;
  }

  const hourMinuteMatch = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (hourMinuteMatch) {
    return `${pad(parseInt(hourMinuteMatch[1], 10))}:${hourMinuteMatch[2]}`;
  }

  return normalized;
}

function formatScaleValue(value) {
  if (!Number.isFinite(value)) return "0";

  return new Intl.NumberFormat("pt-BR", {
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1000 ? 1 : 0
  }).format(Math.round(value));
}

function buildLinePath(points) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
}

function buildAreaPath(points, height) {
  if (!points.length) return "";
  const line = buildLinePath(points);
  const first = points[0];
  const last = points[points.length - 1];
  return `${line} L ${last.x.toFixed(2)} ${height.toFixed(2)} L ${first.x.toFixed(2)} ${height.toFixed(2)} Z`;
}

function pickChartLabels(data, tickLabels) {
  // Prefer real tick labels extracted from the SVG chart axis
  if (Array.isArray(tickLabels) && tickLabels.length >= 3) {
    const formatted = tickLabels.map(formatTickLabel);
    return [
      formatted[0],
      formatted[Math.floor(formatted.length / 2)],
      formatted[formatted.length - 1]
    ];
  }

  const startStr = formatShortTime(data[0].timestamp);
  const midStr = formatShortTime(data[Math.floor((data.length - 1) / 2)].timestamp);
  const endStr = formatShortTime(data[data.length - 1].timestamp);

  return [
    startStr === endStr ? `Ontem ${startStr}` : startStr,
    midStr,
    startStr === endStr ? `Hoje ${endStr}` : endStr
  ];
}

function buildServiceDetail(info) {
  if (!info || info.current === undefined) return "Aguardando checagem...";

  const parts = [];
  if (Number.isFinite(info.current)) parts.push(`Agora ${info.current}`);
  if (Number.isFinite(info.peak)) parts.push(`Pico ${info.peak}`);
  return parts.join(" · ");
}

function renderChart(history, threshold, meta = {}) {
  const data = history
    .slice(-MAX_POINTS)
    .map((point, index, list) => normalizeChartPoint(point, index, list.length))
    .filter(Boolean);

  if (data.length < MIN_GRAPH_POINTS) {
    return '<div class="chart-empty">Sem histórico suficiente no momento.</div>';
  }

  const current = data[data.length - 1].value;
  const stateClass = current >= threshold
    ? "danger"
    : current >= threshold * WARNING_RATIO
      ? "warning"
      : "";
  const width = 320;
  const height = 54;
  const axisWidth = 24;
  const plotWidth = width - axisWidth;
  const maxVal = Math.max(
    threshold,
    10,
    ...data.map(point => point.value),
    ...data.map(point => point.baseline ?? 0)
  );
  const step = data.length > 1 ? plotWidth / (data.length - 1) : plotWidth;
  const coords = data.map((point, index) => ({
    x: axisWidth + (index * step),
    y: Math.max(2, height - ((point.value / maxVal) * height)),
  }));
  const baselineCoords = data
    .map((point, index) => {
      if (!Number.isFinite(point.baseline)) return null;
      return {
        x: axisWidth + (index * step),
        y: Math.max(2, height - ((point.baseline / maxVal) * height)),
      };
    })
    .filter(Boolean);
  const thresholdY = Math.max(2, height - ((threshold / maxVal) * height));
  const gradientId = `chart-grad-${chartGradientCounter++}`;
  const [timeStart, timeMid, timeEnd] = pickChartLabels(data, meta.tickLabels);
  const chartLabel = meta.periodLabel
    ? `${meta.periodLabel} · Limiar ${threshold}`
    : `Limiar ${threshold}`;
  const scaleTop = formatScaleValue(maxVal);
  const scaleMid = formatScaleValue(maxVal / 2);
  const scaleBottom = "0";

  return `
    <div class="chart-container ${stateClass}">
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="Gráfico de reportes nas últimas 24 horas">
        <defs>
          <linearGradient id="${gradientId}" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="currentColor" stop-opacity="0.36"></stop>
            <stop offset="100%" stop-color="currentColor" stop-opacity="0.03"></stop>
          </linearGradient>
        </defs>
        <line class="chart-axis" x1="${axisWidth}" y1="0" x2="${axisWidth}" y2="${height}"></line>
        <g class="chart-grid">
          <line x1="${axisWidth}" y1="${(height * 0.33).toFixed(2)}" x2="${width}" y2="${(height * 0.33).toFixed(2)}"></line>
          <line x1="${axisWidth}" y1="${(height * 0.66).toFixed(2)}" x2="${width}" y2="${(height * 0.66).toFixed(2)}"></line>
        </g>
        <g class="chart-scale">
          <text x="${axisWidth - 2}" y="7" text-anchor="end">${scaleTop}</text>
          <text x="${axisWidth - 2}" y="${(height / 2).toFixed(2)}" text-anchor="end">${scaleMid}</text>
          <text x="${axisWidth - 2}" y="${(height - 3).toFixed(2)}" text-anchor="end">${scaleBottom}</text>
        </g>
        ${baselineCoords.length >= 2 ? `<path class="chart-secondary" d="${buildLinePath(baselineCoords)}"></path>` : ""}
        <line class="chart-baseline" x1="${axisWidth}" y1="${thresholdY.toFixed(2)}" x2="${width}" y2="${thresholdY.toFixed(2)}"></line>
        <path class="chart-area" d="${buildAreaPath(coords, height)}" fill="url(#${gradientId})"></path>
        <path class="chart-line" d="${buildLinePath(coords)}"></path>
      </svg>
      <div class="chart-label">${chartLabel}</div>
    </div>
    <div class="chart-times" style="padding-left:${axisWidth}px">
      <span>${timeStart}</span>
      <span>${timeMid}</span>
      <span>${timeEnd}</span>
    </div>`;
}

let latestStatusMap = null;
let latestLastCheck = null;

function renderStatus(statusMap, lastCheck) {
  latestStatusMap = statusMap || null;
  latestLastCheck = lastCheck || null;
  const list = document.getElementById("status-list");

  if (!statusMap || Object.keys(statusMap).length === 0) {
    list.innerHTML = '<div class="empty">Nenhum dado ainda.<br>Clique em ↺ Checar para iniciar.</div>';
    return;
  }

  // Ordenação inteligente: Problemas > Recuperados > Normal
  const sortedEntries = Object.entries(statusMap).sort(([, a], [, b]) => {
    const getWeight = (info) => {
      if (info.error || info.outage || (info.current >= info.threshold * WARNING_RATIO)) return 3;
      if (info.isTrending && !info.outage) return 2;
      return 1;
    };
    
    const weightA = getWeight(a);
    const weightB = getWeight(b);
    
    if (weightA !== weightB) return weightB - weightA;
    return a.name.localeCompare(b.name); // Desempate por nome
  });

  let html = "";
  for (const [slug, info] of sortedEntries) {
    let dotCls, badgeCls, badgeText, detail;

    const hasLastReading = Number.isFinite(info.current);
    const hasUnavailableReading = Boolean(info.error) && !hasLastReading;

    if (hasUnavailableReading) {
      dotCls    = "unknown";
      badgeCls  = "badge-unknown";
      badgeText = "erro";
      detail    = info.error;
    } else if (info.outage) {
      dotCls    = "outage";
      badgeCls  = "badge-outage";
      badgeText = "falha";
      detail    = buildServiceDetail(info);
    } else if (info.current >= info.threshold * WARNING_RATIO) {
      dotCls    = "warning";
      badgeCls  = "badge-warning";
      badgeText = "alerta";
      detail    = buildServiceDetail(info);
    } else {
      dotCls    = "ok";
      badgeCls  = "badge-ok";
      badgeText = "normal";
      detail    = buildServiceDetail(info);
    }

    // Falha de leitura mantém o número e o gráfico da última vez que deu certo.
    // Sem dizer de quando ele é, o usuário lê dado velho como se fosse de agora.
    if (info.lastError && hasLastReading) {
      detail = `${detail} · sem leitura nova${formatAge(info.lastSuccessfulAt || info.ts)}`;
    }

    const historyHtml = info.error
      ? `<div class="chart-empty">${escapeHtml(info.error)}</div>`
      : info.history && info.history.length > 0
        ? renderChart(info.history, info.threshold, {
          tickLabels: info.tickLabels,
          periodLabel: info.periodLabel
        })
        : '<div class="chart-empty">Sem histórico real disponível no momento.</div>';

    const iconCandidates = Array.isArray(info.iconUrls) && info.iconUrls.length
      ? info.iconUrls
      : (info.iconUrl ? [info.iconUrl] : []);

    const iconHtml = iconCandidates.length
      ? `<img class="svc-icon" src="${escapeAttr(iconCandidates[0])}" data-fallbacks="${escapeAttr(JSON.stringify(iconCandidates.slice(1)))}" loading="lazy" alt="">`
      : "";

    html += `
      <div class="svc-row">
        <div class="svc-header">
          <div class="dot ${dotCls}"></div>
          ${iconHtml}
          <div style="flex:1;min-width:0">
            <div class="svc-name">${escapeHtml(info.name)}</div>
            <div class="svc-detail">${escapeHtml(detail)}</div>
          </div>
          <div class="badge-row">
            ${info.isTrending ? `<div class="svc-badge badge-trending ${info.outage ? '' : 'badge-recovered'}" title="${info.outage ? 'Serviço identificado automaticamente pelo Downdetector' : 'Serviço normalizado, sairá da lista em breve'}">${info.outage ? 'Trending' : 'Recuperado'}</div>` : ''}
            ${info.isBlind
        ? `<div class="svc-badge badge-blind" title="O Downdetector parou de publicar o número exato deste serviço. Os avisos de queda estão suspensos até ele voltar.">Sem dado exato</div>`
        : info.dataQuality === 'estimated'
          ? `<div class="svc-badge badge-estimated" title="Valor estimado pelo desenho do gráfico. Não abre nem encerra aviso.">${info.needsExactConfirmation ? 'Confirmar' : 'Estimado'}</div>`
          : ''}
            <div class="svc-badge ${badgeCls}">${escapeHtml(badgeText)}</div>
          </div>
        </div>
        <div class="svc-body">
          ${historyHtml}
        </div>
      </div>`;
  }
  list.innerHTML = html;

  list.querySelectorAll(".svc-header").forEach(header => {
    header.addEventListener("click", () => {
      header.parentElement.classList.toggle("expanded");
    });
  });

  list.querySelectorAll(".svc-icon").forEach(img => {
    img.addEventListener("error", () => {
      let fallbacks = [];
      try { fallbacks = JSON.parse(img.dataset.fallbacks || "[]"); } catch (_) {}
      if (fallbacks.length === 0) {
        img.style.display = "none";
        return;
      }
      img.dataset.fallbacks = JSON.stringify(fallbacks.slice(1));
      img.src = fallbacks[0];
    });
  });

  if (lastCheck) {
    const d = new Date(lastCheck);
    document.getElementById("last-check").textContent =
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
}

function pad(n) { return String(n).padStart(2, "0"); }

// Idade do dado exibido, em texto curto, para nunca haver número na tela sem
// referência de quando ele foi lido.
function formatAge(timestamp) {
  if (!Number.isFinite(timestamp)) return "";

  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return " (agora)";
  if (minutes < 60) return ` (há ${minutes} min)`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ` (há ${hours} h)`;
  return ` (há ${Math.floor(hours / 24)} d)`;
}

async function refreshStatus() {
  const data = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  renderStatus(data.statusMap, data.lastCheck);
  if (document.getElementById("panel-logs").classList.contains("active")) {
    renderLogs();
  }
}

async function renderLogs() {
  try {
    const { logs = [] } = await chrome.storage.session.get("logs");
    const container = document.getElementById("log-container");
    if (!container) return;

    if (!Array.isArray(logs) || logs.length === 0) {
      container.innerHTML = '<div class="empty">Nenhum log registrado ainda.</div>';
      return;
    }

    container.innerHTML = logs.map(l => {
      const d = new Date(l.ts);
      const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      return `<div class="log-entry"><span class="log-ts">[${ts}]</span><span class="log-msg log-type-${l.type}">${escapeHtml(l.msg)}</span></div>`;
    }).join("");
    
    container.scrollTop = container.scrollHeight;
  } catch (e) { console.warn("Render logs failed", e); }
}

// Spinner + contador no cabeçalho. Usado tanto no boot quanto a cada mudança
// de progresso — antes as duas cópias tinham divergido de leve.
function applyProgressUi(data) {
  const el = document.getElementById("last-check");
  const btn = document.getElementById("btn-refresh");
  const header = document.querySelector("header");
  if (!el || !btn || !header) return;

  if (!data.isChecking) {
    btn.style.display = "block";
    btn.disabled = false;
    btn.innerHTML = SVG_ICONS.refresh;
    document.getElementById("active-spinner")?.remove();
    if (data.statusText) el.textContent = data.statusText;
    return;
  }

  btn.style.display = "none";
  if (!document.getElementById("active-spinner")) {
    const spinner = document.createElement("div");
    spinner.id = "active-spinner";
    spinner.className = "spinner";
    header.querySelector(".header-right").appendChild(spinner);
  }

  if (data.statusText) {
    el.textContent = data.statusText;
  } else if (Number.isFinite(data.checkCompleted) && Number.isFinite(data.checkTotal) && data.checkCompleted < data.checkTotal) {
    el.textContent = `Verificando ${data.checkCompleted + 1}/${data.checkTotal}...`;
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  // Logs e progresso migraram para storage.session (memória).
  // statusMap e lastCheck seguem em storage.local (precisam sobreviver a restart).
  if (areaName === "session") {
    if (changes.logs) renderLogs();
    if (changes.isChecking || changes.checkCompleted || changes.checkTotal || changes.statusText) {
      chrome.storage.session
        .get(["isChecking", "checkCompleted", "checkTotal", "statusText"])
        .then(applyProgressUi);
    }
    return;
  }

  if (areaName !== "local") return;
  if (!changes.statusMap && !changes.lastCheck) return;

  const nextStatusMap = changes.statusMap ? changes.statusMap.newValue : latestStatusMap;
  const nextLastCheck = changes.lastCheck ? changes.lastCheck.newValue : latestLastCheck;
  renderStatus(nextStatusMap, nextLastCheck);
});

document.getElementById("btn-refresh").addEventListener("click", async () => {
  const btn = document.getElementById("btn-refresh");
  btn.disabled = true;
  // Durante o force check, o storage listener substitui o botão pelo spinner —
  // mantemos o ícone refresh enquanto o evento isChecking não chega.
  const result = await chrome.runtime.sendMessage({ type: "FORCE_CHECK" });
  await refreshStatus();
  btn.innerHTML = result?.ok === false ? SVG_ICONS.warning : SVG_ICONS.refresh;
  if (result?.ok === false) {
    setTimeout(() => { btn.innerHTML = SVG_ICONS.refresh; }, 1500);
  }
  btn.disabled = false;
});

// ── Config ────────────────────────────────────────────────────────────────────
let currentServices = [];
let currentSourceSite = DEFAULT_SOURCE_SITE;
let isDirty = false;
let isLoadingConfig = false;

function markDirty() {
  if (isLoadingConfig) return;
  isDirty = true;
  document.getElementById("btn-save")?.classList.add("unsaved");
}

function clearDirty() {
  isDirty = false;
  document.getElementById("btn-save")?.classList.remove("unsaved");
}

async function loadConfig() {
  isLoadingConfig = true;
  try {
    const { config } = await chrome.storage.sync.get("config");
    if (!config) return;
    document.getElementById("interval").value = config.interval_minutes;
    currentSourceSite = config.source_site || DEFAULT_SOURCE_SITE;
    document.getElementById("source-site").value = currentSourceSite;

    const topEnabled = config.top_services_enabled === true;
    document.getElementById("top-enabled").checked = topEnabled;
    document.getElementById("top-count").value = config.top_services_count || 5;
    document.getElementById("top-threshold").value = config.top_services_threshold || DEFAULT_TOP_SERVICES_THRESHOLD;
    document.getElementById("top-count-group").style.display = topEnabled ? "grid" : "none";

    currentServices = (config.services || []).map(service => ({
      ...service,
      threshold: parseInt(service.threshold) || DEFAULT_THRESHOLD
    }));
    renderServiceEditor();
  } finally {
    isLoadingConfig = false;
    clearDirty();
  }
}

function renderServiceEditor() {
  const container = document.getElementById("services-editor");
  container.innerHTML = currentServices.map((svc, i) => `
    <div class="svc-edit-row" data-index="${i}">
      <input type="text" class="e-name" value="${escapeAttr(svc.name)}" placeholder="Nome">
      <input type="text" class="e-slug" value="${escapeAttr(svc.slug)}" placeholder="slug">
      <input type="number" class="e-threshold" value="${svc.threshold ?? DEFAULT_THRESHOLD}" placeholder="${DEFAULT_THRESHOLD}">
      <button class="btn-remove" type="button" data-remove="${i}" aria-label="Remover ${escapeAttr(svc.name)}" title="Remover"></button>
    </div>`).join("");

  container.querySelectorAll("[data-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      currentServices.splice(parseInt(btn.dataset.remove), 1);
      renderServiceEditor();
      markDirty();
    });
  });

  container.querySelectorAll(".svc-edit-row").forEach(row => {
    const i = parseInt(row.dataset.index);
    row.querySelector(".e-name").addEventListener("input", e => currentServices[i].name = e.target.value);
    row.querySelector(".e-slug").addEventListener("input", e => currentServices[i].slug = e.target.value.trim().toLowerCase());
    row.querySelector(".e-threshold").addEventListener("input", e => currentServices[i].threshold = parseInt(e.target.value) || DEFAULT_THRESHOLD);
  });
}

document.getElementById("btn-add").addEventListener("click", () => {
  const name = document.getElementById("new-name").value.trim();
  const slug = document.getElementById("new-slug").value.trim().toLowerCase();
  const threshold = parseInt(document.getElementById("new-threshold").value) || DEFAULT_THRESHOLD;
  if (!name || !slug) return;
  currentServices.push({ name, slug, threshold });
  renderServiceEditor();
  document.getElementById("new-name").value = "";
  document.getElementById("new-slug").value = "";
  document.getElementById("new-threshold").value = String(DEFAULT_THRESHOLD);
  markDirty();
});

// Marca config como "alterações não salvas" em qualquer input/change dentro da
// aba Configurar (exceto nos campos do "Adicionar serviço" — só viram dirty
// quando o user clica em Add, tratado acima).
(() => {
  const panel = document.getElementById("panel-config");
  if (!panel) return;
  const onMaybeDirty = (e) => {
    if (e.target?.id?.startsWith("new-")) return;
    markDirty();
  };
  panel.addEventListener("input", onMaybeDirty);
  panel.addEventListener("change", onMaybeDirty);
})();

// Um serviço rejeitado some da lista ao recarregar. Sem este aviso o usuário
// veria "Salvo!" e a linha desaparecida, sem saber o motivo.
function showRejectedServices(rejected) {
  const box = document.getElementById("save-warning");
  if (!box) return;

  if (!Array.isArray(rejected) || rejected.length === 0) {
    box.hidden = true;
    box.textContent = "";
    return;
  }

  const lines = rejected.map(item => `${item.label}: ${item.reason}`).join(" · ");
  box.textContent = `Não foi salvo ${rejected.length === 1 ? "1 serviço" : `${rejected.length} serviços`}. ${lines}`;
  box.hidden = false;
}

document.getElementById("btn-save").addEventListener("click", async () => {
  const btn = document.getElementById("btn-save");
  const config = {
    interval_minutes: parseInt(document.getElementById("interval").value) || DEFAULT_INTERVAL_MINUTES,
    source_site: document.getElementById("source-site").value || DEFAULT_SOURCE_SITE,
    top_services_enabled: document.getElementById("top-enabled").checked,
    top_services_count: parseInt(document.getElementById("top-count").value) || 5,
    top_services_threshold: parseInt(document.getElementById("top-threshold").value) || DEFAULT_TOP_SERVICES_THRESHOLD,
    services: currentServices.filter(s => s.slug)
  };
  btn.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config });
    if (!result?.ok) throw new Error(result?.error || "Não foi possível salvar.");

    // Exibe exatamente a configuração já validada, para que endereço inválido
    // ou repetido não fique aparentando que foi aceito.
    await loadConfig();
    clearDirty();
    showRejectedServices(result.rejectedServices);
    btn.innerHTML = `${SVG_ICONS.check}Salvo!`;
    setTimeout(() => btn.textContent = "Salvar configurações", 1500);
  } catch (error) {
    console.warn("Falha ao salvar configuração", error);
    btn.innerHTML = `${SVG_ICONS.warning}Falha ao salvar`;
    setTimeout(() => btn.textContent = "Salvar configurações", 1800);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("top-enabled").addEventListener("change", e => {
  document.getElementById("top-count-group").style.display = e.target.checked ? "grid" : "none";
});


// ── Info Toggle (caixa "Sobre o monitoramento" colapsável) ──────────────────
(() => {
  const toggle = document.getElementById("info-toggle");
  const content = document.getElementById("info-content");
  if (!toggle || !content) return;

  // Restaura estado salvo (default: colapsado)
  chrome.storage.local.get("infoExpanded").then(({ infoExpanded }) => {
    if (infoExpanded === true) {
      toggle.setAttribute("aria-expanded", "true");
      content.hidden = false;
    }
  });

  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    content.hidden = expanded;
    chrome.storage.local.set({ infoExpanded: !expanded });
  });
})();

// ── Toggle Monitoring ────────────────────────────────────────────────────────
function applyToggleState(enabled) {
  const btn = document.getElementById("btn-toggle-monitoring");
  const label = document.getElementById("toggle-label");
  if (!btn || !label) return;
  if (enabled) {
    btn.className = "enabled";
    label.textContent = "ON";
  } else {
    btn.className = "disabled";
    label.textContent = "OFF";
  }
}

document.getElementById("btn-toggle-monitoring")?.addEventListener("click", async () => {
  const btn = document.getElementById("btn-toggle-monitoring");
  const isCurrentlyEnabled = btn.className === "enabled";
  const newState = !isCurrentlyEnabled;
  
  applyToggleState(newState);
  const result = await chrome.runtime.sendMessage({ type: "TOGGLE_MONITORING", enabled: newState });
  if (!result?.ok) {
    applyToggleState(!newState);
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  const [progress, local] = await Promise.all([
    chrome.storage.session.get(["isChecking", "statusText", "checkCompleted", "checkTotal"]),
    chrome.storage.local.get("monitoringEnabled")
  ]);

  applyToggleState(local.monitoringEnabled !== false);
  applyProgressUi(progress);

  refreshStatus().catch(() => {
    document.getElementById("status-list").innerHTML =
      '<div class="empty">Falha ao carregar os dados.<br>Clique em ↺ Checar para tentar novamente.</div>';
  });
  loadConfig();
  renderLogs();
}

boot();
