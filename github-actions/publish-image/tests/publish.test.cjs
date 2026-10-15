const test = require("node:test");
const assert = require("node:assert/strict");
const { publish, createDockerClient } = require("../lib/publish.cjs");
const expected = {
  source: "a".repeat(40),
  version: "1.2.3",
  platform: "linux/amd64",
  reference: "registry.test/demo:verified",
  imageId: "sha256:" + "b".repeat(64),
  layers: ["sha256:" + "c".repeat(64)],
};
function fixture() {
  const calls = [],
    refs = new Map(),
    found = {
      digest: "sha256:" + "d".repeat(64),
      image: {
        Id: expected.imageId,
        Os: "linux",
        Architecture: "amd64",
        Config: {
          Labels: {
            "org.opencontainers.image.revision": expected.source,
            "org.opencontainers.image.version": expected.version,
          },
        },
        RootFS: { Layers: expected.layers },
      },
    };
  return {
    calls,
    refs,
    found,
    docker: {
      lookup: async (ref) => refs.get(ref),
      load: async () => calls.push("load"),
      push: async (id, ref) => {
        calls.push("push");
        refs.set(ref, found);
      },
      alias: async (image, digest, ref) => {
        calls.push("alias");
        refs.set(ref, found);
      },
    },
  };
}
const options = (f) => ({
  archive: "verified.tar.gz",
  expected,
  image: "registry.test/demo",
  registry: "registry.test",
  tags: ["1.2.3", "sha-" + expected.source],
  docker: f.docker,
  verify: async () => {
    f.calls.push("verify");
  },
});
test("verified archive is loaded and published without a build", async () => {
  const f = fixture();
  const result = await publish(options(f));
  assert.equal(result.digest, f.found.digest);
  assert.deepEqual(f.calls, ["verify", "load", "push", "alias"]);
});
test("different existing image is updated through normal registry writes", async () => {
  const f = fixture();
  f.refs.set("registry.test/demo:1.2.3", {
    ...f.found,
    image: { ...f.found.image, Id: "sha256:" + "e".repeat(64) },
  });
  assert.equal((await publish(options(f))).digest, f.found.digest);
  assert.deepEqual(f.calls, ["verify", "load", "push", "alias"]);
  assert.equal(
    f.refs.get("registry.test/demo:1.2.3").image.Id,
    expected.imageId,
  );
});
test("verified existing digest is reused without rebuilding or pushing", async () => {
  const f = fixture();
  for (const tag of options(f).tags)
    f.refs.set("registry.test/demo:" + tag, f.found);
  assert.equal((await publish(options(f))).digest, f.found.digest);
  assert.deepEqual(f.calls, ["verify"]);
});
test("registry network and authentication errors are not treated as missing tags", async () => {
  const client = createDockerClient({
    run: () => {
      throw { stderr: "unauthorized: not found" };
    },
  });
  await assert.rejects(
    client.lookup("registry.test/demo:v1", "linux/amd64"),
    /lookup failed/,
  );
});

test("missing tags are published without an immutability confirmation", async () => {
  const f = fixture();
  f.refs.set("registry.test/demo:" + options(f).tags[0], f.found);
  await publish(options(f));
  assert.deepEqual(f.calls, ["verify", "alias"]);
  assert.equal(
    f.refs.get("registry.test/demo:" + options(f).tags[1]).digest,
    f.found.digest,
  );
});
test("registry mismatch fails before archive verification or Docker use", async () => {
  const { validateRegistry } = require("../lib/publish.cjs");
  const f = fixture();
  await assert.rejects(
    publish({ ...options(f), registry: "other.test" }),
    /authenticated registry/,
  );
  assert.deepEqual(f.calls, []);
  assert.equal(validateRegistry("index.docker.io", "example/app"), "docker.io");
  assert.equal(
    validateRegistry("localhost:5000", "localhost:5000/app"),
    "localhost:5000",
  );
  for (const image of [
    "registry.test/app:tag",
    "registry.test/app@sha256:x",
    "registry.test/../app",
  ])
    assert.throws(() => validateRegistry("registry.test", image));
});
test("registry indexes are rejected before pulling any platform", async () => {
  for (const mediaType of [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
  ]) {
    const calls = [];
    const docker = createDockerClient({
      run: (program, args) => {
        calls.push(args);
        return JSON.stringify({ mediaType, digest: fixture().found.digest });
      },
    });
    await assert.rejects(
      docker.lookup("registry.test/demo:v1", "linux/amd64"),
      /not an index/,
    );
    assert.equal(calls.length, 1);
  }
});
test("single registry manifest is pulled by its verified digest", async () => {
  const f = fixture(),
    calls = [];
  const docker = createDockerClient({
    run: (program, args) => {
      calls.push(args);
      if (args[0] === "buildx")
        return JSON.stringify({
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: f.found.digest,
        });
      if (args[0] === "image") return JSON.stringify([f.found.image]);
      return "";
    },
  });
  assert.equal(
    (await docker.lookup("registry.test/demo:v1", expected.platform)).digest,
    f.found.digest,
  );
  assert.ok(calls[1].includes("registry.test/demo@" + f.found.digest));
});
test("ARM variants are part of the registry image identity", () => {
  const { verifyImage } = require("../lib/publish.cjs");
  const image = {
    ...fixture().found.image,
    Architecture: "arm",
    Variant: "v7",
  };
  verifyImage(image, { ...expected, platform: "linux/arm/v7" });
  for (const platform of ["linux/arm/v6", "linux/arm"])
    assert.throws(
      () => verifyImage(image, { ...expected, platform }),
      /platform/,
    );
});
test("archive validation preserves ARM config variants", async (t) => {
  const fs = require("node:fs/promises"),
    path = require("node:path"),
    crypto = require("node:crypto"),
    { execFileSync } = require("node:child_process");
  const { validateArchive } = require("../lib/publish.cjs");
  const dir = await fs.mkdtemp(
    path.join(require("node:os").tmpdir(), "arm-archive-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = JSON.stringify({
    os: "linux",
    architecture: "arm",
    variant: "v7",
    config: fixture().found.image.Config,
    rootfs: { type: "layers", diff_ids: [] },
  });
  const id = crypto.createHash("sha256").update(config).digest("hex");
  await fs.writeFile(path.join(dir, id + ".json"), config);
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify([
      { Config: id + ".json", RepoTags: [expected.reference], Layers: [] },
    ]),
  );
  const archive = path.join(dir, "image.tar.gz");
  execFileSync("tar", [
    "-czf",
    archive,
    "-C",
    dir,
    "manifest.json",
    id + ".json",
  ]);
  const identity = {
    ...expected,
    imageId: "sha256:" + id,
    layers: [],
    platform: "linux/arm/v7",
  };
  await validateArchive(archive, identity);
  await assert.rejects(
    validateArchive(archive, { ...identity, platform: "linux/arm/v6" }),
    /platform/,
  );
});
test("server-side immutability refuses a competing image without replacing its tag", async () => {
  const f = fixture();
  const other = {
    ...f.found,
    digest: "sha256:" + "e".repeat(64),
    image: { ...f.found.image, Id: "sha256:" + "e".repeat(64) },
  };
  f.docker.push = async (id, ref) => {
    f.refs.set(ref, other);
    throw new Error("immutable tag already exists");
  };
  await assert.rejects(publish(options(f)), /conflict/);
  assert.equal(f.refs.get("registry.test/demo:1.2.3"), other);
  assert.equal(f.calls.includes("alias"), false);
});

test("mutable existing alias is updated to the verified publication digest", async () => {
  const f = fixture();
  f.refs.set("registry.test/demo:" + options(f).tags[0], f.found);
  f.refs.set("registry.test/demo:" + options(f).tags[1], {
    ...f.found,
    digest: "sha256:" + "e".repeat(64),
    image: { ...f.found.image, Id: "sha256:" + "e".repeat(64) },
  });
  await publish(options(f));
  assert.deepEqual(f.calls, ["verify", "alias"]);
  for (const tag of options(f).tags)
    assert.equal(
      f.refs.get("registry.test/demo:" + tag).digest,
      f.found.digest,
    );
});
test("registry refusal of an existing tag update cannot report publication success", async () => {
  const f = fixture();
  const old = {
    ...f.found,
    digest: "sha256:" + "e".repeat(64),
    image: { ...f.found.image, Id: "sha256:" + "e".repeat(64) },
  };
  f.refs.set("registry.test/demo:" + options(f).tags[0], old);
  f.docker.push = async () => {
    f.calls.push("push");
    throw new Error("registry forbids tag overwrite");
  };
  await assert.rejects(publish(options(f)), /conflict/);
  assert.equal(f.refs.get("registry.test/demo:" + options(f).tags[0]), old);
  assert.deepEqual(f.calls, ["verify", "load", "push"]);
});
test("registry refusal of an alias update leaves the old alias and fails confirmation", async () => {
  const f = fixture();
  f.refs.set("registry.test/demo:" + options(f).tags[0], f.found);
  const old = { ...f.found, digest: "sha256:" + "e".repeat(64) };
  f.refs.set("registry.test/demo:" + options(f).tags[1], old);
  f.docker.alias = async () => {
    throw new Error("registry forbids tag overwrite");
  };
  await assert.rejects(publish(options(f)), /unconfirmed/);
  assert.equal(f.refs.get("registry.test/demo:" + options(f).tags[1]), old);
});
test("source reuse policy remains available without forcing a new image push", async () => {
  const f = fixture();
  const sameSource = {
    ...f.found,
    image: { ...f.found.image, Id: "sha256:" + "e".repeat(64) },
  };
  for (const tag of options(f).tags)
    f.refs.set("registry.test/demo:" + tag, sameSource);
  assert.equal(
    (await publish({ ...options(f), existingPolicy: "source" })).imageId,
    sameSource.image.Id,
  );
  assert.deepEqual(f.calls, ["verify"]);
});

for (const [label, tags] of [
  ["null", [null]],
  ["boolean", [true]],
  ["number", [1]],
  ["mixed coerced duplicates", [1, "1"]],
  ["object", [{}]],
  ["duplicate strings", ["1", "1"]],
]) {
  test(`publication rejects ${label} tags before any registry operation`, async () => {
    const f = fixture();
    f.docker.lookup = async () => {
      throw new Error("Registry must not be accessed");
    };
    await assert.rejects(
      publish({ ...options(f), tags }),
      /Invalid publication references/,
    );
    assert.deepEqual(f.calls, ["verify"]);
  });
}
test("numeric-looking destination tags remain valid when explicitly supplied as strings", async () => {
  const f = fixture();
  const tags = ["1", "null", "true"];
  await publish({ ...options(f), tags });
  for (const tag of tags)
    assert.equal(
      f.refs.get("registry.test/demo:" + tag).digest,
      f.found.digest,
    );
});

async function layeredArchive(
  t,
  { count = 4, corrupt = false, symlink = false } = {},
) {
  const fs = require("node:fs/promises"),
    path = require("node:path"),
    crypto = require("node:crypto"),
    zlib = require("node:zlib"),
    { execFileSync } = require("node:child_process");
  const dir = await fs.mkdtemp(
    path.join(require("node:os").tmpdir(), "layer-validation-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const entries = [],
    diffIds = [];
  for (let i = 0; i < count; i++) {
    const bytes = Buffer.from(`verified layer ${i}`),
      stored = i % 2 ? zlib.gzipSync(bytes) : bytes;
    const entry =
      crypto.createHash("sha256").update(stored).digest("hex") + ".tar";
    entries.push(entry);
    diffIds.push(
      "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex"),
    );
    await fs.writeFile(path.join(dir, entry), stored);
  }
  const outside = path.join(dir, "outside.bin");
  await fs.writeFile(outside, "must remain unchanged");
  if (corrupt) await fs.writeFile(path.join(dir, entries.at(-1)), "bad layer");
  if (symlink) {
    await fs.rm(path.join(dir, entries[0]));
    await fs.symlink(outside, path.join(dir, entries[0]));
  }
  const config = JSON.stringify({
    os: "linux",
    architecture: "amd64",
    config: fixture().found.image.Config,
    rootfs: { type: "layers", diff_ids: diffIds },
  });
  const configId = crypto.createHash("sha256").update(config).digest("hex");
  await fs.writeFile(path.join(dir, configId + ".json"), config);
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify([
      {
        Config: configId + ".json",
        RepoTags: [expected.reference],
        Layers: entries,
      },
    ]),
  );
  const archive = path.join(dir, "image.tar.gz");
  execFileSync("tar", [
    "-czf",
    archive,
    "-C",
    dir,
    "manifest.json",
    configId + ".json",
    ...entries,
  ]);
  return {
    dir,
    archive,
    outside,
    identity: { ...expected, imageId: "sha256:" + configId, layers: diffIds },
  };
}
test("many mixed compressed and plain layers require a constant number of archive traversals", async (t) => {
  const fs = require("node:fs/promises"),
    path = require("node:path"),
    { execFileSync } = require("node:child_process");
  const f = await layeredArchive(t, { count: 8 });
  const bin = path.join(f.dir, "bin"),
    log = path.join(f.dir, "tar.log");
  await fs.mkdir(bin);
  const realTar = execFileSync("/bin/sh", ["-c", "command -v tar"], {
    encoding: "utf8",
  }).trim();
  await fs.writeFile(
    path.join(bin, "tar"),
    '#!/bin/sh\nprintf "tar\\n" >> "$TOOLKIT_TAR_LOG"\nexec "$TOOLKIT_REAL_TAR" "$@"\n',
    { mode: 0o700 },
  );
  execFileSync(
    process.execPath,
    [
      "-e",
      `require(${JSON.stringify(require.resolve("../lib/publish.cjs"))}).validateArchive(${JSON.stringify(f.archive)},${JSON.stringify(f.identity)}).catch(error=>{console.error(error.message);process.exit(1)})`,
    ],
    {
      env: {
        ...process.env,
        PATH: bin + path.delimiter + process.env.PATH,
        TOOLKIT_TAR_LOG: log,
        TOOLKIT_REAL_TAR: realTar,
      },
    },
  );
  assert.ok((await fs.readFile(log, "utf8")).trim().split("\n").length <= 3);
});
test("single-extraction layer validation rejects corrupted bytes", async (t) => {
  const f = await layeredArchive(t, { corrupt: true });
  await assert.rejects(
    require("../lib/publish.cjs").validateArchive(f.archive, f.identity),
    /layer checksum conflict/,
  );
});
test("single-extraction layer validation rejects symlinks without reading or changing outside files", async (t) => {
  const f = await layeredArchive(t, { symlink: true });
  await assert.rejects(
    require("../lib/publish.cjs").validateArchive(f.archive, f.identity),
    /regular isolated files/,
  );
  assert.equal(
    await require("node:fs/promises").readFile(f.outside, "utf8"),
    "must remain unchanged",
  );
});
