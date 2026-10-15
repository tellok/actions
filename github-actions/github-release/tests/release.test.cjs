const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const {
  ensureRelease,
  hashFile,
  createGitHubClient,
} = require("../lib/runtime.cjs");
const source = "a".repeat(40);
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), "release-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const path = join(dir, "image.bin");
  await fs.writeFile(path, "validated image");
  const files = [{ name: "image.bin", path, hash: await hashFile(path) }];
  const calls = [];
  const state = {
    tag: undefined,
    release: undefined,
    assets: [],
    unknown: false,
    latest: 99,
  };
  const api = {
    getTag: async () => state.tag,
    createTag: async () => {
      calls.push("tag");
      state.tag = source;
    },
    getRelease: async () => state.release,
    getReleaseById: async (id) => {
      assert.equal(id, 1);
      return state.release;
    },
    createRelease: async (data) => {
      calls.push("draft");
      state.release = {
        ...data,
        id: 1,
        html_url: "https://example.test/release",
      };
      if (state.unknown) throw new Error("response lost");
      return state.release;
    },
    updateRelease: async (id, data) => {
      calls.push("update");
      state.release = { ...state.release, ...data };
      if (data.make_latest === "true") state.latest = id;
    },
    listAssets: async () => state.assets,
    uploadAsset: async () => {
      calls.push("upload");
      state.assets.push({
        name: "image.bin",
        size: 15,
        state: "uploaded",
        digest: files[0].hash,
      });
      if (state.unknown) throw new Error("response lost");
    },
    publishRelease: async () => {
      calls.push("publish");
      state.release.draft = false;
    },
    getLatest: async () => ({ id: state.latest }),
  };
  return {
    dir,
    files,
    calls,
    state,
    api,
    options: {
      api,
      source,
      tag: "v1.2.3",
      name: "1.2.3",
      notes: "notes",
      files,
      start: "start",
      end: "end",
      tempRoot: dir,
    },
  };
}
test("release becomes public only after all required assets verify", async (t) => {
  const f = await fixture(t);
  await ensureRelease(f.options);
  assert.deepEqual(f.calls, ["tag", "draft", "upload", "publish"]);
  assert.equal(f.state.release.draft, false);
});
test("404 alone identifies absence and publication stays bound to one ID", async (t) => {
  const f = await fixture(t);
  const result = await ensureRelease(f.options);
  assert.equal(result.id, 1);
  const api = createGitHubClient({
    repository: "example/app",
    github: {
      request: async () => {
        throw { status: 403 };
      },
    },
  });
  await assert.rejects(api.getTag("v1"), /403/);
});
test("unknown create and upload outcomes require exact read-back", async (t) => {
  const f = await fixture(t);
  f.state.unknown = true;
  assert.equal((await ensureRelease(f.options)).published, true);
  assert.equal(f.calls.filter((x) => x === "draft").length, 1);
  assert.equal(f.calls.filter((x) => x === "upload").length, 1);
});
test("conflicting release asset fails without deleting or overwriting it", async (t) => {
  const f = await fixture(t);
  await ensureRelease({ ...f.options, operation: "draft" });
  f.state.assets = [
    {
      name: "image.bin",
      size: 15,
      state: "uploaded",
      digest: "sha256:" + "f".repeat(64),
    },
  ];
  await assert.rejects(ensureRelease(f.options), /digest conflict/);
  assert.equal(f.calls.includes("upload"), false);
  assert.equal(f.calls.includes("publish"), false);
});
test("notes outside managed markers survive maintenance", async (t) => {
  const f = await fixture(t);
  await ensureRelease({ ...f.options, operation: "draft" });
  f.state.release.body = "before\n" + f.state.release.body + "\nafter";
  await ensureRelease({ ...f.options, operation: "draft", notes: "new" });
  assert.equal(f.state.release.body, "before\nstart\nnew\nend\nafter");
});
test("recovery uploads missing assets without changing Latest", async (t) => {
  const f = await fixture(t);
  await ensureRelease({ ...f.options, operation: "draft" });
  f.state.release.draft = false;
  await ensureRelease({ ...f.options, operation: "recover", latest: true });
  assert.equal(f.state.latest, 99);
  assert.equal(f.calls.includes("publish"), false);
});

test("beta draft, publication and recovery preserve prerelease and Latest", async (t) => {
  const f = await fixture(t);
  const options = { ...f.options, tag: "v2.0.0-beta.1", name: "2.0.0-beta.1", prerelease: true };
  await ensureRelease({ ...options, operation: "draft" });
  assert.equal(f.state.release.prerelease, true);
  assert.equal(f.state.release.draft, true);
  assert.equal((await ensureRelease(options)).published, true);
  assert.equal((await ensureRelease({ ...options, operation: "recover" })).published, true);
  assert.equal(f.state.release.prerelease, true);
  assert.equal(f.state.latest, 99);
  assert.equal(f.calls.filter((call) => call === "draft").length, 1);
});

test("prerelease with Latest is rejected before writes for all operations", async (t) => {
  const f = await fixture(t);
  for (const operation of ["draft", "publish", "recover"]) {
    await assert.rejects(ensureRelease({ ...f.options, operation, prerelease: true, latest: true }), /cannot be promoted/);
  }
  assert.deepEqual(f.calls, []);
});

test("existing stable and prerelease identities cannot be interchanged", async (t) => {
  const f = await fixture(t);
  await ensureRelease({ ...f.options, operation: "draft" });
  f.calls.length = 0;
  await assert.rejects(ensureRelease({ ...f.options, prerelease: true }), /identity mismatch/);
  f.state.release.prerelease = true;
  await assert.rejects(ensureRelease(f.options), /identity mismatch/);
  assert.deepEqual(f.calls, []);
});

test("unknown beta creation outcome is recovered with prerelease identity", async (t) => {
  const f = await fixture(t);
  f.state.unknown = true;
  assert.equal((await ensureRelease({ ...f.options, prerelease: true })).published, true);
  assert.equal(f.state.release.prerelease, true);
});

test("publication read-back rejects a changed prerelease flag", async (t) => {
  const f = await fixture(t);
  f.api.publishRelease = async () => {
    f.state.release.draft = false;
    f.state.release.prerelease = false;
  };
  await assert.rejects(ensureRelease({ ...f.options, prerelease: true }), /publication is unconfirmed/);
});

test("stable releases still support explicit Latest promotion", async (t) => {
  const f = await fixture(t);
  await ensureRelease({ ...f.options, latest: true });
  assert.equal(f.state.release.prerelease, false);
  assert.equal(f.state.latest, 1);
});

test("Action entry point passes prerelease through to the API", async (t) => {
  const f = await fixture(t);
  const notes = join(f.dir, "notes.md");
  await fs.writeFile(notes, "notes");
  const requests = [];
  const { run } = require("../lib/runtime.cjs");
  const github = { request: async ({ method, url, data }) => {
    requests.push({ method, url, data });
    if (url.includes("/git/ref/")) return { data: { object: { type: "commit", sha: source } } };
    if (url.includes("/releases/tags/")) throw { status: 404 };
    if (method === "POST") return { data: f.state.release = { ...data, id: 1 } };
    if (url.endsWith("/releases/1")) return { data: f.state.release };
    return { data: [] };
  } };
  const inputs = { operation: "draft", source, tag: "v2-beta.1", name: "beta", prerelease: "true", "notes-file": notes, "body-start": "start", "body-end": "end" };
  await run({ inputs, github, context: { repo: { owner: "example", repo: "app" } }, core: { setOutput() {} } });
  assert.equal(requests.find((r) => r.method === "POST").data.prerelease, true);
  await assert.rejects(run({ inputs: { ...inputs, prerelease: "yes" } }), /must be true or false/);
});
