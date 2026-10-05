// Observes the unchanged downstream runner from outside its process. Timings
// use a monotonic clock; phase boundaries are observed file/log events, not
// injected probes inside ModerationOS. Native PASS times are receipt times.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import crypto from "node:crypto";

const option = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = option("root");
const variant = option("variant");
const label = option("label");
const exclusion = option("exclude");
if (exclusion && exclusion !== "CAS-05")
  throw new Error("Only the owner-approved CAS-05 exclusion is supported");
if (
  !root ||
  !["baseline", "candidate"].includes(variant) ||
  !/^[a-z0-9-]+$/.test(label ?? "")
) {
  throw new Error(
    "Use --root=<prepared directory> --variant=baseline|candidate --label=<run label>",
  );
}
const copy = fs.realpathSync(path.join(root, variant));
const inventory = JSON.parse(
  fs.readFileSync(path.join(root, "inventory.json")),
);
const preparation = JSON.parse(
  fs.readFileSync(path.join(root, "preparation.json")),
);
const require = createRequire(
  path.join(copy, "apps/telegram-manager/package.json"),
);
const installedPath = require.resolve("telegram-bot-test-server");
const packageData = JSON.parse(
  fs.readFileSync(new URL("../package.json", `file://${installedPath}`)),
);
const sourceHash = crypto
  .createHash("sha256")
  .update(fs.readFileSync(installedPath))
  .digest("hex");
if (
  sourceHash !== preparation[variant].installed.sourceSha256 ||
  packageData.version !== preparation[variant].version
) {
  throw new Error("Installed package differs from recorded preparation");
}
const resultsDir = path.join(root, "runs", `${label}-${variant}`);
fs.mkdirSync(resultsDir, { recursive: true });
const safeEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  NO_COLOR: "1",
};
const dockerNames = () =>
  execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
let active;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (active) active.kill(signal);
    process.exitCode = signal === "SIGINT" ? 130 : 143;
  });
}

async function run(workload) {
  const args = [
    "apps/telegram-manager/scripts/telegram-dashboard-stack-e2e.mjs",
    "--bot-defense",
  ];
  const casCases = inventory.cas.filter(
    (scenario) => scenario.id !== exclusion,
  );
  if (workload === "cas")
    args.push(
      `--appeals-scenario=${casCases.map((scenario) => scenario.id).join(",")}`,
    );
  const expected =
    workload === "cas"
      ? casCases.map((s) => s.id)
      : [...inventory.native, ...inventory.defaultAppeals.map((s) => s.id)];
  const existingContainers = dockerNames();
  const at = performance.now();
  const elapsed = () => performance.now() - at;
  const row = {
    label,
    variant,
    workload,
    command: ["node", ...args].join(" "),
    cwd: copy,
    version: packageData.version,
    installedPath,
    sourceHash,
    existingContainers,
    observer:
      "external filesystem/log events; phase timestamps include observer scheduling latency",
    events: {},
    nativeReceipts: [],
  };
  const out = fs.openSync(path.join(resultsDir, `${workload}.log`), "a");
  let child,
    artifact,
    directoryWatch,
    nativeWatch,
    tmpWatch,
    nativeOffset = 0,
    nativeRemainder = "",
    stdout = "";
  const mark = (key) => {
    if (!(key in row.events)) {
      row.events[key] = elapsed();
      console.log(
        `${label}/${variant}/${workload} ${key} ${(row.events[key] / 1000).toFixed(3)}s`,
      );
    }
  };
  function readNative() {
    if (!artifact) return;
    const file = path.join(artifact, "bot-defense.log");
    if (!fs.existsSync(file)) return;
    const length = fs.statSync(file).size - nativeOffset;
    if (length <= 0) return;
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(length);
    try {
      fs.readSync(fd, buffer, 0, length, nativeOffset);
    } finally {
      fs.closeSync(fd);
    }
    nativeOffset += length;
    const lines = (nativeRemainder + buffer.toString()).split("\n");
    nativeRemainder = lines.pop();
    for (const line of lines) {
      const match = line.match(/^PASS \[([^\]]+)\]:/);
      if (match && !row.nativeReceipts.some((r) => r.id === match[1])) {
        row.nativeReceipts.push({ id: match[1], observed_ms: elapsed() });
        console.log(
          `${label}/${variant}/${workload} PASS ${match[1]} (${row.nativeReceipts.length}/${inventory.native.length})`,
        );
      }
      if (line === "Bot Defense complete live E2E matrix passed.")
        mark("native_complete");
    }
  }
  function inspectFile(filename) {
    if (filename === "migrate.log") mark("migration_start");
    if (filename === "fake.log") mark("migration_complete_fixture_start");
    if (filename === "api.log") mark("fixture_complete_app_start");
    if (filename === "bot-defense.log") {
      mark("ready_native_start");
      nativeWatch ??= fs.watch(
        path.join(artifact, "bot-defense.log"),
        readNative,
      );
      readNative();
    }
    if (filename === "appeals.log")
      mark(workload === "cas" ? "ready_cas_start" : "browser_start");
    if (filename.startsWith("cleanup-")) mark("container_cleanup_start");
  }
  function discover() {
    if (artifact || !child) return;
    const found = fs
      .readdirSync("/tmp")
      .find(
        (name) =>
          name.startsWith("modos-bot-dashboard-e2e-") &&
          name.endsWith(`-${child.pid}`),
      );
    if (!found) return;
    artifact = path.join("/tmp", found);
    row.artifact = artifact;
    mark("artifact_created");
    directoryWatch = fs.watch(artifact, (_, filename) => {
      if (filename) inspectFile(String(filename));
    });
    for (const filename of fs.readdirSync(artifact)) inspectFile(filename);
  }
  try {
    tmpWatch = fs.watch("/tmp", discover);
    child = spawn(process.execPath, args, {
      cwd: copy,
      env: safeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    active = child;
    row.pid = child.pid;
    discover();
    child.stdout.on("data", (chunk) => {
      fs.writeSync(out, chunk);
      stdout += chunk;
      discover();
      if (stdout.includes("Evidence and results.json:"))
        mark("scenario_complete_cleanup_start");
      if (stdout.includes("Cleanup complete; artifacts"))
        mark("cleanup_complete");
    });
    child.stderr.on("data", (chunk) => {
      fs.writeSync(out, chunk);
      mark("failure_cleanup_start");
      discover();
    });
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    row.status = status;
    row.total_ms = elapsed();
    readNative();
    const native =
      artifact && fs.existsSync(path.join(artifact, "bot-defense.log"))
        ? fs.readFileSync(path.join(artifact, "bot-defense.log"), "utf8")
        : "";
    const nativePassed = [
      ...new Set(
        [...native.matchAll(/^PASS \[([^\]]+)\]:/gm)].map((match) => match[1]),
      ),
    ];
    const reportPath = artifact && path.join(artifact, "appeals/results.json");
    const appeals =
      reportPath && fs.existsSync(reportPath)
        ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
        : null;
    row.scenarioResults = [
      ...nativePassed.map((id) => ({
        id,
        status: "PASS",
        timing: "no per-scenario duration in existing native report",
      })),
      ...(appeals?.results ?? []),
    ];
    const executed = new Set(row.scenarioResults.map((r) => r.id));
    row.inventory = {
      expected: expected.length,
      expectedIds: expected,
      executed: executed.size,
      passed: row.scenarioResults.filter((r) => r.status === "PASS").length,
      failed: row.scenarioResults.filter((r) => r.status === "FAIL").length,
      skipped: row.scenarioResults.filter((r) => r.status === "SKIP").length,
      missing: expected.filter((id) => !executed.has(id)),
      unexpected: [...executed].filter((id) => !expected.includes(id)),
    };
    row.accepted =
      status.code === 0 &&
      row.inventory.passed === expected.length &&
      row.inventory.failed === 0 &&
      row.inventory.skipped === 0 &&
      !row.inventory.missing.length &&
      !row.inventory.unexpected.length;
    const e = row.events;
    const difference = (start, end) =>
      start in e && end in e ? e[end] - e[start] : null;
    row.phases_ms = {
      initial_startup: e.migration_start ?? null,
      migration: difference(
        "migration_start",
        "migration_complete_fixture_start",
      ),
      fixtures: difference(
        "migration_complete_fixture_start",
        "fixture_complete_app_start",
      ),
      app_readiness: difference(
        "fixture_complete_app_start",
        workload === "cas" ? "ready_cas_start" : "ready_native_start",
      ),
      native: difference("ready_native_start", "native_complete"),
      native_teardown_transition: difference(
        "native_complete",
        "browser_start",
      ),
      browser: difference("browser_start", "scenario_complete_cleanup_start"),
      cas: difference("ready_cas_start", "scenario_complete_cleanup_start"),
      cleanup: difference(
        "scenario_complete_cleanup_start" in e
          ? "scenario_complete_cleanup_start"
          : "failure_cleanup_start",
        "cleanup_complete",
      ),
    };
  } catch (error) {
    row.observerError = error.message;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
    }
    row.total_ms = elapsed();
  } finally {
    active = null;
    tmpWatch?.close();
    directoryWatch?.close();
    nativeWatch?.close();
    fs.closeSync(out);
    // Only exact names belonging to this runner may be cleaned up.
    const id =
      artifact &&
      path.basename(artifact).slice("modos-bot-dashboard-e2e-".length);
    const owned = id
      ? [`modos-dashboard-e2e-pg-${id}`, `modos-dashboard-e2e-redis-${id}`]
      : [];
    let remaining = dockerNames().filter((name) => owned.includes(name));
    row.cleanupInterventions = remaining;
    if (remaining.length)
      execFileSync("docker", ["rm", "-f", ...remaining], { stdio: "ignore" });
    remaining = dockerNames().filter((name) => owned.includes(name));
    row.remainingOwnedContainers = remaining;
    function ownedProcesses() {
      let output;
      try {
        output = execFileSync("lsof", ["-n", "-d", "cwd", "-Fpn"], {
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
        });
      } catch (error) {
        if (error.status !== 1) throw error;
        output = error.stdout?.toString() ?? "";
      }
      return [...output.matchAll(/^p(\d+)\nn(.+)$/gm)]
        .filter(([, , cwd]) => cwd === copy || cwd.startsWith(copy + "/"))
        .map(([, pid]) => Number(pid));
    }
    const leftovers = ownedProcesses();
    row.processCleanupInterventions = leftovers;
    for (const pid of leftovers) {
      try {
        process.kill(pid, "SIGCONT");
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    if (leftovers.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      for (const pid of ownedProcesses()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }
    row.remainingOwnedProcesses = ownedProcesses();
    if (
      leftovers.length ||
      remaining.length ||
      row.remainingOwnedProcesses.length
    )
      row.accepted = false;
    fs.writeFileSync(
      path.join(resultsDir, `${workload}.json`),
      JSON.stringify(row, null, 2) + "\n",
    );
    console.log(
      `${label}/${variant}/${workload} FINISHED ${JSON.stringify({ accepted: row.accepted, seconds: row.total_ms / 1000, inventory: row.inventory, artifact })}`,
    );
  }
  return row;
}

const started = performance.now();
const rows = [];
const only = option("only");
if (only && !["default", "cas"].includes(only))
  throw new Error("--only must be default or cas");
const selectedWorkloads = only ? [only] : ["default", "cas"];
for (const workload of selectedWorkloads) {
  if (process.exitCode) break;
  rows.push(await run(workload));
}
const result = {
  label,
  variant,
  node: process.version,
  nodePath: process.execPath,
  moderationOSCommit: preparation.moderationOSCommit,
  rows,
  accepted:
    rows.length === selectedWorkloads.length && rows.every((r) => r.accepted),
  explicitlyExcluded: exclusion
    ? [
        {
          id: exclusion,
          reason:
            "Owner instructed exclusion during this task; CAS expiry policy is being reviewed by another agent",
        },
      ]
    : [],
  total_ms: performance.now() - started,
};
fs.writeFileSync(
  path.join(resultsDir, "workload.json"),
  JSON.stringify(result, null, 2) + "\n",
);
process.exitCode = result.accepted ? 0 : 1;
