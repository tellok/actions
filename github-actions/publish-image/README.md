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
    immutable-tags: "true" # 调用方已核实服务端策略覆盖全部 tags
    username: ${{ github.actor }}
    password: ${{ secrets.REGISTRY_TOKEN }}
```

默认 existing-policy:exact 要求已存在标签配置 ID 相同。调用方明确选 source 时，允许复用同来源/版本/平台的先前验证镜像，适用于重跑产生不同镜像 ID 的场景；绝不覆盖冲突不可变标签。各标签 digest 必须一致。写入响应未知只有读回相同 digest 才算成功。网络/鉴权失败不会当成 tag 不存在。Docker login post 步骤退出时注销本次登录。

完整输入、默认值和输出见同目录 [action.yml](action.yml)。所有上游 Actions 均固定完整提交；本仓库的各组件共用 Git 提交与版本标签。

运行前提：Actions Runner >=2.327.1，包含 github-script v8 使用的 Node 24 Action 运行时；本仓库安装和程序化调用需 Node >=22。详见[根说明](../../README.md)。

`registry` 必须是主机名（可带端口），`image` 的 registry 必须与它一致；Docker Hub 的 docker.io/index.docker.io/registry-1.docker.io 归一化比较。此校验发生在登录前。已存在标签必须指向单镜像 manifest；索引/manifest list 在拉取前拒绝，避免将未验证平台随索引发布。平台 variant 同时纳入归档和 registry 身份核对。

新标签和补充别名默认禁止写入。只有调用方核实 registry **服务端不可变标签策略覆盖全部目标标签**，并显式设置 `immutable-tags: "true"` 后才允许写入；已有全部标签可只读核对后复用。此输入是调用方的前提确认，组件不会自动核验或修改服务端策略，也无法让普通可变 registry 的 push 具备条件创建能力。客户端读回检查不能代替服务端的并发保护；不要对允许覆盖的标签声明该前提。[Docker Hub 的不可变标签策略说明](https://docs.docker.com/docker-hub/repos/manage/hub-images/immutable-tags/)。
