interface RunBatchSlicesOptions<T> {
  records: T[];
  batchSize: number;
  isInterrupted: () => boolean;
  isPaused: () => boolean;
  runSlice: (slice: T[]) => Promise<void>;
  pausePollMs?: number;
}

export async function runBatchSlices<T>({
  records,
  batchSize,
  isInterrupted,
  isPaused,
  runSlice,
  pausePollMs = 200,
}: RunBatchSlicesOptions<T>): Promise<'completed' | 'interrupted'> {
  for (let i = 0; i < records.length; i += batchSize) {
    if (isInterrupted()) return 'interrupted';
    while (isPaused()) {
      await new Promise((resolve) => window.setTimeout(resolve, pausePollMs));
      if (isInterrupted()) return 'interrupted';
    }
    await runSlice(records.slice(i, i + batchSize));
  }
  return isInterrupted() ? 'interrupted' : 'completed';
}
