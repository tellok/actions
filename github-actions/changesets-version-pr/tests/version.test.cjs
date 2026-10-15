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
    state: "open",
    merged: false,
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

test("symlinked changeset directory cannot read outside the checkout", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "changeset-link-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(join(root, "repo"));
  await fs.mkdir(join(root, "external"));
  await fs.writeFile(join(root, "external/pending.md"), "---");
  await fs.symlink(join(root, "external"), join(root, "repo/.changeset"));
  await assert.rejects(detect(join(root, "repo")), /escapes/);
});
test("command environment strips serialized inputs, token inputs and arbitrary secrets", () => {
  const { commandEnvironment } = require("../lib/version.cjs");
  assert.deepEqual(
    commandEnvironment({
      PATH: "/bin",
      HOME: "/tmp/example",
      TOOLKIT_INPUTS: '{"github-token":"secret"}',
      "INPUT_GITHUB-TOKEN": "secret",
      INPUT_GITHUB_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      GH_TOKEN: "secret",
      CUSTOM_SECRET: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
    }),
    { PATH: "/bin", HOME: "/tmp/example" },
  );
});
async function preparation(t, command) {
  const { execFileSync } = require("node:child_process");
  const dir = await fs.mkdtemp(join(tmpdir(), "version-preparation-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  await fs.mkdir(join(dir, ".changeset"));
  await fs.writeFile(join(dir, ".changeset/pending.md"), "---");
  await fs.writeFile(join(dir, "secrets.yml"), "keep this file");
  git("add", ".");
  git("commit", "-m", "fixture");
  const sha = git("rev-parse", "HEAD"),
    f = fixture();
  f.refs.main = sha;
  delete f.refs.versions;
  f.setPrs([]);
  return {
    dir,
    f,
    context: {
      ...context,
      sha,
      ref: "refs/heads/main",
      eventName: "push",
      payload: { repository: { default_branch: "main", fork: false } },
    },
    inputs: {
      path: dir,
      branch: "versions",
      "version-command": command,
      "allowed-paths": "allowed.md\n.changeset",
      "ownership-marker": "managed",
      "body-start": "start",
      "body-end": "end",
      "managed-author": "bot",
    },
  };
}
test("version command cannot rename a forbidden file into the allowlist", async (t) => {
  const p = await preparation(t, "git mv secrets.yml allowed.md");
  await assert.rejects(
    require("../lib/version.cjs").prepare({
      inputs: p.inputs,
      context: p.context,
      github: p.f.github,
    }),
    /outside the allowlist/,
  );
});
test("actual version subprocess receives no serialized write token", async (t) => {
  const p = await preparation(
    t,
    'node -e \'if(Object.keys(process.env).some(k=>k==="TOOLKIT_INPUTS"||k.startsWith("INPUT_")))process.exit(9); require("node:fs").writeFileSync("allowed.md","versions")\'',
  );
  const old = process.env.TOOLKIT_INPUTS;
  process.env.TOOLKIT_INPUTS = '{"github-token":"sentinel-token"}';
  try {
    const impl = require("../lib/version.cjs");
    const state = await impl.prepare({
      inputs: p.inputs,
      context: p.context,
      github: p.f.github,
    });
    assert.ok(state.paths.includes("allowed.md"));
    await impl.restore(state);
  } finally {
    if (old === undefined) delete process.env.TOOLKIT_INPUTS;
    else process.env.TOOLKIT_INPUTS = old;
  }
});
test("fresh PR body preserves maintainer edits made during version preparation", async (t) => {
  const f = fixture(),
    state = await preflight(args(f));
  const dir = await fs.mkdtemp(join(tmpdir(), "version-body-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  Object.assign(state, {
    start: "start",
    end: "end",
    content: "managed\nnew",
    bodyPath: join(dir, "body.md"),
  });
  f.pr.body = "maintainer edit\nstart\nmanaged old\nend\nfooter";
  await require("../lib/version.cjs").refreshBody({
    github: f.github,
    context,
    state,
  });
  assert.equal(
    await fs.readFile(state.bodyPath, "utf8"),
    "maintainer edit\nstart\nmanaged\nnew\nend\nfooter",
  );
});
for (const [label, change] of [
  ["closed", { state: "closed" }],
  ["merged", { merged: true }],
  ["wrong author", { user: { login: "other-bot" } }],
]) {
  test(`version confirmation rejects ${label} PR including a first managed PR`, async () => {
    const f = fixture(),
      state = await preflight(args(f));
    state.number = undefined;
    state.body = f.pr.body;
    Object.assign(f.pr, change);
    await assert.rejects(
      verifyResult({ github: f.github, context, state, number: 1, head }),
      /could not be confirmed/,
    );
  });
}

for (const input of ["body", "body-file"]) {
  for (const marker of ["start", "end"]) {
    test(`version PR rejects ${marker} marker from ${input}`, async (t) => {
      const p = await preparation(
        t,
        input === "body-file"
          ? `printf 'contains ${marker} marker' > allowed.md`
          : "printf 'versions' > allowed.md",
      );
      p.inputs[input] =
        input === "body-file" ? "allowed.md" : `contains ${marker} marker`;
      await assert.rejects(
        require("../lib/version.cjs").prepare({
          inputs: p.inputs,
          context: p.context,
          github: p.f.github,
        }),
        /must not contain managed body markers/,
      );
    });
  }
}
test("version PR platform policy accepts Linux/macOS and rejects Windows", () => {
  const { assertSupportedPlatform } = require("../lib/version.cjs");
  assert.doesNotThrow(() => assertSupportedPlatform("linux"));
  assert.doesNotThrow(() => assertSupportedPlatform("darwin"));
  assert.throws(() => assertSupportedPlatform("win32"), /only Linux and macOS/);
});
test("unsupported platform is rejected by detect and maintain before workspace access", () => {
  const { execFileSync } = require("node:child_process");
  const modulePath = require.resolve("../lib/version.cjs");
  execFileSync(process.execPath, [
    "-e",
    `
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const impl = require(${JSON.stringify(modulePath)});
    Promise.allSettled([impl.detect('/does-not-exist'), impl.prepare({})]).then(results => {
      if (results.some(result => result.status !== 'rejected' || !/only Linux and macOS/.test(result.reason.message))) process.exit(1);
    }).catch(() => process.exit(1));
  `,
  ]);
});
