const fixedAnchor = "CASE WHEN a.start_ms < @rangeStart THEN @rangeStart ELSE a.start_ms END";
const deadlineAnchor = `CASE t.due_date
  WHEN @d0 THEN @m0 WHEN @d1 THEN @m1 WHEN @d2 THEN @m2 WHEN @d3 THEN @m3
  WHEN @d4 THEN @m4 WHEN @d5 THEN @m5 WHEN @d6 THEN @m6 END`;
const deadlineQualifies = "t.status='open' AND t.due_date BETWEEN @d0 AND @d6";
const fixedStartsOnDeadline = `CASE t.due_date
  WHEN @d0 THEN a.start_ms>=@m0 AND a.start_ms<@m1
  WHEN @d1 THEN a.start_ms>=@m1 AND a.start_ms<@m2
  WHEN @d2 THEN a.start_ms>=@m2 AND a.start_ms<@m3
  WHEN @d3 THEN a.start_ms>=@m3 AND a.start_ms<@m4
  WHEN @d4 THEN a.start_ms>=@m4 AND a.start_ms<@m5
  WHEN @d5 THEN a.start_ms>=@m5 AND a.start_ms<@m6
  WHEN @d6 THEN a.start_ms>=@m6 AND a.start_ms<@m7
  ELSE 0 END`;
const fixedVisibleAnchor = `CASE WHEN ${deadlineQualifies}
  THEN CASE WHEN ${fixedStartsOnDeadline} THEN ${fixedAnchor}
            ELSE min(${fixedAnchor}, ${deadlineAnchor}) END
  ELSE ${fixedAnchor} END`;
const continuation = (anchor: string, rank: 0 | 1 | 2, id: string) => `(
  @hasAfter=0 OR ${anchor}>@afterAnchor OR
  (${anchor}=@afterAnchor AND (${rank}>@afterRank OR (${rank}=@afterRank AND ${id}>@afterId)))
)`;

/** Four title-free branches with continuation in every branch and one bounded top-N. */
export const WEEK_IDENTITY_SQL = `SELECT * FROM (
  SELECT 'task' AS recordKind,t.id AS sourceId,t.id AS taskId,0 AS kindRank,
         ${fixedVisibleAnchor} AS visibleAnchor,t.status AS sourceStatus,
         s.starts_at AS fixedStart,s.ends_at AS fixedEnd,
         CASE WHEN ${deadlineQualifies} THEN t.due_date ELSE NULL END AS deadlineDate,
         NULL AS trackedStart,NULL AS trackedEnd,
         a.start_ms AS companionStart,a.end_ms AS companionEnd
  FROM week_interval_rtree AS r
  CROSS JOIN week_interval_access AS a ON a.index_id=r.index_id
  CROSS JOIN task_fixed_slots AS s ON s.task_id=a.task_id
  CROSS JOIN tasks AS t ON t.id=a.task_id
  WHERE a.source_kind=0 AND a.source_id=t.id
    AND r.start_day<=@rangeEndDay AND r.end_day>=@rangeStartDay
    AND a.start_ms<@rangeEnd AND a.end_ms>@rangeStart
    AND t.status IN ('open','done')
    AND ${continuation(fixedVisibleAnchor, 0, "t.id")}
  UNION ALL
  SELECT 'task',t.id,t.id,0,${deadlineAnchor},t.status,
         NULL,NULL,t.due_date,NULL,NULL,NULL,NULL
  FROM tasks AS t INDEXED BY idx_tasks_due_date
  WHERE t.status='open' AND t.due_date BETWEEN @d0 AND @d6
    AND NOT EXISTS (
      SELECT 1 FROM week_interval_access AS x
      WHERE x.source_kind=0 AND x.source_id=t.id
        AND x.start_ms<@rangeEnd AND x.end_ms>@rangeStart
    )
    AND ${continuation(deadlineAnchor, 0, "t.id")}
  UNION ALL
  SELECT 'goal',g.id,g.id,1,
         CASE g.target_date
           WHEN @d0 THEN @m0 WHEN @d1 THEN @m1 WHEN @d2 THEN @m2 WHEN @d3 THEN @m3
           WHEN @d4 THEN @m4 WHEN @d5 THEN @m5 WHEN @d6 THEN @m6 END,
         g.status,NULL,NULL,g.target_date,NULL,NULL,NULL,NULL
  FROM goals AS g INDEXED BY idx_goals_target_date
  WHERE g.status='active' AND g.target_date BETWEEN @d0 AND @d6
    AND ${continuation(`CASE g.target_date
      WHEN @d0 THEN @m0 WHEN @d1 THEN @m1 WHEN @d2 THEN @m2 WHEN @d3 THEN @m3
      WHEN @d4 THEN @m4 WHEN @d5 THEN @m5 WHEN @d6 THEN @m6 END`, 1, "g.id")}
  UNION ALL
  SELECT 'tracked',e.id,e.task_id,2,
         CASE WHEN a.start_ms<@rangeStart THEN @rangeStart ELSE a.start_ms END,
         t.status,NULL,NULL,NULL,e.started_at,e.ended_at,a.start_ms,a.end_ms
  FROM week_interval_rtree AS r
  CROSS JOIN week_interval_access AS a ON a.index_id=r.index_id
  CROSS JOIN time_entries AS e ON e.id=a.source_id
  CROSS JOIN tasks AS t ON t.id=a.task_id AND t.id=e.task_id
  WHERE a.source_kind=2
    AND r.start_day<=@rangeEndDay AND r.end_day>=@rangeStartDay
    AND a.start_ms<@rangeEnd
    AND (CASE WHEN a.end_ms IS NULL THEN @requestNow ELSE a.end_ms END)>@rangeStart
    AND (a.end_ms IS NOT NULL OR a.start_ms<@requestNow)
    AND ${continuation("CASE WHEN a.start_ms<@rangeStart THEN @rangeStart ELSE a.start_ms END", 2, "e.id")}
) ORDER BY visibleAnchor,kindRank,sourceId LIMIT 101`;
