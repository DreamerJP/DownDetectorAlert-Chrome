// Configuração padrão e helpers de leitura/normalização.
// Depende de constants.js + utils.js (sanitizeThreshold, sanitizeSourceSite).

const DEFAULT_CONFIG = {
  interval_minutes: DEFAULT_INTERVAL_MINUTES,
  source_site: DEFAULT_SOURCE_SITE,
  top_services_enabled: DEFAULT_TOP_SERVICES_ENABLED,
  top_services_count: DEFAULT_TOP_SERVICES_COUNT,
  top_services_threshold: DEFAULT_TOP_SERVICES_THRESHOLD,
  services: [
    { slug: "youtube", name: "YouTube", threshold: DEFAULT_THRESHOLD },
    { slug: "netflix", name: "Netflix", threshold: DEFAULT_THRESHOLD },
    { slug: "instagram", name: "Instagram", threshold: DEFAULT_THRESHOLD },
    { slug: "whatsapp", name: "WhatsApp", threshold: DEFAULT_THRESHOLD },
    { slug: "twitch", name: "Twitch", threshold: DEFAULT_THRESHOLD },
    { slug: "cloudflare", name: "Cloudflare", threshold: DEFAULT_THRESHOLD },
    { slug: "steam", name: "Steam", threshold: DEFAULT_THRESHOLD },
  ]
};

const LEGACY_DEFAULT_THRESHOLDS = {
  youtube: 50,
  netflix: 30,
  instagram: 50,
  whatsapp: 100,
  twitch: 30,
  cloudflare: 20,
  steam: 40
};

function upgradeLegacyConfig(config) {
  if (!config || !Array.isArray(config.services)) return config;
  if (config.services.length !== Object.keys(LEGACY_DEFAULT_THRESHOLDS).length) return config;

  const matchedLegacy = config.services.every(service => {
    const slug = String(service.slug || "").trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(LEGACY_DEFAULT_THRESHOLDS, slug) &&
      sanitizeThreshold(service.threshold) === LEGACY_DEFAULT_THRESHOLDS[slug];
  });

  if (!matchedLegacy) return config;

  return {
    ...config,
    services: config.services.map(service => ({
      ...service,
      threshold: DEFAULT_THRESHOLD
    }))
  };
}

function normalizeConfig(config) {
  const upgraded = upgradeLegacyConfig(config || DEFAULT_CONFIG) || DEFAULT_CONFIG;
  const fallbackServices = Array.isArray(DEFAULT_CONFIG.services) ? DEFAULT_CONFIG.services : [];
  // Uma lista vazia é uma escolha válida: permite usar somente Trending ou
  // pausar a lista manual. Só configurações legadas que não possuíam o campo
  // services recebem a lista padrão.
  const inputServices = Array.isArray(upgraded.services)
    ? upgraded.services
    : fallbackServices;

  const seen = new Set();
  return {
    interval_minutes: Math.max(1, Math.min(60, parseInt(upgraded.interval_minutes, 10) || DEFAULT_CONFIG.interval_minutes)),
    source_site: sanitizeSourceSite(upgraded.source_site),
    top_services_enabled: upgraded.top_services_enabled === true,
    top_services_count: Math.max(1, Math.min(20, parseInt(upgraded.top_services_count, 10) || DEFAULT_TOP_SERVICES_COUNT)),
    top_services_threshold: Math.max(1, parseInt(upgraded.top_services_threshold, 10) || DEFAULT_TOP_SERVICES_THRESHOLD),
    services: inputServices
      .filter(Boolean)
      .map(service => ({
        slug: sanitizeSlug(service.slug),
        name: String(service.name || service.slug).trim(),
        threshold: sanitizeThreshold(service.threshold)
      }))
      .filter(service => {
        if (!service.slug) return false;
        if (seen.has(service.slug)) return false;
        seen.add(service.slug);
        return true;
      })
  };
}

// Diz o que a normalização jogou fora e por quê. Sem isso a linha some da tela
// e o botão ainda anuncia que salvou, sem o usuário entender o que aconteceu.
function listRejectedServices(rawConfig, normalizedConfig) {
  const input = Array.isArray(rawConfig?.services) ? rawConfig.services : [];
  const accepted = new Set((normalizedConfig?.services || []).map(service => service.slug));
  const seen = new Set();
  const rejected = [];

  for (const service of input) {
    const label = String(service?.name || service?.slug || "").trim() || "(sem nome)";
    const slug = sanitizeSlug(service?.slug);

    if (!slug) {
      rejected.push({ label, reason: "endereço inválido" });
      continue;
    }
    if (seen.has(slug)) {
      rejected.push({ label, reason: "repetido" });
      continue;
    }

    seen.add(slug);
    if (!accepted.has(slug)) rejected.push({ label, reason: "descartado" });
  }

  return rejected;
}

async function ensureConfig() {
  const { config } = await chrome.storage.sync.get("config");
  const nextConfig = normalizeConfig(config || DEFAULT_CONFIG);

  if (!config || JSON.stringify(nextConfig) !== JSON.stringify(config)) {
    await chrome.storage.sync.set({ config: nextConfig });
  }

  return nextConfig;
}
