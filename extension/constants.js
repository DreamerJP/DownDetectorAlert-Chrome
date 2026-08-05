const DEFAULT_THRESHOLD = 100;
const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_SOURCE_SITE = "com.br";
const WARNING_RATIO = 0.75;
const MAX_POINTS = 96;
const MIN_GRAPH_POINTS = 12;

// Teto de tempo por serviço. Aplicado via AbortSignal.timeout para que o
// estouro realmente cancele o scrape em curso (ver comentário em background.js).
const SERVICE_TIMEOUT_MS = 25000;

// Ritmo da busca direta. Começou com 5 simultâneas e sem intervalo: o Cloudflare
// devolveu 429 na primeira rajada e derrubou o ciclo inteiro para a aba. Uma por
// vez, com pausa entre elas, é o que mantém a busca direta viável — ainda assim
// é bem mais rápido que carregar a página inteira numa aba.
const DIRECT_FETCH_CONCURRENCY = 1;
// 2s é o valor conservador de partida: ainda não medimos qual ritmo o Cloudflare
// aceita, e errar para baixo custa um bloqueio de 30 min. Dá para reduzir depois
// de medir — ver o teste de calibragem no README.
const DIRECT_FETCH_GAP_MS = 2000;

// Ao tomar 429, para de insistir por um tempo: continuar tentando a cada ciclo
// só renova o bloqueio. Nesse período vai direto para a aba.
const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;
const RATE_LIMIT_KEY = "directFetchBlockedUntil";

const DEFAULT_TOP_SERVICES_COUNT = 5;
const DEFAULT_TOP_SERVICES_ENABLED = true;
const DEFAULT_TOP_SERVICES_THRESHOLD = 100;
