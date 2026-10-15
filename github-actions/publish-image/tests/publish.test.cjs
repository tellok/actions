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
  immutableTags: true,
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
test("immutable conflict prevents all registry writes", async () => {
  const f = fixture();
  f.refs.set("registry.test/demo:1.2.3", {
    ...f.found,
    image: { ...f.found.image, Id: "sha256:" + "e".repeat(64) },
  });
  await assert.rejects(publish(options(f)), /conflict/);
  assert.deepEqual(f.calls, ["verify"]);
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

test("new tags require explicit server immutability confirmation; existing tags remain reusable", async () => {
  const f = fixture();
  await assert.rejects(
    publish({ ...options(f), immutableTags: false }),
    /registry-side immutable/,
  );
  assert.deepEqual(f.calls, ["verify"]);
  for (const tag of options(f).tags)
    f.refs.set("registry.test/demo:" + tag, f.found);
  await publish({ ...options(f), immutableTags: false });
  f.refs.delete("registry.test/demo:" + options(f).tags[1]);
  await assert.rejects(
    publish({ ...options(f), immutableTags: false }),
    /registry-side immutable/,
  );
  assert.equal(f.calls.includes("alias"), false);
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
