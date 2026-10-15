# changesets-version-pr

检测未消费 Changesets，或创建/更新一个版本 PR。此组件仅支持 Linux/macOS，运行环境须有 Git 和 `/bin/bash`；detect 与 maintain 在其他平台会先明确拒绝，不承诺 Windows 兼容。先由调用方用官方 setup-node 和固定的包管理器安装 Changesets CLI；空扫描不需要安装依赖。组件不构建、不发布、不会自行决定产品版本策略。

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

`path` 必须指向 GITHUB_WORKSPACE 内 checkout 的仓库根目录，不能指向仓库内的子项目。初始检测及维护前都会对 workspace 和候选路径取 realpath 并检查包含关系，不允许通过绝对路径、上级相对路径或符号链接定位工作区外部仓库；写入器使用已经核实的规范路径。对子项目使用相对根目录的 `changeset-directory` 和 `allowed-paths`；需要在子目录运行 CLI 时，在 `version-command` 中切换目录。组件会在版本准备前核对这一边界。

完整输入、默认值和输出见同目录 [action.yml](action.yml)。所有上游 Actions 均固定完整提交；本仓库的各组件共用 Git 提交与版本标签。

使用 GITHUB_TOKEN 写入 PR 还需仓库允许 Actions 创建 PR；默认工作流权限可继续只读，只给 maintain job 显式内容与 PR 写权限。组件不会修改仓库开关。

运行前提：Actions Runner >=2.327.1，包含 github-script v8 使用的 Node 24 Action 运行时；本仓库安装和程序化调用需 Node >=22。详见[根说明](../../README.md)。

版本命令使用显式环境白名单：保留 PATH、HOME、临时目录、区域设置及工具缓存位置，移除序列化 Action 输入、全部 INPUT_* 及任意令牌/秘密环境变量。调用方应使用 `actions/checkout` 的 `persist-credentials: false`，且不要将发布凭据放入项目可读文件；环境清理不是恶意依赖的进程沙箱。路径白名单禁用重命名检测，同时检查工作树和暂存区，禁止从范围外文件重命名到允许路径。Changeset 目录的实际路径必须位于 checkout 内。

版本命令完成后重新读取受管理 PR 正文并更新标记块，保留这次读取时的人工内容；最终确认要求 PR 仍开放、未合并、来源/目标仓库与提交匹配，并核对配置的 managed-author（包括首次创建）。GitHub PR 正文更新没有这里可用的原子比较写接口；读取之后的并发人工编辑仍需调用方协调，不能把此刷新当作正文写入租约。

调用方的 body 或 body-file 内容不得包含任一 body-start/body-end 管理标记；创建首张 PR 时也会拒绝，避免生成后无法继续维护的重复标记正文。
