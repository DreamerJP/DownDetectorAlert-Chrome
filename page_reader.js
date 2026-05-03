(() => {
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
            continue;
          }

          if (nextKnown >= filled.length && lastKnown !== -1) {
            filled[index] = filled[lastKnown];
            continue;
          }

          if (lastKnown !== -1 && nextKnown < filled.length) {
            const ratio = (index - lastKnown) / (nextKnown - lastKnown);
            filled[index] = filled[lastKnown] + ((filled[nextKnown] - filled[lastKnown]) * ratio);
          }
        }

        return filled.map(value => Number.isFinite(value) ? value : null);
      };

      const extractPeriodLabel = () => {
        const candidates = [
          ...Array.from(document.querySelectorAll("[aria-label]")).map(element => element.getAttribute("aria-label") || ""),
          ...Array.from(document.querySelectorAll("h1, h2, h3")).map(element => element.textContent || ""),
          document.title || ""
        ];

        for (const candidate of candidates) {
          const match = String(candidate).match(/(?:últimas?|ultimas?|last|past)\s+(\d+)\s*(?:horas?|hours?)/i);
          if (match) {
            return `${match[1]}h`;
          }
        }

        return "24h";
      };

      const extractSvgChart = peakValue => {
        const svgCandidates = Array.from(document.querySelectorAll("svg"))
          .map(svg => {
            const viewBox = svg.viewBox?.baseVal;
            const bounds = svg.getBoundingClientRect();
            const width = Number.isFinite(viewBox?.width) && viewBox.width > 0 ? viewBox.width : bounds.width;
            const height = Number.isFinite(viewBox?.height) && viewBox.height > 0 ? viewBox.height : bounds.height;
            return { svg, width, height };
          })
          .filter(candidate => candidate.width >= 300 && candidate.height >= 120);

        let best = null;

        for (const candidate of svgCandidates) {
          const plotRect = Array.from(candidate.svg.querySelectorAll("rect"))
            .map(rect => ({
              x: parseFloat(rect.getAttribute("x") || "0"),
              y: parseFloat(rect.getAttribute("y") || "0"),
              width: parseFloat(rect.getAttribute("width") || "0"),
              height: parseFloat(rect.getAttribute("height") || "0")
            }))
            .filter(rect => rect.width >= candidate.width * 0.45 && rect.height >= candidate.height * 0.4)
            .sort((left, right) => (right.width * right.height) - (left.width * left.height))[0] || null;

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
              if (hasFill && !hasStroke) score -= 160;
              if (isDashed) score -= 180;

              if (plotRect) {
                const withinPlot =
                  bbox.x >= plotRect.x - 20 &&
                  bbox.y >= plotRect.y - 30 &&
                  (bbox.x + bbox.width) <= (plotRect.x + plotRect.width + 20) &&
                  (bbox.y + bbox.height) <= (plotRect.y + plotRect.height + 30);
                if (withinPlot) score += 80;
              }

              if (!best || score > best.score) {
                best = {
                  ...candidate,
                  path,
                  bbox,
                  plotRect,
                  score
                };
              }
            } catch (_error) {}
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
              const bbox = node.getBBox();
              if (!Number.isFinite(x)) x = bbox.x + (bbox.width / 2);
              if (!Number.isFinite(y)) y = bbox.y + (bbox.height / 2);
              return { text, x, y };
            } catch (_error) {
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

        const yAxisMax = Math.max(...yAxisLabels, Number.isFinite(peakValue) ? peakValue : 0, 100);

        const buildSeriesFromPath = path => {
          const pathLength = path.getTotalLength();
          const sampleBuckets = new Array(96).fill(null);
          const samples = 720;

          for (let index = 0; index <= samples; index += 1) {
            const point = path.getPointAtLength((pathLength * index) / samples);
            const normalizedX = clamp((point.x - plotLeft) / Math.max(plotWidth, 1), 0, 1);
            const bucketIndex = clamp(Math.round(normalizedX * (sampleBuckets.length - 1)), 0, sampleBuckets.length - 1);

            if (!Number.isFinite(sampleBuckets[bucketIndex]) || point.y < sampleBuckets[bucketIndex]) {
              sampleBuckets[bucketIndex] = point.y;
            }
          }

          const yValues = interpolateBuckets(sampleBuckets);
          if (yValues.filter(Number.isFinite).length < 24) return [];

          return yValues.map(value => {
            if (!Number.isFinite(value)) return null;
            const relative = clamp((plotTop + plotHeight - value) / Math.max(plotHeight, 1), 0, 1);
            return Math.max(0, Math.round(relative * yAxisMax));
          });
        };

        const baselinePath = Array.from(best.svg.querySelectorAll("path"))
          .filter(path => {
            try {
              if (path === best.path) return false;

              const bbox = path.getBBox();
              const style = getComputedStyle(path);
              const dashArray = path.getAttribute("stroke-dasharray") || style.strokeDasharray;
              const stroke = path.getAttribute("stroke") || style.stroke;
              const fill = path.getAttribute("fill") || style.fill;

              return Boolean(dashArray && dashArray !== "none" && dashArray !== "0px") &&
                isVisibleColor(stroke) &&
                !isVisibleColor(fill) &&
                Number.isFinite(bbox.width) &&
                bbox.width >= plotWidth * 0.35;
            } catch (_error) {
              return false;
            }
          })
          .sort((left, right) => {
            try {
              return right.getBBox().width - left.getBBox().width;
            } catch (_error) {
              return 0;
            }
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
          .sort((left, right) => left.x - right.x)
          .map(item => item.text)
          .filter((label, index, array) => array.indexOf(label) === index);

        return {
          history: values.map((value, index) => {
            const point = {
              value,
              timestamp: new Date(now - ((values.length - 1 - index) * interval)).toISOString()
            };

            const baseline = baselineValues[index];
            if (Number.isFinite(baseline)) {
              point.baseline = baseline;
            }

            return point;
          }),
          tickLabels,
          yAxisMax,
          periodLabel: extractPeriodLabel()
        };
      };

      const bodyText = document.body?.innerText || "";
      const hasCloudflareElements = Boolean(
        document.getElementById("challenge-stage") ||
        document.getElementById("cf-please-wait") ||
        document.querySelector(".cf-turnstile") ||
        document.getElementById("cf-spin") ||
        document.getElementById("cf-wrapper")
      );

      const cloudflareBlocked = hasCloudflareElements || [
        "Um momento...",
        "Verify you are human",
        "Checking your browser",
        "Executando verificação de segurança"
      ].some(text => bodyText.includes(text));

      const resourceUrls = performance.getEntriesByType("resource")
        .map(entry => entry.name)
        .filter(Boolean);

      let reportUrl = resourceUrls.find(url =>
        /^https:\/\/data-api\.downdetector\.com\/v1\/companies\/\d+\/report\?/i.test(url)
      ) || null;

      if (!reportUrl) {
        for (const script of document.scripts) {
          const text = script.textContent || "";
          const match = text.match(/https:\/\/data-api\.downdetector\.com\/v1\/companies\/\d+\/report\?[^"'`\s)]+/i);
          if (match) {
            reportUrl = match[0].replace(/\\u0026/g, "&");
            break;
          }
        }
      }

      let peak = null;
      for (const element of document.querySelectorAll("[aria-label]")) {
        const label = element.getAttribute("aria-label") || "";
        const match = label.match(/(?:pico de|peak of)\s+([\d.,]+)/i);
        if (match) {
          const numeric = parseInt(match[1].replace(/[^\d]/g, ""), 10);
          if (Number.isFinite(numeric)) {
            peak = Math.max(peak ?? 0, numeric);
          }
        }
      }

      if (!Number.isFinite(peak)) {
        const peakMatch = bodyText.match(/(?:pico de|peak of)\s+([\d.,]+)\s+(?:reportes|reports)/i);
        if (peakMatch) {
          const numeric = parseInt(peakMatch[1].replace(/[^\d]/g, ""), 10);
          if (Number.isFinite(numeric)) peak = numeric;
        }
      }

      const capture = window.__DDMONITOR_CAPTURE__?.lastReport || null;
      const capturedUrl = capture?.url || null;
      if (!reportUrl && capturedUrl) reportUrl = capturedUrl;
      const svgChart = extractSvgChart(peak);

      const extractTrendingServices = () => {
        const services = [];
        // Seleciona os cards de serviços que geralmente estão no grid da home
        const items = document.querySelectorAll("a[href*='/status/'], a[href*='/fora-do-ar/']");

        for (const item of items) {
          const href = item.getAttribute("href");
          const slugMatch = href.match(/\/(?:status|fora-do-ar)\/([^/]+)\/?$/);
          if (!slugMatch) continue;

          const slug = slugMatch[1];
          if (slug === "fora-do-ar" || slug === "status") continue;
          if (services.find(s => s.slug === slug)) continue;

          // Tenta pegar o nome da empresa
          const nameElement = item.querySelector(".company-name, .name, h3, h4, strong") || item;
          let name = nameElement.textContent.trim().split("\n")[0].trim();
          if (name.length > 30) name = name.substring(0, 27) + "...";

          // Busca por indicadores de problemas em qualquer lugar dentro do card
          const childrenLabels = Array.from(item.querySelectorAll("[aria-label]")).map(el => el.getAttribute("aria-label")).join(" ");
          const cardText = item.innerText + " " + childrenLabels;
          
          const isNegative = /nenhum problema|sem problema|no problem|não mostram problemas/i.test(cardText);
          const hasProblemText = /problema|problem|outage|falha|instabilidade|down/i.test(cardText);

          const hasProblem = (!isNegative && hasProblemText) ||
                             item.querySelector(".indicator-problem, .indicator-outage, .problem, .danger, .status-red, .status-yellow, .status-warning") !== null;

          services.push({ name, slug, hasProblem });
          if (services.length >= 20) break; // Limite de busca
        }
        return services;
      };

      const isHomePage = window.location.pathname === "/" || window.location.pathname === "/index.html";

      return {
        isHomePage,
        trendingServices: isHomePage ? extractTrendingServices() : [],
        cloudflareBlocked,
        reportUrl,
        reportPayload: capture?.payload ?? null,
        peak: Number.isFinite(peak) ? peak : null,
        svgHistory: Array.isArray(svgChart?.history) ? svgChart.history : [],
        tickLabels: Array.isArray(svgChart?.tickLabels) ? svgChart.tickLabels : [],
        periodLabel: svgChart?.periodLabel || extractPeriodLabel(),
        yAxisMax: Number.isFinite(svgChart?.yAxisMax) ? svgChart.yAxisMax : null
      };
})();
