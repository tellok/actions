"use strict";
const fs = require("node:fs/promises");
const { createReadStream, createWriteStream } = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const { resolve, basename } = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const SOURCE = /^[a-f0-9]{40}$/;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return "sha256:" + hash.digest("hex");
}

function managedBody(previous, content, start, end) {
  if (content.includes(start) || content.includes(end))
    throw new Error("Release notes must not contain managed markers");
  const a = previous.split(start).length - 1,
    b = previous.split(end).length - 1;
  const block = `${start}\n${content}\n${end}`;
  if (!a && !b) return previous ? previous + "\n\n" + block : block;
  if (a !== 1 || b !== 1 || previous.indexOf(start) >= previous.indexOf(end))
    throw new Error("Invalid or duplicate managed release markers");
  return (
    previous.slice(0, previous.indexOf(start)) +
    block +
    previous.slice(previous.indexOf(end) + end.length)
  );
}

function createGitHubClient({
  repository,
  token,
  fetchImpl = fetch,
  apiUrl = process.env.GITHUB_API_URL || "https://api.github.com",
  github,
}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || ""))
    throw new Error("Invalid GitHub repository");
  let instance = github;
  const api = async () => {
    if (!instance) {
      const { Octokit } = await import("@octokit/rest");
      instance = new Octokit({
        auth: token,
        baseUrl: apiUrl,
        request: {
          fetch: async (url, init) =>
            fetchImpl(url, {
              ...init,
              ...(init.body &&
              typeof init.body !== "string" &&
              !Buffer.isBuffer(init.body)
                ? { duplex: "half" }
                : {}),
            }),
        },
      });
    }
    return instance;
  };
  const request = async (
    path,
    { method = "GET", body, allowNotFound = false } = {},
  ) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const data = (
          await (
            await api()
          ).request({
            method,
            url: `/repos/${repository}${path}`,
            data: body,
            headers: { "x-github-api-version": "2022-11-28" },
          })
        ).data;
        if (typeof data === "string") {
          try {
            return JSON.parse(data);
          } catch {}
        }
        return data;
      } catch (error) {
        if (allowNotFound && error.status === 404) return undefined;
        if (
          method === "GET" &&
          [500, 502, 503, 504].includes(error.status) &&
          attempt < 2
        ) {
          await sleep(200 * (attempt + 1));
          continue;
        }
        throw new Error(
          `GitHub API ${method} failed${error.status ? " (HTTP " + error.status + ")" : ""}`,
          {
            cause: {
              status: error.status,
              message:
                typeof error.response?.data?.message === "string"
                  ? error.response.data.message.slice(0, 200)
                  : undefined,
            },
          },
        );
      }
    }
  };
  const pages = async (path) => {
    const result = [];
    for (let page = 1; ; page++) {
      const batch = await request(
        path + (path.includes("?") ? "&" : "?") + `per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) throw new Error("GitHub page is not a list");
      result.push(...batch);
      if (batch.length < 100) return result;
    }
  };
  const client = {
    request,
    pages,
    async getTag(tag) {
      let ref = await request("/git/ref/tags/" + encodeURIComponent(tag), {
        allowNotFound: true,
      });
      if (!ref) return undefined;
      for (let depth = 0; ref.object.type === "tag" && depth < 8; depth++)
        ref = { object: (await request("/git/tags/" + ref.object.sha)).object };
      if (ref.object.type !== "commit" || !SOURCE.test(ref.object.sha))
        throw new Error("Tag does not resolve to a commit");
      return ref.object.sha;
    },
    async getRelease(tag) {
      const byTag = await request("/releases/tags/" + encodeURIComponent(tag), {
        allowNotFound: true,
      });
      if (byTag) return byTag;
      const found = (await pages("/releases")).filter(
        (release) => release.tag_name === tag,
      );
      if (found.length > 1) throw new Error("Duplicate release candidates");
      return found[0];
    },
    getReleaseById: (id) => request("/releases/" + id, { allowNotFound: true }),
    getLatest: () => request("/releases/latest"),
    createTag: (tag, source) =>
      request("/git/refs", {
        method: "POST",
        body: { ref: "refs/tags/" + tag, sha: source },
      }),
    createRelease: (data) =>
      request("/releases", { method: "POST", body: data }),
    updateRelease: (id, body) =>
      request("/releases/" + id, { method: "PATCH", body }),
    publishRelease: (id) =>
      request("/releases/" + id, {
        method: "PATCH",
        body: { draft: false, make_latest: "false" },
      }),
    listAssets: (id) => pages("/releases/" + id + "/assets"),
    async uploadAsset(id, file, name) {
      const instance = await api();
      const [owner, repo] = repository.split("/");
      return (
        await instance.rest.repos.uploadReleaseAsset({
          owner,
          repo,
          release_id: id,
          name,
          data: Readable.toWeb(createReadStream(file)),
          headers: {
            "content-type": "application/octet-stream",
            "content-length": (await fs.stat(file)).size,
          },
          request: {
            fetch: async (url, init) =>
              fetchImpl(url, { ...init, duplex: "half" }),
            timeout: 30 * 60_000,
          },
        })
      ).data;
    },
    async downloadAsset(asset, file) {
      const response = await (
        await api()
      ).request({
        method: "GET",
        url: `/repos/${repository}/releases/assets/${asset.id}`,
        headers: { accept: "application/octet-stream" },
        request: { parseSuccessResponseBody: false },
      });
      const body = response.data;
      await pipeline(
        body && typeof body.getReader === "function"
          ? Readable.fromWeb(body)
          : body,
        createWriteStream(file, { flags: "wx", mode: 0o600 }),
      );
    },
    async jobPages(run, attempt) {
      const all = [];
      for (let page = 1; ; page++) {
        const value = await request(
          `/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
        );
        if (!Array.isArray(value.jobs)) throw new Error("Invalid jobs page");
        all.push(...value.jobs);
        if (value.jobs.length < 100) return all;
      }
    },
    async artifactPages(run) {
      const all = [];
      for (let page = 1; ; page++) {
        const value = await request(
          `/actions/runs/${run}/artifacts?per_page=100&page=${page}`,
        );
        all.push(...value.artifacts);
        if (value.artifacts.length < 100) return all;
      }
    },
    async jobLog(id) {
      const response = await (
        await api()
      ).request({
        method: "GET",
        url: `/repos/${repository}/actions/jobs/${id}/logs`,
        request: { parseSuccessResponseBody: false },
      });
      const body = response.data;
      if (typeof body === "string") return body;
      const parts = [];
      for await (const part of body) parts.push(Buffer.from(part));
      return Buffer.concat(parts).toString();
    },
  };
  return client;
}

function validate(options) {
  if (
    !SOURCE.test(options.source || "") ||
    !options.tag ||
    /[\r\n\s~^:?*\[\\]/.test(options.tag) ||
    options.tag.includes("..") ||
    !options.name ||
    !options.start ||
    !options.end ||
    options.start === options.end ||
    options.start.includes(options.end) ||
    options.end.includes(options.start)
  )
    throw new Error("Invalid release identity or notes markers");
}

async function confirmAsset(api, asset, file, tempRoot) {
  if (asset.state !== "uploaded" || asset.size !== file.size)
    throw new Error("Release asset size/state conflict");
  const digest = file.hash;
  if (asset.digest) {
    if (asset.digest !== digest)
      throw new Error("Release asset digest conflict");
  } else {
    const temp = resolve(tempRoot, ".asset-check-" + randomUUID());
    try {
      await api.downloadAsset(asset, temp);
      if ((await hashFile(temp)) !== digest)
        throw new Error("Release asset bytes conflict");
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
}

async function ensureRelease({
  api,
  source,
  tag,
  name,
  notes,
  files,
  operation = "publish",
  latest = false,
  start,
  end,
  tempRoot,
}) {
  const options = { source, tag, name, start, end };
  validate(options);
  if (!["draft", "publish", "recover"].includes(operation))
    throw new Error("Unknown release operation");
  // Validate caller notes and the complete manifest before any remote writes.
  managedBody("", notes, start, end);
  if (
    !Array.isArray(files) ||
    new Set(files.map((f) => f.name)).size !== files.length
  )
    throw new Error("Explicit unique release assets are required");
  if (operation !== "draft" && !files.length)
    throw new Error("Publication requires a nonempty explicit asset list");
  files = files.map((file) => ({ ...file }));
  for (const file of files) {
    if (!/^sha256:[a-f0-9]{64}$/.test(file.hash || ""))
      throw new Error(
        "Every release asset requires a valid declared SHA-256 hash",
      );
    if (
      !file.name ||
      basename(file.name) !== file.name ||
      /[\r\n]/.test(file.name) ||
      (await fs.lstat(file.path)).isSymbolicLink()
    )
      throw new Error("Invalid release asset path/name");
    const size = (await fs.stat(file.path)).size;
    if (size < 1 || size >= 2 * 1024 ** 3)
      throw new Error("Release asset exceeds the service limit");
    if ((await hashFile(file.path)) !== file.hash)
      throw new Error("Local release asset hash mismatch");
    file.size = size;
  }
  let actualTag = await api.getTag(tag);
  if (actualTag && actualTag !== source)
    throw new Error("Release tag points to another source");
  let release = await api.getRelease(tag);
  if (operation === "draft" && release && !release.draft)
    throw new Error("Draft operation cannot modify a published release");
  if (operation === "recover" && (!actualTag || !release))
    throw new Error("Recovery requires an existing verified release");
  if (!actualTag) {
    let writeError;
    try {
      await api.createTag(tag, source);
    } catch (error) {
      writeError = error;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      actualTag = await api.getTag(tag);
      if (actualTag || attempt === 3) break;
      await sleep(200 * (attempt + 1));
    }
    if (actualTag !== source)
      throw new Error(
        "Tag creation is unconfirmed" +
          (writeError
            ? ": " +
              writeError.message +
              (writeError.cause?.message ? " " + writeError.cause.message : "")
            : ""),
      );
  }
  let body = managedBody(release?.body || "", notes, start, end);
  if (!release) {
    try {
      release = await api.createRelease({
        tag_name: tag,
        target_commitish: source,
        name,
        body,
        draft: true,
        prerelease: false,
        make_latest: "false",
      });
    } catch {
      release = await api.getRelease(tag);
    }
    if (!release?.id) throw new Error("Release creation is unconfirmed");
  }
  const id = release.id;
  const assertIdentity = (value, message = "Release ID identity mismatch") => {
    if (
      !value ||
      value.id !== id ||
      value.tag_name !== tag ||
      value.name !== name ||
      value.prerelease ||
      value.target_commitish !== source
    )
      throw new Error(message);
  };
  release = await api.getReleaseById(id);
  assertIdentity(release);
  if (operation === "draft" && !release.draft)
    throw new Error("Draft operation cannot modify a published release");
  body = managedBody(release.body || "", notes, start, end);
  if (release.body !== body) {
    await api.updateRelease(id, { body });
    release = await api.getReleaseById(id);
    if (release.body !== body)
      throw new Error("Release notes write is unconfirmed");
  }
  if (operation === "draft") {
    release = await api.getReleaseById(id);
    assertIdentity(
      release,
      "Draft release identity changed before confirmation",
    );
    if (!release.draft)
      throw new Error("Draft release identity changed before confirmation");
    if ((await api.getTag(tag)) !== source)
      throw new Error("Release tag changed during draft preparation");
    return { id, url: release.html_url, published: false };
  }
  for (const file of files) {
    const existing = (await api.listAssets(id)).filter(
      (asset) => asset.name === file.name,
    );
    if (existing.length > 1) throw new Error("Duplicate release asset");
    let asset = existing[0];
    if (!asset) {
      if (release.immutable)
        throw new Error("Immutable release is missing an asset");
      try {
        await api.uploadAsset(id, file.path, file.name);
      } catch {}
      const reread = (await api.listAssets(id)).filter(
        (candidate) => candidate.name === file.name,
      );
      if (reread.length !== 1)
        throw new Error("Release asset upload is unconfirmed");
      asset = reread[0];
    }
    await confirmAsset(api, asset, file, tempRoot);
  }
  const confirmTag = async () => {
    if ((await api.getTag(tag)) !== source)
      throw new Error("Release tag changed during publication");
  };
  const confirmAssets = async () => {
    const assets = await api.listAssets(id);
    for (const file of files) {
      const matching = assets.filter((asset) => asset.name === file.name);
      if (matching.length !== 1)
        throw new Error("Declared release asset set changed");
      await confirmAsset(api, matching[0], file, tempRoot);
    }
  };
  await confirmAssets();
  release = await api.getReleaseById(id);
  assertIdentity(release, "Release identity changed before publication");
  await confirmTag();
  if (release.draft) {
    try {
      await api.publishRelease(id);
    } catch {}
    release = await api.getReleaseById(id);
    assertIdentity(release, "Release publication is unconfirmed");
    if (release.draft) throw new Error("Release publication is unconfirmed");
  }
  if (latest && operation !== "recover") {
    try {
      await api.updateRelease(id, { make_latest: "true" });
    } catch {}
    if ((await api.getLatest()).id !== id)
      throw new Error("Latest promotion is unconfirmed");
  }
  release = await api.getReleaseById(id);
  assertIdentity(release, "Published release identity changed");
  if (release.draft) throw new Error("Published release identity changed");
  await confirmAssets();
  await confirmTag();
  return { id, url: release.html_url, published: true };
}

async function run({ inputs, github, context, core }) {
  if (!["draft", "publish", "recover"].includes(inputs.operation))
    throw new Error("Unknown release operation");
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const api = createGitHubClient({ repository, github });
  const notes = await fs.readFile(inputs["notes-file"], "utf8");
  const files = inputs["assets-file"]
    ? JSON.parse(await fs.readFile(inputs["assets-file"], "utf8"))
    : [];
  const tempRoot = await fs.mkdtemp(
    resolve(
      process.env.RUNNER_TEMP || require("node:os").tmpdir(),
      "ci-release-",
    ),
  );
  try {
    const result = await ensureRelease({
      api,
      source: inputs.source,
      tag: inputs.tag,
      name: inputs.name,
      notes,
      files,
      operation: inputs.operation,
      latest: inputs.latest === "true",
      start: inputs["body-start"],
      end: inputs["body-end"],
      tempRoot,
    });
    for (const [key, value] of Object.entries(result))
      core.setOutput(key, value);
    return result;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

module.exports = {
  createGitHubClient,
  managedBody,
  hashFile,
  confirmAsset,
  ensureRelease,
  run,
};
