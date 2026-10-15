# changesets-version-pr

`detect` 和 `maintain` 共用轻量检测：当所选 `changeset-directory` 的 `pre.json` 为 `mode: pre` 时，按无 `.md` 后缀的 changeset ID 排除 `changesets` 中已消费的文件；只有新增文件才继续版本准备。`mode: exit` 不排除这些文件，以便生成稳定版本；没有 `pre.json` 时沿用普通检测。JSON 损坏、模式或消费列表无效时明确失败，不当作空变更。检测仍只预筛候选，具体格式和发布项由调用方固定的 CLI 校验。

检测未消费 Changesets，或创建/更新一个版本 PR。先由调用方用官方 setup-node 和固定的包管理器安装 Changesets CLI；空扫描不需要安装依赖。组件不构建、不发布、不会自行决定产品版本策略。

PR 写入使用社区维护的 [create-pull-request](https://github.com/peter-evans/create-pull-request)。GitHub 没有官方版本 PR 写入 Action。组件在调用前核对目标和受管理分支 SHA，并通过 Git 原生 pre-push hook 与上游 force-with-lease 拒绝准备期间的并发分支变化；写入后核对 PR、单个来源提交和完整版本树。候选必须带 ownership-marker，人工分支或重复候选会失败。body-start/body-end 外的正文保留。

```yaml
- uses: your-org/ci-toolkit/github-actions/changesets-version-pr@<commit-sha>
  id: pending
  with:
    operation: detect
- if: steps.pending.outputs.found == 'true'
  uses: actions/setup-node@<commit-sha>
  with:
    node-version-file: .node-version
- if: steps.pending.outputs.found == 'true'
  run: corepack enable && pnpm install --frozen-lockfile --ignore-scripts
- if: steps.pending.outputs.found == 'true'
  uses: your-org/ci-toolkit/github-actions/changesets-version-pr@<commit-sha>
  with:
    branch: automation/versions
    version-command: pnpm exec changeset version
    allowed-paths: |
      .changeset/*.md
      packages/*/package.json
      packages/*/CHANGELOG.md
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

maintain 需要可信目标分支事件、干净 checkout、contents:write 和 pull-requests:write。detect 只读。Changeset 消费是否合法、来源证明与发布资格由调用方负责。GITHUB_TOKEN 创建的 PR 不保证触发另一个 workflow；需要原生触发时由调用方选择已授权 App token。组件不会额外 dispatch 检查。

`path` 必须指向 checkout 的仓库根目录，不能指向仓库内的子项目。对子项目使用相对根目录的 `changeset-directory` 和 `allowed-paths`；需要在子目录运行 CLI 时，在 `version-command` 中切换目录。组件会在版本准备前核对这一边界。

完整输入、默认值和输出见同目录 [action.yml](action.yml)。所有上游 Actions 均固定完整提交；本仓库的各组件共用 Git 提交与版本标签。

使用 GITHUB_TOKEN 写入 PR 还需仓库允许 Actions 创建 PR；默认工作流权限可继续只读，只给 maintain job 显式内容与 PR 写权限。组件不会修改仓库开关。
