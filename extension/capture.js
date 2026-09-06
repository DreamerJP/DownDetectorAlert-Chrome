(() => {
  if (window.__DDMONITOR_CAPTURE_INSTALLED__) return;

  // Só age na aba worker da extensão. O fragmento é anexado pelo background e
  // está disponível no document_start; logo o interceptor também cobre a
  // primeira navegação, antes de a aplicação chamar fetch/XHR. sessionStorage
  // mantém a marca nas navegações seguintes da mesma aba/origem.
  let isWorkerTab = false;
  let markedByHash = false;
  try {
    markedByHash = /^#ddm-[a-z0-9]+$/.test(location.hash);
    isWorkerTab = markedByHash || sessionStorage.getItem("__ddm_worker") === "1";
    if (isWorkerTab) sessionStorage.setItem("__ddm_worker", "1");
  } catch (_error) { }
  if (!isWorkerTab) return;

  // Apaga o fragmento antes dos scripts da página rodarem. A marca já foi lida
  // e guardada; deixá-la na barra de endereço só daria ao site um traço a mais
  // para reconhecer a aba automatizada.
  if (markedByHash) {
    try {
      history.replaceState(history.state, "", location.pathname + location.search);
    } catch (_error) { }
  }

  window.__DDMONITOR_CAPTURE_INSTALLED__ = true;

  const REPORT_URL_PATTERN = /^https:\/\/data-api\.downdetector\.com\/v1\/companies\/\d+\/report\?/i;
  const captureStore = window.__DDMONITOR_CAPTURE__ = window.__DDMONITOR_CAPTURE__ || {};

  const rememberPayload = (url, payload) => {
    if (!REPORT_URL_PATTERN.test(String(url || "")) || payload == null) return;

    captureStore.lastReport = {
      url,
      payload,
      ts: Date.now()
    };
  };

  // Mantém o segundo guarda: mesmo na aba worker, se ela estiver em primeiro
  // plano (usuário resolvendo um captcha, por exemplo) não há o que forçar.
  const applyVisibilityOverrides = () => {
    if (document.visibilityState === "visible" && document.hasFocus()) return;

    try {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => false
      });
    } catch (_error) {}

    try {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible"
      });
    } catch (_error) {}

    try {
      document.hasFocus = () => true;
    } catch (_error) {}
  };

  applyVisibilityOverrides();

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function patchedFetch(...args) {
      const response = await originalFetch.apply(this, args);

      try {
        const request = args[0];
        const requestUrl = typeof request === "string" ? request : request?.url;
        const responseUrl = response?.url || requestUrl;

        if (REPORT_URL_PATTERN.test(String(responseUrl || ""))) {
          response.clone().json()
            .then(payload => rememberPayload(responseUrl, payload))
            .catch(() => {});
        }
      } catch (_error) {}

      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__ddMonitorUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    this.addEventListener("load", () => {
      try {
        const responseUrl = this.responseURL || this.__ddMonitorUrl;
        if (!REPORT_URL_PATTERN.test(String(responseUrl || ""))) return;

        if (this.responseType === "json" && this.response) {
          rememberPayload(responseUrl, this.response);
          return;
        }

        if (this.responseType === "" || this.responseType === "text") {
          rememberPayload(responseUrl, JSON.parse(this.responseText));
        }
      } catch (_error) {}
    });

    return originalSend.apply(this, args);
  };
})();
