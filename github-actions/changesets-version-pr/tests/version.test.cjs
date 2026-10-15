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
  const previousWorkspace = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = dir;
  t.after(() => {
    if (previousWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = previousWorkspace;
  });
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
      path: ".",
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

test("repository paths resolve canonically within the workspace", async (t) => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "version-workspace-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(join(workspace, "nested"));
  await fs.symlink("nested", join(workspace, "alias"));
  const { resolveRepositoryPath } = require("../lib/version.cjs");
  assert.equal(
    await resolveRepositoryPath(workspace, "."),
    await fs.realpath(workspace),
  );
  assert.equal(
    await resolveRepositoryPath(workspace, "alias"),
    await fs.realpath(join(workspace, "nested")),
  );
  assert.equal(
    await resolveRepositoryPath(workspace, join(workspace, "nested")),
    await fs.realpath(join(workspace, "nested")),
  );
});
for (const mode of ["absolute", "parent", "symlink"]) {
  test(`initial detection and maintain reject an external checkout through ${mode} path`, async (t) => {
    const p = await preparation(t, "printf 'must not run' > allowed.md");
    const { execFileSync } = require("node:child_process"),
      path = require("node:path"),
      yaml = require("yaml");
    const parent = await fs.mkdtemp(join(tmpdir(), "external-checkout-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const external = join(parent, "repo");
    execFileSync("git", ["clone", "--quiet", p.dir, external]);
    if (mode === "symlink") await fs.symlink(external, join(p.dir, "escape"));
    p.inputs.path =
      mode === "absolute"
        ? external
        : mode === "parent"
          ? path.relative(p.dir, external)
          : "escape";
    const impl = require("../lib/version.cjs");
    await assert.rejects(
      impl.prepare({
        inputs: p.inputs,
        context: p.context,
        github: p.f.github,
      }),
      /escapes GITHUB_WORKSPACE/,
    );
    const action = yaml.parse(
      await fs.readFile(join(__dirname, "../action.yml"), "utf8"),
    );
    const code = action.runs.steps.find((step) => step.id === "prepare").with
      .script;
    const AsyncFunction = Object.getPrototypeOf(
      async function () {},
    ).constructor;
    await assert.rejects(
      new AsyncFunction(
        "require",
        "process",
        "core",
        "github",
        "context",
        code,
      )(
        require,
        {
          env: {
            ...process.env,
            GITHUB_WORKSPACE: p.dir,
            TOOLKIT_ACTION_PATH: path.resolve(__dirname, ".."),
            TOOLKIT_INPUTS: JSON.stringify({
              ...p.inputs,
              operation: "detect",
            }),
          },
        },
        {
          setOutput() {
            throw new Error("Detection must not emit outputs");
          },
        },
        p.f.github,
        p.context,
      ),
      /escapes GITHUB_WORKSPACE/,
    );
    await assert.rejects(fs.access(join(external, "allowed.md")), {
      code: "ENOENT",
    });
  });
}

for (const [start, end] of [
  ["<!--notes", "<!--notes:end-->"],
  ["<!--notes:start-->", "<!--notes"],
]) {
  test(`overlapping version body markers ${start} / ${end} cannot create a managed body`, async (t) => {
    const p = await preparation(t, "printf 'versions' > allowed.md");
    Object.assign(p.inputs, { "body-start": start, "body-end": end });
    await assert.rejects(
      require("../lib/version.cjs").prepare({
        inputs: p.inputs,
        context: p.context,
        github: p.f.github,
      }),
      /must not overlap/,
    );
    assert.throws(
      () => managedBody("", "notes", start, end),
      /must not overlap/,
    );
  });
}
for (const mode of ["absolute", "parent", "symlink"]) {
  test(`body-file cannot copy external content through ${mode} path`, async (t) => {
    const parent = await fs.mkdtemp(join(tmpdir(), "outside-version-notes-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const outside = join(parent, "notes.md");
    await fs.writeFile(outside, "private runner content");
    const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
    const p = await preparation(
      t,
      mode === "symlink"
        ? `ln -s ${quote(outside)} allowed.md`
        : "printf 'versions' > allowed.md",
    );
    p.inputs["body-file"] =
      mode === "absolute"
        ? outside
        : mode === "parent"
          ? require("node:path").relative(p.dir, outside)
          : "allowed.md";
    await assert.rejects(
      require("../lib/version.cjs").prepare({
        inputs: p.inputs,
        context: p.context,
        github: p.f.github,
      }),
      /body-file escapes the checkout/,
    );
    assert.equal(await fs.readFile(outside, "utf8"), "private runner content");
  });
}
test("body-file generated inside the checkout remains usable", async (t) => {
  const p = await preparation(t, "printf 'release notes' > allowed.md");
  p.inputs["body-file"] = "allowed.md";
  const impl = require("../lib/version.cjs");
  const state = await impl.prepare({
    inputs: p.inputs,
    context: p.context,
    github: p.f.github,
  });
  assert.match(state.body, /release notes/);
  await impl.restore(state);
});

async function lateCandidate(t) {
  const f = fixture();
  let opened = false;
  const closed = { ...f.pr, state: "closed" };
  f.github.paginate = async (method, args) =>
    args.state === "open" ? (opened ? [f.pr] : []) : [closed];
  const state = await preflight(args(f));
  assert.equal(state.number, undefined);
  f.pr.number = 2;
  f.pr.body = "new human note\nstart\nmanaged old notes\nend\nfooter";
  opened = true;
  const dir = await fs.mkdtemp(join(tmpdir(), "late-version-pr-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  Object.assign(state, {
    start: "start",
    end: "end",
    content: "managed\nnew versions",
    bodyPath: join(dir, "body.md"),
  });
  return { f, state };
}
test("PR opened on an unchanged previously managed branch is rediscovered with current outside notes", async (t) => {
  const { f, state } = await lateCandidate(t);
  await require("../lib/version.cjs").refreshBody({
    github: f.github,
    context,
    state,
  });
  assert.equal(state.number, 2);
  assert.equal(
    await fs.readFile(state.bodyPath, "utf8"),
    "new human note\nstart\nmanaged\nnew versions\nend\nfooter",
  );
});
for (const [label, mutate] of [
  [
    "wrong author",
    (pr) => {
      pr.user.login = "other";
    },
  ],
  [
    "changed head",
    (pr) => {
      pr.head.sha = "c".repeat(40);
    },
  ],
]) {
  test(`rediscovered PR with ${label} is rejected before writing its body`, async (t) => {
    const { f, state } = await lateCandidate(t);
    mutate(f.pr);
    await assert.rejects(
      require("../lib/version.cjs").refreshBody({
        github: f.github,
        context,
        state,
      }),
      /Managed PR identity changed/,
    );
    await assert.rejects(fs.access(state.bodyPath), { code: "ENOENT" });
  });
}
test("multiple PR candidates appearing after preflight are rejected", async (t) => {
  const { f, state } = await lateCandidate(t);
  f.github.paginate = async () => [f.pr, { ...f.pr, number: 3 }];
  await assert.rejects(
    require("../lib/version.cjs").refreshBody({
      github: f.github,
      context,
      state,
    }),
    /Duplicate version PR candidates/,
  );
  await assert.rejects(fs.access(state.bodyPath), { code: "ENOENT" });
});
