# 招标公告跟踪器

Node.js 本地数据接入项目。已有一次来源读取、结构化导入与操作查询，来源服务和业务存储独立，来源变化不会自动刷新本地集合。采集生命周期新增了公告修订历史、附件身份与本地文件的对应，以及可恢复的附件下载：续传时用来源实体（ETag/If-Match 与声明校验和）核对同一份内容，完整且校验通过后才把文件发布给业务使用方。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行现有行为、续传和本地接口测试；`npm run demo` 启动临时来源、读取首批并采集附件，再切到补遗观察演示未上传附件与修订追溯，结束时自动关闭监听并清理临时数据。`npm start -- ingest` 从 `fixtures/records.json` 导入，`npm start -- query` 读取本地 `var/records.json`，`npm start -- collect [来源场景]` 启动临时本地来源、导入并采集附件。演示数据不访问生产站点。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json` 并监听随机回环端口。`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()；publish 切换可观察来源版本而不修改业务仓库，failNext 可返回 503 或使用 disconnect 断开连接。它记录请求路径（含 Range/If-Match）并支持来源 ETag/304 与 412/416。`src/source-client.js` 只接受同一回环来源；`src/adapter.js` 解析现有首批页面并保留原始来源属性，返回 records 和 next；目前 demo 只导入首批。`src/service.js` 与 `src/repository.js` 维护持久集合；`src/operations.js` 是读取该集合的业务消费入口，来源协议见 [CONTRACT.md](CONTRACT.md)。

采集状态与业务集合分开保存：`var/records.json.collection.json` 保存每个公告的修订历史（revision、supersedes、每版的附件任务），`var/attachments/partial/` 只放未完成字节，`var/attachments/ready/` 只放通过完整 SHA-256 校验的文件。`src/collection-state.js` 维护修订与附件身份，`src/attachment-store.js` 维护断点文件、发布改名和哈希。附件任务以 `noticeId + revision + attachmentId` 定位；来源替换同一地址的内容、附件尚为 404、下载中断或只抓取一部分时，任务保持 `pending`/`unavailable` 并带 `reason` 与 `message`，不会进入业务可用附件。`readOperations` 的每行只把 `ready` 附件列在 `attachments`，未完成的列在 `unfinished`，并在 `revisionHistory` 中保留补遗与其 `supersedes` 的对应关系。

状态目录属于运行产物。扩展导入时应保留现有 CLI 和现有集合查询能力；新增状态可以另行组织。测试可直接使用随机端口来源，不需要等待真实时间或接入外网。运行录制可用 test 和 demo，无需安装浏览器或外部数据库。

`npm start` 或 `npm start -- --help` 查看命令；原导入和查询使用显式的 ingest、query 动作，采集使用 collect。`npm run acceptance` 在临时目录中验证本地来源读取、首批导入、重启回读、重放、中断续传、补遗追溯与业务查询，完成后清理临时状态。
