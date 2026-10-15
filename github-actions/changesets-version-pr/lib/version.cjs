"use strict";
const fs = require("node:fs/promises");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { resolve, join } = require("node:path");
const SHA = /^[a-f0-9]{40}$/;
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 ** 2,
  }).trim();

function managedBody(previous, content, start, end) {
  if (content.includes(start) || content.includes(end))
    throw new Error("Version PR content must not contain managed body markers");
  const starts = previous.split(start).length - 1;
  const ends = previous.split(end).length - 1;
  const block = `${start}\n${content}\n${end}`;
  if (!starts && !ends) return previous ? `${previous}\n\n${block}` : block;
  if (
    starts !== 1 ||
    ends !== 1 ||
    previous.indexOf(start) >= previous.indexOf(end)
  )
    throw new Error("Managed body markers are invalid");
  return (
    previous.slice(0, previous.indexOf(start)) +
    block +
    previous.slice(previous.indexOf(end) + end.length)
  );
}

function assertSupportedPlatform(platform = process.platform) {
  if (!["linux", "darwin"].includes(platform))
    throw new Error("Changesets version PR supports only Linux and macOS");
}
async function detect(cwd, directory = ".changeset") {
  assertSupportedPlatform();
  const root = await fs.realpath(cwd);
  const candidate = resolve(root, directory);
  if (!candidate.startsWith(root + "/") || directory.includes("\n"))
    throw new Error("Changeset directory escapes the workspace");
  const real = await fs.realpath(candidate).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (real && !real.startsWith(root + "/"))
    throw new Error("Changeset directory escapes the workspace");
  const entries = await fs
    .readdir(candidate, { withFileTypes: true })
    .catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.name.startsWith(".") &&
        entry.name.endsWith(".md") &&
        entry.name.toLowerCase() !== "readme.md",
    )
    .map((entry) => entry.name)
    .sort();
  return { found: files.length > 0, count: files.length };
}

async function getRef(github, repo, branch) {
  try {
    return (await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` }))
      .data.object.sha;
  } catch (error) {
    if (error.status === 404) return undefined;
    throw new Error("Cannot verify the remote branch");
  }
}

async function preflight({
  github,
  context,
  source,
  base,
  branch,
  marker,
  author,
}) {
  if (
    !SHA.test(source) ||
    !base ||
    !branch ||
    base === branch ||
    /[\n\r]/.test(base + branch) ||
    !marker
  )
    throw new Error("Invalid version PR identity");
  const repo = context.repo;
  const current = await getRef(github, repo, base);
  if (current !== source) return { stale: true };
  const prs = await github.paginate(github.rest.pulls.list, {
    ...repo,
    state: "open",
    head: `${repo.owner}:${branch}`,
    per_page: 100,
  });
  const valid = (pr) =>
    pr.head?.repo?.full_name === `${repo.owner}/${repo.repo}` &&
    pr.base?.repo?.full_name === `${repo.owner}/${repo.repo}` &&
    pr.head.ref === branch &&
    pr.base.ref === base &&
    pr.body?.includes(marker) &&
    (!author || pr.user?.login === author);
  if (prs.length > 1 || prs.some((pr) => !valid(pr)))
    throw new Error("Unmanaged or duplicate version PR");
  const expected = await getRef(github, repo, branch);
  if (expected && prs.length && expected !== prs[0].head.sha)
    throw new Error("Managed branch lease is stale");
  if (expected && !prs.length) {
    const closed = await github.paginate(github.rest.pulls.list, {
      ...repo,
      state: "closed",
      head: `${repo.owner}:${branch}`,
      per_page: 100,
    });
    if (!closed.some((pr) => valid(pr) && pr.head.sha === expected))
      throw new Error("Existing branch is not managed by this component");
  }
  return {
    source,
    base,
    branch,
    expected: expected || "0".repeat(40),
    previous: prs[0]?.body || "",
    number: prs[0]?.number,
    marker,
    author,
  };
}

async function assertFresh(github, context, state) {
  if ((await getRef(github, context.repo, state.base)) !== state.source)
    throw new Error("Target branch advanced during version preparation");
  if (
    ((await getRef(github, context.repo, state.branch)) || "0".repeat(40)) !==
    state.expected
  )
    throw new Error("Managed branch lease changed during preparation");
}

function commandEnvironment(environment = process.env) {
  // Keep tools usable, but do not pass action inputs or arbitrary caller secrets.
  const allowed =
    /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|TZ|CI|TERM|SYSTEMROOT|WINDIR|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|PNPM_HOME|COREPACK_HOME|XDG_CACHE_HOME|npm_config_cache|NPM_CONFIG_CACHE|GITHUB_WORKSPACE|RUNNER_TEMP|RUNNER_TOOL_CACHE|AGENT_TOOLSDIRECTORY)$/;
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => allowed.test(key)),
  );
}
async function refreshBody({ github, context, state }) {
  if (state.number) {
    const pr = (
      await github.rest.pulls.get({
        ...context.repo,
        pull_number: state.number,
      })
    ).data;
    if (
      pr.state !== "open" ||
      pr.merged ||
      pr.head?.ref !== state.branch ||
      pr.base?.ref !== state.base ||
      pr.head?.repo?.full_name !==
        `${context.repo.owner}/${context.repo.repo}` ||
      pr.base?.repo?.full_name !==
        `${context.repo.owner}/${context.repo.repo}` ||
      !pr.body?.includes(state.marker) ||
      (state.author && pr.user?.login !== state.author)
    )
      throw new Error("Managed PR identity changed before updating its body");
    state.previous = pr.body;
  }
  state.body = managedBody(
    state.previous,
    state.content,
    state.start,
    state.end,
  );
  await fs.writeFile(state.bodyPath, state.body, { mode: 0o600 });
}
async function prepare({ inputs, github, context }) {
  assertSupportedPlatform();
  const cwd = resolve(
    process.env.GITHUB_WORKSPACE || process.cwd(),
    inputs.path || ".",
  );
  if ((await fs.realpath(cwd)) !== git(cwd, "rev-parse", "--show-toplevel"))
    throw new Error(
      "path must point to the checkout repository root; use changeset-directory and version-command for a nested workspace",
    );
  const pending = await detect(
    cwd,
    inputs["changeset-directory"] || ".changeset",
  );
  if (!pending.found) return { ...pending, changed: false };
  const base = inputs.base || context.payload.repository?.default_branch;
  const source = git(cwd, "rev-parse", "HEAD");
  if (source !== context.sha || git(cwd, "status", "--porcelain"))
    throw new Error("Version preparation requires a clean event checkout");
  if (
    context.ref !== `refs/heads/${base}` ||
    !["push", "workflow_dispatch"].includes(context.eventName) ||
    context.payload.repository?.fork
  )
    throw new Error("Version maintenance requires a trusted base-branch run");
  const state = await preflight({
    github,
    context,
    source,
    base,
    branch: inputs.branch,
    marker: inputs["ownership-marker"],
    author: inputs["managed-author"],
  });
  if (state.stale) return { ...pending, changed: false, stale: true };
  if (!inputs["version-command"])
    throw new Error("version-command is required");
  execFileSync(
    "/bin/bash",
    ["-euo", "pipefail", "-c", inputs["version-command"]],
    { cwd, stdio: "inherit", env: commandEnvironment() },
  );
  await assertFresh(github, context, state);
  const patterns = inputs["allowed-paths"]
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
  if (!patterns.length) throw new Error("Explicit allowed-paths are required");
  const lines = (value) => value.split("\n").filter(Boolean);
  const all = new Set([
    ...lines(
      git(cwd, "diff", "--no-renames", "--relative", "--name-only", source),
    ),
    ...lines(
      git(
        cwd,
        "diff",
        "--cached",
        "--no-renames",
        "--relative",
        "--name-only",
        source,
      ),
    ),
    ...lines(git(cwd, "ls-files", "--others", "--exclude-standard")),
  ]);
  const allowed = new Set([
    ...lines(
      git(
        cwd,
        "diff",
        "--cached",
        "--no-renames",
        "--relative",
        "--name-only",
        source,
        "--",
        ...patterns,
      ),
    ),
    ...lines(
      git(
        cwd,
        "diff",
        "--no-renames",
        "--relative",
        "--name-only",
        source,
        "--",
        ...patterns,
      ),
    ),
    ...lines(
      git(cwd, "ls-files", "--others", "--exclude-standard", "--", ...patterns),
    ),
  ]);
  if ([...all].some((path) => !allowed.has(path)))
    throw new Error("Version command changed a path outside the allowlist");
  if (!all.size) return { ...pending, changed: false };
  git(cwd, "add", "--", ...all);
  state.tree = git(cwd, "write-tree");
  state.paths = [...all].sort();
  state.cwd = cwd;
  const content = inputs["body-file"]
    ? await fs.readFile(resolve(cwd, inputs["body-file"]), "utf8")
    : inputs.body || "";
  state.start = inputs["body-start"];
  state.end = inputs["body-end"];
  if (!state.start || !state.end || state.start === state.end)
    throw new Error("Distinct body markers are required");
  state.content = `${state.marker}\nSource: ${state.source}\n${content}`;
  managedBody("", state.content, state.start, state.end);
  state.temp = await fs.mkdtemp(
    join(process.env.RUNNER_TEMP || require("node:os").tmpdir(), "ci-version-"),
  );
  state.bodyPath = join(state.temp, "body.md");
  await refreshBody({ github, context, state });
  try {
    state.oldHooks = git(cwd, "config", "--local", "--get", "core.hooksPath");
  } catch (error) {
    if (error.status !== 1) throw error;
    state.oldHooks = "";
  }
  return state;
}

async function installLeaseHook(state) {
  const hooks = join(state.temp, "hooks");
  await fs.mkdir(hooks);
  await fs.writeFile(
    join(hooks, "pre-push"),
    '#!/usr/bin/env bash\nset -euo pipefail\nwhile read -r local_ref local_sha remote_ref remote_sha; do\n  [[ "$remote_ref" == "$CI_EXPECTED_VERSION_REF" && "$remote_sha" == "$CI_EXPECTED_VERSION_SHA" ]] || { echo "Version branch lease changed" >&2; exit 1; }\ndone\n',
    { mode: 0o700 },
  );
  git(state.cwd, "config", "--local", "core.hooksPath", hooks);
}

async function verifyResult({ github, context, state, number, head }) {
  if (!number) {
    const found = await github.paginate(github.rest.pulls.list, {
      ...context.repo,
      state: "open",
      head: `${context.repo.owner}:${state.branch}`,
      per_page: 100,
    });
    if (found.length !== 1)
      throw new Error("Upstream write has no unique confirmed PR");
    number = found[0].number;
  }
  if (!head) head = await getRef(github, context.repo, state.branch);
  if (
    !Number.isSafeInteger(Number(number)) ||
    Number(number) < 1 ||
    !SHA.test(head)
  )
    throw new Error("Upstream did not return a version PR identity");
  if ((await getRef(github, context.repo, state.base)) !== state.source)
    throw new Error("Version PR target advanced before confirmation");
  const pr = (
    await github.rest.pulls.get({
      ...context.repo,
      pull_number: Number(number),
    })
  ).data;
  if (
    pr.number !== Number(number) ||
    pr.state !== "open" ||
    pr.merged ||
    (state.author && pr.user?.login !== state.author) ||
    pr.base?.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}` ||
    pr.head?.sha !== head ||
    pr.head?.ref !== state.branch ||
    pr.base?.ref !== state.base ||
    pr.head?.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}` ||
    pr.body !== state.body ||
    (state.number && state.number !== pr.number)
  )
    throw new Error("Version PR write could not be confirmed");
  if (git(state.cwd, "rev-parse", `${head}^{tree}`) !== state.tree)
    throw new Error("Upstream changed the prepared version tree");
  const commits = await github.paginate(github.rest.pulls.listCommits, {
    ...context.repo,
    pull_number: pr.number,
    per_page: 100,
  });
  if (
    commits.length !== 1 ||
    commits[0].sha !== head ||
    commits[0].parents?.[0]?.sha !== state.source
  )
    throw new Error(
      "Version PR must contain one commit based on the event source",
    );
  return { number: pr.number, head, url: pr.html_url };
}

async function restore(state) {
  if (!state?.temp) return;
  if (state.oldHooks)
    git(state.cwd, "config", "--local", "core.hooksPath", state.oldHooks);
  else {
    try {
      git(state.cwd, "config", "--local", "--unset-all", "core.hooksPath");
    } catch {}
  }
  await fs.rm(state.temp, { recursive: true, force: true });
}

module.exports = {
  detect,
  assertSupportedPlatform,
  commandEnvironment,
  refreshBody,
  managedBody,
  preflight,
  assertFresh,
  prepare,
  installLeaseHook,
  verifyResult,
  restore,
};
