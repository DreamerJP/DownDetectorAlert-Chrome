let chartGradientCounter = 0;

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}

function escapeAttr(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

    if (info.error) {
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

    const historyHtml = info.error
      ? `<div class="chart-empty">${escapeHtml(info.error)}</div>`
      : info.history && info.history.length > 0
        ? renderChart(info.history, info.threshold, {
          tickLabels: info.tickLabels,
          periodLabel: info.periodLabel
        })
        : '<div class="chart-empty">Sem histórico real disponível no momento.</div>';

    html += `
      <div class="svc-row">
        <div class="svc-header">
          <div class="dot ${dotCls}"></div>
          <div style="flex:1;min-width:0">
            <div class="svc-name">${escapeHtml(info.name)}</div>
            <div class="svc-detail">${escapeHtml(detail)}</div>
          </div>
          <div class="badge-row">
            ${info.isTrending ? `<div class="svc-badge badge-trending ${info.outage ? '' : 'badge-recovered'}" title="${info.outage ? 'Serviço identificado automaticamente pelo Downdetector' : 'Serviço normalizado, sairá da lista em breve'}">${info.outage ? 'Trending' : 'Recuperado'}</div>` : ''}
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

  if (lastCheck) {
    const d = new Date(lastCheck);
    document.getElementById("last-check").textContent =
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
}

function pad(n) { return String(n).padStart(2, "0"); }

async function refreshStatus() {
  const data = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  renderStatus(data.statusMap, data.lastCheck);
  if (document.getElementById("panel-logs").classList.contains("active")) {
    renderLogs();
  }
}

async function renderLogs() {
  try {
    const { logs = [] } = await chrome.storage.local.get("logs");
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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  // Show check progress in the header
  if (changes.isChecking || changes.checkCompleted || changes.checkTotal || changes.statusText) {
    chrome.storage.local.get(["isChecking", "checkCompleted", "checkTotal", "statusText"]).then(data => {
      const el = document.getElementById("last-check");
      const btn = document.getElementById("btn-refresh");
      const header = document.querySelector("header");
      
      if (data.isChecking) {
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
      } else {
        btn.style.display = "block";
        btn.disabled = false;
        btn.textContent = "↻";
        const spinner = document.getElementById("active-spinner");
        if (spinner) spinner.remove();
      }
    });
  }

  if (changes.logs) renderLogs();
  if (!changes.statusMap && !changes.lastCheck) return;

  const nextStatusMap = changes.statusMap ? changes.statusMap.newValue : latestStatusMap;
  const nextLastCheck = changes.lastCheck ? changes.lastCheck.newValue : latestLastCheck;
  renderStatus(nextStatusMap, nextLastCheck);
});

document.getElementById("btn-refresh").addEventListener("click", async () => {
  const btn = document.getElementById("btn-refresh");
  btn.textContent = "⏳";
  btn.disabled = true;
  const result = await chrome.runtime.sendMessage({ type: "FORCE_CHECK" });
  await refreshStatus();
  btn.textContent = result?.ok === false ? "⚠" : "↻";
  if (result?.ok === false) {
    setTimeout(() => {
      btn.textContent = "↻";
    }, 1500);
  }
  btn.disabled = false;
});

// ── Config ────────────────────────────────────────────────────────────────────
let currentServices = [];
let currentSourceSite = DEFAULT_SOURCE_SITE;

async function loadConfig() {
  const { config } = await chrome.storage.sync.get("config");
  if (!config) return;
  document.getElementById("interval").value = config.interval_minutes;
  currentSourceSite = config.source_site || DEFAULT_SOURCE_SITE;
  document.getElementById("source-site").value = currentSourceSite;
  
  const topEnabled = config.top_services_enabled === true;
  document.getElementById("top-enabled").checked = topEnabled;
  document.getElementById("top-count").value = config.top_services_count || 5;
  document.getElementById("top-threshold").value = config.top_services_threshold || DEFAULT_TOP_SERVICES_THRESHOLD;
  document.getElementById("top-count-group").style.display = topEnabled ? "flex" : "none";

  currentServices = (config.services || []).map(service => ({
    ...service,
    threshold: parseInt(service.threshold) || DEFAULT_THRESHOLD
  }));
  renderServiceEditor();
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
});

document.getElementById("btn-save").addEventListener("click", async () => {
  const btn = document.getElementById("btn-save");
  const config = {
    interval_minutes: parseInt(document.getElementById("interval").value) || 10,
    source_site: document.getElementById("source-site").value || DEFAULT_SOURCE_SITE,
    top_services_enabled: document.getElementById("top-enabled").checked,
    top_services_count: parseInt(document.getElementById("top-count").value) || 5,
    top_services_threshold: parseInt(document.getElementById("top-threshold").value) || DEFAULT_TOP_SERVICES_THRESHOLD,
    services: currentServices.filter(s => s.slug)
  };
  await chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config });
  btn.textContent = "✓ Salvo!";
  setTimeout(() => btn.textContent = "Salvar", 1500);
});

document.getElementById("top-enabled").addEventListener("change", e => {
  document.getElementById("top-count-group").style.display = e.target.checked ? "flex" : "none";
});


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
  const data = await chrome.storage.local.get(["isChecking", "statusText", "checkCompleted", "checkTotal", "monitoringEnabled"]);
  
  // Inicializa o toggle de monitoramento
  applyToggleState(data.monitoringEnabled !== false);
  const btn = document.getElementById("btn-refresh");
  const el = document.getElementById("last-check");
  const header = document.querySelector("header");
  
  if (data.isChecking) {
    btn.style.display = "none";
    if (!document.getElementById("active-spinner")) {
      const spinner = document.createElement("div");
      spinner.id = "active-spinner";
      spinner.className = "spinner";
      header.querySelector(".header-right").appendChild(spinner);
    }
    
    if (data.statusText) {
      el.textContent = data.statusText;
    } else if (Number.isFinite(data.checkCompleted) && Number.isFinite(data.checkTotal)) {
      el.textContent = `Verificando ${data.checkCompleted + 1}/${data.checkTotal}...`;
    }
  } else {
    btn.style.display = "block";
    btn.textContent = "↻";
    const spinner = document.getElementById("active-spinner");
    if (spinner) spinner.remove();
  }

  refreshStatus().catch(() => {
    document.getElementById("status-list").innerHTML =
      '<div class="empty">Falha ao carregar os dados.<br>Clique em ↺ Checar para tentar novamente.</div>';
  });
  loadConfig();
  renderLogs();
}

boot();
