-- ─── migration_fix_dobs ──────────────────────────────────────────────
--
-- Per Nadeem: "I again see DATE OF BIRTH 31 Dec 1981 for me is incorrect,
-- my iqama number is 2191731641 and my date of birth is 01-jan-1982".
--
-- Investigation showed that the source MOL Excel and the molSnapshot.json
-- file both have 1982-01-01 stored for Nadeem (and the correct DOB for
-- every other subscriber — verified by audit). The UI's date formatter
-- was already fixed to be timezone-safe in commit cc236a2. So if the
-- displayed date is still wrong, it's because the DB itself holds a
-- shifted date — likely from an earlier sync run before the apply
-- path was hardened, where a Date-object round-trip could have shifted
-- a day in any timezone west of UTC.
--
-- This migration repairs the data by overwriting date_of_birth and
-- mol_join_date for every employee whose national_id matches one of
-- the 60 known MOL subscribers. The values come straight from the
-- snapshot — no Date arithmetic, just the YYYY-MM-DD strings — so
-- the cure cannot itself shift any dates. Idempotent: running it
-- again is a no-op for rows already correct.
--
-- After running, the displayed DOB should be correct for every
-- synced employee. The formatter fix from cc236a2 means it will
-- ALSO render correctly in any browser timezone.
-- ──────────────────────────────────────────────────────────────────

-- Build a temp table from the canonical snapshot data
create temp table mol_dob_snapshot (
  national_id   text primary key,
  date_of_birth date not null,
  mol_join_date date
);

insert into mol_dob_snapshot (national_id, date_of_birth, mol_join_date) values
  ('1003101688', '1979-04-08'::date, '2023-09-07'::date),
  ('1009008614', '1978-04-17'::date, '2021-08-01'::date),
  ('1009311190', '1972-09-22'::date, '2022-01-02'::date),
  ('1014390908', '1985-06-07'::date, '2021-08-01'::date),
  ('1014532368', '1978-03-18'::date, '2022-12-06'::date),
  ('1017745124', '1983-08-20'::date, '2021-06-30'::date),
  ('1024134833', '1983-05-17'::date, '2021-08-01'::date),
  ('1026372472', '1986-06-02'::date, '2021-07-01'::date),
  ('1031106147', '1986-04-25'::date, '2023-07-01'::date),
  ('1040638254', '1986-02-06'::date, '2022-01-26'::date),
  ('1049096330', '1985-01-22'::date, '2023-08-08'::date),
  ('1049728239', '1987-10-04'::date, '2021-08-01'::date),
  ('1050218039', '1986-04-05'::date, '2022-01-26'::date),
  ('1064779638', '1990-01-10'::date, '2024-07-01'::date),
  ('1068026556', '1990-10-24'::date, '2021-08-01'::date),
  ('1073164426', '1991-08-02'::date, '2023-06-01'::date),
  ('1074575968', '1989-10-22'::date, '2021-12-02'::date),
  ('1079375323', '1993-11-05'::date, '2026-03-01'::date),
  ('1082979483', '1994-03-22'::date, '2025-03-09'::date),
  ('1087338180', '1995-06-16'::date, '2023-02-12'::date),
  ('1087809164', '1992-04-02'::date, '2024-07-01'::date),
  ('1088040553', '1995-10-02'::date, '2024-06-23'::date),
  ('1091916161', '1996-07-09'::date, '2023-02-06'::date),
  ('1092578200', '1996-09-18'::date, '2021-07-01'::date),
  ('1097172173', '1996-03-12'::date, '2023-08-08'::date),
  ('1098737800', '1998-03-27'::date, '2021-07-01'::date),
  ('1102407200', '1997-10-18'::date, '2022-01-05'::date),
  ('1105476277', '1999-10-13'::date, '2021-07-01'::date),
  ('1105950180', '1996-11-13'::date, '2024-06-23'::date),
  ('1108624873', '1999-05-31'::date, '2025-10-01'::date),
  ('1111808687', '1995-06-28'::date, '2024-06-09'::date),
  ('1113771438', '2001-10-11'::date, '2024-06-23'::date),
  ('1115904169', '2002-04-25'::date, '2024-03-03'::date),
  ('1120776453', '1997-06-05'::date, '2024-07-01'::date),
  ('1127510475', '2001-05-06'::date, '2024-03-10'::date),
  ('1127754297', '2004-02-21'::date, '2026-04-01'::date),
  ('2018314076', '1986-12-16'::date, '2021-12-27'::date),
  ('2021984592', '1982-10-18'::date, '2022-03-01'::date),
  ('2065773299', '1968-03-22'::date, '2022-01-02'::date),
  ('2072642503', '1965-07-01'::date, '2021-10-12'::date),
  ('2123400158', '1960-01-01'::date, '2021-12-30'::date),
  ('2131527950', '1996-10-10'::date, '2025-09-10'::date),
  ('2161177320', '1970-01-12'::date, '2021-10-12'::date),
  ('2191731641', '1982-01-01'::date, '2021-10-12'::date),
  ('2271973758', '1975-09-19'::date, '2021-10-12'::date),
  ('2276658073', '1976-06-29'::date, '2022-03-01'::date),
  ('2314408218', '1971-11-06'::date, '2021-10-12'::date),
  ('2326749559', '1987-03-08'::date, '2021-10-19'::date),
  ('2339734903', '1987-01-27'::date, '2021-10-12'::date),
  ('2370259448', '1972-12-29'::date, '2021-10-12'::date),
  ('2383233141', '1990-04-07'::date, '2021-10-12'::date),
  ('2387549344', '1989-12-09'::date, '2022-03-01'::date),
  ('2403330802', '1980-02-04'::date, '2022-03-01'::date),
  ('2403761758', '1990-11-29'::date, '2022-03-01'::date),
  ('2422553103', '1972-08-22'::date, '2021-10-12'::date),
  ('2493705525', '1962-09-16'::date, '2021-10-12'::date),
  ('2505922498', '1992-08-27'::date, '2022-01-07'::date),
  ('2543030890', '1996-10-10'::date, '2025-09-28'::date),
  ('2593213636', '1997-06-22'::date, '2025-08-01'::date),
  ('2623221021', '1990-07-23'::date, '2025-12-01'::date);

-- Patch any employees whose stored DOB or join date differs from the
-- snapshot. ONLY touches rows whose national_id is in the snapshot
-- — non-MOL employees (no national_id, contractors, future hires) are
-- left alone.
update public.employees e
set
  date_of_birth = m.date_of_birth,
  mol_join_date = coalesce(m.mol_join_date, e.mol_join_date),
  mol_synced_at = now()
from mol_dob_snapshot m
where e.national_id = m.national_id
  and (
    e.date_of_birth is distinct from m.date_of_birth
    or (m.mol_join_date is not null and e.mol_join_date is distinct from m.mol_join_date)
  );

-- Audit log a single row recording the bulk fix. actor_psn is null
-- because this runs as a migration, not via a logged-in user.
insert into public.audit_log (action, target_type, target_label, details)
values (
  'mol_dob_bulk_fix',
  'employees',
  'MOL DOB bulk repair from snapshot',
  jsonb_build_object(
    'snapshot_size', (select count(*) from mol_dob_snapshot),
    'patched_at', now()
  )
);

drop table mol_dob_snapshot;
