import { randomBytes } from "node:crypto";
import { redactDeep } from "@motion-mcp/shared";

/**
 * OpenTelemetry-shaped hierarchical traces with first-class cost fields.
 * Span names follow the execution graph (`video.generate`, `director.opus`, `pi.execute`, ...).
 * The in-memory tree is persisted with the job; an OTLP exporter can be added without changing callers.
 */

export type CostKind = "api" | "render" | "asset" | "storage";

export interface ModelUsage {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
}

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  status: "unset" | "ok" | "error";
  error?: string;
  attributes: Record<string, string | number | boolean>;
  modelCalls: ModelUsage[];
  costs: Record<CostKind, number>;
  retries: number;
  children: SpanData[];
}

export interface TraceSummary {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  apiCostUsd: number;
  renderCostUsd: number;
  assetCostUsd: number;
  storageCostUsd: number;
  cogsUsd: number;
  retries: number;
  failures: number;
  modelCalls: number;
  opusCalls: number;
  costByModel: Record<string, number>;
  costByProvider: Record<string, number>;
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

export class Span {
  readonly data: SpanData;
  private readonly onEnd?: (span: Span) => void;

  constructor(name: string, traceId: string, parent?: Span, onEnd?: (span: Span) => void) {
    this.data = {
      traceId,
      spanId: hex(8),
      parentSpanId: parent?.data.spanId,
      name,
      startTime: Date.now(),
      status: "unset",
      attributes: {},
      modelCalls: [],
      costs: { api: 0, render: 0, asset: 0, storage: 0 },
      retries: 0,
      children: [],
    };
    this.onEnd = onEnd;
    parent?.data.children.push(this.data);
  }

  child(name: string, attributes: Record<string, string | number | boolean> = {}): Span {
    const span = new Span(name, this.data.traceId, this, this.onEnd);
    span.setAttributes(attributes);
    return span;
  }

  setAttributes(attrs: Record<string, string | number | boolean | undefined>): this {
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined) this.data.attributes[k] = v;
    return this;
  }

  recordModelCall(usage: ModelUsage): this {
    this.data.modelCalls.push(usage);
    this.data.costs.api += usage.costUsd;
    return this;
  }

  addCost(kind: CostKind, usd: number): this {
    this.data.costs[kind] += usd;
    return this;
  }

  retry(): this {
    this.data.retries += 1;
    return this;
  }

  fail(err: unknown): this {
    this.data.status = "error";
    this.data.error = redactDeep(err instanceof Error ? err.message : String(err));
    return this;
  }

  end(): this {
    if (this.data.endTime === undefined) {
      this.data.endTime = Date.now();
      if (this.data.status === "unset") this.data.status = "ok";
      this.onEnd?.(this);
    }
    return this;
  }

  /** Run `fn` inside a child span, ending it and recording failures. */
  async run<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    attrs: Record<string, string | number | boolean> = {},
  ) {
    const span = this.child(name, attrs);
    try {
      return await fn(span);
    } catch (err) {
      span.fail(err);
      throw err;
    } finally {
      span.end();
    }
  }
}

export function startTrace(name: string, attributes: Record<string, string | number | boolean> = {}): Span {
  const root = new Span(name, hex(16));
  root.setAttributes(attributes);
  return root;
}

export function summarize(root: SpanData): TraceSummary {
  const s: TraceSummary = {
    durationMs: (root.endTime ?? Date.now()) - root.startTime,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    apiCostUsd: 0,
    renderCostUsd: 0,
    assetCostUsd: 0,
    storageCostUsd: 0,
    cogsUsd: 0,
    retries: 0,
    failures: 0,
    modelCalls: 0,
    opusCalls: 0,
    costByModel: {},
    costByProvider: {},
  };
  const walk = (span: SpanData) => {
    s.apiCostUsd += span.costs.api;
    s.renderCostUsd += span.costs.render;
    s.assetCostUsd += span.costs.asset;
    s.storageCostUsd += span.costs.storage;
    s.retries += span.retries;
    if (span.status === "error") s.failures += 1;
    for (const call of span.modelCalls) {
      s.modelCalls += 1;
      if (/opus/i.test(call.model)) s.opusCalls += 1;
      s.inputTokens += call.inputTokens;
      s.outputTokens += call.outputTokens;
      s.cacheReadTokens += call.cacheReadTokens ?? 0;
      s.costByModel[call.model] = (s.costByModel[call.model] ?? 0) + call.costUsd;
      s.costByProvider[call.provider] = (s.costByProvider[call.provider] ?? 0) + call.costUsd;
    }
    for (const c of span.children) walk(c);
  };
  walk(root);
  s.cogsUsd = s.apiCostUsd + s.renderCostUsd + s.assetCostUsd + s.storageCostUsd;
  return s;
}

/** Revenue-side view used by billing and the dashboard. */
export function margin(summary: TraceSummary, revenueUsd: number) {
  const grossProfitUsd = revenueUsd - summary.cogsUsd;
  return {
    revenueUsd,
    cogsUsd: summary.cogsUsd,
    grossProfitUsd,
    grossMargin: revenueUsd > 0 ? grossProfitUsd / revenueUsd : 0,
  };
}

/** Compact human-readable tree (for CLI output and logs). */
export function renderTree(root: SpanData, indent = ""): string {
  const dur = root.endTime ? `${root.endTime - root.startTime}ms` : "open";
  const cost = root.costs.api + root.costs.render + root.costs.asset;
  const line = `${indent}${root.name} ${dur}${cost > 0 ? ` $${cost.toFixed(4)}` : ""}${root.status === "error" ? " ✗" : ""}`;
  return [line, ...root.children.map((c) => renderTree(c, `${indent}  `))].join("\n");
}
