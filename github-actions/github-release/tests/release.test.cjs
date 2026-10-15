const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { ensureRelease, hashFile, createGitHubClient } = require(
  process.env.TOOLKIT_TEST_DIST === "true"
    ? "../dist/index.js"
    : "../lib/runtime.cjs",
);
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

test("missing or invalid declared hashes fail before tag or release creation", async (t) => {
  for (const hash of [undefined, "", "sha256:bad", "a".repeat(64)]) {
    const f = await fixture(t);
    await assert.rejects(
      ensureRelease({ ...f.options, files: [{ ...f.files[0], hash }] }),
      /declared SHA-256/,
    );
    assert.deepEqual(f.calls, []);
  }
});
test("empty publication manifest fails without leaving a tag or draft", async (t) => {
  const f = await fixture(t);
  await assert.rejects(ensureRelease({ ...f.options, files: [] }), /nonempty/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.tag, undefined);
  assert.equal(f.state.release, undefined);
});
test("generated notes containing either managed marker fail before remote writes", async (t) => {
  for (const notes of ["contains start here", "contains end here"]) {
    const f = await fixture(t);
    await assert.rejects(
      ensureRelease({ ...f.options, notes }),
      /must not contain/,
    );
    assert.deepEqual(f.calls, []);
  }
});
test("draft operation cannot rewrite a published release", async (t) => {
  const f = await fixture(t);
  await ensureRelease(f.options);
  const body = f.state.release.body,
    calls = f.calls.length;
  await assert.rejects(
    ensureRelease({ ...f.options, operation: "draft", notes: "changed" }),
    /cannot modify a published/,
  );
  assert.equal(f.state.release.body, body);
  assert.equal(f.calls.length, calls);
});
test("fresh release body retains concurrent maintainer notes", async (t) => {
  const f = await fixture(t);
  await ensureRelease({ ...f.options, operation: "draft" });
  f.api.getRelease = async () => ({ ...f.state.release });
  const get = f.api.getReleaseById;
  let edited = false;
  f.api.getReleaseById = async (id) => {
    if (!edited) {
      edited = true;
      f.state.release.body = "concurrent note\n" + f.state.release.body;
    }
    return get(id);
  };
  await ensureRelease({ ...f.options, operation: "draft", notes: "new notes" });
  assert.equal(f.state.release.body, "concurrent note\nstart\nnew notes\nend");
});
test("tag movement during asset upload blocks publication", async (t) => {
  const f = await fixture(t),
    upload = f.api.uploadAsset;
  f.api.uploadAsset = async (...args) => {
    await upload(...args);
    f.state.tag = "b".repeat(40);
  };
  await assert.rejects(ensureRelease(f.options), /tag changed/);
  assert.equal(f.calls.includes("publish"), false);
});
test("tag movement at publication cannot return success", async (t) => {
  const f = await fixture(t),
    publish = f.api.publishRelease;
  f.api.publishRelease = async () => {
    await publish();
    f.state.tag = "b".repeat(40);
  };
  await assert.rejects(ensureRelease(f.options), /tag changed/);
});
test("asset removed between upload verification and publication blocks publication", async (t) => {
  const f = await fixture(t),
    list = f.api.listAssets;
  let count = 0;
  f.api.listAssets = async () => {
    if (++count === 3) f.state.assets = [];
    return list();
  };
  await assert.rejects(ensureRelease(f.options), /asset set changed/);
  assert.equal(f.calls.includes("publish"), false);
});
test("asset replaced at publication cannot return success", async (t) => {
  const f = await fixture(t),
    publish = f.api.publishRelease;
  f.api.publishRelease = async () => {
    await publish();
    f.state.assets[0].digest = "sha256:" + "f".repeat(64);
  };
  await assert.rejects(ensureRelease(f.options), /digest conflict/);
});
test("asset confirmation remains bound to caller hash when local bytes change", async (t) => {
  const f = await fixture(t),
    upload = f.api.uploadAsset;
  f.api.uploadAsset = async (...args) => {
    await fs.writeFile(f.files[0].path, "corrupted image");
    await upload(...args);
    f.state.assets[0].digest = await hashFile(f.files[0].path);
  };
  await assert.rejects(ensureRelease(f.options), /digest conflict/);
  assert.equal(f.calls.includes("publish"), false);
});

test("tag movement during draft creation cannot return success", async (t) => {
  const f = await fixture(t),
    create = f.api.createRelease;
  f.api.createRelease = async (data) => {
    const release = await create(data);
    f.state.tag = "b".repeat(40);
    return release;
  };
  await assert.rejects(
    ensureRelease({ ...f.options, operation: "draft" }),
    /tag changed during draft/,
  );
  assert.equal(f.calls.includes("publish"), false);
});
test("tag movement during draft notes update cannot return success", async (t) => {
  const f = await fixture(t);
  await ensureRelease({ ...f.options, operation: "draft" });
  const update = f.api.updateRelease;
  f.api.updateRelease = async (...args) => {
    await update(...args);
    f.state.tag = "b".repeat(40);
  };
  await assert.rejects(
    ensureRelease({ ...f.options, operation: "draft", notes: "updated notes" }),
    /tag changed during draft/,
  );
  assert.equal(f.calls.includes("publish"), false);
});
for (const [field, value] of [
  ["id", 2],
  ["tag_name", "v2.0.0"],
  ["name", "other"],
  ["target_commitish", "b".repeat(40)],
  ["draft", false],
]) {
  test(`draft confirmation rejects changed ${field} identity`, async (t) => {
    const f = await fixture(t),
      get = f.api.getReleaseById;
    let reads = 0;
    f.api.getReleaseById = async (id) => {
      const release = await get(id);
      if (++reads === 2) return { ...release, [field]: value };
      return release;
    };
    await assert.rejects(
      ensureRelease({ ...f.options, operation: "draft" }),
      /Draft release identity changed/,
    );
    assert.equal(f.calls.includes("publish"), false);
  });
}

for (const [start, end] of [
  ["<!--notes", "<!--notes:end-->"],
  ["<!--notes:start-->", "<!--notes"],
]) {
  test(`overlapping release markers ${start} / ${end} fail before remote writes`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      ensureRelease({ ...f.options, start, end }),
      /Invalid release identity or notes markers/,
    );
    assert.deepEqual(f.calls, []);
    assert.equal(f.state.tag, undefined);
    assert.equal(f.state.release, undefined);
  });
}

for (const [field, value] of [
  ["name", "changed"],
  ["prerelease", true],
]) {
  test(`changed release ${field} during upload blocks publication`, async (t) => {
    const f = await fixture(t),
      upload = f.api.uploadAsset;
    f.api.uploadAsset = async (...args) => {
      await upload(...args);
      f.state.release[field] = value;
    };
    await assert.rejects(
      ensureRelease(f.options),
      /identity changed before publication/,
    );
    assert.equal(f.calls.includes("publish"), false);
  });
  test(`changed release ${field} during publication cannot return success or promote Latest`, async (t) => {
    const f = await fixture(t),
      publish = f.api.publishRelease;
    f.api.publishRelease = async () => {
      await publish();
      f.state.release[field] = value;
    };
    await assert.rejects(
      ensureRelease({ ...f.options, latest: true }),
      /publication is unconfirmed/,
    );
    assert.equal(f.state.latest, 99);
  });
}

test("undeclared existing draft assets block publication without deleting remote content", async (t) => {
  const f = await fixture(t);
  await ensureRelease({ ...f.options, operation: "draft" });
  const extra = {
    name: "old.bin",
    size: 15,
    state: "uploaded",
    digest: f.files[0].hash,
  };
  f.state.assets.push(extra);
  await assert.rejects(ensureRelease(f.options), /undeclared or missing asset/);
  assert.equal(f.calls.includes("publish"), false);
  assert.ok(f.state.assets.includes(extra));
});
test("asset added at publication blocks success and Latest promotion", async (t) => {
  const f = await fixture(t),
    publish = f.api.publishRelease;
  f.api.publishRelease = async () => {
    await publish();
    f.state.assets.push({
      name: "unexpected.bin",
      size: 15,
      state: "uploaded",
      digest: f.files[0].hash,
    });
  };
  await assert.rejects(
    ensureRelease({ ...f.options, latest: true }),
    /undeclared or missing asset/,
  );
  assert.equal(f.state.latest, 99);
});
test("extra assets added during Latest update are rejected at final confirmation", async (t) => {
  const f = await fixture(t),
    update = f.api.updateRelease;
  f.api.updateRelease = async (id, data) => {
    await update(id, data);
    if (data.make_latest === "true")
      f.state.assets.push({ name: "unexpected.bin" });
  };
  await assert.rejects(
    ensureRelease({ ...f.options, latest: true }),
    /undeclared or missing asset/,
  );
});
for (const latest of ["True", "treu", "", true, 1, null]) {
  test(`release action rejects invalid latest input ${JSON.stringify(latest)} before any I/O`, async () => {
    const { run } = require(
      process.env.TOOLKIT_TEST_DIST === "true"
        ? "../dist/index.js"
        : "../lib/runtime.cjs",
    );
    await assert.rejects(
      run({
        inputs: {
          operation: "publish",
          latest,
          "notes-file": "/does-not-exist",
        },
        github: {},
        context: {},
        core: {},
      }),
      /latest input must be exactly/,
    );
  });
}
for (const latest of ["false", 1, null]) {
  test(`programmatic release rejects non-boolean latest ${JSON.stringify(latest)}`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      ensureRelease({ ...f.options, latest }),
      /latest must be a boolean/,
    );
    assert.deepEqual(f.calls, []);
  });
}
for (const name of [
  ".checksums",
  "artifact.",
  "with space.zip",
  "file#1.zip",
  "a\\b.zip",
  "文件.zip",
]) {
  test(`normalized asset name ${JSON.stringify(name)} fails before creating remote resources`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      ensureRelease({ ...f.options, files: [{ ...f.files[0], name }] }),
      /Invalid release asset path\/name/,
    );
    assert.deepEqual(f.calls, []);
    assert.equal(f.state.tag, undefined);
    assert.equal(f.state.release, undefined);
  });
}
test("safe checksum and platform archive names are accepted", async (t) => {
  const f = await fixture(t);
  await ensureRelease({
    ...f.options,
    operation: "draft",
    files: [
      { ...f.files[0], name: "SHA256SUMS" },
      { ...f.files[0], name: "linux-amd64_v1.tar.gz" },
    ],
  });
  assert.deepEqual(f.calls, ["tag", "draft"]);
});

for (const change of ["replace", "remove"]) {
  test(`${change} managed notes during upload blocks publication`, async (t) => {
    const f = await fixture(t),
      upload = f.api.uploadAsset;
    f.api.uploadAsset = async (...args) => {
      await upload(...args);
      f.state.release.body =
        change === "remove" ? "human note only" : "start\nother notes\nend";
    };
    await assert.rejects(
      ensureRelease(f.options),
      /Managed release notes changed/,
    );
    assert.equal(f.calls.includes("publish"), false);
  });
}
test("managed notes changed at publication prevent success and Latest promotion", async (t) => {
  const f = await fixture(t),
    publish = f.api.publishRelease;
  f.api.publishRelease = async (...args) => {
    await publish(...args);
    f.state.release.body = "start\nother notes\nend";
  };
  await assert.rejects(
    ensureRelease({ ...f.options, latest: true }),
    /Managed release notes changed/,
  );
  assert.equal(f.state.latest, 99);
});
test("managed notes changed at Latest update are rejected before success", async (t) => {
  const f = await fixture(t),
    update = f.api.updateRelease;
  f.api.updateRelease = async (id, data) => {
    await update(id, data);
    if (data.make_latest) f.state.release.body = "human note only";
  };
  await assert.rejects(
    ensureRelease({ ...f.options, latest: true }),
    /Managed release notes changed/,
  );
});
test("outside notes edited during upload remain allowed and preserved", async (t) => {
  const f = await fixture(t),
    upload = f.api.uploadAsset;
  f.api.uploadAsset = async (...args) => {
    await upload(...args);
    f.state.release.body =
      "fresh human note\n" + f.state.release.body + "\nfooter";
  };
  await ensureRelease(f.options);
  assert.equal(
    f.state.release.body,
    "fresh human note\nstart\nnotes\nend\nfooter",
  );
});

test("draft confirmation rejects changed managed notes", async (t) => {
  const f = await fixture(t),
    get = f.api.getReleaseById;
  let reads = 0;
  f.api.getReleaseById = async (...args) => {
    const result = await get(...args);
    if (++reads === 2) result.body = "human note only";
    return result;
  };
  await assert.rejects(
    ensureRelease({ ...f.options, operation: "draft" }),
    /Managed release notes changed/,
  );
});

test("prerelease publication and recovery preserve identity and stable Latest", async (t) => {
  const f = await fixture(t);
  const options = {
    ...f.options,
    tag: "v2.0.0-beta.0",
    name: "2.0.0-beta.0",
    prerelease: true,
  };
  await ensureRelease(options);
  assert.equal(f.state.release.prerelease, true);
  assert.equal(f.state.release.draft, false);
  assert.equal(f.state.latest, 99);
  const result = await ensureRelease({ ...options, operation: "recover" });
  assert.equal(result.published, true);
  assert.equal(f.calls.filter((call) => call === "draft").length, 1);
  assert.equal(f.state.release.prerelease, true);
  assert.equal(f.state.latest, 99);
});

test("prerelease Latest promotion fails before any remote access", async (t) => {
  const f = await fixture(t);
  f.api.getTag = async () => {
    throw new Error("Unexpected remote access");
  };
  await assert.rejects(
    ensureRelease({ ...f.options, prerelease: true, latest: true }),
    /cannot be promoted to Latest/,
  );
  assert.deepEqual(f.calls, []);
});

test("non-boolean prerelease values fail before any remote access", async (t) => {
  const f = await fixture(t);
  f.api.getTag = async () => {
    throw new Error("Unexpected remote access");
  };
  for (const prerelease of ["true", 1, null]) {
    await assert.rejects(
      ensureRelease({ ...f.options, prerelease }),
      /prerelease must be a boolean/,
    );
  }
  assert.deepEqual(f.calls, []);
});

test("action rejects invalid prerelease flags and Latest promotion before file reads", async () => {
  const { run } = require(
    process.env.TOOLKIT_TEST_DIST === "true"
      ? "../dist/index.js"
      : "../lib/runtime.cjs",
  );
  for (const prerelease of ["TRUE", "yes", ""]) {
    await assert.rejects(
      run({ inputs: { operation: "publish", prerelease } }),
      /prerelease input must be exactly/,
    );
  }
  await assert.rejects(
    run({
      inputs: { operation: "publish", prerelease: "true", latest: "true" },
    }),
    /cannot be promoted to Latest/,
  );
});

test("prerelease identity changes are rejected before publication", async (t) => {
  const f = await fixture(t);
  const options = { ...f.options, prerelease: true };
  await ensureRelease({ ...options, operation: "draft" });
  f.state.release.prerelease = false;
  await assert.rejects(ensureRelease(options), /identity mismatch/);
  assert.equal(f.calls.includes("publish"), false);
});

test("a stable release cannot be silently reclassified as a prerelease", async (t) => {
  const f = await fixture(t);
  await ensureRelease(f.options);
  await assert.rejects(
    ensureRelease({ ...f.options, operation: "recover", prerelease: true }),
    /identity mismatch/,
  );
  assert.equal(f.state.release.prerelease, false);
});
