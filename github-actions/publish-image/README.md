# publish-image

使用 Docker 官方 login/setup-buildx Actions 和 Docker CLI 发布已验收归档。组件不会调用 docker build。调用方仍负责发布资格、质量门禁与凭据仅授予可信发布任务。

identity-file 的明确字段：source（完整 SHA）、version、platform（例如 linux/amd64 或 linux/arm/v7）、reference（归档内唯一标签）、imageId（配置 sha256）、可选 layers、archiveHash、archiveSize。先独立核对归档 config、OCI 来源/版本/平台和每层解压摘要，再导入发布，不能因 Docker 本地已有层而跳过坏归档。

```yaml
- uses: your-org/ci-toolkit/github-actions/publish-image@<commit-sha>
  with:
    archive: build/image.tar.gz
    identity-file: build/image-identity.json
    image: ${{ vars.CONTAINER_IMAGE }}
    tags: '["1.2.3", "sha-example"]'
    registry: ${{ vars.CONTAINER_REGISTRY }}
    username: ${{ github.actor }}
    password: ${{ secrets.REGISTRY_TOKEN }}
```

默认 existing-policy:exact 只复用配置 ID 相同的已有镜像。调用方明确选 source 时，允许复用同来源/版本/平台的先前验证镜像，适用于重跑产生不同镜像 ID 的场景。没有可复用镜像时，加载已验收归档并正常 push；已有目标标签内容不同时也走正常写入，由 registry 决定是否允许更新。成功返回前核对各标签 digest 一致。写入响应未知只有读回相同 digest 才算成功。网络/鉴权失败不会当成 tag 不存在。Docker login post 步骤退出时注销本次登录。

完整输入、默认值和输出见同目录 [action.yml](action.yml)。所有上游 Actions 均固定完整提交；本仓库的各组件共用 Git 提交与版本标签。

运行前提：Actions Runner >=2.327.1，包含 github-script v8 使用的 Node 24 Action 运行时；本仓库安装和程序化调用需 Node >=22。详见[根说明](../../README.md)。

`registry` 必须是主机名（可带端口），`image` 的 registry 必须与它一致；Docker Hub 的 docker.io/index.docker.io/registry-1.docker.io 归一化比较。此校验发生在登录前。已存在标签必须指向单镜像 manifest；索引/manifest list 在拉取前拒绝，避免将未验证平台随索引发布。平台 variant 同时纳入归档和 registry 身份核对。

tags 必须是非空 JSON 字符串数组，不将 null、布尔值或数字隐式转换为标签；明确写为字符串的数字标签仍可使用。标签写入遵循普通 Docker 客户端语义，不需要额外确认参数：新标签正常创建，可变标签允许更新；registry 启用不可变标签规则时，由服务端拒绝覆盖，组件不会移除该规则或强制绕过。组件不承诺跨任务标签不可变或多个标签的事务更新；并发写入者仍可能在检查之后更新标签。发布只核对本次读取时的 digest 和镜像身份。[Docker 标签规则说明](https://docs.docker.com/docker-hub/repos/manage/hub-images/immutable-tags/)。
