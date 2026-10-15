# build-image

封装 Docker 官方 setup-buildx 和 build-push Actions。使用明确的本地 context，结果 load 到任务 Docker 中供调用方验收；不推送产品镜像。关闭构建记录 Artifact 上传和构建摘要；缓存本身不使用 GitHub Artifact/Cache API。

```yaml
- uses: your-org/ci-toolkit/github-actions/build-image@<commit-sha>
  with:
    context: .
    file: Dockerfile
    tags: example/app:verified
    platforms: linux/amd64
    cache-root: ${{ vars.BUILD_CACHE_DIRECTORY }}
    cache-namespace: ${{ github.repository }}
    read-scopes: main
    write-scope: ${{ github.event_name == 'push' && 'main' || '' }}
```

cache-root 为空时为普通无持久缓存构建。运行环境需要 Docker、Python 3 和支持 POSIX flock/原子 rename/symlink 的持久文件系统。调用方负责挂载目录、授权作用域；组件不判断哪个分支可信。共享 main 缓存应只给可信构建写，PR 可读共享并写独立 pr-N。

每次导出到独立 pending 目录，成功且 index.json 完整才原子切换 current；并发写不互删未完成目录。读任务登记 generation lease，回收保留活动读者及最近完整代。正常失败/取消只移除本任务的临时导出和租约。进程被强杀或机器消失时，孤儿租约保守保留，维护者必须核实该执行已终止后清理；不以时间推断任务死亡。容量限制拒绝新指针，保留旧缓存，持续占用由运维监控。

缓存命中是否跳过依赖安装由 Dockerfile 输入层决定；源码 COPY 应位于锁文件/依赖安装之后。[Docker local backend](https://docs.docker.com/build/cache/backends/local/) 不会自动清理历史 blobs，本组件以完整代管理。

完整输入、默认值和输出见同目录 [action.yml](action.yml)。所有上游 Actions 均固定完整提交；本仓库的各组件共用 Git 提交与版本标签。

运行前提：Actions Runner >=2.327.1，包含 github-script v8 使用的 Node 24 Action 运行时；本仓库安装和程序化调用需 Node >=22。详见[根说明](../../README.md)。

镜像必须可加载到本地 Docker：`platforms` 为空或仅含一个 `os/arch[/variant]`；多平台列表在构建前拒绝。两个字节容量限制必须为非负整数（0 表示不限制），`keep-generations` 必须为正整数；数值及全部 read-scopes/write-scope 名称均在创建租约/临时导出前校验，避免后续无效作用域遗留前面已经取得的租约。
