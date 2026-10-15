const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  detect,
  managedBody,
  preflight,
  assertFresh,
  verifyResult,
} = require("../lib/version.cjs");
const source = "a".repeat(40),
  head = "b".repeat(40),
  context = { repo: { owner: "example", repo: "app" } };
function fixture() {
  const refs = { main: source, versions: head };
  const pr = {
    number: 1,
    body: "managed",
    user: { login: "bot" },
    head: { sha: head, ref: "versions", repo: { full_name: "example/app" } },
    base: { ref: "main", repo: { full_name: "example/app" } },
  };
  let prs = [pr];
  const github = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          const sha = refs[ref.slice(6)];
          if (!sha) throw { status: 404 };
          return { data: { object: { sha } } };
        },
      },
      pulls: { list() {}, listCommits() {}, get: async () => ({ data: pr }) },
    },
    paginate: async (method) =>
      method === github.rest.pulls.listCommits
        ? [{ sha: head, parents: [{ sha: source }] }]
        : prs,
  };
  return { refs, pr, github, setPrs: (v) => (prs = v) };
}
const args = (f) => ({
  github: f.github,
  context,
  source,
  base: "main",
  branch: "versions",
  marker: "managed",
  author: "bot",
});
test("empty README and hidden metadata skip preparation and writes", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "changesets-"));
  try {
    await fs.mkdir(join(dir, ".changeset"));
    await Promise.all(
      ["README.md", ".ignored.md", "config.json"].map((name) =>
        fs.writeFile(join(dir, ".changeset", name), "x"),
      ),
    );
    assert.deepEqual(await detect(dir), { found: false, count: 0 });
    await fs.writeFile(join(dir, ".changeset", "pending.md"), "---");
    assert.equal((await detect(dir)).count, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("malformed candidate identity fails before writing", async () => {
  const f = fixture();
  await assert.rejects(preflight({ ...args(f), source: "wrong" }));
  assert.throws(() => managedBody("start start end", "x", "start", "end"));
});
test("base advancement prevents version write", async () => {
  const f = fixture();
  const state = await preflight(args(f));
  f.refs.main = "c".repeat(40);
  await assert.rejects(
    assertFresh(f.github, context, state),
    /Target branch advanced/,
  );
  assert.equal((await preflight(args(f))).stale, true);
});
test("human branch and duplicate managed candidates are rejected", async () => {
  const f = fixture();
  f.pr.user.login = "human";
  await assert.rejects(preflight(args(f)), /Unmanaged/);
  f.pr.user.login = "bot";
  f.setPrs([f.pr, { ...f.pr, number: 2 }]);
  await assert.rejects(preflight(args(f)), /duplicate/);
});
test("managed body preserves external notes and confirmation rejects wrong head", async () => {
  assert.equal(
    managedBody("before\nstart\nold\nend\nafter", "new", "start", "end"),
    "before\nstart\nnew\nend\nafter",
  );
  const f = fixture();
  await assert.rejects(
    verifyResult({
      github: f.github,
      context,
      state: { ...(await preflight(args(f))), body: "managed" },
      number: 1,
      head: "c".repeat(40),
    }),
    /confirmed/,
  );
});

async function preFixture(t, directory = ".changeset") {
  const root = await fs.mkdtemp(join(tmpdir(), "changesets-pre-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = join(root, directory);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "used.md"), "---");
  const writeState = (state) => fs.writeFile(join(dir, "pre.json"), JSON.stringify(state));
  await writeState({ mode: "pre", tag: "beta", initialVersions: {}, changesets: ["used", "removed"] });
  return { root, dir, writeState };
}

test("beta excludes consumed IDs and counts only newly added changesets", async (t) => {
  const f = await preFixture(t);
  assert.deepEqual(await detect(f.root), { found: false, count: 0 });
  await fs.writeFile(join(f.dir, "fresh.md"), "---");
  assert.deepEqual(await detect(f.root), { found: true, count: 1 });
});

test("exit mode retains consumed changesets for the stable release", async (t) => {
  const f = await preFixture(t);
  await f.writeState({ mode: "exit", changesets: ["used"] });
  assert.deepEqual(await detect(f.root), { found: true, count: 1 });
});

test("custom changeset directory uses its own prerelease state", async (t) => {
  const f = await preFixture(t, "packages/app/.changeset");
  assert.deepEqual(await detect(f.root, "packages/app/.changeset"), { found: false, count: 0 });
});

test("invalid prerelease JSON or consumption state fails explicitly", async (t) => {
  const f = await preFixture(t);
  await fs.writeFile(join(f.dir, "pre.json"), "{");
  await assert.rejects(detect(f.root), SyntaxError);
  for (const state of [null, {}, { mode: "pre", changesets: "used" }, { mode: "pre", changesets: [1] }, { mode: "unknown", changesets: [] }]) {
    await f.writeState(state);
    await assert.rejects(detect(f.root), /Invalid Changesets/);
  }
});

test("consumed-only beta skips the version command and GitHub access", async (t) => {
  const f = await preFixture(t);
  require("node:child_process").execFileSync("git", ["init", "-q", f.root]);
  const { prepare } = require("../lib/version.cjs");
  const result = await prepare({
    inputs: { path: f.root, "version-command": "exit 99" },
    github: {}, context: {},
  });
  assert.deepEqual(result, { found: false, count: 0, changed: false });
});
