-- ════════════════════════════════════════════════════════════════════════
--  DIAGNOSE_OVERLAP_LV1B33AC2A.sql
--
--  Shows exactly what LV-1B33AC2A is + every leave request for the same
--  employee that overlaps its date range. Lets HR see at a glance:
--    • whose request it is
--    • the date range
--    • the workflow stage + legacy status
--    • all other leaves the new overlap filter would pick up
--
--  Nadeem 2026-05-18: 'LV-1B33AC2A is overlapping'
--
--  How the LV-ref maps to the UUID: LV-XXXXXXXX is the first 8 hex
--  characters of leave_requests.id, uppercased. So LV-1B33AC2A
--  corresponds to a UUID starting with '1b33ac2a-…'.
-- ════════════════════════════════════════════════════════════════════════

-- ─── 1. The request itself ──────────────────────────────────────────────
SELECT
  id,
  employee_id,
  leave_type_id,
  start_date,
  end_date,
  days,
  stage,
  status,
  requested_at,
  manager_decided_at,
  hr_decided_at
FROM leave_requests
WHERE id::text LIKE '1b33ac2a%';


-- ─── 2. Everything for the same employee in overlapping date range ──────
WITH target AS (
  SELECT * FROM leave_requests WHERE id::text LIKE '1b33ac2a%'
)
SELECT
  lr.id,
  CONCAT('LV-', UPPER(LEFT(lr.id::text, 8))) AS ref,
  lr.leave_type_id,
  lr.start_date,
  lr.end_date,
  lr.days,
  lr.stage,
  lr.status,
  CASE
    WHEN lr.id = (SELECT id FROM target)         THEN 'SELF'
    WHEN lr.end_date   < (SELECT start_date FROM target)
      OR lr.start_date > (SELECT end_date   FROM target) THEN 'no overlap'
    ELSE 'OVERLAPS'
  END AS overlap_check,
  CASE
    WHEN lr.stage = 'approved'                THEN 'approved'
    WHEN lr.stage LIKE 'pending%'             THEN 'active-pending'
    WHEN lr.stage IN ('rejected', 'expired',
                       'withdrawn')           THEN 'inactive'
    WHEN lr.status = 'approved'               THEN 'legacy-approved'
    WHEN lr.status = 'pending'                THEN 'legacy-pending'
    ELSE 'other'
  END AS classification
FROM leave_requests lr
WHERE lr.employee_id = (SELECT employee_id FROM target)
ORDER BY lr.start_date DESC;


-- ─── 3. What the NEW filter would catch as overlapping ──────────────────
WITH target AS (
  SELECT * FROM leave_requests WHERE id::text LIKE '1b33ac2a%'
)
SELECT
  CONCAT('LV-', UPPER(LEFT(lr.id::text, 8))) AS ref,
  lr.start_date,
  lr.end_date,
  lr.days,
  lr.stage,
  lr.status
FROM leave_requests lr
WHERE lr.employee_id = (SELECT employee_id FROM target)
  AND lr.id          <> (SELECT id          FROM target)
  AND (
        lr.stage = 'approved'
     OR lr.stage LIKE 'pending%'
     OR lr.status IN ('approved', 'pending')
      )
  AND NOT (lr.end_date   < (SELECT start_date FROM target)
        OR lr.start_date > (SELECT end_date   FROM target))
ORDER BY lr.start_date;
