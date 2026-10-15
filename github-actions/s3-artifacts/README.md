# s3-artifacts

通过 AWS 官方 JavaScript SDK 上传、登记、下载与精确删除普通 S3 对象。连接、桶、前缀与凭据完全由调用方传入；支持 S3 兼容服务，不自行创建桶或生命周期策略。

identity-file：`{"repository":"example/app","source":"<40-char-sha>","run":1,"attempt":1,"job":10}`。record schema 为 1，含 identity、prefix 和 objects（name/key/size/sha256 hash，以及版本化对象的 versionId）。files 是明确 JSON 文件名数组，不递归遍历目录或跟随符号链接。

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

upload 在发送 S3 请求前校验并哈希完整本地文件清单，后续项无效、缺失、为符号链接/非普通文件或超限时不会先上传前面的文件；上传阶段的网络或服务端失败仍不构成多对象事务。upload 使用 If-None-Match:\*，不会覆盖冲突对象；响应未知时以 SHA-256 回读确认。download 先暂存并校验整批文件，再逐个替换目标；任一下载失败时旧文件全部保留，替换阶段的普通错误尝试回滚并保留无法恢复的备份。多文件替换不构成崩溃时的原子事务，进程在替换期间被强杀可能留下部分替换状态。仅 404 表示不存在；权限/网络错误失败，不误作不存在。允许大小默认单文件 2 GiB；max-file-bytes 必须为正的安全整数。output-file 不得与任一上传源文件或下载目标重合，包括符号链接及硬链接别名；上传与下载均在任何传输前校验，结果路径及祖先中的未解析符号链接会提前拒绝，不能将悬空链接当作普通的尚不存在路径。SDK 只在只读请求网络/暂时错误时重试，不盲目重试未知写入。

delete 需要 record-file 与 consumers-file（`[{"id":20,"status":"completed"}]`）；先核对对象大小与生产身份 Metadata，缺失或空白 ETag 时拒绝删除；发送 ETag 条件删除请求并确认不存在。上传/登记保留 HEAD 返回的 versionId，下载和删除均绑定该版本，删除后也按该版本确认；旧记录缺少 versionId 而对象带版本时拒绝删除，不能用删除标记冒充永久删除。需要相应的对象版本读取/删除权限（如 s3:GetObjectVersion 和 s3:DeleteObjectVersion）。调用方必须从可信 CI API 核实生产登记和消费者终态，不应接受 PR 任意生成的删除许可。旧格式对象缺少 Metadata 时不会删除。register 只回读既有对象，不重新上传。

服务必须实际执行 S3 条件写/删除语义，调用方应在启用前核实；部分 S3 兼容服务会忽略条件头并返回成功，客户端无法仅凭正常响应识别这种情况。SDK 发送 If-Match/If-None-Match 不等于服务端已经提供并发保护。每个生产任务必须使用独占前缀，不可让不同生产者共享对象键；需要并发条件保证时，不得依赖未经核实的兼容实现。服务明确返回不支持或权限错误时失败，不移除条件头重试。

完整输入、默认值和输出见同目录 [action.yml](action.yml)。所有上游 Actions 均固定完整提交；本仓库的各组件共用 Git 提交与版本标签。

运行前提：Actions Runner >=2.327.1，包含 github-script v8 使用的 Node 24 Action 运行时；本仓库安装和程序化调用需 Node >=22。详见[根说明](../../README.md)。

上传设置 output-file 时，先在结果目录预留并同步独占暂存文件，提前拒绝目录、无效父路径及不可写位置；失败清理暂存并保留旧记录，成功同步完整结果后同目录 rename 替换。远端传输成功即输出生产登记日志，随后即使结果落盘遭遇新的故障，也可从该日志恢复登记；预留文件不能消除后续磁盘耗尽或进程崩溃风险。

register 与 upload 使用相同的生产者校验：HEAD 的 ContentLength、sha256 及 repository/source/run/attempt/job 元数据必须全部匹配登记身份，缺失或冲突时不读取正文、不发出登记。只有匹配后才绑定 HEAD 确认的对象版本，并按该版本回读校验字节。
