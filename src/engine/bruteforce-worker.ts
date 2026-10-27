/**
 * Brute-force work in a worker thread (see bruteforce.ts): one shard of the tree walk, or, as a
 * persistent worker, slices of a GPU shortlist scored exactly, one message per slice.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { loadSnapshot } from '../data.ts';
import { runShard, scoreCombinations, type BruteForcePlan } from './bruteforce.ts';
import { rivenShard, type RivenShardJob } from './riven-picker.ts';

const { plan, snapshotPath, shard, shards, limit, persistent } = workerData as {
  plan: BruteForcePlan;
  snapshotPath?: string;
  shard: number;
  shards: number;
  limit: number;
  /** Stay up and score `{ plan, limit, combinations }` messages instead of walking a tree. */
  persistent?: boolean;
};

const snapshot = loadSnapshot(snapshotPath);
if (persistent) {
  parentPort!.on('message', (job: ({ kind: 'combinations'; plan: BruteForcePlan; limit: number; combinations: string[][] }) | RivenShardJob) => {
    try {
      const result = job.kind === 'riven' ? rivenShard(snapshot, job) : scoreCombinations(snapshot, job.plan, job.combinations, job.limit);
      parentPort!.postMessage({ type: 'done', result });
    } catch (error) {
      parentPort!.postMessage({ type: 'error', message: String((error as Error).message ?? error) });
    }
  });
} else {
  const result = runShard(snapshot, plan, shard, shards, limit, (done) => parentPort!.postMessage({ type: 'progress', done }));
  parentPort!.postMessage({ type: 'done', result });
}
