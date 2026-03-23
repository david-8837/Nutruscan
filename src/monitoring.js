import * as Sentry from "@sentry/react";

let initialized = false;

const SENTRY_DSN = (import.meta.env.VITE_SENTRY_DSN || "").trim();
const SENTRY_ENV = (import.meta.env.VITE_APP_ENV || import.meta.env.MODE || "development").trim();
const TRACE_SAMPLE_RATE = Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE || 0);

export function initMonitoring() {
  if (initialized || !SENTRY_DSN) return;
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: SENTRY_ENV,
    tracesSampleRate: Number.isFinite(TRACE_SAMPLE_RATE) ? TRACE_SAMPLE_RATE : 0,
  });
  initialized = true;
}

export function logAppError(error, context, extra = {}) {
  const label = context || "unknown";
  console.error(`[NutriScan][${label}]`, error, extra);
  if (!SENTRY_DSN) return;
  Sentry.captureException(error instanceof Error ? error : new Error(String(error || "Unknown error")), {
    tags: { context: label },
    extra,
  });
}

export function logAppMessage(message, level = "info", extra = {}) {
  if (!SENTRY_DSN) return;
  Sentry.captureMessage(String(message || "NutriScan message"), {
    level,
    extra,
  });
}
