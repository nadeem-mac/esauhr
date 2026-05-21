-- ════════════════════════════════════════════════════════════════════════
--  migration_sync_leave_balances_from_tracker.sql
--
--  Imports the per-employee leave balance state from the manually-
--  maintained tracker:
--    /mnt/project/FinalUpdate_20260521_ESAU_STAFF_LEAVE_TRACKER.xlsm
--
--  Nadeem 2026-05-21: 'update the master database for the staff leaves
--  balances, correctly'
--
-- ── WHAT GETS SET (per employee, year=2026, leave_type_id='annual') ─────
--
--    carried_over    = 2025 Carry Forward (CFW column from Excel)
--    adjustment      = -(PL_used + HDL_used)  — pre-portal 2026 usage
--                       PL  = Privilege Leave  (full days)
--                       HDL = Halfday Leave    (0.5 days each)
--                       These were taken before the portal launch
--                       and aren't in leave_requests — recorded as a
--                       negative adjustment so the available balance
--                       reflects reality.
--    adjustment_note = 'Excel migration 2026-05-21: pre-portal usage
--                       PL=X.X HDL=Y.Y · CFW=Z.Z'
--
-- ── BALANCE COMPUTATION ON THE PORTAL ───────────────────────────────────
--
--    available = entitlement (KSA Art.109 pro-rated)
--              + carried_over
--              + adjustment
--              - used_from_leave_requests
--              - pending_from_leave_requests
--
--    For employees with >=5 years of service this matches the Excel
--    BALANCE DAYS column exactly. For <5-year employees the portal
--    applies the 21→30 pro-rata around the 5-year anniversary, so
--    their portal balance may differ from Excel's flat-30 calc by
--    a few days. This is intentional — the portal follows KSA
--    Labour Law strictly while the Excel used a single 30-day rule.
--
-- ── HOW TO RUN ──────────────────────────────────────────────────────────
--    1. Supabase Dashboard → SQL Editor → New Query
--    2. Paste this entire file
--    3. Click Run
--    4. Read the NOTICE output:
--         • per-row 'set H94XXX: carry=A.A adj=-B.B' for each upsert
--         • 'SKIPPED' for PSNs not found in employees table
--         • totals at the end
-- ════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  upserted bigint := 0;
  skipped  bigint := 0;
  v_psn    text;
  v_carry  numeric;
  v_pl     numeric;
  v_hdl    numeric;
  v_adj    numeric;
  v_note   text;
BEGIN
  IF to_regclass('public.leave_balances') IS NULL THEN
    RAISE EXCEPTION 'leave_balances table not present';
  END IF;

  -- Stage: one INSERT per row from the Excel tracker.
  -- (employee_id, carried_over, pl_used, hdl_used)
  FOR v_psn, v_carry, v_pl, v_hdl IN
    SELECT * FROM (VALUES
      ('H298143', 0.0::numeric, 0.0::numeric, 0.0::numeric),  -- JAMES Q.J. LIU
      ('H94076', 0.0::numeric, 0.0::numeric, 0.0::numeric),  -- SADAKATHULLAH SHADULY PALAYAM MEERA SAHI
      ('H94152', 7.0::numeric, 5.0::numeric, 0.5::numeric),  -- MOHAMMED NADEEM NISAR SHAIKH
      ('H94328', 0.0::numeric, 27.0::numeric, 0.0::numeric),  -- NASIR KHAN MUHAMMADA NWAR
      ('H94404', 0.0::numeric, 20.0::numeric, 0.0::numeric),  -- MUHAMMAD RIZWAN ABDUR REHMAN
      ('H94590', 0.0::numeric, 17.0::numeric, 0.0::numeric),  -- ARIEL SALONGA RICO
      ('H94855', 0.0::numeric, 3.0::numeric, 0.0::numeric),  -- SHAHAD KHALID ALFOHAID
      ('H94091', 0.0::numeric, 16.0::numeric, 0.5::numeric),  -- MOHIADEEN THAMBY MOHAMED ABDUL KADER
      ('H94200', 0.0::numeric, 17.0::numeric, 0.0::numeric),  -- MELVIN ROMULO MANCENIDO
      ('H94282', 0.0::numeric, 0.0::numeric, 0.0::numeric),  -- MOHAMMAD ABDULLAH MOHAMMAD AL SHAIJI
      ('H94384', 0.0::numeric, 0.0::numeric, 0.0::numeric),  -- MANSOUR ZAKI AHMAD AL ABBAS
      ('H94519', 1.0::numeric, 5.0::numeric, 2.0::numeric),  -- AHMED NAZMI AHMED AL ABAAS
      ('H94608', 0.0::numeric, 30.0::numeric, 0.0::numeric),  -- MUSTAF ABDUL KHDER
      ('H94664', 0.0::numeric, 25.0::numeric, 0.0::numeric),  -- MOHAMMED MAFAZ MOHAMMED BILAL
      ('H94870', 0.0::numeric, 9.0::numeric, 0.0::numeric),  -- NOJUD MOHAMMED HAKAMI
      ('H94957', 0.0::numeric, 3.0::numeric, 1.0::numeric),  -- FAISAL MUBARK AL-AWAD
      ('H94137', 26.0::numeric, 26.0::numeric, 0.5::numeric),  -- KHAJA MUJEEBUR RAHMAN
      ('H94534', 0.0::numeric, 3.0::numeric, 0.0::numeric),  -- HASSAN ABDRBALNABI JAWAD AL DARWEESH
      ('H94550', 0.0::numeric, 3.0::numeric, 0.5::numeric),  -- ALI HUSSAIN NASSIR AL BRAHIM
      ('H94562', 0.0::numeric, 11.0::numeric, 0.0::numeric),  -- HAIDER ALI HABIB AL FARDAN
      ('H94651', 0.0::numeric, 15.0::numeric, 0.0::numeric),  -- MOHSIN AHMED O BALOBAID
      ('H94842', 0.0::numeric, 1.0::numeric, 1.0::numeric),  -- BASMAH FOUAD ALYOUSEF
      ('H94180', 5.0::numeric, 13.0::numeric, 2.5::numeric),  -- MAHMOUD AHMAD HASSAN AL ABBAS
      ('H94295', 0.0::numeric, 0.0::numeric, 0.0::numeric),  -- NAWAF ABDULRAHMAN SALEH ALFOZAIA
      ('H94445', 0.0::numeric, 24.0::numeric, 0.0::numeric),  -- MUHAMMAD ABDUL WAHAB RAFIQ
      ('H94460', 1.5::numeric, 4.0::numeric, 0.0::numeric),  -- MOHAMMAD SHARIQUE MOHAMMAD YAQUB
      ('H94692', 0.0::numeric, 13.0::numeric, 2.0::numeric),  -- MOHAMMAD AWADH AL QAHTANI
      ('H94738', 0.5::numeric, 5.0::numeric, 0.0::numeric),  -- NORAH MOHAMMED ALRUBAYYI
      ('H94779', 0.0::numeric, 6.0::numeric, 0.0::numeric),  -- JASSIM ABDULLAH AL DOSSERY
      ('H94458', 0.0::numeric, 5.0::numeric, 0.0::numeric),  -- BADRIA MOHAMMED AHMAD AL HASSAN
      ('H94330', 0.0::numeric, 3.0::numeric, 1.5::numeric),  -- JAFFAR ABDULLAH AL DARWEASH
      ('H94712', 0.0::numeric, 9.0::numeric, 1.0::numeric),  -- FAHAD SULAIMAN ABDULRAHMAN ALHUSSAIN
      ('H94830', 0.0::numeric, 13.0::numeric, 8.0::numeric),  -- BASHAIER ALI ALSUBAIE
      ('H94420', 13.0::numeric, 11.0::numeric, 0.0::numeric),  -- SYED NOMAN SADAQAT SYED SADAQAT ALI
      ('H94178', 0.0::numeric, 0.0::numeric, 0.0::numeric),  -- FAHAD  ABDULQADER AL  MOULAD
      ('H94239', 0.0::numeric, 0.0::numeric, 0.0::numeric),  -- HAITAM  ELTAYEB
      ('H94371', 4.0::numeric, 15.0::numeric, 0.0::numeric),  -- SAHAR ALI DARWEISH ABED
      ('H94740', 0.0::numeric, 4.0::numeric, 0.0::numeric),  -- AREEJ ALNASHRI
      ('H94766', 0.0::numeric, 1.0::numeric, 0.0::numeric),  -- AMINAH AHMED MOHAMMED ABDULLAH
      ('H94944', 0.0::numeric, 5.0::numeric, 0.0::numeric),  -- HAMAD AHMED ALNASHRI
      ('H94998', 4.0::numeric, 4.0::numeric, 0.0::numeric),  -- LARA KHALID
      ('H94972', 6.0::numeric, 0.0::numeric, 2.0::numeric),  -- SYED AHMED
      ('H94960', 3.0::numeric, 7.0::numeric, 0.5::numeric),  -- SYED ISHAQ MOHAMMED
      ('H95008', 0.0::numeric, 17.0::numeric, 0.0::numeric),  -- HASSAN ALTASSAN
      ('H94226', 7.0::numeric, 23.0::numeric, 0.0::numeric),  -- SONNIE BOY TOPNIO HABAL
      ('H94397', 0.0::numeric, 0.0::numeric, 0.0::numeric),  -- AHMED ABDELMONSEF IBRAHIM ELSHARKAWY
      ('H94499', 0.0::numeric, 18.0::numeric, 0.0::numeric),  -- ABDULRAHMAN NASSER AHMED ALGHAMDI
      ('H94753', 0.0::numeric, 4.0::numeric, 1.0::numeric),  -- BEDOR MOHAMMED ALMWALLAD
      ('H94801', 0.0::numeric, 1.0::numeric, 0.0::numeric),  -- KHALID ALMUTAIRI
      ('H94929', 0.0::numeric, 9.0::numeric, 0.0::numeric),  -- MAALI SADEQ ALSHEKH
      ('H95010', 3.5::numeric, 24.0::numeric, 0.0::numeric),  -- KASHIF MEHMOUD
      ('H94931', 0.0::numeric, 0.0::numeric, 0.0::numeric),  -- SHABBAB NOOR ALMUTAIRI
      ('H94109', 0.0::numeric, 30.0::numeric, 0.0::numeric),  -- MOUSA ABDULRAHEEM HAMAD
      ('H94193', 0.0::numeric, 16.0::numeric, 1.5::numeric),  -- SAAD OTHMAN MOHAMMED
      ('H94432', 0.0::numeric, 0.0::numeric, 0.0::numeric),  -- ZAHER FARAJ ABU HOUSA
      ('H94610', 0.5::numeric, 0.0::numeric, 0.5::numeric),  -- MOHAMED MOHAMED YANI ABULHASSAN
      ('H94725', 0.0::numeric, 27.0::numeric, 3.0::numeric),  -- MUSAID ALMUAYSIB
      ('H94794', 1.5::numeric, 14.0::numeric, 2.5::numeric),  -- ABDULAZIZ JABER AWAJI
      ('H95036', 0.0::numeric, 2.0::numeric, 0.0::numeric),  -- GHALA NAWAF ALSHARIF
      ('H95023', 0.0::numeric, 0.0::numeric, 0.0::numeric)  -- FAHAD FAISAL ALHARBI
    ) AS t(psn, carry, pl, hdl)
  LOOP
    -- Skip PSNs not in employees
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = v_psn) THEN
      RAISE NOTICE '  – SKIPPED % (not in employees)', v_psn;
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    v_adj  := -(v_pl + v_hdl);
    v_note := format('Excel migration 2026-05-21: pre-portal usage PL=%s HDL=%s · CFW=%s',
                     v_pl, v_hdl, v_carry);

    INSERT INTO leave_balances (employee_id, leave_type_id, year,
                                 carried_over, adjustment, adjustment_note)
    VALUES (v_psn, 'annual', 2026, v_carry, v_adj, v_note)
    ON CONFLICT (employee_id, leave_type_id, year)
    DO UPDATE SET
      carried_over    = EXCLUDED.carried_over,
      adjustment      = EXCLUDED.adjustment,
      adjustment_note = EXCLUDED.adjustment_note;

    RAISE NOTICE '  ✓ set %: carry=% adj=% (PL=% HDL=%)',
                 v_psn, v_carry, v_adj, v_pl, v_hdl;
    upserted := upserted + 1;
  END LOOP;

  RAISE NOTICE '══════════════════════════════════════════════════════════';
  RAISE NOTICE ' LEAVE BALANCE SYNC COMPLETE';
  RAISE NOTICE '   upserted: %', upserted;
  RAISE NOTICE '   skipped : % (PSN not in employees table)', skipped;
  RAISE NOTICE '══════════════════════════════════════════════════════════';
END $$;