(() => {
  if (window.__DDMONITOR_CAPTURE_INSTALLED__) return;
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

  // Only override visibility on background/inactive tabs (the worker tab).
  // This prevents interfering when the user is actively browsing Downdetector.
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
