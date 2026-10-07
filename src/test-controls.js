/**
 * Instance-owned scheduling; network and diagnostic deadlines remain wall-clock.
 *
 * Real time with no options; a manual clock with { now }, which only advance
 * moves; or a running clock with { offset }: real time plus an offset that
 * advance adds to, so time keeps moving between jumps.
 */
export function createClock(options) {
  const mode =
    options == null
      ? "real"
      : options.offset === undefined
        ? "manual"
        : "running";
  if (mode === "running" && options.now !== undefined)
    throw new TypeError("clock takes now or offset, not both");
  let time = options?.now;
  if (mode === "manual" && (!Number.isSafeInteger(time) || time < 0))
    throw new TypeError(
      "clock.now must be a non-negative millisecond timestamp",
    );
  let offset = mode === "running" ? options.offset : 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new TypeError("clock.offset must be non-negative milliseconds");
  const tasks = new Set();
  let sequence = 0;
  let advances = 0;
  let advanceQueue = Promise.resolve();
  const now = () => (mode === "manual" ? time : Date.now() + offset);
  function schedule(fn, ms, { passive = false } = {}) {
    const task = { at: now() + ms, sequence: sequence++, fn, passive };
    tasks.add(task);
    const cancel = () => {
      clearTimeout(task.timer);
      tasks.delete(task);
    };
    if (mode !== "manual") {
      // Real and running time fire a task by a timer; a running clock's jump
      // arms it again (advance).
      task.arm = () => {
        clearTimeout(task.timer);
        task.timer = setTimeout(
          () => {
            if (task.at > now()) task.arm();
            else {
              tasks.delete(task);
              fn();
            }
          },
          Math.min(2 ** 31 - 1, Math.max(0, task.at - now())),
        );
        task.timer.unref();
      };
      task.arm();
    }
    return cancel;
  }
  return {
    now,
    schedule,
    state: () => ({
      mode,
      now: now(),
      ...(mode === "running" ? { offset } : {}),
      scheduled: tasks.size,
    }),
    busy: () => advances > 0 || [...tasks].some((t) => !t.passive),
    async advance(ms) {
      if (mode === "real")
        throw new Error("advanceTime requires a manual clock");
      if (
        !Number.isSafeInteger(ms) ||
        ms < 0 ||
        !Number.isSafeInteger(now() + ms)
      )
        throw new TypeError(
          "advanceTime requires non-negative safe milliseconds",
        );
      advances += 1;
      const work = advanceQueue
        .then(async () => {
          if (!Number.isSafeInteger(now() + ms))
            throw new TypeError("Clock timestamp overflow");
          // A manual clock ends at a time; a running clock at an offset, so
          // its end keeps moving with real time while due tasks run.
          const target = (mode === "manual" ? time : offset) + ms;
          const end = () => (mode === "manual" ? target : Date.now() + target);
          while (true) {
            const limit = end();
            const due = [...tasks]
              .filter((t) => t.at <= limit)
              .sort((a, b) => a.at - b.at || a.sequence - b.sequence)[0];
            if (!due) break;
            // Each task runs at its deadline, and time never goes back.
            if (mode === "manual") time = due.at;
            else offset = Math.max(offset, due.at - Date.now());
            clearTimeout(due.timer);
            tasks.delete(due);
            due.fn();
            await Promise.resolve();
          }
          if (mode === "manual") time = target;
          else offset = target;
          // A timer armed before a running clock's jump would fire late.
          for (const task of tasks) task.arm?.();
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
    /** What a snapshot keeps: a manual clock's time and a running clock's offset. */
    save: () => ({ time, offset }),
    /** Set a manual clock's time or a running clock's offset back; real time stays. */
    restore(saved) {
      if (mode === "manual") time = saved.time;
      if (mode === "running") offset = saved.offset;
    },
    clear() {
      for (const t of tasks) clearTimeout(t.timer);
      tasks.clear();
    },
  };
}

/**
 * No polling: evaluate at registration and when this instance changes state.
 * `onNotify` hears of every change, after the waits have checked it.
 */
export function createWaits({ onNotify } = {}) {
  const pending = new Set();
  let stopped = false;
  return {
    get size() {
      return pending.size;
    },
    notify() {
      for (const waiter of [...pending]) waiter.check();
      onNotify?.();
    },
    cancel(reason, stop = false) {
      stopped ||= stop;
      for (const waiter of [...pending]) waiter.fail(new Error(reason));
    },
    wait(read, timeoutMs = 1000, describe = () => "exact fake state") {
      if (stopped) return Promise.reject(new Error("Server stopped"));
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
                  `Wait deadline ${timeoutMs}ms exceeded: ${describe()}`,
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
