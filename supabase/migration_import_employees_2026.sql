-- =============================================================================
-- Bulk import: 53 staff from ESAU LIST EMPLOYEES 2026 Copy.xlsx
-- Generated: 2026-05-08
--
-- Run AFTER migration_employee_extra_fields.sql (which adds the new columns).
-- UPSERTs by PSN so existing employees get their fields refreshed; any new
-- PSNs are inserted as active employees.
--
-- Normalization applied:
--   • HR        → SUP   (Human Resources & Supervisory)
--   • BUSINESS  → BIZ
--   • LOGISTICS → LOG
--   • Names trimmed + collapsed whitespace + newlines stripped
--   • Emails sorted: @evergreen → email (company), other → personal_email
--   • nationality (short, 'saudi'|'expat') derived from nationality_full
-- =============================================================================

INSERT INTO employees (
  id, name, location, department, department_ar,
  iqama_id, nationality_full, nationality, gender, join_date,
  email, personal_email, employment_status
) VALUES
  ('062789', 'CHUNG HSING HO', 'Dammam', 'MGT', 'المدير التنفيذي', '2493705525', 'Taiwanese', 'expat', 'male', '2021-08-01', 'johnho@evergreen-shipping.com.sa', NULL, 'active'),
  ('H94458', 'BADRIA MOHAMMED AHMAD AL HASSAN', 'Dammam', 'SUP', 'الموارد البشرية', '1017745124', 'Saudi', 'saudi', 'female', '2021-08-01', 'badria.alhassan@evergreen-shipping.com.sa', 'badria_alhassan@hotmail.com', 'active'),
  ('H94330', 'JAFFAR ABDULLAH AL DARWEASH', 'Dammam', 'SUP', 'الموارد البشرية', '1026372472', 'Saudi', 'saudi', 'male', '2021-08-01', 'jaffar.aldarweash@evergreen-shipping.com.sa', 'jaffarppp@gmail.com', 'active'),
  ('H94712', 'FAHAD SULAIMAN ABDULRAHMAN ALHUSSAIN', 'Dammam', 'SUP', 'الموارد البشرية', '1087338180', 'Saudi', 'saudi', 'male', '2023-02-12', 'fahad.alhussain@evergreen-shipping.com.sa', 'mr.fahad.s.alhussain@gmail.com', 'active'),
  ('H94830', 'BASHAIER ALI ALSUBAIE', 'Dammam', 'SUP', 'الموارد البشرية', '1111808687', 'Saudi', 'saudi', 'female', '2024-06-09', 'bashaier.alsubaie@evergreen-shipping.com.sa', 'BSHAYERALI@OUTLOOK', 'active'),
  ('H94137', 'KHAJA MUJEEBUR RAHMAN', 'Dammam', 'FIN', 'المالية', '2161177320', 'Indian', 'expat', 'male', '2021-08-01', 'mujeeb@evergreen-shipping.com.sa', 'mweebasa@gamil.com', 'active'),
  ('H94562', 'HAIDER ALI HABIB AL FARDAN', 'Dammam', 'FIN', 'المالية', '1092578200', 'Saudi', 'saudi', 'male', '2021-08-01', 'haider.alfardan@evergreen-shipping.com.sa', 'Haidoo17@hotmail.com', 'active'),
  ('H94534', 'HASSAN ABDRBALNABI JAWAD AL DARWEESH', 'Dammam', 'FIN', 'المالية', '1098737800', 'Saudi', 'saudi', 'male', '2021-08-01', 'hassanal.derweesh@evergreen-shipping.com.sa', 'hassan_darweesh@hotmail.com.sa', 'active'),
  ('H94550', 'ALI HUSSAIN NASSIR AL BRAHIM', 'Dammam', 'FIN', 'المالية', '1105476277', 'Saudi', 'saudi', 'male', '2021-08-01', 'ali.albrahim@evergreen-shipping.com.sa', 'lqzq1000@hotmail.com', 'active'),
  ('H94651', 'MOHSIN AHMED BALOBAID', 'Dammam', 'FIN', 'المالية', '1102407200', 'Saudi', 'saudi', 'male', '2022-01-05', 'mohsin.balobaid@evergreen-shipping.com.sa', 'M7sin-a@hotmail.com', 'active'),
  ('H94842', 'BASMAH FOUAD ALYOUSEF', 'Dammam', 'FIN', 'المالية', '1088040553', 'Saudi', 'saudi', 'female', '2024-06-23', 'basmh.alyousef@evergreen-shipping.com.sa', 'basmh.alyousef@gmail.com', 'active'),
  ('H94076', 'SADAKATHULLAH SHADULY PALAYAM MEERA SAHIB', 'Dammam', 'BIZ', 'التسويق', '2065773299', 'Indian', 'expat', 'male', '2021-08-01', 'sadakath@evergreen-shipping.com.sa', 'sadakathpms@gmail.com', 'active'),
  ('H94152', 'MOHAMMED NADEEM NISAR SHAIKH', 'Dammam', 'BIZ', 'التسويق', '2191731641', 'Indian', 'expat', 'male', '2021-08-01', 'nadeem@evergreen-shipping.com.sa', 'nadeem.mac@gmail.com', 'active'),
  ('H94328', 'NASIR KHAN MUHAMMAD ANWAR', 'Dammam', 'BIZ', 'التسويق', '2339734903', 'Pakistani', 'expat', 'male', '2021-08-01', 'nasir@evergreen-shipping.com.sa', 'nasir.sardarzada@gmail.com', 'active'),
  ('H94404', 'MUHAMMAD RIZWAN ABDUR REHMAN', 'Dammam', 'BIZ', 'التسويق', '2383233141', 'Pakistani', 'expat', 'male', '2021-08-01', 'rizwan@evergreen-shipping.com.sa', 'sardarrizwan18@gmail.com', 'active'),
  ('H94590', 'ARIEL SALONGA RICO', 'Dammam', 'BIZ', 'التسويق', '2314408218', 'Philippine', 'expat', 'male', '2021-08-01', 'ariel.rico@evergreen-shipping.com.sa', 'fire71fly@yahoo.com', 'active'),
  ('H94855', 'SHAHAD KHALID ALFOHAID', 'Dammam', 'BIZ', 'التسويق', '1113771438', 'Saudi', 'saudi', 'female', '2024-06-23', 'shahadalfouhid@evergreen-shipping.com.sa', 'shahadalfouhid882@gmail.com', 'active'),
  ('H94460', 'MOHAMMAD SHARIQUE MOHAMMAD YAQUB', 'Dammam', 'LOG', 'الخدمات اللوجستية', '2370259448', 'Indian', 'expat', 'male', '2021-08-01', 'capt.sharique@evergreen-shipping.com.sa', 'c.msharique@gmail.com', 'active'),
  ('H94180', 'MAHMOUD AHMAD HASSAN AL ABBAS', 'Dammam', 'LOG', 'الخدمات اللوجستية', '1014390908', 'Saudi', 'saudi', 'male', '2021-08-01', 'mahmoud.alabbas@evergreen-shipping.com.sa', 'mahmoud99629@gmail.com', 'active'),
  ('H94295', 'NAWAF ABDULRAHMAN SALEH ALFOZAIA', 'Dammam', 'LOG', 'الخدمات اللوجستية', '1009008614', 'Saudi', 'saudi', 'male', '2021-08-01', 'nawaf.alfozaia@evergreen-shipping.com.sa', 'NAWAF7161QW@ICLOUD.COM', 'active'),
  ('H94445', 'MUHAMMAD ABDUL WAHAB RAFIQ', 'Dammam', 'LOG', 'الخدمات اللوجستية', '2422553103', 'Pakistani', 'expat', 'male', '2021-08-01', 'abdul.wahab@evergreen-shipping.com.sa', 'tariqwahahab672@yahoo.com', 'active'),
  ('H94692', 'MOHAMMED AWADH AL QAHTANI', 'Dammam', 'LOG', 'الخدمات اللوجستية', '1014532368', 'Saudi', 'saudi', 'male', '2022-12-06', 'mohammed.alqahtani@evergreen-shipping.com.sa', 'mohammed.alqahtani@hotmail.com', 'active'),
  ('H94738', 'NORAH MOHAMMED ALRUBAYYI', 'Dammam', 'LOG', 'الخدمات اللوجستية', '1073164426', 'Saudi', 'saudi', 'female', '2023-04-02', 'norah@evergreen-shipping.com.sa', '''nouurM775@hotmail.com''', 'active'),
  ('H94779', 'JASSIM ABDULLAH AL DOSSERY', 'Dammam', 'LOG', 'الخدمات اللوجستية', '1003101688', 'Saudi', 'saudi', 'male', '2023-09-07', 'jassim.aldossery@evergreen-shipping.com.sa', 'JALDOSSARY3 @', 'active'),
  ('H94664', 'MOHAMMED MAFAZ MOHAMMED BILAL', 'Dammam', 'CSD', 'خدمة العملاء', '2505922498', 'Indian', 'expat', 'male', '2022-01-02', 'Mafaz@evergreen-shipping.com.sa', 'mafazkayal@gmail.com', 'active'),
  ('H94384', 'MANSOUR ZAKI AHMAD AL ABBAS', 'Dammam', 'CSD', 'خدمة العملاء', '1024134833', 'Saudi', 'saudi', 'male', '2021-08-01', 'mansour.alabbas@evergreen-shipping.com.sa', 'MANSZAK54321@GAMIL.COM', 'active'),
  ('H94519', 'AHMED NAZMI AHMED AL ABAAS', 'Dammam', 'CSD', 'خدمة العملاء', '1068026556', 'Saudi', 'saudi', 'male', '2021-08-01', 'ahmad.alabbas@evergreen-shipping.com.sa', 'A_2006_a_2006@hotmail.com', 'active'),
  ('H94282', 'MOHAMMAD ABDULLAH MOHAMMAD AL SHAIJI', 'Dammam', 'CSD', 'خدمة العملاء', '1049728239', 'Saudi', 'saudi', 'male', '2021-08-01', 'm.alshaiji@evergreen-shipping.com.sa', 'mohammed.alshaiji@hotmail.com', 'active'),
  ('H94091', 'MOHIADEEN THAMBY MOHAMED ABDUL KADER', 'Dammam', 'CSD', 'خدمة العملاء', '2072642503', 'Indian', 'expat', 'male', '2021-08-01', 'abdul.kader@evergreen-shipping.com.sa', 'mtkader1599@gmail.com', 'active'),
  ('H94608', 'MUSTAF ABDUL KHDER', 'Dammam', 'CSD', 'خدمة العملاء', '2326749559', 'Indian', 'expat', 'male', '2021-08-01', 'mustafa.khader@evergreen-shipping.com.sa', 'mustaf025@gmail.com', 'active'),
  ('H94200', 'MELVIN ROMULO MANCENIDO', 'Dammam', 'CSD', 'خدمة العملاء', '2271973758', 'Philippine', 'expat', 'male', '2021-08-01', 'melvin.romulo@evergreen-shipping.com.sa', 'merodol19@yahoo.com', 'active'),
  ('H94870', 'NUJUD MOHAMMED HAKAMI', 'Dammam', 'CSD', 'خدمة العملاء', '1105950180', 'Saudi', 'saudi', 'female', '2024-06-23', 'nojud.hakami@evergreen-shipping.com.sa', 'jood3221@gmail.com', 'active'),
  ('H94957', 'FAISAL MUBARK ALAWAD', 'Dammam', 'CSD', 'خدمة العملاء', '1082979483', 'Saudi', 'saudi', 'male', '2025-03-02', 'Faisal.Alawad@evergreen-shipping.com.sa', NULL, 'active'),
  ('H94420', 'SYED NOMAN SADAQAT SYED SADAQAT ALI', 'Dammam', 'BIZ', 'الاعمال', '2403330802', 'Pakistani', 'expat', 'male', '2021-08-01', 'syed.noman@evergreen-shipping.com.sa', 'noman_mega@hotmail.com', 'active'),
  ('H94929', 'MAALI SADEQ ALSHEKH', 'Dammam', 'LOG', 'الخدمات اللوجستية', '1087809164', 'Saudi', 'saudi', 'female', '2024-07-01', 'Maali.Alshekh@evergreen-shipping.com.sa', 'maali.alsheikh@gmail.com', 'active'),
  ('H94397', 'AHMED ABDELMONSEF IBRAHIM ELSHARKAWY', 'Dammam', 'LOG', 'الخدمات اللوجستية', '2387549344', 'Egyptian', 'expat', 'male', '2021-08-01', 'ahmad.elsharkawi@evergreen-shipping.com.sa', 'Ahmed.elsharkawy89@gmail.com', 'active'),
  ('H94499', 'ABDULRAHMAN NASSER AHMED ALGHAMDI', 'Dammam', 'LOG', 'الخدمات اللوجستية', '1009311190', 'Saudi', 'saudi', 'male', '2021-08-01', 'abdulrahman.alghamdi@evergreen-shipping.com.sa', 'dhmee64@gmail.com', 'active'),
  ('H94226', 'SONNIE BOY TOPNIO HABAL', 'Dammam', 'LOG', 'الخدمات اللوجستية', '2276658073', 'Philippine', 'expat', 'male', '2021-08-01', 'sonnie.habal@evergreen-shipping.com.sa', 'sth003_maersk@yahoo.com', 'active'),
  ('H94801', 'KHALID MOHAMMED ALMUTAIRI', 'Dammam', 'LOG', 'الخدمات اللوجستية', '1127510475', 'Saudi', 'saudi', 'male', '2024-03-10', 'Khalid.Almutari@evergreen-shipping.com.sa', 'motairi25@gamil.con', 'active'),
  ('H94753', 'BEDOR MOHAMMED ALMWALLAD', 'Dammam', 'LOG', 'الخدمات اللوجستية', '1097172173', 'Saudi', 'saudi', 'female', '2023-08-08', 'Bedor. Almwallad@evergreen-shipping.com.sa', 'bedoralmwallad@hotmail.com', 'active'),
  ('H94178', 'FAHAD ABDULQADER MOULAD', 'Dammam', 'CSD', 'خدمه عملاء', '1040638254', 'Saudi', 'saudi', 'male', '2021-08-01', 'fahad.almoulad@evergreen-shipping.com.sa', 'fahadshr@icloud.com', 'active'),
  ('H94371', 'SAHAR ALI DARWEISH ABED', 'Dammam', 'CSD', 'خدمه عملاء', '1050218039', 'Saudi', 'saudi', 'female', '2021-08-01', 'sahar.abed@evergreen-shipping.com.sa', 'earlymorningsahar@hotmail.com)', 'active'),
  ('H94239', 'HAITAM ELTAYEB', 'Dammam', 'CSD', 'خدمه عملاء', '2021984592', 'Sudanese', 'expat', 'male', '2021-08-01', 'haitham.altayeb@evergreen-shipping.com.sa', 'lionpaw83@gmail.com', 'active'),
  ('H94740', 'AREEJ MOHAMMED ABDULLAH ALGHAMDI', 'Dammam', 'CSD', 'خدمه عملاء', '1031106147', 'Saudi', 'saudi', 'female', '2023-05-21', 'Areej.Alnashri@evergreen-shipping.com.sa', 'Tn-tn2010@hotmail.com', 'active'),
  ('H94766', 'AMINAH AHMED MOHAMMED ABDULLAH', 'Dammam', 'CSD', 'خدمه عملاء', '1049096330', 'Saudi', 'saudi', 'female', '2023-08-08', 'Aminah. Abdullah @evergreen-shipping.com.sa', 'AMINAHMAKKI @gamil.com', 'active'),
  ('H94944', 'HAMAD AHMED ALNASHRI', 'Dammam', 'CSD', 'خدمه عملاء', '1064779638', 'Saudi', 'saudi', 'male', '2024-07-01', 'hamad.alnashri@evergreen-shipping.com.sa', 'hmad225c@gmail.com', 'active'),
  ('H94931', 'SHABBAB NOOR ALMUTAIRI', 'Dammam', 'SUP / CSD', 'موارد بشرية', '1120776453', 'Saudi', 'saudi', 'male', '2024-07-01', 'shabbab@evergreen-shipping.com.sa', 'Shsh381@hotmail.com', 'active'),
  ('H94432', 'ZAHIR FARAJ ABU HOUSA', 'Dammam', 'BIZ', 'الاعمال', '2018314076', 'Palestine', 'expat', 'male', '2021-08-01', 'zaher.abuhousa@evergreen-shipping.com.sa', 'Zaher_abuhosa@hotmail.com', 'active'),
  ('H94109', 'MOUSA ABDULRAHEEM HAMAD IZAIRIG', 'Dammam', 'LOG', 'الخدمات اللوجستية', '2123400158', 'Sudanese', 'expat', 'male', '2021-08-01', 'mousa.izairig@evergreen-shipping.com.sa', 'moousa2090@gmail.com', 'active'),
  ('H94193', 'SAAD OTHMAN MOHAMMAD AL OTHMAN', 'Dammam', 'CSD', 'خدمة العملاء', '1074575968', 'Saudi', 'saudi', 'male', '2021-08-01', 'saad.alothman@evergreen-shipping.com.sa', 'saadotm@gamil.com', 'active'),
  ('H94610', 'MOHAMED MOHAMED YANI ABULHASSAN', 'Dammam', 'CSD', 'خدمة العملاء', '2403761758', 'Indian', 'expat', 'male', '2021-08-01', 'mohamed.abubacker@evergreen-shipping.com.sa', 'yes.abubacker@gmail.com', 'active'),
  ('H94725', 'MUSAAD ABDULH MOHAMMED ALMUAYSIB', 'Dammam', 'CSD', 'خدمه عملاء', '1091916161', 'Saudi', 'saudi', 'male', '2023-02-06', 'musaad.almuaysib@evergreen-shipping.com.sa', 'MR.MSA3D1996@gamil.com', 'active'),
  ('H94794', 'ABDULAZIZ JABER AWAJI', 'Dammam', 'CSD', 'خدمه عملاء', '1115904169', 'Saudi', 'saudi', 'male', '2024-03-03', 'abdulaziz.awaji@evergreen-shipping.com.sa', NULL, 'active')
ON CONFLICT (id) DO UPDATE SET
  name             = EXCLUDED.name,
  department       = EXCLUDED.department,
  department_ar    = EXCLUDED.department_ar,
  iqama_id         = EXCLUDED.iqama_id,
  nationality_full = EXCLUDED.nationality_full,
  nationality      = EXCLUDED.nationality,
  gender           = EXCLUDED.gender,
  join_date        = COALESCE(EXCLUDED.join_date, employees.join_date),
  email            = EXCLUDED.email,
  personal_email   = EXCLUDED.personal_email,
  updated_at       = NOW();

-- Verify:
--   SELECT id, name, department, nationality_full, gender, iqama_id
--   FROM employees WHERE iqama_id IS NOT NULL ORDER BY id LIMIT 10;
