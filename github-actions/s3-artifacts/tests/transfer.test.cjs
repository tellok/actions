const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { Readable } = require("node:stream");
const { Transfer, createClient, validateRecord } = require(
  process.env.TOOLKIT_TEST_DIST === "true"
    ? "../dist/index.js"
    : "../lib/runtime.cjs",
);
const identity = {
  repository: "example/app",
  source: "a".repeat(40),
  run: 1,
  attempt: 1,
  job: 10,
};
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), "s3-transfer-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(join(dir, "image.bin"), "image bytes");
  const objects = new Map();
  const calls = [];
  const state = {
    unknownPut: false,
    unknownDelete: false,
    denied: false,
    broken: false,
  };
  const client = {
    send: async (command) => {
      const name = command.constructor.name,
        key = command.input.Key;
      calls.push(name);
      if (state.denied) throw { $metadata: { httpStatusCode: 403 } };
      if (name === "PutObjectCommand") {
        const chunks = [];
        for await (const chunk of command.input.Body) chunks.push(chunk);
        if (objects.has(key)) throw { $metadata: { httpStatusCode: 412 } };
        objects.set(key, {
          bytes: Buffer.concat(chunks),
          meta: command.input.Metadata,
        });
        if (state.unknownPut) throw new Error("lost response");
        return {};
      }
      const item = objects.get(key);
      if (!item) throw { $metadata: { httpStatusCode: 404 } };
      if (name === "HeadObjectCommand")
        return {
          ContentLength: item.bytes.length,
          Metadata: item.meta,
          ETag: "etag",
        };
      if (name === "GetObjectCommand")
        return {
          ContentLength: item.bytes.length,
          Body: state.broken
            ? Readable.from(
                (async function* () {
                  yield item.bytes.slice(0, 2);
                  throw new Error("network");
                })(),
              )
            : Readable.from([item.bytes]),
        };
      if (name === "DeleteObjectCommand") {
        objects.delete(key);
        if (state.unknownDelete) throw new Error("lost response");
        return {};
      }
    },
  };
  const transfer = new Transfer({
    client,
    bucket: "test-bucket",
    readAttempts: 1,
  });
  return {
    dir,
    objects,
    calls,
    state,
    transfer,
    upload: () =>
      transfer.upload({
        identity,
        prefix: "build/1/1/10",
        directory: dir,
        files: ["image.bin"],
      }),
  };
}
test("standard configuration and upload read-back download identical bytes", async (t) => {
  assert.throws(() =>
    createClient({ endpoint: "http://user:pass@example.test" }),
  );
  const f = await fixture(t),
    record = await f.upload();
  await f.transfer.download(record, {
    identity,
    directory: join(f.dir, "out"),
    allowedFiles: ["image.bin"],
  });
  assert.equal(
    await fs.readFile(join(f.dir, "out/image.bin"), "utf8"),
    "image bytes",
  );
});
test("interrupted download preserves the existing file and removes partial bytes", async (t) => {
  const f = await fixture(t),
    record = await f.upload();
  const out = join(f.dir, "out");
  await fs.mkdir(out);
  await fs.writeFile(join(out, "image.bin"), "previous");
  f.state.broken = true;
  await assert.rejects(
    f.transfer.download(record, {
      identity,
      directory: out,
      allowedFiles: ["image.bin"],
    }),
    /interrupted/,
  );
  assert.equal(await fs.readFile(join(out, "image.bin"), "utf8"), "previous");
  assert.deepEqual(await fs.readdir(out), ["image.bin"]);
});
test("unknown upload is confirmed and conflicting objects are not overwritten", async (t) => {
  const f = await fixture(t);
  f.state.unknownPut = true;
  await f.upload();
  await fs.writeFile(join(f.dir, "image.bin"), "other bytes");
  await assert.rejects(f.upload(), /match|size/);
  assert.equal(f.calls.filter((x) => x === "PutObjectCommand").length, 1);
});
test("wrong source and out-of-scope keys are rejected", async (t) => {
  const f = await fixture(t),
    record = await f.upload();
  assert.throws(
    () => validateRecord(record, { ...identity, source: "b".repeat(40) }),
    /generation/,
  );
  assert.throws(
    () =>
      validateRecord(
        { ...record, objects: [{ ...record.objects[0], key: "another/key" }] },
        identity,
      ),
    /scope/,
  );
});
test("terminal cleanup targets only the recorded producer attempt", async (t) => {
  const f = await fixture(t),
    record = await f.upload();
  f.objects.set("build/1/2/10/image.bin", { bytes: Buffer.from("new") });
  await assert.rejects(
    f.transfer.remove(record, {
      identity,
      consumers: [{ id: 20, status: "in_progress" }],
    }),
  );
  await f.transfer.remove(record, {
    identity,
    consumers: [{ id: 20, status: "completed" }],
  });
  assert.equal(f.objects.size, 1);
  assert.ok(f.objects.has("build/1/2/10/image.bin"));
});
test("unknown deletion is confirmed but permission failure is never absence", async (t) => {
  const f = await fixture(t),
    record = await f.upload();
  f.state.unknownDelete = true;
  assert.equal(
    (
      await f.transfer.remove(record, {
        identity,
        consumers: [{ id: 20, status: "completed" }],
      })
    ).deleted,
    1,
  );
  f.state.denied = true;
  await assert.rejects(f.transfer.head("x"), /403/);
});

test("later artifact failure leaves every previous destination unchanged", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(join(f.dir, "manifest.json"), "new manifest");
  const record = await f.transfer.upload({
    identity,
    prefix: "build/1/1/10",
    directory: f.dir,
    files: ["image.bin", "manifest.json"],
  });
  const out = join(f.dir, "out");
  await fs.mkdir(out);
  await fs.writeFile(join(out, "image.bin"), "old image");
  await fs.writeFile(join(out, "manifest.json"), "old manifest");
  f.objects.get(record.objects[1].key).bytes = Buffer.from("bad manifest");
  await assert.rejects(
    f.transfer.download(record, {
      identity,
      directory: out,
      allowedFiles: ["image.bin", "manifest.json"],
    }),
    /bytes do not match/,
  );
  assert.equal(await fs.readFile(join(out, "image.bin"), "utf8"), "old image");
  assert.equal(
    await fs.readFile(join(out, "manifest.json"), "utf8"),
    "old manifest",
  );
  assert.deepEqual((await fs.readdir(out)).sort(), [
    "image.bin",
    "manifest.json",
  ]);
});
test("existing identical bytes with missing or conflicting producer metadata cannot register as a new upload", async (t) => {
  for (const metadata of [{}, { repository: "other/repo" }]) {
    const f = await fixture(t),
      record = await f.upload();
    f.objects.get(record.objects[0].key).meta = metadata;
    await assert.rejects(f.upload(), /producer identity/);
    assert.equal(f.calls.filter((x) => x === "PutObjectCommand").length, 1);
  }
});
test("missing or whitespace ETag never causes an unconditional delete", async (t) => {
  for (const etag of [undefined, "", "   "]) {
    const f = await fixture(t),
      record = await f.upload();
    const original = f.transfer.client.send;
    f.transfer.client.send = async (command) => {
      const response = await original(command);
      if (command.constructor.name === "HeadObjectCommand")
        response.ETag = etag;
      return response;
    };
    await assert.rejects(
      f.transfer.remove(record, {
        identity,
        consumers: [{ id: 20, status: "completed" }],
      }),
      /ETag/,
    );
    assert.equal(f.calls.includes("DeleteObjectCommand"), false);
  }
});
test("invalid per-file limits fail before transferring any bytes", () => {
  for (const maxBytes of [
    NaN,
    Infinity,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => new Transfer({ maxBytes }), /positive safe integer/);
});
test("result file cannot alias a download target through paths or symlinks", async (t) => {
  const f = await fixture(t),
    record = await f.upload();
  const { validateOutputPath } = require(
    process.env.TOOLKIT_TEST_DIST === "true"
      ? "../dist/index.js"
      : "../lib/runtime.cjs",
  );
  await assert.rejects(
    validateOutputPath(record, f.dir, join(f.dir, "image.bin")),
    /collides/,
  );
  await fs.symlink(join(f.dir, "image.bin"), join(f.dir, "result.json"));
  await assert.rejects(
    validateOutputPath(record, f.dir, join(f.dir, "result.json")),
    /collides/,
  );
  await fs.symlink(f.dir, join(f.dir, "alias"));
  await assert.rejects(
    validateOutputPath(
      record,
      join(f.dir, "new"),
      join(f.dir, "alias/new/image.bin"),
    ),
    /collides/,
  );
  await validateOutputPath(record, f.dir, join(f.dir, "record.json"));
});
test("versioned uploads retain and delete only their recorded version", async (t) => {
  const f = await fixture(t),
    commands = [],
    versions = new Map();
  const send = f.transfer.client.send;
  f.transfer.client.send = async (command) => {
    const { VersionId, Key } = command.input,
      name = command.constructor.name;
    commands.push(command);
    if (VersionId) {
      const item = versions.get(VersionId);
      if (!item) throw { $metadata: { httpStatusCode: 404 } };
      if (name === "HeadObjectCommand")
        return {
          ContentLength: item.bytes.length,
          Metadata: item.meta,
          ETag: "etag",
          VersionId,
        };
      if (name === "GetObjectCommand")
        return {
          ContentLength: item.bytes.length,
          VersionId,
          Body: Readable.from([item.bytes]),
        };
      if (name === "DeleteObjectCommand") {
        versions.delete(VersionId);
        return {};
      }
    }
    const response = await send(command);
    if (name === "PutObjectCommand")
      versions.set("version-1", f.objects.get(Key));
    if (name === "HeadObjectCommand" || name === "GetObjectCommand")
      response.VersionId = "version-1";
    return response;
  };
  const record = await f.upload();
  assert.equal(record.objects[0].versionId, "version-1");
  f.objects.set(record.objects[0].key, {
    bytes: Buffer.from("new version"),
    meta: {},
  });
  await f.transfer.remove(record, {
    identity,
    consumers: [{ id: 20, status: "completed" }],
  });
  assert.equal(versions.has("version-1"), false);
  assert.equal(f.objects.has(record.objects[0].key), true);
  assert.equal(
    commands.find((c) => c.constructor.name === "DeleteObjectCommand").input
      .VersionId,
    "version-1",
  );
});
test("legacy unversioned record cannot delete a versioned object", async (t) => {
  const f = await fixture(t),
    record = await f.upload(),
    send = f.transfer.client.send;
  f.transfer.client.send = async (command) => ({
    ...(await send(command)),
    VersionId: "new-version",
  });
  await assert.rejects(
    f.transfer.remove(record, {
      identity,
      consumers: [{ id: 20, status: "completed" }],
    }),
    /recorded object version/,
  );
  assert.equal(f.calls.includes("DeleteObjectCommand"), false);
});

test("replacement failure rolls earlier destination files back", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(join(f.dir, "manifest.json"), "new manifest");
  const record = await f.transfer.upload({
    identity,
    prefix: "build/1/1/10",
    directory: f.dir,
    files: ["image.bin", "manifest.json"],
  });
  const out = join(f.dir, "out");
  await fs.mkdir(join(out, "manifest.json"), { recursive: true });
  await fs.writeFile(join(out, "image.bin"), "old image");
  await assert.rejects(
    f.transfer.download(record, {
      identity,
      directory: out,
      allowedFiles: ["image.bin", "manifest.json"],
    }),
    /regular file/,
  );
  assert.equal(await fs.readFile(join(out, "image.bin"), "utf8"), "old image");
  assert.deepEqual((await fs.readdir(out)).sort(), [
    "image.bin",
    "manifest.json",
  ]);
});
test("unknown PUT outcome with wrong producer metadata is rejected", async (t) => {
  const f = await fixture(t),
    send = f.transfer.client.send;
  f.transfer.client.send = async (command) => {
    const response = await send(command);
    if (command.constructor.name === "PutObjectCommand") {
      f.objects.get(command.input.Key).meta = {};
      throw new Error("unknown PUT outcome");
    }
    return response;
  };
  await assert.rejects(f.upload(), /producer identity/);
});

for (const absolute of [false, true]) {
  test(`download rejects a ${absolute ? "absolute" : "relative"} dangling result symlink before transfer`, async (t) => {
    const f = await fixture(t),
      record = await f.upload();
    const out = join(f.dir, "out");
    await fs.mkdir(out);
    const output = join(out, "record.json");
    await fs.symlink(absolute ? join(out, "image.bin") : "image.bin", output);
    const identityFile = join(f.dir, "identity.json"),
      recordFile = join(f.dir, "production.json");
    await fs.writeFile(identityFile, JSON.stringify(identity));
    await fs.writeFile(recordFile, JSON.stringify(record));
    const { run } = require(
      process.env.TOOLKIT_TEST_DIST === "true"
        ? "../dist/index.js"
        : "../lib/runtime.cjs",
    );
    await assert.rejects(
      run({
        inputs: {
          operation: "download",
          endpoint: "http://127.0.0.1:9",
          region: "test",
          bucket: "test-bucket",
          "access-key-id": "test-key",
          "secret-access-key": "test-secret",
          "identity-file": identityFile,
          "record-file": recordFile,
          directory: out,
          files: '["image.bin"]',
          "output-file": output,
        },
        core: {
          setSecret() {},
          setOutput() {
            throw new Error("Unexpected success output");
          },
        },
      }),
      /Unresolved symlink/,
    );
    assert.equal((await fs.lstat(output)).isSymbolicLink(), true);
    await assert.rejects(fs.stat(join(out, "image.bin")), { code: "ENOENT" });
  });
}
test("result paths reject an unresolved directory symlink ancestor", async (t) => {
  const f = await fixture(t),
    record = await f.upload();
  await fs.symlink("missing-directory", join(f.dir, "dangling"));
  const { validateOutputPath } = require(
    process.env.TOOLKIT_TEST_DIST === "true"
      ? "../dist/index.js"
      : "../lib/runtime.cjs",
  );
  await assert.rejects(
    validateOutputPath(record, f.dir, join(f.dir, "dangling/record.json")),
    /Unresolved symlink/,
  );
});
