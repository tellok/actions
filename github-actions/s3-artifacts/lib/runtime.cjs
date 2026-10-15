"use strict";
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { createReadStream, createWriteStream } = require("node:fs");
const fs = require("node:fs/promises");
const { createHash, randomUUID } = require("node:crypto");
const { resolve, basename, dirname } = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SOURCE = /^[a-f0-9]{40}$/;

async function hashFile(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return "sha256:" + digest.digest("hex");
}

function validateIdentity(identity) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity.repository || "") ||
    identity.repository
      .split("/")
      .some((part) => part === "." || part === "..") ||
    !SOURCE.test(identity.source || "") ||
    ["run", "attempt", "job"].some(
      (key) => !Number.isSafeInteger(identity[key]) || identity[key] < 1,
    )
  )
    throw new Error("Invalid artifact generation identity");
}
function prefix(value) {
  if (
    !value ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    /[\r\n\\]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Invalid S3 prefix");
  return value;
}
function fileName(name) {
  if (
    !name ||
    basename(name) !== name ||
    name === "." ||
    name === ".." ||
    /[\r\n\\]/.test(name)
  )
    throw new Error("Artifact must be a plain allowed file name");
  return name;
}
function validateRecord(record, expected) {
  validateIdentity(record.identity);
  if (
    expected &&
    ["repository", "source", "run", "attempt", "job"].some(
      (key) => record.identity[key] !== expected[key],
    )
  )
    throw new Error("Artifact source or generation mismatch");
  prefix(record.prefix);
  if (
    record.schema_version !== 1 ||
    !Array.isArray(record.objects) ||
    !record.objects.length ||
    record.objects.length > 100
  )
    throw new Error("Invalid artifact record");
  const seen = new Set();
  for (const object of record.objects) {
    fileName(object.name);
    if (
      seen.has(object.name) ||
      object.key !== record.prefix + "/" + object.name ||
      !DIGEST.test(object.hash) ||
      !Number.isSafeInteger(object.size) ||
      object.size < 1 ||
      (object.versionId !== undefined &&
        (typeof object.versionId !== "string" ||
          !object.versionId.trim() ||
          /[\r\n]/.test(object.versionId)))
    )
      throw new Error("Invalid, duplicate, or out-of-scope artifact object");
    seen.add(object.name);
  }
  return record;
}

function positiveLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("max-file-bytes must be a positive safe integer");
  return value;
}
async function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return await fs.realpath(absolute);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const entry = await fs.lstat(absolute).catch((statError) => {
      if (statError.code === "ENOENT") return undefined;
      throw statError;
    });
    if (entry?.isSymbolicLink())
      throw new Error(
        "Unresolved symlink is not allowed in artifact result paths",
      );
    return resolve(await canonicalPath(dirname(absolute)), basename(absolute));
  }
}
async function statIfPresent(path) {
  try {
    return await fs.stat(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
async function validateOutputPath(record, directory, outputFile) {
  if (!outputFile) return;
  const output = await canonicalPath(outputFile);
  const outputEntry = await statIfPresent(output);
  for (const object of record.objects) {
    const target = await canonicalPath(resolve(directory, object.name));
    const entry = outputEntry && (await statIfPresent(target));
    if (
      output === target ||
      (entry && entry.dev === outputEntry.dev && entry.ino === outputEntry.ino)
    )
      throw new Error("Result output-file collides with an artifact");
  }
}

function createClient(config) {
  const endpoint = new URL(config.endpoint);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    !config.region ||
    !config.bucket ||
    !config.accessKeyId ||
    !config.secretAccessKey
  )
    throw new Error("Invalid standard S3 configuration");
  return new S3Client({
    endpoint: endpoint.origin,
    region: config.region,
    forcePathStyle: config.pathStyle !== false,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken || undefined,
    },
    maxAttempts: 1, // Unknown writes are confirmed by read-back instead of blindly replayed.
    requestHandler: { connectionTimeout: 30_000, requestTimeout: 10 * 60_000 },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

class Transfer {
  constructor({ client, bucket, maxBytes = 2 * 1024 ** 3, readAttempts = 3 }) {
    this.client = client;
    this.bucket = bucket;
    this.maxBytes = positiveLimit(maxBytes);
    this.readAttempts = readAttempts;
  }
  async request(command, { read = false, absent = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.send(command);
      } catch (error) {
        const status = error.$metadata?.httpStatusCode || error.status;
        if (absent && status === 404) return undefined;
        if (
          read &&
          attempt + 1 < this.readAttempts &&
          (!status || [429, 500, 502, 503, 504].includes(status))
        ) {
          await new Promise((resolvePromise) =>
            setTimeout(resolvePromise, 200 * (attempt + 1)),
          );
          continue;
        }
        throw new Error(
          `S3 ${command.constructor.name.replace("Command", "")} failed${status ? " (HTTP " + status + ")" : ""}`,
        );
      }
    }
  }
  head(key, versionId) {
    return this.request(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
        VersionId: versionId,
      }),
      { read: true, absent: true },
    );
  }
  async read(key, path, object) {
    if (
      !Number.isSafeInteger(object.size) ||
      object.size < 1 ||
      object.size > this.maxBytes ||
      !DIGEST.test(object.hash)
    )
      throw new Error("Invalid or excessive artifact size");
    const received = await this.request(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        VersionId: object.versionId,
      }),
      { read: true },
    );
    if (
      (object.versionId !== undefined &&
        received.VersionId !== object.versionId) ||
      (received.ContentLength !== undefined &&
        received.ContentLength !== object.size)
    ) {
      received.Body?.destroy?.();
      throw new Error("S3 artifact size mismatch");
    }
    let bytes = 0;
    const bounded = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        callback(
          bytes > object.size
            ? new Error("S3 artifact exceeds registered size")
            : null,
          chunk,
        );
      },
    });
    try {
      await pipeline(
        received.Body,
        bounded,
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      );
    } catch {
      await fs.rm(path, { force: true });
      throw new Error("S3 artifact download interrupted");
    }
    if (bytes !== object.size || (await hashFile(path)) !== object.hash) {
      await fs.rm(path, { force: true });
      throw new Error("S3 artifact bytes do not match their record");
    }
  }
  async upload({
    identity,
    prefix: objectPrefix,
    directory,
    files,
    outputFile,
  }) {
    validateIdentity(identity);
    prefix(objectPrefix);
    if (
      !Array.isArray(files) ||
      !files.length ||
      files.length > 100 ||
      new Set(files).size !== files.length
    )
      throw new Error("Explicit unique allowed files are required");
    const record = {
      schema_version: 1,
      identity,
      prefix: objectPrefix,
      objects: [],
    };
    const root = await fs.realpath(directory);
    const prepared = [];
    for (const name of files) {
      fileName(name);
      const source = resolve(root, name);
      const entry = await fs.lstat(source);
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        (await fs.realpath(source)) !== source
      )
        throw new Error("Artifacts must be regular files without symlinks");
      const size = (await fs.stat(source)).size;
      if (!Number.isSafeInteger(size) || size < 1 || size > this.maxBytes)
        throw new Error("Artifact size is invalid");
      const object = {
        name,
        key: objectPrefix + "/" + name,
        size,
        hash: await hashFile(source),
      };
      prepared.push({ source, object });
    }
    await validateOutputPath(
      { objects: prepared.map(({ object }) => object) },
      root,
      outputFile,
    );
    for (const { source, object } of prepared) {
      const { size } = object;
      if (!(await this.head(object.key))) {
        try {
          await this.request(
            new PutObjectCommand({
              Bucket: this.bucket,
              Key: object.key,
              Body: createReadStream(source),
              ContentLength: size,
              IfNoneMatch: "*",
              Metadata: {
                sha256: object.hash,
                repository: identity.repository,
                source: identity.source,
                run: String(identity.run),
                attempt: String(identity.attempt),
                job: String(identity.job),
              },
            }),
          );
        } catch {
          /* A conditional or unknown write is accepted only after exact read-back below. */
        }
      }
      const head = await this.head(object.key);
      if (
        !head ||
        head.ContentLength !== size ||
        head.Metadata?.sha256 !== object.hash ||
        ["repository", "source", "run", "attempt", "job"].some(
          (key) => head.Metadata?.[key] !== String(identity[key]),
        )
      )
        throw new Error("S3 upload producer identity or size mismatch");
      if (head.VersionId !== undefined) object.versionId = head.VersionId;
      const temp = resolve(root, ".verify-" + randomUUID());
      try {
        await this.read(object.key, temp, object);
      } finally {
        await fs.rm(temp, { force: true });
      }
      record.objects.push(object);
    }
    return validateRecord(record, identity);
  }
  async download(record, { identity, directory, allowedFiles }) {
    validateRecord(record, identity);
    if (
      !Array.isArray(allowedFiles) ||
      allowedFiles.length !== record.objects.length ||
      record.objects.some((object) => !allowedFiles.includes(object.name))
    )
      throw new Error("Artifact allowlist mismatch");
    await fs.mkdir(directory, { recursive: true });
    const root = await fs.realpath(directory);
    const staging = await fs.mkdtemp(resolve(root, ".download-"));
    const incoming = resolve(staging, "incoming");
    await fs.mkdir(incoming);
    const replaced = [];
    let preserveBackup = false;
    try {
      // No destination is touched until the entire generation has been verified.
      for (const object of record.objects)
        await this.read(object.key, resolve(incoming, object.name), object);
      const backup = resolve(staging, "previous");
      await fs.mkdir(backup);
      for (const object of record.objects) {
        const target = resolve(root, object.name);
        const old = resolve(backup, object.name);
        const entry = { target, old, saved: false, installed: false };
        replaced.push(entry);
        const existing = await fs.lstat(target).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (existing) {
          if (!existing.isFile() || existing.isSymbolicLink())
            throw new Error("Download target must be a regular file");
          await fs.rename(target, old);
          entry.saved = true;
        }
        await fs.rename(resolve(incoming, object.name), target);
        entry.installed = true;
      }
    } catch (error) {
      for (const entry of replaced.reverse()) {
        try {
          if (entry.installed) await fs.rm(entry.target);
          if (entry.saved) await fs.rename(entry.old, entry.target);
        } catch {
          preserveBackup = true;
        }
      }
      if (preserveBackup)
        throw new Error(
          "Download rollback incomplete; retained backup at " + staging,
          { cause: error },
        );
      throw error;
    } finally {
      if (!preserveBackup)
        await fs.rm(staging, { recursive: true, force: true });
    }
    return record;
  }
  async remove(
    record,
    {
      identity,
      consumers,
      allowLegacyMetadata = false,
      tempRoot = require("node:os").tmpdir(),
    },
  ) {
    validateRecord(record, identity);
    if (
      !Array.isArray(consumers) ||
      !consumers.length ||
      consumers.some(
        (job) =>
          job.status !== "completed" ||
          !Number.isSafeInteger(job.id) ||
          job.id < 1,
      )
    )
      throw new Error("Consumers have not terminated");
    for (const object of record.objects) {
      const head = await this.head(object.key, object.versionId);
      if (head) {
        if (head.VersionId !== object.versionId)
          throw new Error(
            "S3 versioned deletion requires the recorded object version",
          );
        const metadataMatches =
          head.Metadata?.sha256 === object.hash &&
          ["repository", "source", "run", "attempt", "job"].every(
            (key) => head.Metadata?.[key] === String(record.identity[key]),
          );
        if (
          head.ContentLength !== object.size ||
          (!metadataMatches &&
            (!allowLegacyMetadata ||
              ["sha256", "repository", "source", "run", "attempt", "job"].some(
                (key) => head.Metadata?.[key] !== undefined,
              )))
        )
          throw new Error("S3 object no longer matches its producer identity");
        if (!metadataMatches) {
          const path = resolve(tempRoot, ".legacy-check-" + randomUUID());
          try {
            await this.read(object.key, path, object);
          } finally {
            await fs.rm(path, { force: true });
          }
        }
        if (typeof head.ETag !== "string" || !head.ETag.trim())
          throw new Error("S3 delete requires a confirmed ETag");
        try {
          await this.request(
            new DeleteObjectCommand({
              Bucket: this.bucket,
              Key: object.key,
              VersionId: object.versionId,
              IfMatch: head.ETag,
            }),
          );
        } catch {}
        if (await this.head(object.key, object.versionId))
          throw new Error("S3 object deletion is unconfirmed");
      }
    }
    return { deleted: record.objects.length };
  }
}

async function run({ inputs, core }) {
  for (const key of ["access-key-id", "secret-access-key", "session-token"])
    if (inputs[key]) core.setSecret(inputs[key]);
  const maxBytes = positiveLimit(
    Number(inputs["max-file-bytes"] || 2 * 1024 ** 3),
  );
  const transfer = new Transfer({
    client: createClient({
      endpoint: inputs.endpoint,
      region: inputs.region,
      bucket: inputs.bucket,
      accessKeyId: inputs["access-key-id"],
      secretAccessKey: inputs["secret-access-key"],
      sessionToken: inputs["session-token"],
      pathStyle: inputs["path-style"] !== "false",
    }),
    bucket: inputs.bucket,
    maxBytes,
  });
  const identity = JSON.parse(
    await fs.readFile(inputs["identity-file"], "utf8"),
  );
  let result;
  if (inputs.operation === "upload")
    result = await transfer.upload({
      identity,
      prefix: inputs.prefix,
      directory: inputs.directory,
      files: JSON.parse(inputs.files),
      outputFile: inputs["output-file"],
    });
  else {
    const record = JSON.parse(await fs.readFile(inputs["record-file"], "utf8"));
    if (inputs.operation === "download") {
      validateRecord(record, identity);
      await validateOutputPath(record, inputs.directory, inputs["output-file"]);
      result = await transfer.download(record, {
        identity,
        directory: inputs.directory,
        allowedFiles: JSON.parse(inputs.files),
      });
    } else if (inputs.operation === "delete")
      result = await transfer.remove(record, {
        identity,
        consumers: JSON.parse(
          await fs.readFile(inputs["consumers-file"], "utf8"),
        ),
      });
    else if (inputs.operation === "register") {
      validateRecord(record, identity);
      for (const object of record.objects) {
        const head = await transfer.head(object.key, object.versionId);
        if (
          !head ||
          (object.versionId !== undefined &&
            head.VersionId !== object.versionId)
        )
          throw new Error("Registered S3 object version is missing");
        if (head.VersionId !== undefined) object.versionId = head.VersionId;
        const path = resolve(inputs.directory, ".register-" + randomUUID());
        try {
          await transfer.read(object.key, path, object);
        } finally {
          await fs.rm(path, { force: true });
        }
      }
      result = record;
    } else throw new Error("Unknown S3 operation");
  }
  if (inputs["output-file"]) {
    await fs.mkdir(dirname(resolve(inputs["output-file"])), {
      recursive: true,
    });
    await fs.writeFile(
      inputs["output-file"],
      JSON.stringify(result, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
  core.setOutput("record", JSON.stringify(result));
  if (result.objects)
    core.info("CI_ARTIFACT_REGISTRATION " + JSON.stringify(result));
  if (result.deleted !== undefined) core.setOutput("deleted", result.deleted);
  return result;
}
module.exports = {
  hashFile,
  positiveLimit,
  validateOutputPath,
  validateIdentity,
  validateRecord,
  createClient,
  Transfer,
  run,
  commands: {
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
  },
};
