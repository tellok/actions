# github-release

使用 GitHub 官方 Octokit SDK 维护草稿、上传附件、回读校验和公开 Release。发布前需要所有显式附件校验成功；同名冲突失败而不删除。标签必须指向调用方指定的完整 source SHA。创建响应未知按标签发现草稿，随后固定 Release ID。

```yaml
- uses: your-org/ci-toolkit/github-actions/github-release@<commit-sha>
  with:
    source: ${{ github.sha }}
    tag: v1.2.3
    name: "1.2.3"
    notes-file: build/notes.md
    assets-file: build/assets.json
    latest: "false"
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

assets-file：`[{"name":"image.tar.gz","path":"build/image.tar.gz","hash":"sha256:<64-char-hash>"}]`。附件小于 2 GiB；GitHub 返回 digest 时精确比对，否则下载校验。body-start/body-end 外部正文保留。已有 tag、name、target_commitish 和固定 ID 必须匹配，不追认冲突 Release。operation:draft 只准备草稿；publish 附件齐备后公开；recover 必须是既有标签/Release，补附件且不变更 Latest。latest:true 仅发布路径显式晋升并回读 Latest。默认 false。

权限由 workflow 设置为 contents:write。组件不决定 SemVer、产品发布资格、变更日志或历史恢复白名单；调用方生成说明和附件清单。单独使用组件不意味着获得发布许可。

完整输入、默认值和输出见同目录 [action.yml](action.yml)。所有上游 Actions 均固定完整提交；本仓库的各组件共用 Git 提交与版本标签。

运行前提：Actions Runner >=2.327.1，包含 github-script v8 使用的 Node 24 Action 运行时；本仓库安装和程序化调用需 Node >=22。详见[根说明](../../README.md)。

每个附件必须声明有效 SHA-256 hash 并匹配本地文件，后续远程确认始终使用该声明值。publish/recover 的空附件清单、无效 hash 和包含管理标记的生成说明均在创建标签或草稿之前拒绝。draft 遇到已公开 Release 直接失败，不修改公开说明；草稿返回前重新核对标签指向及固定 Release ID、tag/name/source 和草稿状态，不能沿用创建或正文更新前的身份。

更新说明前基于最新读取的 Release 正文重建管理块。公开前重新核对完整附件集及标签来源，返回成功前再次核对；发现并发标签移动或附件删除/替换会失败，不自行撤回已公开版本或移动标签。GitHub 的独立 API 请求不提供覆盖标签、正文及附件的整体事务，调用方仍应限制并发发布者和可变标签权限；回读只能确认观察时的状态，不能锁住后续修改。
