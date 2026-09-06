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

// Só a leitura exata muda alerta. Se o site mudar de formato e sobrar apenas a
// estimativa do desenho, o monitoramento fica cego sem perceber. Depois deste
// número de ciclos seguidos sem fonte exata, o serviço é marcado como cego e o
// usuário é avisado uma vez.
const MAX_CYCLES_WITHOUT_EXACT_READING = 3;

// Erro de leitura preserva o alerta em aberto, senão uma falha momentânea
// zeraria o incidente. Mas preservar para sempre trava o contador do ícone em
// serviço que quebrou de vez. Passado este número de falhas seguidas, o alerta
// é solto e o serviço volta a "desconhecido".
const MAX_CONSECUTIVE_READ_FAILURES = 5;

// Mínimo de serviços encontrados na página inicial para considerar que ela
// terminou de montar. Um único link de status aparece no menu e no rodapé
// antes da grade existir.
const MIN_HOME_SERVICES_READY = 5;
