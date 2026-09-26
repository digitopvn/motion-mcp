import { MotionError } from "@motion-mcp/shared";

export type JobTask = (signal: AbortSignal) => Promise<void>;

interface Entry {
  jobId: string;
  task: JobTask;
  controller: AbortController;
  settled: Promise<void>;
  resolve: () => void;
}

/**
 * In-process FIFO job queue with bounded concurrency. Tasks own their persistence (status, progress,
 * errors); the queue only schedules, cancels and reports when a task has settled. Task errors are
 * swallowed here because the task records them on the job.
 */
export class JobQueue {
  private readonly pending: Entry[] = [];
  private readonly running = new Map<string, Entry>();
  private readonly all = new Map<string, Entry>();
  private closed = false;

  constructor(
    private readonly concurrency: number,
    private readonly onTaskError?: (jobId: string, err: unknown) => void,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new MotionError("CONFIG", "Job concurrency must be a positive integer");
    }
  }

  get size(): { pending: number; running: number } {
    return { pending: this.pending.length, running: this.running.size };
  }

  enqueue(jobId: string, task: JobTask): void {
    if (this.closed) throw new MotionError("RATE_LIMITED", "Server is shutting down; try again shortly");
    if (this.all.has(jobId)) throw new MotionError("CONFLICT", `Job ${jobId} is already queued`);
    let resolve!: () => void;
    const settled = new Promise<void>((r) => {
      resolve = r;
    });
    const entry: Entry = { jobId, task, controller: new AbortController(), settled, resolve };
    this.all.set(jobId, entry);
    this.pending.push(entry);
    this.pump();
  }

  /** Resolves when the job has finished (any outcome); immediately when the job is unknown. */
  settled(jobId: string): Promise<void> {
    return this.all.get(jobId)?.settled ?? Promise.resolve();
  }

  isActive(jobId: string): boolean {
    return this.all.has(jobId);
  }

  /** Abort a queued or running job. Returns false when the job is not in this queue. */
  cancel(jobId: string, reason = "cancelled"): boolean {
    const entry = this.all.get(jobId);
    if (!entry) return false;
    entry.controller.abort(new MotionError("CANCELLED", reason));
    return true;
  }

  /**
   * Stop accepting jobs, let running jobs finish for up to `graceMs`, then abort whatever is left.
   * Queued jobs that never started are aborted immediately (their task still runs once to record it).
   */
  async close(graceMs = 30_000): Promise<void> {
    this.closed = true;
    for (const entry of this.pending) entry.controller.abort(new MotionError("CANCELLED", "server shutdown"));
    const everything = () => Promise.all([...this.all.values()].map((e) => e.settled));
    const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), graceMs).unref());
    if ((await Promise.race([everything(), timer])) === "timeout") {
      for (const entry of this.all.values()) {
        entry.controller.abort(new MotionError("CANCELLED", "server shutdown"));
      }
      await everything();
    }
  }

  private pump(): void {
    while (this.running.size < this.concurrency) {
      const entry = this.pending.shift();
      if (!entry) return;
      this.running.set(entry.jobId, entry);
      void this.execute(entry);
    }
  }

  private async execute(entry: Entry): Promise<void> {
    try {
      await entry.task(entry.controller.signal);
    } catch (err) {
      this.onTaskError?.(entry.jobId, err);
    } finally {
      this.running.delete(entry.jobId);
      this.all.delete(entry.jobId);
      entry.resolve();
      this.pump();
    }
  }
}
