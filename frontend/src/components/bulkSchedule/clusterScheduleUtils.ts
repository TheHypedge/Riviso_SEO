import type { BulkScheduleSeedRow } from "@/components/bulkSchedule/useBulkScheduleForm";
import type { TopicCluster } from "@/lib/api";

/** Build schedule modal rows from pending cluster topic slots. */
export function buildClusterScheduleSeeds(
  cluster: TopicCluster,
  topicIds: string[] | null,
): BulkScheduleSeedRow[] {
  const pillarSlot = (cluster.pillar?.id || "pillar").trim() || "pillar";
  const rows: BulkScheduleSeedRow[] = [];
  const pillarTitle = (cluster.pillar?.title || "").trim();
  const pillarImported = !!(cluster.pillar?.imported_article_id || "").trim();
  const includePillar =
    topicIds === null
      ? !!pillarTitle && !pillarImported
      : topicIds.includes(pillarSlot) && !!pillarTitle && !pillarImported;
  if (includePillar) {
    rows.push({ id: pillarSlot, title: pillarTitle });
  }
  for (const c of cluster.clusters || []) {
    const slotId = (c.id || "").trim() || "cluster";
    const title = (c.title || "").trim();
    if (!title) continue;
    const imported = !!(c.imported_article_id || "").trim();
    const include = topicIds === null ? !imported : topicIds.includes(slotId) && !imported;
    if (include) rows.push({ id: slotId, title });
  }
  return rows;
}

export function articleIdForClusterTopic(cluster: TopicCluster, topicId: string): string | null {
  const pillarSlot = (cluster.pillar?.id || "pillar").trim() || "pillar";
  if (topicId === pillarSlot) {
    const aid = (cluster.pillar?.imported_article_id || "").trim();
    return aid || null;
  }
  for (const c of cluster.clusters || []) {
    if ((c.id || "").trim() === topicId) {
      const aid = (c.imported_article_id || "").trim();
      return aid || null;
    }
  }
  return null;
}
