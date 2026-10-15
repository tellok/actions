const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { execFileSync } = require("node:child_process");
const script = join(__dirname, "../lib/cache.py");
const call = (op, value) =>
  JSON.parse(
    execFileSync("python3", [script, op], {
      input: JSON.stringify(value),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
async function root(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), "build-cache-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const config = (dir) => ({
  "cache-root": dir,
  "cache-namespace": "example/project",
  "read-scopes": "main",
  "write-scope": "main",
  "keep-generations": "1",
});
async function complete(state, value = "lock-A") {
  await fs.writeFile(
    join(state.export, "index.json"),
    JSON.stringify({ manifests: [value] }),
  );
  call("commit", state);
  return join(state.root, state.scope, "complete-" + state.token);
}
test("same build input reuses a completed generation", async (t) => {
  const dir = await root(t),
    one = call("prepare", config(dir));
  const gen = await complete(one);
  call("release", one);
  const two = call("prepare", config(dir));
  assert.equal(two.imports, "type=local,src=" + gen);
  call("release", two);
});
test("source-only update retains dependency cache imports", async (t) => {
  const dir = await root(t),
    one = call("prepare", config(dir));
  await complete(one, "dependency-lock");
  call("release", one);
  const changed = call("prepare", { ...config(dir), execution: "source-B" });
  assert.match(
    await fs.readFile(join(changed.imports.slice(15), "index.json"), "utf8"),
    /dependency-lock/,
  );
  call("release", changed);
});
test("lock update publishes a distinct complete generation", async (t) => {
  const dir = await root(t),
    one = call("prepare", config(dir));
  await complete(one, "lock-A");
  call("release", one);
  const two = call("prepare", config(dir));
  const gen = await complete(two, "lock-B");
  assert.match(await fs.readFile(join(gen, "index.json"), "utf8"), /lock-B/);
  assert.notEqual(one.token, two.token);
  call("release", two);
});
test("concurrent writers publish independent complete generations", async (t) => {
  const dir = await root(t),
    one = call("prepare", config(dir)),
    two = call("prepare", config(dir));
  assert.notEqual(one.export, two.export);
  await Promise.all([complete(one), complete(two)]);
  const link = await fs.readlink(join(one.root, "main/current"));
  assert.ok([one, two].some((x) => link === "complete-" + x.token));
  call("release", one);
  call("release", two);
});
test("active reader protects an older generation during collection", async (t) => {
  const dir = await root(t),
    one = call("prepare", config(dir));
  const old = await complete(one);
  call("release", one);
  const reader = call("prepare", { ...config(dir), "write-scope": "" });
  const two = call("prepare", config(dir));
  await complete(two);
  call("release", two);
  await fs.access(old);
  call("release", reader);
  await assert.rejects(fs.access(old));
});
test("interrupted export leaves previous pointer and other writer untouched", async (t) => {
  const dir = await root(t),
    one = call("prepare", config(dir));
  const old = await complete(one);
  call("release", one);
  const broken = call("prepare", config(dir)),
    other = call("prepare", config(dir));
  assert.throws(() => call("commit", broken));
  call("release", broken);
  await fs.access(other.export);
  assert.equal(await fs.realpath(join(one.root, "main/current")), old);
  call("release", other);
});
test("read-only scopes and path escapes cannot overwrite shared cache", async (t) => {
  const dir = await root(t);
  const state = call("prepare", { ...config(dir), "write-scope": "" });
  assert.equal(call("commit", state).published, false);
  call("release", state);
  assert.throws(() =>
    call("prepare", { ...config(dir), "cache-namespace": "../escape" }),
  );
  const evil = join(dir, "elsewhere");
  await fs.mkdir(evil);
  await fs.mkdir(join(state.root, "main"), { recursive: true });
  await fs.symlink(evil, join(state.root, "main/current"));
  assert.throws(() => call("prepare", config(dir)));
});

test("multiple load platforms fail even when caching is disabled", () => {
  for (const platforms of [
    "linux/amd64,linux/arm64",
    "linux/amd64\nlinux/arm64",
  ])
    assert.throws(() => call("prepare", { platforms }), /exactly one platform/);
  assert.equal(call("prepare", { platforms: "linux/arm/v7" }).enabled, false);
});
test("invalid numeric limits create no lease or pending export", async (t) => {
  const dir = await root(t);
  const initial = call("prepare", config(dir));
  await complete(initial);
  call("release", initial);
  for (const [key, value] of [
    ["max-generation-bytes", "bad"],
    ["max-total-bytes", "-1"],
    ["keep-generations", "0"],
    ["keep-generations", "1.5"],
  ]) {
    assert.throws(
      () => call("prepare", { ...config(dir), [key]: value }),
      /Invalid cache limit/,
    );
    const names = await fs.readdir(join(initial.root, "main"));
    assert.equal(
      names.some((name) => name.startsWith("pending-")),
      false,
    );
    const leases = await fs
      .readdir(join(initial.root, "main/.leases"))
      .catch(() => []);
    assert.deepEqual(leases, []);
  }
});

for (const [label, invalid] of [
  ["later read scope", { "read-scopes": "main ../invalid" }],
  ["write scope", { "write-scope": "../invalid" }],
]) {
  test(`malformed ${label} fails before acquiring any reader lease`, async (t) => {
    const dir = await root(t),
      initial = call("prepare", config(dir));
    const generation = await complete(initial);
    call("release", initial);
    assert.throws(
      () => call("prepare", { ...config(dir), ...invalid }),
      /Invalid cache namespace or scope/,
    );
    assert.deepEqual(
      await fs.readdir(join(initial.root, "main/.leases")).catch(() => []),
      [],
    );
    assert.equal(
      (await fs.readdir(join(initial.root, "main"))).some((name) =>
        name.startsWith("pending-"),
      ),
      false,
    );
    assert.equal(
      await fs.realpath(join(initial.root, "main/current")),
      generation,
    );
  });
}

for (const failure of ["mkdtemp", "writeFile"]) {
  test(`cache state ${failure} failure releases real leases and pending export`, async (t) => {
    const dir = await root(t),
      initial = call("prepare", config(dir));
    const generation = await complete(initial);
    call("release", initial);
    const runnerTemp = join(dir, "runner-temp");
    await fs.mkdir(runnerTemp);
    const yaml = require("yaml"),
      nodePath = require("node:path");
    const action = yaml.parse(
      await fs.readFile(join(__dirname, "../action.yml"), "utf8"),
    );
    const code = action.runs.steps.find((step) => step.id === "cache").with
      .script;
    const AsyncFunction = Object.getPrototypeOf(
      async function () {},
    ).constructor;
    const operations = [],
      outputs = [];
    const injectedRequire = (name) => {
      if (name === "node:fs/promises")
        return {
          ...fs,
          [failure]: async () => {
            throw new Error("injected state persistence failure");
          },
        };
      if (name === "node:child_process")
        return {
          execFileSync: (program, args, options) => {
            operations.push(args[1]);
            return execFileSync(program, args, options);
          },
        };
      return require(name);
    };
    await assert.rejects(
      new AsyncFunction("require", "process", "context", "core", code)(
        injectedRequire,
        {
          env: {
            ...process.env,
            RUNNER_TEMP: runnerTemp,
            TOOLKIT_ACTION_PATH: nodePath.resolve(__dirname, ".."),
            TOOLKIT_INPUTS: JSON.stringify(config(dir)),
          },
        },
        { repo: { owner: "example", repo: "project" }, runId: 1, job: "build" },
        { setOutput: (...args) => outputs.push(args) },
      ),
      /injected state persistence failure/,
    );
    assert.deepEqual(operations, ["prepare", "release"]);
    assert.deepEqual(outputs, []);
    assert.deepEqual(await fs.readdir(join(initial.root, "main/.leases")), []);
    assert.equal(
      (await fs.readdir(join(initial.root, "main"))).some((name) =>
        name.startsWith("pending-"),
      ),
      false,
    );
    assert.deepEqual(await fs.readdir(runnerTemp), []);
    assert.equal(
      await fs.realpath(join(initial.root, "main/current")),
      generation,
    );
  });
}
test("retention keeps the latest publications despite reversed writer start order and directory timestamps", async (t) => {
  const dir = await root(t),
    settings = { ...config(dir), "keep-generations": "2", "read-scopes": "" };
  const slow = call("prepare", settings),
    fast = call("prepare", settings);
  const fastGeneration = await complete(fast, "fast");
  const slowGeneration = await complete(slow, "slow");
  call("release", fast);
  call("release", slow);
  await fs.utimes(
    fastGeneration,
    new Date("2040-01-01"),
    new Date("2040-01-01"),
  );
  await fs.utimes(
    slowGeneration,
    new Date("2000-01-01"),
    new Date("2000-01-01"),
  );
  const third = call("prepare", settings),
    latest = await complete(third, "third");
  call("release", third);
  await assert.rejects(fs.access(fastGeneration), { code: "ENOENT" });
  await fs.access(slowGeneration);
  await fs.access(latest);
  assert.equal(await fs.realpath(join(third.root, "main/current")), latest);
});
test("parent and nested namespaces cannot share locks, scopes or complete generations", async (t) => {
  const dir = await root(t);
  const outer = call("prepare", {
    ...config(dir),
    "cache-namespace": "a",
    "read-scopes": "",
    "write-scope": "b",
  });
  const generation = await complete(outer, "outer");
  const before = await fs.readdir(generation);
  const inner = call("prepare", {
    ...config(dir),
    "cache-namespace": "a/b",
    "read-scopes": "",
    "write-scope": "current",
  });
  assert.notEqual(inner.root, outer.root);
  assert.equal(inner.export.startsWith(outer.root + "/"), false);
  assert.equal(outer.export.startsWith(inner.root + "/"), false);
  await complete(inner, "inner");
  call("release", inner);
  call("release", outer);
  assert.deepEqual(await fs.readdir(generation), before);
  assert.equal(await fs.realpath(join(outer.root, "b/current")), generation);
  assert.match(
    await fs.readFile(join(generation, "index.json"), "utf8"),
    /outer/,
  );
});
test("new cache layout does not import or delete legacy overlapping directories", async (t) => {
  const dir = await root(t),
    legacy = join(dir, "a/b"),
    oldGeneration = join(legacy, "complete-old");
  await fs.mkdir(oldGeneration, { recursive: true });
  await fs.writeFile(join(oldGeneration, "index.json"), "{}");
  await fs.symlink("complete-old", join(legacy, "current"));
  const state = call("prepare", {
    ...config(dir),
    "cache-namespace": "a",
    "read-scopes": "b",
    "write-scope": "b",
  });
  assert.equal(state.imports, "");
  await complete(state);
  call("release", state);
  assert.equal(
    await fs.realpath(join(legacy, "current")),
    await fs.realpath(oldGeneration),
  );
  await fs.access(join(oldGeneration, "index.json"));
});
