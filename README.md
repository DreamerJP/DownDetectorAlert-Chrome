# Downdetector Monitor (Extensão Chrome)

Monitora serviços no Downdetector diretamente no Chrome e envia notificação
quando o número de reportes ultrapassa o limite configurado. Também detecta
automaticamente os serviços em alta na home do Downdetector e os monitora
enquanto estiverem com problemas.

Versão atual: **1.2** · Manifest V3 · requer Chrome 116+.

## Autor

- DreamerJP
- E-mail: `DreamerJPMG@gmail.com`
- GitHub: [github.com/DreamerJP](https://github.com/DreamerJP)
- Copyright © 2026 DreamerJP. Todos os direitos reservados (ver `LICENSE`).

## Funcionalidades

- Lista personalizada de serviços com limiar configurável por serviço
- Detecção automática de serviços em alta (Trending) na home
- Notificação ao **ultrapassar** o limiar e ao **normalizar** (recovery);
  clicar na notificação abre a página do serviço
- Badge no ícone da extensão com a quantidade de serviços em falha
- Gráfico das últimas 24h de cada serviço, direto no popup
- Aba de **Logs** com o passo a passo do último ciclo de checagem
- Botão de **liga/desliga** do monitoramento sem precisar desinstalar
- Favicons dos serviços oficiais ao lado do nome
- Funciona sem abrir aba nenhuma na maior parte do tempo
- Pausa automática quando todas as janelas do Chrome fecham (poupa CPU)
- Cancelamento imediato da checagem em curso ao desligar o monitoramento

## Como instalar

1. Abra o Chrome e acesse: `chrome://extensions`
2. Ative o **Modo do desenvolvedor** (canto superior direito)
3. Clique em **"Carregar sem compactação"**
4. Selecione a pasta **`extension/`** deste repositório — não a raiz.
   É lá que fica o `manifest.json`.
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
- **Intervalo**: minutos entre checagens automáticas (1–60, padrão 15)
- **Origem dos dados**: `.com.br` ou `.com`
- **Trending**: ativa/desativa o monitoramento da home, define quantos
  serviços puxar e o limiar usado para eles
- **Serviços monitorados**: lista manual com nome, slug e limiar individual

### Aba Logs
Mostra o que aconteceu no último ciclo, reiniciando a cada checagem para
ficar sempre relevante. As linhas saem na ordem em que cada serviço
termina, que não é necessariamente a ordem da lista.

Ao lado de cada serviço aparece a fonte usada entre colchetes. `[fetch]`
é o normal; qualquer outra indica que a extensão precisou recorrer ao
método reserva.

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

## Como funciona

Na maior parte do tempo a extensão busca os dados em segundo plano, sem
abrir nada. O gráfico do Downdetector já vem pronto na página, e é dele
que sai a contagem de reportes.

Como o site limita quantas buscas desse tipo aceita por vez, as consultas
saem uma de cada vez, com pausa entre elas. Se o limite for atingido
mesmo assim, a extensão recua sozinha e passa a usar um método alternativo:
uma aba de apoio que carrega as páginas normalmente, como se você
estivesse navegando. É mais lento, mas nunca esbarra em limite.

Você não precisa fazer nada nessa troca — ela é automática, e os dados
chegam do mesmo jeito. A aba de apoio só existe enquanto for necessária.

## Estrutura do repositório

```
README.md    este arquivo
LICENSE
extension/   a extensão em si; é esta pasta que o Chrome carrega
```

## Permissões

- `alarms` — agendar checagens periódicas
- `notifications` — alertas de queda/recovery
- `storage` — guardar configuração e estado
- `scripting` — ler o gráfico quando usa a aba de apoio
- `tabs` — gerenciar a aba de apoio
- `declarativeNetRequest` — bloquear anúncios na aba de apoio
- `host_permissions` — restritas a `*.downdetector.com.br/*` e `*.downdetector.com/*`

Nenhum dado sai da sua máquina além das requisições ao próprio Downdetector
e da busca dos favicons dos serviços monitorados.
