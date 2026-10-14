# CI Toolkit

按平台与能力组织可独立调用的 CI 组件，所有组件共用仓库提交和标签。调用方负责业务策略与环境配置，公共组件不携带某个项目的包名、NAS 地址、发布资格或 runner 标签。

| GitHub 组件                                                    | 用途                        | 复用的现成能力                           |
| -------------------------------------------------------------- | --------------------------- | ---------------------------------------- |
| [changesets-version-pr](github-actions/changesets-version-pr/) | 检测并轻量维护版本 PR       | Changesets CLI；社区 create-pull-request |
| [build-image](github-actions/build-image/)                     | 构建加载镜像、持久目录缓存  | Docker 官方 Buildx/Build Actions         |
| [s3-artifacts](github-actions/s3-artifacts/)                   | 上传/登记/下载/精确清理制品 | AWS 官方 S3 SDK                          |
| [publish-image](github-actions/publish-image/)                 | 发布已验收归档并确认 digest | Docker 官方登录与 CLI                    |
| [github-release](github-actions/github-release/)               | 草稿、附件、公开与恢复      | GitHub 官方 Octokit SDK                  |

安装 Node >=20 后用 `corepack enable`、`pnpm install --frozen-lockfile --ignore-scripts`、`pnpm test`、`pnpm build`、`pnpm check` 验证组件。JavaScript SDK 随 dist 打包，消费 Action 无需安装本仓库依赖。需要程序调用时可使用同一提交的包 exports；不发布 npm 包。提交包含生成后的 dist 与锁文件。

调用示例：`uses: your-org/ci-toolkit/github-actions/build-image@<full-commit-sha>`。正式调用固定不可变完整 SHA；版本统一用仓库标签表示。保持可信 workflow 与 PR 验证的权限分离。checkout、项目环境准备、质量门禁和发布资格不被组件代替。未部署自建缓存服务，不使用 GitHub Artifact 存储作为组件间传递路径。

[GitLab 目录](gitlab-actions/) 暂未实现，不承诺 Steps/Components 接口。没有通用 deploy 组件或完整可复用工作流。
