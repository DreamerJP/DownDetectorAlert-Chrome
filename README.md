# Downdetector Monitor — Extensão Chrome

Monitora serviços no Downdetector diretamente no Chrome.
Envia notificação quando os reports ultrapassam o limite configurado.

## Autor

- DreamerJP
- E-mail: `DreamerJPMG@gmail.com`
- GitHub: [github.com/DreamerJP](https://github.com/DreamerJP)
- Copyright © 2026 DreamerJP. Todos os direitos reservados.

## Como instalar

1. Abra o Chrome e acesse: `chrome://extensions`
2. Ative o **Modo do desenvolvedor** (canto superior direito)
3. Clique em **"Carregar sem compactação"**
4. Selecione a pasta `downdetector-extension`
5. Pronto! O ícone aparece na barra do Chrome.

## Como usar

- Clique no ícone da extensão para ver o status de cada serviço
- Aba **Status**: mostra reports atuais vs limite configurado
- Aba **Configurar**: adiciona/remove serviços e ajusta thresholds
- Botão **↺ Checar**: força uma verificação imediata
- Notificações aparecem automaticamente quando um serviço ultrapassar o limite

## Indicadores de status

- 🟢 Verde — Normal
- 🟡 Amarelo — Acima de 75% do limite (atenção)
- 🔴 Vermelho piscando — Limite ultrapassado (notificação enviada)
- ⚪ Cinza — Sem dados disponíveis

## Slug dos serviços

O "slug" é o trecho final da URL do Downdetector:
```
https://downdetector.com.br/status/SLUG/
```
Exemplos: `youtube`, `netflix`, `tim`, `claro-net-virtua`, `steam`
