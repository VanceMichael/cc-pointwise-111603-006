# 来源与消费契约

## 来源

入口 `/tenders`，HTML 内的 source-record JSON 节点保留了门户输出字段；rel=next 链接表示下一页。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

noticeId 表示招标公告，revision 表示公告修订。附件有稳定 id、来源地址和 SHA-256；正文版本与文件到达可分离。同名附件不证明内容相同；HTTP 成功不证明完整。文件支持 Range: bytes=N- 与 If-Match；续传来源改变返回 412，越界返回 416。A1 首版内容为 dummy，来源可能在相同路径发布 amended 内容；A2 尚未上传时返回 404。

## 业务消费

`readOperations(repository)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。现有 CLI 和结构化导入用于本地运维；新增采集结果也需要让业务读取入口看到一致状态，必要的解释信息可扩展返回。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。

## 采集结果

业务行只把完整下载并通过声明 SHA-256 校验的附件放入 `attachments`，每项带指向状态目录内已校验文件的 `file`、`sha256`、`bytes`。尚未完成的附件放入 `unfinished`，带 `status`（pending 可续传 / unavailable 来源暂不可用）、`reason` 和 `message`；它们没有 `file`，不能当作已就绪资料。`revision` 是该行对应的公告修订，`supersedes` 指向补遗所修订的上一版，`revisionHistory` 按修订号保留各版及其附件状态，补遗到达后仍可追溯原公告修订。附件任务身份为 `noticeId + revision + attachmentId`；同一地址内容被替换时，旧字节不会与新字节拼接，旧修订已校验通过的文件也不会被挪用来充当新内容。
