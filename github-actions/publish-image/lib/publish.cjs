"use strict";
const { execFileSync } = require("node:child_process");
const { resolve, join } = require("node:path");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { createHash } = require("node:crypto");
const { Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createGunzip } = require("node:zlib");
const digest = /^sha256:[a-f0-9]{64}$/;
const output = (program, args) =>
  execFileSync(program, args, {
    maxBuffer: 8 * 1024 ** 2,
  });
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return "sha256:" + hash.digest("hex");
}
function verifyImage(image, expected, strict = true) {
  if (
    !digest.test(image.Id || "") ||
    [image.Os, image.Architecture, image.Variant].filter(Boolean).join("/") !==
      expected.platform ||
    image.Config?.Labels?.["org.opencontainers.image.revision"] !==
      expected.source ||
    image.Config?.Labels?.["org.opencontainers.image.version"] !==
      expected.version ||
    (strict && image.Id !== expected.imageId) ||
    !Array.isArray(image.RootFS?.Layers) ||
    image.RootFS.Layers.some((x) => !digest.test(x))
  )
    throw new Error("Image source, version, platform or ID conflict");
  if (
    strict &&
    expected.layers &&
    JSON.stringify(image.RootFS.Layers) !== JSON.stringify(expected.layers)
  )
    throw new Error("Image layers conflict");
}
async function layerHash(file) {
  const handle = await fs.open(file, "r");
  const magic = Buffer.alloc(2);
  try {
    await handle.read(magic, 0, 2, 0);
  } finally {
    await handle.close();
  }
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(file),
    ...(magic[0] === 31 && magic[1] === 139 ? [createGunzip()] : []),
    new Writable({
      write(chunk, encoding, callback) {
        hash.update(chunk);
        callback();
      },
    }),
  );
  return "sha256:" + hash.digest("hex");
}
async function validateArchive(archive, expected, run = output) {
  if (
    !/^[a-f0-9]{40}$/.test(expected.source || "") ||
    !digest.test(expected.imageId || "") ||
    !/^[a-z0-9]+\/[a-z0-9_]+(?:\/[a-z0-9_.-]+)?$/.test(
      expected.platform || "",
    ) ||
    !expected.version ||
    !expected.reference
  )
    throw new Error("Invalid expected image identity");
  if (
    expected.archiveHash &&
    (await hashFile(archive)) !== expected.archiveHash
  )
    throw new Error("Archive checksum conflict");
  if (
    expected.archiveSize &&
    (await fs.stat(archive)).size !== expected.archiveSize
  )
    throw new Error("Archive size conflict");
  const manifest = JSON.parse(run("tar", ["-xOzf", archive, "manifest.json"]));
  if (
    !Array.isArray(manifest) ||
    manifest.length !== 1 ||
    manifest[0].RepoTags?.length !== 1 ||
    manifest[0].RepoTags[0] !== expected.reference ||
    !/^(?:[a-f0-9]{64}\.json|blobs\/sha256\/[a-f0-9]{64})$/.test(
      manifest[0].Config || "",
    )
  )
    throw new Error("Archive must contain exactly the declared image");
  const raw = run("tar", ["-xOzf", archive, manifest[0].Config]);
  const config = JSON.parse(raw);
  const image = {
    Id: "sha256:" + createHash("sha256").update(raw).digest("hex"),
    Os: config.os,
    Architecture: config.architecture,
    Variant: config.variant,
    Config: config.config,
    RootFS: { Layers: config.rootfs?.diff_ids },
  };
  verifyImage(image, expected);
  const layers = manifest[0].Layers;
  if (
    config.rootfs?.type !== "layers" ||
    !Array.isArray(layers) ||
    layers.length !== image.RootFS.Layers.length ||
    layers.some(
      (x) =>
        !/^(?:[a-f0-9]{64}(?:\/layer)?\.tar|blobs\/sha256\/[a-f0-9]{64})$/.test(
          x,
        ),
    )
  )
    throw new Error("Invalid archive layers");
  if (!layers.length) return;
  const directory = await fs.mkdtemp(
    join(
      process.env.RUNNER_TEMP || require("node:os").tmpdir(),
      "ci-image-layers-",
    ),
  );
  try {
    // Exact validated member names, an empty destination and tar's default
    // traversal protection keep links from escaping the staging directory.
    run("tar", [
      "-xzf",
      resolve(archive),
      "-C",
      directory,
      "--no-same-owner",
      "--no-same-permissions",
      "--no-recursion",
      "--keep-old-files",
      "--",
      ...new Set(layers),
    ]);
    const root = await fs.realpath(directory);
    for (const [i, entry] of layers.entries()) {
      const file = resolve(root, entry),
        stat = await fs.lstat(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (await fs.realpath(file)) !== file
      )
        throw new Error("Archive layers must be regular isolated files");
      if ((await layerHash(file)) !== image.RootFS.Layers[i])
        throw new Error("Archive layer checksum conflict");
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
function createDockerClient({ run = output } = {}) {
  return {
    async lookup(reference, platform) {
      let raw;
      try {
        raw = run("docker", [
          "buildx",
          "imagetools",
          "inspect",
          reference,
          "--format",
          "{{json .Manifest}}",
        ]);
      } catch (error) {
        const message = String(error.stderr || "");
        if (
          /manifest unknown|manifest_unknown|not found/i.test(message) &&
          !/unauthorized|denied|authentication|dial tcp|timeout/i.test(message)
        )
          return undefined;
        throw new Error("Registry lookup failed");
      }
      const manifest = JSON.parse(raw);
      const mediaType = manifest.mediaType || manifest.MediaType;
      if (
        manifest.manifests ||
        manifest.Manifests ||
        ![
          "application/vnd.docker.distribution.manifest.v2+json",
          "application/vnd.oci.image.manifest.v1+json",
        ].includes(mediaType)
      )
        throw new Error(
          "Registry tag must resolve to a single image manifest, not an index",
        );
      const found = manifest.digest || manifest.Digest;
      if (!digest.test(found || ""))
        throw new Error("Registry response lacks a verified digest");
      const image = reference.slice(0, reference.lastIndexOf(":"));
      run("docker", ["pull", "--platform", platform, image + "@" + found]);
      const [config] = JSON.parse(
        run("docker", ["image", "inspect", image + "@" + found]),
      );
      return { digest: found, image: config };
    },
    async load(archive) {
      run("docker", ["load", "--input", archive]);
    },
    async push(id, reference) {
      run("docker", ["tag", id, reference]);
      run("docker", ["push", reference]);
    },
    async alias(image, digestValue, reference) {
      run("docker", [
        "buildx",
        "imagetools",
        "create",
        "--prefer-index=false",
        "--tag",
        reference,
        image + "@" + digestValue,
      ]);
    },
  };
}
function normalizeRegistry(registry) {
  if (
    typeof registry !== "string" ||
    !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::[0-9]+)?$/.test(
      registry,
    )
  )
    throw new Error("Invalid registry hostname");
  const host = registry.toLowerCase();
  return ["docker.io", "index.docker.io", "registry-1.docker.io"].includes(host)
    ? "docker.io"
    : host;
}
function validateRegistry(registry, image) {
  const login = normalizeRegistry(registry);
  if (
    typeof image !== "string" ||
    !/^[a-z0-9][a-z0-9./:_-]*$/.test(image) ||
    image.includes("@")
  )
    throw new Error("Invalid image repository");
  const parts = image.split("/");
  const explicit =
    parts.length > 1 &&
    (parts[0].includes(".") ||
      parts[0].includes(":") ||
      parts[0] === "localhost");
  const host = explicit ? normalizeRegistry(parts.shift()) : "docker.io";
  if (
    host !== login ||
    parts.some((part) => !/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(part))
  )
    throw new Error(
      "Image repository must match the authenticated registry and contain no tag",
    );
  return login;
}
async function publish(options) {
  validateRegistry(options.registry, options.image);
  await (options.verify || validateArchive)(options.archive, options.expected);
  return publishVerified(options);
}
async function publishVerified({
  archive,
  expected,
  image,
  tags,
  existingPolicy = "exact",
  registry,
  docker = createDockerClient(),
}) {
  if (
    !/^[a-z0-9][a-z0-9./:_-]*$/.test(image || "") ||
    image.includes("@") ||
    !Array.isArray(tags) ||
    !tags.length ||
    Array.from(tags).some((tag) => typeof tag !== "string") ||
    new Set(tags).size !== tags.length ||
    tags.some((tag) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) ||
    !["exact", "source"].includes(existingPolicy)
  )
    throw new Error("Invalid publication references or policy");
  validateRegistry(registry, image);
  const found = await Promise.all(
    tags.map((tag) => docker.lookup(image + ":" + tag, expected.platform)),
  );
  // Reuse a verified image when possible. A different existing tag is updated
  // through the normal registry write path, rather than rejected client-side.
  let published = found.find((item) => {
    if (!item) return false;
    try {
      verifyImage(item.image, expected, existingPolicy === "exact");
      return true;
    } catch {
      return false;
    }
  });
  let pushedFirst = false;
  if (!published) {
    await docker.load(archive);
    try {
      await docker.push(expected.imageId, image + ":" + tags[0]);
    } catch {}
    published = await docker.lookup(image + ":" + tags[0], expected.platform);
    if (!published) throw new Error("Image push is unconfirmed");
    verifyImage(published.image, expected, true);
    pushedFirst = true;
  }
  for (const [i, tag] of tags.entries()) {
    if (found[i]?.digest !== published.digest && !(pushedFirst && i === 0))
      try {
        await docker.alias(image, published.digest, image + ":" + tag);
      } catch {}
    const read = await docker.lookup(image + ":" + tag, expected.platform);
    if (!read || read.digest !== published.digest)
      throw new Error("Image tag write is unconfirmed");
    verifyImage(read.image, expected, existingPolicy === "exact");
  }
  return { digest: published.digest, imageId: published.image.Id };
}
module.exports = {
  hashFile,
  validateRegistry,
  normalizeRegistry,
  verifyImage,
  validateArchive,
  createDockerClient,
  publish,
  publishVerified,
};
