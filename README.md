# Downdetector Monitor — Extensão Chrome

Monitora serviços no Downdetector diretamente no Chrome e envia notificação
quando o número de reportes ultrapassa o limite configurado. Também detecta
automaticamente os serviços em alta na home do Downdetector e os monitora
enquanto estiverem com problemas.

Versão atual: **1.1** · Manifest V3.

## Autor

- DreamerJP
- E-mail: `DreamerJPMG@gmail.com`
- GitHub: [github.com/DreamerJP](https://github.com/DreamerJP)
- Copyright © 2026 DreamerJP. Todos os direitos reservados (ver `LICENSE`).

## Funcionalidades

- Lista personalizada de serviços com limiar configurável por serviço
- Detecção automática de serviços em alta (Trending) na home
- Notificação ao **ultrapassar** o limiar e ao **normalizar** (recovery)
- Badge no ícone da extensão com a quantidade de serviços em falha
- Aba de **Logs** com o passo a passo do último ciclo de checagem
- Botão de **liga/desliga** do monitoramento sem precisar desinstalar
- Favicons dos serviços oficiais ao lado do nome (DuckDuckGo + fallback)
- Pausa automática quando todas as janelas do Chrome fecham (poupa CPU)
- Cancelamento imediato da checagem em curso ao desligar o monitoramento

## Como instalar

1. Abra o Chrome e acesse: `chrome://extensions`
2. Ative o **Modo do desenvolvedor** (canto superior direito)
3. Clique em **"Carregar sem compactação"**
4. Selecione a pasta deste repositório (`DownDetectorAlert-Chrome`)
5. O ícone DD.Monitor aparece na barra do Chrome

## Como usar

Clique no ícone da extensão para abrir o popup. Ele tem três abas:

### Aba Status
Lista todos os serviços monitorados, ordenados por gravidade (problemas
primeiro). Cada linha mostra:
- Bolinha colorida com o estado atual
- Favicon do serviço oficial (quando disponível)
- Nome do serviço e contagem atual / pico em 24h
- Badge de estado (`Normal`, `Alerta`, `Falha`, `Erro`)
- Badge `Trending` para serviços detectados automaticamente

Clique numa linha para expandir o gráfico das últimas 24h.

### Aba Configurar
- **Intervalo**: minutos entre checagens automáticas (1–60, padrão 10)
- **Origem dos dados**: `.com.br` ou `.com`
- **Trending**: ativa/desativa o monitoramento da home, define quantos
  serviços puxar e o limiar usado para eles
- **Serviços monitorados**: lista manual com nome, slug e limiar individual

### Aba Logs
Mostra o que aconteceu no último ciclo. Os logs são reiniciados a cada
ciclo (intencional, para ficarem sempre relevantes).

### Cabeçalho
- **Botão ON/OFF** (lado esquerdo do ↺): pausa/retoma o monitoramento.
  Quando OFF, nenhuma checagem automática roda. Ao desligar durante uma
  checagem, ela é cancelada na hora.
- **↺ Checar**: força uma checagem imediata, mesmo com monitoramento OFF.
- **Hora**: hora da última checagem concluída.

## Indicadores de status

- 🟢 Verde — Normal
- 🟡 Amarelo — Acima de 75% do limiar (atenção)
- 🔴 Vermelho piscando — Limiar ultrapassado (notificação enviada)
- ⚪ Cinza — Erro ao ler o serviço ou sem dados

## Slug dos serviços

O "slug" é o trecho final da URL da página de status no Downdetector:

```
https://downdetector.com.br/status/SLUG/
```

Exemplos: `youtube`, `netflix`, `tim`, `claro-net-virtua`, `steam`,
`mercado-pago`, `vivo`, `nubank`.

## Como funciona por baixo

A extensão mantém uma aba pinada (chamada "Aba de Serviço") que carrega
as páginas do Downdetector em segundo plano. Os reportes são extraídos
de duas fontes, em ordem:

1. **Interceptação da API**: um content script captura o JSON da
   `data-api.downdetector.com` quando a página o requisita.
2. **Fallback via SVG**: se a API não aparecer, a extensão lê o gráfico
   renderizado direto do DOM, reconstruindo a série temporal.

A aba worker bloqueia anúncios via `declarativeNetRequest` e fica mutada
para não atrapalhar. **Não feche essa aba manualmente.** Se fechar, a
extensão recria automaticamente no próximo ciclo.

Quando o Cloudflare exige verificação humana, a extensão tenta recarregar
a página silenciosamente uma vez. Se persistir, traz a aba ao foco e
notifica o usuário a resolver o captcha.

## Estrutura do código

| Arquivo | Função |
|---|---|
| `manifest.json` | Manifest V3 |
| `background.js` | Service worker — lifecycle, alarmes, mensagens, loop principal |
| `constants.js` | Constantes globais (thresholds padrão, etc.) |
| `utils.js` | Helpers genéricos (delay, withTimeout, sanitizers, parsing) |
| `normalize.js` | Normalização de séries vindas do payload da API |
| `config.js` | Configuração padrão e helpers de leitura/normalização |
| `scrape.js` | Aba worker, navegação e extração por serviço |
| `capture.js` | Content script (MAIN world) que captura fetch/XHR |
| `page_reader.js` | Leitor injetado para extrair gráfico, logo e trending |
| `popup.html`/`popup.js` | UI do popup (status, config, logs) |
| `worker.html` | Página exibida na aba pinada |

## Permissões

- `alarms` — agendar checagens periódicas
- `notifications` — alertas de queda/recovery
- `storage` — persistir config (sync) e estado (local)
- `scripting` — injetar `page_reader.js`
- `tabs` — gerenciar a aba worker
- `declarativeNetRequest` — bloquear anúncios na aba worker
- `host_permissions` — restritas a `*.downdetector.com.br/*` e `*.downdetector.com/*`
