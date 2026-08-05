// Busca a página do serviço direto do service worker e lê a série do HTML,
// sem abrir aba nenhuma. É o caminho primário; scrape.js (aba worker) ficou
// como reserva para quando isto falhar.
//
// Por que funciona: o Downdetector é Next.js e entrega o gráfico já no HTML,
// dentro do payload de hidratação. O fetch sai do próprio Chrome e leva os
// cookies do perfil (inclusive o cf_clearance), então o Cloudflare deixa passar
// — um fetch anônimo, de fora do navegador, leva 403.
//
// Formato dos pontos dentro do HTML (aspas escapadas pelo Next):
//   \"dataPoints\":[{\"__typename\":\"ChartDataPointType\",
//     \"timestampUtc\":\"2026-08-04T17:55:42+00:00\",
//     \"reportsValue\":8,\"baselineValue\":6}, ...]

const DIRECT_FETCH_TIMEOUT_MS = 12000;

// Todos os regexes aceitam a forma escapada (\") e a crua ("), porque o mesmo
// dado pode aparecer nos dois formatos dependendo de como o Next serializa.
const DATA_POINTS_OPEN_RE = /\\?"?dataPoints\\?"?\s*:\s*\\?\[/g;
const POINT_CHUNK_RE = /\{[^{}]*?reportsValue[^{}]*?\}/g;
const VALUE_RE = /\\?"?reportsValue\\?"?\s*:\s*(-?\d+)/;
const BASELINE_RE = /\\?"?baselineValue\\?"?\s*:\s*(-?\d+)/;
const TIMESTAMP_RE = /\\?"?timestampUtc\\?"?\s*:\s*\\?"([^"\\]+)/;

const CHALLENGE_RE = /cf-please-wait|challenge-stage|Just a moment|Um momento\.\.\.|Verify you are human/i;

// Isola os trechos entre "dataPoints":[ e o primeiro ] seguinte. Sem isso,
// uma página com mais de um gráfico misturaria as séries.
function extractDataPointBlocks(html) {
  const blocks = [];
  DATA_POINTS_OPEN_RE.lastIndex = 0;

  let match;
  while ((match = DATA_POINTS_OPEN_RE.exec(html)) !== null) {
    const start = match.index + match[0].length;
    const end = html.indexOf("]", start);
    if (end === -1) continue;
    blocks.push(html.slice(start, end));
  }
  return blocks;
}

function parsePointChunk(chunk) {
  const value = VALUE_RE.exec(chunk);
  if (!value) return null;

  const point = { value: Math.max(0, parseInt(value[1], 10)) };
  if (!Number.isFinite(point.value)) return null;

  const timestamp = TIMESTAMP_RE.exec(chunk);
  if (timestamp) {
    const parsed = new Date(timestamp[1]);
    if (!Number.isNaN(parsed.getTime())) point.timestamp = parsed.toISOString();
  }

  const baseline = BASELINE_RE.exec(chunk);
  if (baseline) {
    const parsedBaseline = parseInt(baseline[1], 10);
    if (Number.isFinite(parsedBaseline)) point.baseline = Math.max(0, parsedBaseline);
  }

  return point;
}

// Devolve a maior série encontrada no HTML, em ordem cronológica.
function parseChartHistory(html) {
  const blocks = extractDataPointBlocks(html);
  // Se o marcador dataPoints mudar de nome, ainda tentamos o HTML inteiro.
  if (!blocks.length) blocks.push(html);

  let best = [];
  for (const block of blocks) {
    const points = [];
    for (const chunk of block.match(POINT_CHUNK_RE) || []) {
      const point = parsePointChunk(chunk);
      if (point) points.push(point);
    }
    if (points.length > best.length) best = points;
  }

  if (best.length >= 2 && best.every(point => point.timestamp)) {
    best.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  return best.slice(-MAX_POINTS);
}

// O popup mostra o favicon do domínio oficial do serviço. No HTML cru não temos
// DOM para navegar até o link, então procuramos o domínio nos campos que o
// Downdetector serializa junto da empresa, e caímos no logo dele como reserva.
function parseIconUrls(html) {
  const urls = [];

  const domainMatch = html.match(
    /\\?"?(?:companyUrl|websiteUrl|website|homepage|url)\\?"?\s*:\s*\\?"https?:\/\/(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i
  );
  const domain = domainMatch?.[1];

  if (domain && !domain.includes("downdetector.")) {
    urls.push(`https://icons.duckduckgo.com/ip3/${domain}.ico`);
    urls.push(`https://www.google.com/s2/favicons?domain=${domain}&sz=64`);
  }

  const logoMatch = html.match(/https?:\/\/[^"'\\\s]*\/static\/uploads\/logo\/[^"'\\\s]+/i);
  if (logoMatch) {
    urls.push(logoMatch[0].replace(/\/cdn-cgi\/image\/[^/]+/, "/cdn-cgi/image/width=64"));
  }

  return urls;
}

async function fetchServiceDirect(slug, sourceSite, abortSignal) {
  const urls = getServiceUrls(slug, sourceSite);
  let lastError = null;

  for (const url of urls) {
    if (abortSignal?.aborted) throw new Error("Abortado");

    try {
      const signal = abortSignal
        ? AbortSignal.any([abortSignal, AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS)])
        : AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS);

      const response = await fetch(url, { credentials: "include", signal });

      // 429/503 é o Cloudflare pedindo para desacelerar. Tentar a próxima URL
      // seria mais uma requisição no vazio, piorando o bloqueio — sai fora já.
      if (response.status === 429 || response.status === 503) {
        const rateLimitError = new Error(`Limite de requisições do Downdetector (HTTP ${response.status}).`);
        rateLimitError.rateLimited = true;

        // Quando o servidor diz por quanto tempo esperar, obedecemos em vez de
        // usar o nosso palpite fixo.
        const retryAfter = parseInt(response.headers.get("retry-after"), 10);
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          rateLimitError.retryAfterMs = Math.min(retryAfter * 1000, 2 * 60 * 60 * 1000);
        }

        throw rateLimitError;
      }

      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }

      const html = await response.text();

      // Tenta ler os dados ANTES de qualquer heurística de bloqueio: se a série
      // está aqui, a página é boa, ponto final. Checar "parece um desafio?"
      // primeiro rejeitava páginas válidas, porque a Cloudflare injeta scripts
      // com nomes tipo challenge-* em respostas perfeitamente normais.
      const history = parseChartHistory(html);
      if (history.length < MIN_GRAPH_POINTS) {
        lastError = new Error(
          CHALLENGE_RE.test(html)
            ? "Cloudflare pediu verificação."
            : `Série não encontrada no HTML (${html.length} chars).`
        );
        continue;
      }

      const last = history[history.length - 1];
      return {
        current: last.value,
        peak: Math.max(...history.map(point => point.value)),
        baselineCurrent: Number.isFinite(last.baseline) ? last.baseline : null,
        history,
        source: "fetch",
        iconUrls: parseIconUrls(html),
        periodLabel: "24h",
        tickLabels: []
      };
    } catch (error) {
      lastError = error;
      // Cancelamento e bloqueio por excesso não devem virar tentativa na próxima URL.
      if (error.rateLimited || abortSignal?.aborted) throw error;
    }
  }

  throw lastError || new Error("Não foi possível buscar os dados diretamente.");
}

// Lista de serviços em alta, também sem abrir aba. Os cards da home são
// <a href="/fora-do-ar/<slug>/" aria-label="Página de status <Nome>">.
const TRENDING_LINK_RE =
  /<a\b[^>]*href=["'](?:https?:\/\/[^/"']+)?\/(?:status|fora-do-ar)\/([^/"'?#]+)\/?["'][^>]*>/gi;
const ARIA_LABEL_RE = /aria-label=["']([^"']+)["']/i;

function humanizeSlug(slug) {
  return decodeURIComponent(String(slug || ""))
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, character => character.toUpperCase());
}

function parseTrendingServices(html) {
  const services = [];
  const seen = new Set();
  TRENDING_LINK_RE.lastIndex = 0;

  let match;
  while ((match = TRENDING_LINK_RE.exec(html)) !== null && services.length < 20) {
    const slug = match[1];
    if (slug === "status" || slug === "fora-do-ar" || seen.has(slug)) continue;
    seen.add(slug);

    const label = ARIA_LABEL_RE.exec(match[0])?.[1] || "";
    let name = label
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^p[áa]gina de status\s+/i, "")
      .replace(/^status page\s+/i, "")
      .trim();

    if (!name) name = humanizeSlug(slug);
    if (name.length > 30) name = `${name.substring(0, 27)}...`;

    services.push({ name, slug, iconUrl: null });
  }

  return services;
}

async function fetchTrendingDirect(sourceSite, abortSignal) {
  const homeUrl = sanitizeSourceSite(sourceSite) === "com"
    ? "https://downdetector.com/"
    : "https://downdetector.com.br/";

  const signal = abortSignal
    ? AbortSignal.any([abortSignal, AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS)])
    : AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS);

  const response = await fetch(homeUrl, { credentials: "include", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const html = await response.text();
  const services = parseTrendingServices(html);
  if (!services.length) {
    throw new Error(CHALLENGE_RE.test(html) ? "Cloudflare pediu verificação." : "Nenhum serviço encontrado na home.");
  }
  return services;
}
