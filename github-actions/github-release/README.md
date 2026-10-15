# github-release

English | [简体中文](./README.zh-CN.md)

Manage a draft, upload verified assets, publish a GitHub release, or recover an existing release using the official Octokit SDK. The caller supplies its release policy, exact source SHA, notes, asset manifest, and stable or prerelease identity. The component does not decide versions or authorize publication.

```yaml
- uses: your-org/ci-toolkit/github-actions/github-release@<full-commit-sha>
  with:
    source: ${{ github.sha }}
    tag: v2.0.0-beta.0
    name: "2.0.0-beta.0"
    notes-file: build/notes.md
    assets-file: build/assets.json
    prerelease: "true"
    latest: "false"
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Release identity and recovery

`prerelease` accepts exactly `"true"` or `"false"` and defaults to `"false"`. Programmatic `ensureRelease` takes a boolean. A prerelease cannot request `latest: "true"`; this combination and malformed flags fail before remote access. Creation, publication, recovery, and final verification enforce the declared prerelease identity. Existing stable releases are not silently reclassified. Recovery of a prerelease must also specify `prerelease: "true"`. This input controls GitHub Releases and does not change npm dist-tags.

`operation: draft` prepares a draft and rejects already public releases. `publish` verifies every declared asset before making the release public. `recover` requires an existing matching tag and release, fills missing assets, and never changes Latest. Stable callers can explicitly request `latest: "true"` during publication; the default is false. Both string flags accept only their exact lower-case spellings.

Tags must resolve to the caller's complete source SHA. Release ID, tag, name, source, prerelease status, managed notes, and the complete declared asset set are verified throughout delivery. Conflicts fail without deleting files, moving tags, or retracting a public release. An unknown creation response is recovered by finding the tag and then binding to one fixed release ID.

## Notes and assets

`assets-file` contains a JSON array such as `[{"name":"archive.tar.gz","path":"build/archive.tar.gz","hash":"sha256:<64-character-hash>"}]`. Every asset must have a declared SHA-256 matching its local bytes and be smaller than 2 GiB. Remote digests are compared when available; otherwise assets are downloaded and hashed. Publication and recovery reject empty manifests, invalid hashes, and undeclared remote assets. Existing conflicting assets are never overwritten or deleted.

Asset names allow ASCII letters, digits, underscores, hyphens, and internal periods. Leading or trailing periods and characters that the service normalizes are rejected before remote writes.

Notes outside `body-start`/`body-end` are preserved. The markers must be distinct and must not contain each other; generated notes cannot contain either marker. Managed notes are rechecked after updates, asset transfers, and publication. Concurrent edits outside the managed block are allowed. Independent GitHub API calls are not a transaction: callers must coordinate concurrent publishers and mutable tag permissions. Read-back confirms the observed state without locking later changes.

## Permissions and runtime

The calling workflow grants `contents: write`. All upstream Actions are pinned to full commits; callers should pin this component to a full repository commit as well. See [action.yml](./action.yml) for inputs and defaults.

Actions Runner >=2.327.1 must provide the Node 24 Action runtime used by github-script v8. Local package installation and programmatic usage require Node >=22. A setup-node step does not upgrade the runner's own Action runtime. See the [repository README](../../README.md) for component distribution and validation commands.
