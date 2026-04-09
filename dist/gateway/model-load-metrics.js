const DEFAULT_WINDOW_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MAX_SAMPLES_PER_MODEL = 5000;
const modelSamples = new Map();
function quantileFromSorted(values, q) {
    if (values.length === 0) {
        return 0;
    }
    const clampedQ = Math.max(0, Math.min(1, q));
    const index = Math.floor((values.length - 1) * clampedQ);
    return values[index] ?? values[values.length - 1] ?? 0;
}
function roundMs(value) {
    return Math.round(value * 100) / 100;
}
function pruneModelSamples(samples, cutoffAt) {
    let startIndex = 0;
    while (startIndex < samples.length && samples[startIndex] && samples[startIndex].at < cutoffAt) {
        startIndex += 1;
    }
    if (startIndex <= 0) {
        return samples;
    }
    return samples.slice(startIndex);
}
function pruneExpiredSamples(cutoffAt) {
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
export function recordModelLoadSample(model, loadMs) {
    if (!model) {
        return;
    }
    if (!Number.isFinite(loadMs) || loadMs <= 0) {
        return;
    }
    const now = Date.now();
    const sample = {
        at: now,
        loadMs,
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
function summarizeModel(model, samples) {
    if (samples.length === 0) {
        return null;
    }
    const loadValues = samples.map((sample) => sample.loadMs).sort((a, b) => a - b);
    const total = loadValues.reduce((acc, value) => acc + value, 0);
    const avgLoadMs = total / loadValues.length;
    const minLoadMs = loadValues[0] ?? 0;
    const maxLoadMs = loadValues[loadValues.length - 1] ?? 0;
    const latestAt = samples[samples.length - 1]?.at ?? Date.now();
    return {
        model,
        sampleCount: samples.length,
        avgLoadMs: roundMs(avgLoadMs),
        p50LoadMs: roundMs(quantileFromSorted(loadValues, 0.5)),
        p95LoadMs: roundMs(quantileFromSorted(loadValues, 0.95)),
        minLoadMs: roundMs(minLoadMs),
        maxLoadMs: roundMs(maxLoadMs),
        lastSeenAt: new Date(latestAt).toISOString(),
    };
}
export function getModelLoadRankingHealth(windowMs = DEFAULT_WINDOW_MS) {
    const normalizedWindowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS;
    const now = Date.now();
    const cutoffAt = now - normalizedWindowMs;
    pruneExpiredSamples(cutoffAt);
    const summaries = [];
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
        if (a.avgLoadMs !== b.avgLoadMs) {
            return a.avgLoadMs - b.avgLoadMs;
        }
        if (a.p95LoadMs !== b.p95LoadMs) {
            return a.p95LoadMs - b.p95LoadMs;
        }
        return b.sampleCount - a.sampleCount;
    });
    return {
        windowHours: roundMs(normalizedWindowMs / (60 * 60 * 1000)),
        rankedModels: summaries.map((entry, index) => ({
            rank: index + 1,
            ...entry,
        })),
    };
}
