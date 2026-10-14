# s3-artifacts

通过 AWS 官方 JavaScript SDK 上传、登记、下载与精确删除普通 S3 对象。连接、桶、前缀与凭据完全由调用方传入；支持 S3 兼容服务，不自行创建桶或生命周期策略。

identity-file：`{"repository":"example/app","source":"<40-char-sha>","run":1,"attempt":1,"job":10}`。record schema 为 1，含 identity、prefix 和 objects（name/key/size/sha256 hash）。files 是明确 JSON 文件名数组，不递归遍历目录或跟随符号链接。

```yaml
- uses: your-org/ci-toolkit/github-actions/s3-artifacts@<commit-sha>
  with:
    operation: upload
    endpoint: ${{ vars.S3_ENDPOINT }}
    region: ${{ vars.S3_REGION }}
    bucket: ${{ vars.S3_BUCKET }}
    access-key-id: ${{ secrets.S3_ACCESS_KEY_ID }}
    secret-access-key: ${{ secrets.S3_SECRET_ACCESS_KEY }}
    identity-file: build/identity.json
    directory: build
    files: '["image.tar.gz", "manifest.json"]'
    prefix: build/${{ github.sha }}/${{ github.run_id }}/${{ github.run_attempt }}
    output-file: build/record.json
```

upload 使用 If-None-Match:\*，不会覆盖冲突对象；响应未知时以 SHA-256 回读确认。download 校验完整字节后原子替换，下载失败保留原文件并删除自己的 partial。仅 404 表示不存在；权限/网络错误失败，不误作不存在。允许大小默认单文件 2 GiB。SDK 只在只读请求网络/暂时错误时重试，不盲目重试未知写入。

delete 需要 record-file 与 consumers-file（`[{"id":20,"status":"completed"}]`）；先核对对象大小与生产身份 Metadata，再发送 ETag 条件删除请求并确认不存在。调用方必须从可信 CI API 核实生产登记和消费者终态，不应接受 PR 任意生成的删除许可。旧格式对象缺少 Metadata 时不会删除。register 只回读既有对象，不重新上传。

服务必须实际执行 S3 条件写/删除语义，调用方应在启用前核实；部分 S3 兼容服务会忽略条件头并返回成功，客户端无法仅凭正常响应识别这种情况。SDK 发送 If-Match/If-None-Match 不等于服务端已经提供并发保护。每个生产任务必须使用独占前缀，不可让不同生产者共享对象键；需要并发条件保证时，不得依赖未经核实的兼容实现。服务明确返回不支持或权限错误时失败，不移除条件头重试。

完整输入、默认值和输出见同目录 [action.yml](action.yml)。所有上游 Actions 均固定完整提交；本仓库的各组件共用 Git 提交与版本标签。
