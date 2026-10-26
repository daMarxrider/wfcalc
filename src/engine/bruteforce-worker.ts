/** One shard of a brute-force search, run in a worker thread (see bruteforce.ts). */
import { parentPort, workerData } from 'node:worker_threads';
import { loadSnapshot } from '../data.ts';
import { runShard, type BruteForcePlan } from './bruteforce.ts';

const { plan, snapshotPath, shard, shards, limit } = workerData as {
  plan: BruteForcePlan;
  snapshotPath?: string;
  shard: number;
  shards: number;
  limit: number;
};

const snapshot = loadSnapshot(snapshotPath);
const result = runShard(snapshot, plan, shard, shards, limit, (done) => parentPort!.postMessage({ type: 'progress', done }));
parentPort!.postMessage({ type: 'done', result });
