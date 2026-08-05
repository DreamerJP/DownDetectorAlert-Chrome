// Script injetado em páginas do Downdetector via chrome.scripting.executeScript
// (MAIN world). Lê tudo que o background.js precisa: histórico (em 3 fontes,
// em ordem de preferência), pico declarado, ícones, lista de trending na home,
// e flags de Cloudflare.
//
// Fontes de histórico, da mais precisa pra menos:
//   1. reactChartData    — array exato no estado React do componente
//   2. reportPayload     — JSON da API capturado por capture.js (fetch/XHR)
//   3. svgHistory        — reconstruído amostrando o path SVG (fallback)

(() => {
  // ============================================================
  // Helpers genéricos
  // ============================================================
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const isVisibleColor = value => {
    if (!value) return false;
    const normalized = String(value).trim().toLowerCase();
    return normalized !== "none" &&
      normalized !== "transparent" &&
      normalized !== "rgba(0, 0, 0, 0)" &&
      normalized !== "rgba(0,0,0,0)";
  };

  const interpolateBuckets = buckets => {
    const filled = [...buckets];
    let lastKnown = -1;
    for (let index = 0; index < filled.length; index += 1) {
      if (Number.isFinite(filled[index])) {
        lastKnown = index;
        continue;
      }

      let nextKnown = index + 1;
      while (nextKnown < filled.length && !Number.isFinite(filled[nextKnown])) {
        nextKnown += 1;
      }

      if (lastKnown === -1 && nextKnown < filled.length) {
        filled[index] = filled[nextKnown];
      } else if (nextKnown >= filled.length && lastKnown !== -1) {
        filled[index] = filled[lastKnown];
      } else if (lastKnown !== -1 && nextKnown < filled.length) {
        const ratio = (index - lastKnown) / (nextKnown - lastKnown);
        filled[index] = filled[lastKnown] + ((filled[nextKnown] - filled[lastKnown]) * ratio);
      }
    }
    return filled.map(value => Number.isFinite(value) ? value : null);
  };

  // ============================================================
  // Contexto da página
  // ============================================================
  const isHomePage = location.pathname === "/" || location.pathname === "/index.html";

  const detectCloudflareBlock = () => {
    const hasElements = Boolean(
      document.getElementById("challenge-stage") ||
      document.getElementById("cf-please-wait") ||
      document.querySelector(".cf-turnstile") ||
      document.getElementById("cf-spin") ||
      document.getElementById("cf-wrapper")
    );
    if (hasElements) return true;
    const bodyText = document.body?.innerText || "";
    return ["Um momento...", "Verify you are human", "Checking your browser", "Executando verificação de segurança"]
      .some(t => bodyText.includes(t));
  };

  const extractPeriodLabel = () => {
    const candidates = [
      ...Array.from(document.querySelectorAll("[aria-label]")).map(el => el.getAttribute("aria-label") || ""),
      ...Array.from(document.querySelectorAll("h1, h2, h3")).map(el => el.textContent || ""),
      document.title || ""
    ];
    for (const c of candidates) {
      const m = String(c).match(/(?:últimas?|ultimas?|last|past)\s+(\d+)\s*(?:horas?|hours?)/i);
      if (m) return `${m[1]}h`;
    }
    return "24h";
  };

  // ============================================================
  // Pico declarado pela página (aria-label / tooltip estático)
  // — fonte autoritativa, usada para calibrar o eixo Y do SVG.
  // ============================================================
  const detectDeclaredPeak = () => {
    // Aria-label do gráfico: "...com um pico de N reportes..."
    for (const el of document.querySelectorAll("[aria-label]")) {
      const label = el.getAttribute("aria-label") || "";
      const m = label.match(/(?:pico de|peak of)\s+([\d.,]+)/i);
      if (m) {
        const n = parseInt(m[1].replace(/[^\d]/g, ""), 10);
        if (Number.isFinite(n)) return n;
      }
    }

    // Tooltip estático do Recharts (fallback)
    const tooltip = document.querySelector(".recharts-tooltip-item-value, .recharts-default-tooltip");
    if (tooltip) {
      const m = (tooltip.innerText || "").match(/(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n)) return n;
      }
    }

    // Texto bruto na página (último fallback)
    const bodyText = document.body?.innerText || "";
    const m = bodyText.match(/(?:pico de|peak of)\s+([\d.,]+)\s+(?:reportes|reports)/i);
    if (m) {
      const n = parseInt(m[1].replace(/[^\d]/g, ""), 10);
      if (Number.isFinite(n)) return n;
    }

    return null;
  };

  // ============================================================
  // Override de animações do Recharts
  // — necessário para o SVG estabilizar a tempo da extração.
  // ============================================================
  const ANIM_STYLE_ID = "__ddm_no_anim";

  const disableRechartsAnimations = () => {
    // Este script é reinjetado a cada segundo enquanto a página carrega; sem a
    // checagem de id acumulávamos dezenas de <style> idênticos por página.
    if (document.getElementById(ANIM_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = ANIM_STYLE_ID;
    style.textContent = `
      .recharts-curve, .recharts-area-area, .recharts-rectangle, .recharts-bar-rectangle, .recharts-area {
        transition: none !important;
        animation: none !important;
        animation-duration: 0s !important;
        transition-duration: 0s !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  };

  // ============================================================
  // Fonte #1: React fiber → prop `chartData`
  // Array<{ timestamp, value, baseline }> — exato.
  // ============================================================
  const extractReactChartData = () => {
    const roots = [
      document.querySelector('[data-testid="card-company-status"]'),
      document.querySelector('[data-testid="card"]'),
      document.querySelector("main"),
      document.body
    ].filter(Boolean);

    for (const el of roots) {
      const fiberKey = Object.keys(el).find(k =>
        k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance")
      );
      if (!fiberKey) continue;

      const visited = new WeakSet();
      const search = (node, depth) => {
        if (!node || depth > 200) return null;
        if (typeof node === "object") {
          if (visited.has(node)) return null;
          visited.add(node);
        }
        try {
          const props = node.memoizedProps || node.pendingProps;
          if (props && typeof props === "object" && !Array.isArray(props)) {
            const cd = props.chartData;
            if (Array.isArray(cd) && cd.length >= 12 && cd[0] && Number.isFinite(cd[0].value)) {
              return cd;
            }
          }
        } catch (_e) {}
        try {
          if (node.child) {
            const found = search(node.child, depth + 1);
            if (found) return found;
          }
          if (node.sibling) {
            const found = search(node.sibling, depth + 1);
            if (found) return found;
          }
        } catch (_e) {}
        return null;
      };

      const found = search(el[fiberKey], 0);
      if (found) return found;
    }
    return null;
  };

  // ============================================================
  // Fonte #2: URL e payload da API (data-api.downdetector.com)
  // — capturados por capture.js quando a página chama fetch/XHR.
  // ============================================================
  const findReportApiUrl = () => {
    const apiPattern = /^https:\/\/data-api\.downdetector\.com\/v1\/companies\/\d+\/report\?/i;

    const fromResources = performance.getEntriesByType("resource")
      .map(e => e.name)
      .find(url => apiPattern.test(url));
    if (fromResources) return fromResources;

    for (const script of document.scripts) {
      const m = (script.textContent || "")
        .match(/https:\/\/data-api\.downdetector\.com\/v1\/companies\/\d+\/report\?[^"'`\s)]+/i);
      if (m) return m[0].replace(/\\u0026/g, "&");
    }
    return null;
  };

  // ============================================================
  // Fonte #3: Reconstrução do SVG (fallback, aproximado)
  // ============================================================
  const extractSvgChart = peakValue => {
    const svgCandidates = Array.from(document.querySelectorAll("svg"))
      .map(svg => {
        const vb = svg.viewBox?.baseVal;
        const r = svg.getBoundingClientRect();
        const width = Number.isFinite(vb?.width) && vb.width > 0 ? vb.width : r.width;
        const height = Number.isFinite(vb?.height) && vb.height > 0 ? vb.height : r.height;
        return { svg, width, height };
      })
      .filter(c => c.width >= 300 && c.height >= 120);

    let best = null;
    for (const candidate of svgCandidates) {
      const plotRect = Array.from(candidate.svg.querySelectorAll("rect"))
        .map(rect => ({
          x: parseFloat(rect.getAttribute("x") || "0"),
          y: parseFloat(rect.getAttribute("y") || "0"),
          width: parseFloat(rect.getAttribute("width") || "0"),
          height: parseFloat(rect.getAttribute("height") || "0")
        }))
        .filter(r => r.width >= candidate.width * 0.45 && r.height >= candidate.height * 0.4)
        .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0] || null;

      for (const path of candidate.svg.querySelectorAll("path")) {
        try {
          const bbox = path.getBBox();
          const length = path.getTotalLength();
          const style = getComputedStyle(path);
          const stroke = path.getAttribute("stroke") || style.stroke;
          const fill = path.getAttribute("fill") || style.fill;
          const dashArray = path.getAttribute("stroke-dasharray") || style.strokeDasharray;
          const hasStroke = isVisibleColor(stroke);
          const hasFill = isVisibleColor(fill);
          const isDashed = Boolean(dashArray && dashArray !== "none" && dashArray !== "0px");

          if (!Number.isFinite(length) || length < candidate.width * 0.4) continue;
          if (!Number.isFinite(bbox.width) || bbox.width < candidate.width * 0.35) continue;
          if (!Number.isFinite(bbox.height)) continue;
          if (bbox.height < 8 && isDashed) continue;

          let score = (bbox.width * 2) + length + (bbox.height * 4);
          if (hasStroke) score += 500;
          if (!hasFill) score += 120;
          // Path com fill e sem stroke costuma ser a ÁREA (preenchimento abaixo
          // da linha). O path da área é mais comprido — penalidade forte garante
          // que a linha (stroke + !fill) sempre vença quando ambas existem.
          if (hasFill && !hasStroke) score -= 800;
          if (isDashed) score -= 180;

          if (plotRect) {
            const within =
              bbox.x >= plotRect.x - 20 &&
              bbox.y >= plotRect.y - 30 &&
              (bbox.x + bbox.width) <= (plotRect.x + plotRect.width + 20) &&
              (bbox.y + bbox.height) <= (plotRect.y + plotRect.height + 30);
            if (within) score += 80;
          }

          if (!best || score > best.score) {
            best = { ...candidate, path, bbox, plotRect, score };
          }
        } catch (_e) {}
      }
    }
    if (!best) return null;

    const plotLeft = best.plotRect?.x ?? best.bbox.x;
    const plotTop = best.plotRect?.y ?? Math.max(0, best.bbox.y - 4);
    const plotWidth = best.plotRect?.width ?? best.bbox.width;
    const plotHeight = best.plotRect?.height ?? Math.max(best.bbox.height, best.height - plotTop);

    const textItems = Array.from(best.svg.querySelectorAll("text"))
      .map(node => {
        const text = (node.textContent || "").trim();
        if (!text) return null;
        let x = parseFloat(node.getAttribute("x") || "NaN");
        let y = parseFloat(node.getAttribute("y") || "NaN");
        try {
          const bb = node.getBBox();
          if (!Number.isFinite(x)) x = bb.x + (bb.width / 2);
          if (!Number.isFinite(y)) y = bb.y + (bb.height / 2);
          return { text, x, y };
        } catch (_e) {
          if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
          return { text, x, y };
        }
      })
      .filter(Boolean);

    const yAxisLabels = textItems
      .filter(item =>
        /^-?\d+(?:[.,]\d+)?$/.test(item.text) &&
        item.x <= plotLeft + 28 &&
        item.y >= plotTop - 12 &&
        item.y <= plotTop + plotHeight + 12
      )
      .map(item => Number(item.text.replace(",", ".")))
      .filter(Number.isFinite);

    // Quando há labels reais no eixo Y (ex: 0,10,20,30,40), usamos o maior como
    // autoridade. Se o pico declarado excede o eixo (raro), o pico vira o teto.
    let yAxisMax;
    if (yAxisLabels.length >= 2) {
      yAxisMax = Math.max(...yAxisLabels);
      if (Number.isFinite(peakValue) && peakValue > yAxisMax) yAxisMax = peakValue;
    } else if (Number.isFinite(peakValue) && peakValue > 0) {
      yAxisMax = peakValue;
    } else {
      yAxisMax = 100;
    }

    const buildSeriesFromPath = path => {
      const pathLength = path.getTotalLength();
      const buckets = new Array(96).fill(null);
      const samples = 720;
      for (let i = 0; i <= samples; i += 1) {
        const pt = path.getPointAtLength((pathLength * i) / samples);
        const nx = clamp((pt.x - plotLeft) / Math.max(plotWidth, 1), 0, 1);
        const bi = clamp(Math.round(nx * (buckets.length - 1)), 0, buckets.length - 1);
        if (!Number.isFinite(buckets[bi]) || pt.y < buckets[bi]) buckets[bi] = pt.y;
      }
      const yVals = interpolateBuckets(buckets);
      if (yVals.filter(Number.isFinite).length < 24) return [];
      return yVals.map(v => {
        if (!Number.isFinite(v)) return null;
        const rel = clamp((plotTop + plotHeight - v) / Math.max(plotHeight, 1), 0, 1);
        return Math.max(0, Math.round(rel * yAxisMax));
      });
    };

    const baselinePath = Array.from(best.svg.querySelectorAll("path"))
      .filter(p => {
        try {
          if (p === best.path) return false;
          const bb = p.getBBox();
          const cs = getComputedStyle(p);
          const dash = p.getAttribute("stroke-dasharray") || cs.strokeDasharray;
          const stroke = p.getAttribute("stroke") || cs.stroke;
          const fill = p.getAttribute("fill") || cs.fill;
          return Boolean(dash && dash !== "none" && dash !== "0px") &&
            isVisibleColor(stroke) && !isVisibleColor(fill) &&
            Number.isFinite(bb.width) && bb.width >= plotWidth * 0.35;
        } catch (_e) { return false; }
      })
      .sort((a, b) => {
        try { return b.getBBox().width - a.getBBox().width; }
        catch (_e) { return 0; }
      })[0] || null;

    const values = buildSeriesFromPath(best.path);
    if (values.length < 24) return null;

    const baselineValues = baselinePath ? buildSeriesFromPath(baselinePath) : [];
    const now = Date.now();
    const interval = (24 * 60 * 60 * 1000) / Math.max(values.length - 1, 1);

    const tickLabels = textItems
      .filter(item =>
        /^(?:\d{1,2}(?::\d{2})?\s?(?:AM|PM)|\d{1,2}:\d{2})$/i.test(item.text) &&
        item.x >= plotLeft - 8 &&
        item.x <= plotLeft + plotWidth + 8 &&
        item.y >= plotTop + plotHeight - 18
      )
      .sort((a, b) => a.x - b.x)
      .map(item => item.text)
      .filter((label, i, arr) => arr.indexOf(label) === i);

    return {
      history: values.map((value, i) => {
        const point = {
          value,
          timestamp: new Date(now - ((values.length - 1 - i) * interval)).toISOString()
        };
        const baseline = baselineValues[i];
        if (Number.isFinite(baseline)) point.baseline = baseline;
        return point;
      }),
      tickLabels,
      yAxisMax,
      periodLabel: extractPeriodLabel()
    };
  };

  // Calibra a história do SVG quando temos o pico declarado.
  // Evita amplificar ruído puro (ex: pico 1500 vs SVG max 3 → fator 500x).
  const calibrateSvgWithPeak = (svgChart, declaredPeak) => {
    if (declaredPeak === null || !svgChart?.history?.length) return;
    const max = Math.max(...svgChart.history.map(p => p.value).filter(Number.isFinite), 0);
    if (max < declaredPeak * 0.05) return;
    const factor = declaredPeak / max;
    svgChart.history.forEach(p => {
      if (Number.isFinite(p.value)) p.value = Math.round(p.value * factor);
    });
  };

  // ============================================================
  // Logos / favicons
  // ============================================================

  // Logos vêm via Cloudflare image resizing
  // (ex: cdn3.../cdn-cgi/image/width=750/cdn2.../static/uploads/logo/<hash>.png).
  // Trocamos por width=64 — suficiente para o ícone 18x18 do popup, retina-ready.
  const downsizeLogoUrl = url => {
    if (!url || !url.startsWith("http")) return null;
    if (url.includes("/cdn-cgi/image/")) {
      return url.replace(/\/cdn-cgi\/image\/[^/]+/, "/cdn-cgi/image/width=64");
    }
    return url;
  };

  const extractTrendingIconUrl = item => {
    const img = item.querySelector("img");
    if (!img) return null;
    return downsizeLogoUrl(img.getAttribute("src") || img.src || null);
  };

  // Na página de detalhe, o logo principal tem "/static/uploads/logo/" no src e
  // fica dentro de um <a> que aponta pro domínio oficial. Preferimos favicon
  // (sempre quadrado) sobre o logo wide do Downdetector. Devolvemos uma lista
  // em ordem de preferência para o popup tentar uma a uma.
  //
  // Nota: os dois serviços de favicon abaixo são terceiros, então cada abertura
  // do popup revela a eles quais serviços são monitorados. Decisão consciente —
  // a alternativa (só o logo do Downdetector) piora bastante o visual, porque
  // muitos logos são escritos e não cabem bem num ícone pequeno.
  const extractServiceIconUrls = () => {
    let officialDomain = null;
    let fallbackLogo = null;

    for (const img of document.querySelectorAll("img")) {
      const src = img.getAttribute("src") || img.src || "";
      const srcset = img.getAttribute("srcset") || "";
      const hasLogo = src.includes("/static/uploads/logo/") || srcset.includes("/static/uploads/logo/");
      if (!hasLogo) continue;

      if (!fallbackLogo) {
        if (src.includes("/static/uploads/logo/")) {
          fallbackLogo = downsizeLogoUrl(src);
        } else {
          const m = srcset.match(/(https?:\/\/\S+)/);
          if (m) fallbackLogo = downsizeLogoUrl(m[1]);
        }
      }

      if (!officialDomain) {
        const anchor = img.closest("a[href^='http']");
        if (anchor) {
          try {
            const linkUrl = new URL(anchor.getAttribute("href") || "");
            if (linkUrl.hostname && !linkUrl.hostname.includes("downdetector.")) {
              // Remove "www." — favicon services indexam pelo domínio raiz.
              officialDomain = linkUrl.hostname.replace(/^www\./i, "");
            }
          } catch (_e) {}
        }
      }
      if (officialDomain && fallbackLogo) break;
    }

    const urls = [];
    if (officialDomain) {
      // DuckDuckGo retorna 404 quando não tem (deixa onerror disparar no popup).
      urls.push(`https://icons.duckduckgo.com/ip3/${officialDomain}.ico`);
      // Google tem ampla cobertura, mas pode servir placeholder genérico (200 OK).
      urls.push(`https://www.google.com/s2/favicons?domain=${officialDomain}&sz=64`);
    }
    if (fallbackLogo) urls.push(fallbackLogo);
    return urls;
  };

  // ============================================================
  // Lista de serviços em alta (home)
  // ============================================================

  // Slug → nome legível, usado como fallback quando o aria-label não vier
  // (ex: "disney-plus" → "Disney Plus").
  const humanizeSlug = slug => decodeURIComponent(String(slug || ""))
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());

  // Na home cada card é um <a href="/fora-do-ar/<slug>/"> sem texto nem <img>
  // dentro: o nome do serviço fica no aria-label, no formato
  // "Página de status <Nome>" (.com.br) ou "Status page <Nome>" (.com).
  // Lemos o aria-label, tiramos esse prefixo e, na falta dele, caímos no slug.
  const resolveTrendingName = (item, slug) => {
    const name = (item.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^p[áa]gina de status\s+/i, "")
      .replace(/^status page\s+/i, "")
      .trim();
    return name || humanizeSlug(slug);
  };

  const extractTrendingServices = () => {
    const services = [];
    const items = document.querySelectorAll("a[href*='/status/'], a[href*='/fora-do-ar/']");

    for (const item of items) {
      const href = item.getAttribute("href");
      const slugMatch = href.match(/\/(?:status|fora-do-ar)\/([^/]+)\/?$/);
      if (!slugMatch) continue;

      const slug = slugMatch[1];
      if (slug === "fora-do-ar" || slug === "status") continue;
      if (services.find(s => s.slug === slug)) continue;

      let name = resolveTrendingName(item, slug);
      if (name.length > 30) name = name.substring(0, 27) + "...";

      // A posição na lista é o único critério — sem filtro por indicadores visuais.
      services.push({ name, slug, iconUrl: extractTrendingIconUrl(item) });
      if (services.length >= 20) break;
    }
    return services;
  };

  // ============================================================
  // Main: monta o objeto de retorno
  // ============================================================
  disableRechartsAnimations();

  // Marca a aba como worker da extensão. capture.js (content script, MAIN world)
  // lê esta marca no document_start para só then aplicar os patches de rede e de
  // visibilidade — sem isso ele mexeria também nas abas do Downdetector que o
  // próprio usuário abre. sessionStorage é por aba e por origem, então a marca
  // não vaza para outras abas.
  try { sessionStorage.setItem("__ddm_worker", "1"); } catch (_e) { }

  const cloudflareBlocked = detectCloudflareBlock();
  const capture = window.__DDMONITOR_CAPTURE__?.lastReport || null;

  if (isHomePage) {
    return {
      isHomePage: true,
      trendingServices: extractTrendingServices(),
      serviceIconUrls: [],
      reactChartData: null,
      cloudflareBlocked,
      reportUrl: null,
      reportPayload: null,
      peak: null,
      svgHistory: [],
      tickLabels: [],
      periodLabel: "24h",
      yAxisMax: null
    };
  }

  const reactChartData = extractReactChartData();
  const reportUrl = findReportApiUrl();
  const declaredPeak = detectDeclaredPeak();

  // extractSvgChart é de longe a parte mais cara deste script (centenas de
  // getPointAtLength por path candidato) e é a ÚLTIMA opção — atrás do React e
  // do payload da API. Como o script é reinjetado a cada segundo enquanto a
  // página carrega, rodá-la incondicionalmente era pagar a fonte mais cara
  // justamente nos casos em que ela nem seria usada.
  const REACT_MIN_POINTS = 50;
  const hasBetterSource =
    (Array.isArray(reactChartData) && reactChartData.length >= REACT_MIN_POINTS) ||
    Boolean(capture?.payload);

  const svgChart = hasBetterSource ? null : extractSvgChart(declaredPeak);
  if (svgChart) calibrateSvgWithPeak(svgChart, declaredPeak);

  return {
    isHomePage: false,
    trendingServices: [],
    serviceIconUrls: extractServiceIconUrls(),
    reactChartData,
    cloudflareBlocked,
    reportUrl: reportUrl || capture?.url || null,
    reportPayload: capture?.payload || null,
    peak: declaredPeak,
    svgHistory: svgChart?.history || [],
    tickLabels: svgChart?.tickLabels || [],
    periodLabel: svgChart?.periodLabel || extractPeriodLabel(),
    yAxisMax: svgChart?.yAxisMax ?? null
  };
})();
