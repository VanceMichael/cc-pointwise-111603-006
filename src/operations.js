const fields = ["noticeId", "title", "revision", "publishedAt", "attachments"];

export async function readOperations(repository) {
  const records = await repository.read();
  return { product: "招标公告跟踪器", rows: records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  })) };
}
