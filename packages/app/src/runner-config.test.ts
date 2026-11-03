import { describe, expect, it } from "vitest";
import { runnerAllowedHosts, runnerEnvVars } from "./runner-config.js";

const BASE = ["github.com", "api.github.com", "api.anthropic.com", "registry.npmjs.org"];

const SETTINGS = { ANTHROPIC_API_KEY: "sk-test", THIN_PR_MODEL: "live", THIN_PR_SPEND_LIMIT_USD: "25", GITHUB_APP_SLUG: "thin-pr" };

describe("runnerAllowedHosts", () => {
  it("keeps the base allowlist when no collector is configured", () => {
    expect(runnerAllowedHosts(undefined)).toEqual(BASE);
    expect(runnerAllowedHosts("")).toEqual(BASE);
  });

  it("adds the collector host when an endpoint is configured", () => {
    expect(runnerAllowedHosts("https://api.honeycomb.io")).toEqual([...BASE, "api.honeycomb.io"]);
    expect(runnerAllowedHosts("https://otlp.example.com:443/otlp")).toEqual([...BASE, "otlp.example.com"]);
  });

  it("fails on an endpoint the container could never reach", () => {
    expect(() => runnerAllowedHosts("api.honeycomb.io")).toThrow("OTEL_EXPORTER_OTLP_ENDPOINT is not a URL");
    expect(() => runnerAllowedHosts("http://collector.example.com:4318")).toThrow("must use port 443 or 80, got 4318");
  });
});

describe("runnerEnvVars", () => {
  it("carries only the token and run settings when tracing is off", () => {
    expect(runnerEnvVars({ ...SETTINGS, OTEL_EXPORTER_OTLP_ENDPOINT: "" }, "ghs_test")).toEqual({
      GITHUB_TOKEN: "ghs_test",
      ANTHROPIC_API_KEY: "sk-test",
      THIN_PR_MODEL: "live",
      THIN_PR_SPEND_LIMIT_USD: "25",
      GITHUB_APP_SLUG: "thin-pr",
    });
  });

  it("refuses to start a runner without the App's slug", () => {
    for (const slug of ["", "thin-pr[bot]", "Thin PR"]) {
      expect(() => runnerEnvVars({ ...SETTINGS, GITHUB_APP_SLUG: slug }, "t")).toThrow("GITHUB_APP_SLUG must be the GitHub App's slug");
    }
  });

  it("carries the OTLP endpoint and headers when they are set", () => {
    const vars = runnerEnvVars(
      { ...SETTINGS, OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.honeycomb.io", OTEL_EXPORTER_OTLP_HEADERS: "x-honeycomb-team=k" },
      "ghs_test",
    );
    expect(vars).toMatchObject({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.honeycomb.io",
      OTEL_EXPORTER_OTLP_HEADERS: "x-honeycomb-team=k",
    });
    expect(runnerEnvVars({ ...SETTINGS, OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.honeycomb.io" }, "t")).not.toHaveProperty(
      "OTEL_EXPORTER_OTLP_HEADERS",
    );
  });
});
