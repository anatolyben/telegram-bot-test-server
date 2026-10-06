/** Instance-owned scheduling; network and diagnostic deadlines remain wall-clock. */
export function createClock(options) {
  const manual = options != null;
  let time = options?.now;
  if (manual && (!Number.isSafeInteger(time) || time < 0))
    throw new TypeError(
      "clock.now must be a non-negative millisecond timestamp",
    );
  const tasks = new Set();
  let sequence = 0;
  let advances = 0;
  let advanceQueue = Promise.resolve();
  const now = () => (manual ? time : Date.now());
  function schedule(fn, ms, { passive = false } = {}) {
    const task = { at: now() + ms, sequence: sequence++, fn, passive };
    tasks.add(task);
    const cancel = () => {
      clearTimeout(task.timer);
      tasks.delete(task);
    };
    if (!manual) {
      const arm = () => {
        task.timer = setTimeout(
          () => {
            if (task.at > now()) arm();
            else {
              tasks.delete(task);
              fn();
            }
          },
          Math.min(2 ** 31 - 1, Math.max(0, task.at - now())),
        );
        task.timer.unref();
      };
      arm();
    }
    return cancel;
  }
  return {
    now,
    schedule,
    state: () => ({
      mode: manual ? "manual" : "real",
      now: now(),
      scheduled: tasks.size,
    }),
    busy: () => advances > 0 || [...tasks].some((t) => !t.passive),
    async advance(ms) {
      if (!manual) throw new Error("advanceTime requires a manual clock");
      if (
        !Number.isSafeInteger(ms) ||
        ms < 0 ||
        !Number.isSafeInteger(time + ms)
      )
        throw new TypeError(
          "advanceTime requires non-negative safe milliseconds",
        );
      advances += 1;
      const work = advanceQueue
        .then(async () => {
          if (!Number.isSafeInteger(time + ms))
            throw new TypeError("Clock timestamp overflow");
          const end = time + ms;
          while (true) {
            const due = [...tasks]
              .filter((t) => t.at <= end)
              .sort((a, b) => a.at - b.at || a.sequence - b.sequence)[0];
            if (!due) break;
            time = due.at;
            tasks.delete(due);
            due.fn();
            await Promise.resolve();
          }
          time = end;
          return this.state();
        })
        .finally(() => {
          advances -= 1;
        });
      // Keep the scheduler usable after a rejected advance; the caller still
      // receives and must handle that rejection through the original promise.
      advanceQueue = work.catch(() => {});
      return work;
    },
    restore(value) {
      if (manual) time = value;
    },
    clear() {
      for (const t of tasks) clearTimeout(t.timer);
      tasks.clear();
    },
  };
}

/** No polling: evaluate at registration and when this instance changes state. */
export function createWaits() {
  const pending = new Set();
  let stopped = false;
  return {
    get size() {
      return pending.size;
    },
    notify() {
      for (const waiter of [...pending]) waiter.check();
    },
    cancel(reason, stop = false) {
      stopped ||= stop;
      for (const waiter of [...pending]) waiter.fail(new Error(reason));
    },
    wait(read, timeoutMs = 1000, describe = () => "exact fake state") {
      if (stopped) return Promise.reject(new Error("Fake server stopped"));
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
        return Promise.reject(new TypeError("timeoutMs must be 1-30000"));
      return new Promise((resolve, reject) => {
        let timer;
        const finish = (fn, value) => {
          clearTimeout(timer);
          pending.delete(waiter);
          fn(value);
        };
        const waiter = {
          fail: (error) => finish(reject, error),
          check() {
            try {
              const result = read();
              if (result !== null) finish(resolve, structuredClone(result));
            } catch (error) {
              finish(reject, error);
            }
          },
        };
        pending.add(waiter);
        timer = setTimeout(
          () =>
            waiter.fail(
              Object.assign(
                new Error(
                  `Fake wait deadline ${timeoutMs}ms exceeded: ${describe()}`,
                ),
                { timedOut: true },
              ),
            ),
          timeoutMs,
        );
        waiter.check();
      });
    },
  };
}

/** Diagnostics, unlike the original request journal, never print credentials. */
export function diagnostic(value, secrets = []) {
  const json = JSON.stringify(value, (key, item) =>
    /token|secret|authorization|password|raw_body/i.test(key)
      ? "[redacted]"
      : item,
  );
  let safe = json ?? "null";
  for (const secret of secrets)
    if (secret) safe = safe.split(secret).join("[redacted]");
  safe = safe.replace(/(?:bot)?\b[0-9]{3,}:[A-Za-z0-9_-]+/g, "[redacted]");
  return safe.length > 8000 ? `${safe.slice(0, 8000)}… [truncated]` : safe;
}
