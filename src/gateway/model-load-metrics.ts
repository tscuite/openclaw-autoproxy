const DEFAULT_WINDOW_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MAX_SAMPLES_PER_MODEL = 5000;

export const DEFAULT_MODEL_HEALTH_WINDOW_MS = DEFAULT_WINDOW_MS;

interface ModelRequestSample {
  at: number;
  ok: boolean;
  responseMs: number;
  statusCode: number | null;
}

export interface ModelHealthSummary {
  model: string;
  accessCount: number;
  avgResponseMs: number;
  lastResponseMs: number;
  lastSeenAt: string;
  lastStatusCode: number | null;
  successCount: number;
  successRatePct: number;
}

const modelSamples = new Map<string, ModelRequestSample[]>();

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function pruneModelSamples(samples: ModelRequestSample[], cutoffAt: number): ModelRequestSample[] {
  let startIndex = 0;

  while (startIndex < samples.length && samples[startIndex] && samples[startIndex].at < cutoffAt) {
    startIndex += 1;
  }

  if (startIndex <= 0) {
    return samples;
  }

  return samples.slice(startIndex);
}

function pruneExpiredSamples(cutoffAt: number): void {
  for (const [model, samples] of modelSamples.entries()) {
    const pruned = pruneModelSamples(samples, cutoffAt);

    if (pruned.length === 0) {
      modelSamples.delete(model);
      continue;
    }

    if (pruned !== samples) {
      modelSamples.set(model, pruned);
    }
  }
}

export function recordModelRequestSample(
  model: string | null,
  params: {
    ok: boolean;
    responseMs: number;
    statusCode?: number | null;
  },
): void {
  if (!model) {
    return;
  }

  if (!Number.isFinite(params.responseMs) || params.responseMs < 0) {
    return;
  }

  const now = Date.now();
  const sample: ModelRequestSample = {
    at: now,
    ok: params.ok,
    responseMs: params.responseMs,
    statusCode: params.statusCode ?? null,
  };

  const existing = modelSamples.get(model) ?? [];
  existing.push(sample);

  if (existing.length > DEFAULT_MAX_SAMPLES_PER_MODEL) {
    existing.splice(0, existing.length - DEFAULT_MAX_SAMPLES_PER_MODEL);
  }

  modelSamples.set(model, existing);

  const cutoffAt = now - DEFAULT_WINDOW_MS;
  pruneExpiredSamples(cutoffAt);
}

export function recordModelLoadSample(model: string | null, loadMs: number): void {
  recordModelRequestSample(model, {
    ok: true,
    responseMs: loadMs,
    statusCode: 200,
  });
}

function summarizeModel(model: string, samples: ModelRequestSample[]): ModelHealthSummary | null {
  if (samples.length === 0) {
    return null;
  }

  const accessCount = samples.length;
  const successCount = samples.reduce((count, sample) => count + (sample.ok ? 1 : 0), 0);
  const totalResponseMs = samples.reduce((total, sample) => total + sample.responseMs, 0);
  const lastSample = samples[samples.length - 1] ?? null;
  const avgResponseMs = totalResponseMs / accessCount;
  const successRatePct = accessCount > 0 ? (successCount / accessCount) * 100 : 0;

  return {
    model,
    accessCount,
    avgResponseMs: roundMs(avgResponseMs),
    lastResponseMs: roundMs(lastSample?.responseMs ?? 0),
    lastSeenAt: new Date(lastSample?.at ?? Date.now()).toISOString(),
    lastStatusCode: lastSample?.statusCode ?? null,
    successCount,
    successRatePct: roundMs(successRatePct),
  };
}

export function getModelHealthWindow(windowMs = DEFAULT_WINDOW_MS): {
  windowHours: number;
  models: Array<ModelHealthSummary & { rank: number }>;
} {
  const normalizedWindowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS;
  const cutoffAt = Date.now() - normalizedWindowMs;

  pruneExpiredSamples(cutoffAt);

  const summaries: ModelHealthSummary[] = [];

  for (const [model, samples] of modelSamples.entries()) {
    const filtered = pruneModelSamples(samples, cutoffAt);

    if (filtered.length === 0) {
      continue;
    }

    if (filtered !== samples) {
      modelSamples.set(model, filtered);
    }

    const summary = summarizeModel(model, filtered);

    if (summary) {
      summaries.push(summary);
    }
  }

  summaries.sort((a, b) => {
    if (a.accessCount !== b.accessCount) {
      return b.accessCount - a.accessCount;
    }

    if (a.successRatePct !== b.successRatePct) {
      return b.successRatePct - a.successRatePct;
    }

    if (a.avgResponseMs !== b.avgResponseMs) {
      return a.avgResponseMs - b.avgResponseMs;
    }

    return a.model.localeCompare(b.model);
  });

  return {
    windowHours: roundMs(normalizedWindowMs / (60 * 60 * 1000)),
    models: summaries.map((entry, index) => ({
      rank: index + 1,
      ...entry,
    })),
  };
}

export function getModelLoadRankingHealth(windowMs = DEFAULT_WINDOW_MS): {
  windowHours: number;
  rankedModels: Array<ModelHealthSummary & { rank: number }>;
} {
  const health = getModelHealthWindow(windowMs);

  return {
    windowHours: health.windowHours,
    rankedModels: health.models,
  };
}
