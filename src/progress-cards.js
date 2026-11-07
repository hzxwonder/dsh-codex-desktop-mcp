import { randomBytes, randomUUID } from 'node:crypto';
import { createMonitor } from './monitor.js';

export const progressResourceUri = 'ui://dsh/progress-v1.html';

export function createProgressCards({ secret } = {}) {
  const runs = new Map();
  const find = (id) => {
    const run = runs.get(id);
    if (!run) throw new Error('Progress card expired or unavailable.');
    return run;
  };
  return {
    open() {
      if (runs.size >= 20) {
        const oldest = [...runs].find(([, run]) => run.status !== 'running');
        if (!oldest) throw new Error('Progress card limit reached.');
        runs.delete(oldest[0]);
      }
      const progress_id = randomUUID();
      const view_token = randomBytes(32).toString('hex');
      runs.set(progress_id, { view_token, status: 'waiting', monitor: createMonitor({ secret }) });
      return { progress_id, view_token };
    },
    attach(id) {
      const run = find(id);
      if (run.status !== 'waiting') throw new Error('Use a new progress card for each delegation.');
      run.status = 'running';
      return {
        publish(event) {
          if (event.type === 'run_end') run.status = event.status;
          run.monitor.publish(event);
        },
        finish(status) {
          if (run.status === 'running') {
            run.status = status;
            run.monitor.publish({ type: 'run_end', status });
          }
        },
      };
    },
    read(id, token, after = 0) {
      const run = find(id);
      if (typeof token !== 'string' || token !== run.view_token) throw new Error('Progress access denied.');
      const { events, sequence } = run.monitor.snapshot();
      return { progress_id: id, status: run.status, events: events.filter(({ id }) => id > after), next_seq: sequence };
    },
  };
}
