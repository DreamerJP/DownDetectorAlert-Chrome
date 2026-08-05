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
// Nota histórica: houve uma tentativa de buscar os dados por fetch direto do
// service worker, sem abrir aba. Foi removida em 05/08/2026. Funcionava por
// algumas requisições e então o Cloudflare passava a exigir verificação (403),
// que um fetch não tem como resolver — sem página, sem JavaScript, sem saída.
// Pior: gastava o passe de liberação do perfil, degradando a navegação normal
// do usuário no site. A aba resolve verificação sozinha; por isso ela ficou.

const DEFAULT_TOP_SERVICES_COUNT = 5;
const DEFAULT_TOP_SERVICES_ENABLED = true;
const DEFAULT_TOP_SERVICES_THRESHOLD = 100;
