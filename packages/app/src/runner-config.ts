const BASE_HOSTS = ["github.com", "api.github.com", "api.anthropic.com", "registry.npmjs.org"];

/** The settings the Worker hands to the container, beside the installation token. */
export type RunnerSettings = {
  readonly ANTHROPIC_API_KEY: string;
  readonly THIN_PR_MODEL: string;
  readonly THIN_PR_SPEND_LIMIT_USD: string;
  readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  readonly OTEL_EXPORTER_OTLP_HEADERS?: string;
};

/**
 * The hosts the container may reach. A configured OTLP endpoint adds its host, so the egress stays an allowlist.
 * Container egress leaves only on ports 80 and 443, so an endpoint on another port could never be reached.
 */
export function runnerAllowedHosts(otlpEndpoint: string | undefined): string[] {
  if (!otlpEndpoint) {
    return [...BASE_HOSTS];
  }
  let url: URL;
  try {
    url = new URL(otlpEndpoint);
  } catch {
    throw new Error(`OTEL_EXPORTER_OTLP_ENDPOINT is not a URL: ${otlpEndpoint}`);
  }
  if (url.port !== "" && url.port !== "80" && url.port !== "443") {
    throw new Error(`OTEL_EXPORTER_OTLP_ENDPOINT must use port 443 or 80, got ${url.port}`);
  }
  return [...BASE_HOSTS, url.hostname];
}

/** The container's environment. The OTLP values travel only when they are set. */
export function runnerEnvVars(settings: RunnerSettings, token: string): Record<string, string> {
  return {
    GITHUB_TOKEN: token,
    ANTHROPIC_API_KEY: settings.ANTHROPIC_API_KEY,
    THIN_PR_MODEL: settings.THIN_PR_MODEL,
    THIN_PR_SPEND_LIMIT_USD: settings.THIN_PR_SPEND_LIMIT_USD,
    ...(settings.OTEL_EXPORTER_OTLP_ENDPOINT ? { OTEL_EXPORTER_OTLP_ENDPOINT: settings.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
    ...(settings.OTEL_EXPORTER_OTLP_HEADERS ? { OTEL_EXPORTER_OTLP_HEADERS: settings.OTEL_EXPORTER_OTLP_HEADERS } : {}),
  };
}
