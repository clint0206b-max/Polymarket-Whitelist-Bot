// Simple concurrency-limited queue for HTTP calls

export function createHttpQueue(cfg, health) {
  const concurrency = Number(cfg?.polling?.http_max_concurrency || 2);
  const queueMax = Number(cfg?.polling?.http_queue_max || 30);

  let running = 0;
  const q = [];

  async function pump() {
    while (running < concurrency && q.length) {
      const { fn, resolve } = q.shift();
      running++;
      (async () => {
        try {
          const v = await fn();
          resolve(v);
        } finally {
          running--;
          pump();
        }
      })();
    }
  }

  function enqueue(fn, dropMeta = {}) {
    if (q.length >= queueMax) {
      if (health) health.http_queue_dropped_count = (health.http_queue_dropped_count || 0) + 1;
      return Promise.resolve({ ok: false, dropped_by_queue: true, ...dropMeta });
    }
    return new Promise((resolve) => {
      q.push({ fn, resolve });
      pump();
    });
  }

  return { enqueue };
}
