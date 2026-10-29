
-- 003_egypt_cities.sql
-- Insert or update reference cities for Egypt.
-- Coordinates are approximate city-center locations.

INSERT INTO cities
  (slug, name_ar, name_en, governorate_en, location, is_active)
VALUES
  ('cairo', 'القاهرة', 'Cairo', 'Cairo', ST_SetSRID(ST_MakePoint(31.2357, 30.0444), 4326)::geography, true),
  ('giza', 'الجيزة', 'Giza', 'Giza', ST_SetSRID(ST_MakePoint(31.2089, 30.0131), 4326)::geography, true),
  ('alexandria', 'الإسكندرية', 'Alexandria', 'Alexandria', ST_SetSRID(ST_MakePoint(29.9187, 31.2001), 4326)::geography, true),
  ('new-cairo', 'القاهرة الجديدة', 'New Cairo', 'Cairo', ST_SetSRID(ST_MakePoint(31.4913, 30.0074), 4326)::geography, true),
  ('sixth-of-october', 'مدينة 6 أكتوبر', '6th of October City', 'Giza', ST_SetSRID(ST_MakePoint(30.9760, 29.9285), 4326)::geography, true),
  ('sheikh-zayed', 'الشيخ زايد', 'Sheikh Zayed City', 'Giza', ST_SetSRID(ST_MakePoint(30.9429, 30.0131), 4326)::geography, true),
  ('obour', 'العبور', 'Obour City', 'Qalyubia', ST_SetSRID(ST_MakePoint(31.4785, 30.2280), 4326)::geography, true),
  ('tenth-of-ramadan', 'العاشر من رمضان', '10th of Ramadan City', 'Sharqia', ST_SetSRID(ST_MakePoint(31.7410, 30.2964), 4326)::geography, true),
  ('new-administrative-capital', 'العاصمة الإدارية الجديدة', 'New Administrative Capital', 'Cairo', ST_SetSRID(ST_MakePoint(31.7500, 30.0200), 4326)::geography, true),
  ('mansoura', 'المنصورة', 'Mansoura', 'Dakahlia', ST_SetSRID(ST_MakePoint(31.3785, 31.0409), 4326)::geography, true),
  ('tanta', 'طنطا', 'Tanta', 'Gharbia', ST_SetSRID(ST_MakePoint(31.0004, 30.7865), 4326)::geography, true),
  ('zagazig', 'الزقازيق', 'Zagazig', 'Sharqia', ST_SetSRID(ST_MakePoint(31.5020, 30.5877), 4326)::geography, true),
  ('ismailia', 'الإسماعيلية', 'Ismailia', 'Ismailia', ST_SetSRID(ST_MakePoint(32.2715, 30.5965), 4326)::geography, true),
  ('suez', 'السويس', 'Suez', 'Suez', ST_SetSRID(ST_MakePoint(32.5498, 29.9668), 4326)::geography, true),
  ('port-said', 'بورسعيد', 'Port Said', 'Port Said', ST_SetSRID(ST_MakePoint(32.3019, 31.2653), 4326)::geography, true),
  ('damietta', 'دمياط', 'Damietta', 'Damietta', ST_SetSRID(ST_MakePoint(31.8144, 31.4175), 4326)::geography, true),
  ('damanhur', 'دمنهور', 'Damanhur', 'Beheira', ST_SetSRID(ST_MakePoint(30.4690, 31.0341), 4326)::geography, true),
  ('kafr-el-sheikh', 'كفر الشيخ', 'Kafr El Sheikh', 'Kafr El Sheikh', ST_SetSRID(ST_MakePoint(30.9400, 31.1107), 4326)::geography, true),
  ('banha', 'بنها', 'Banha', 'Qalyubia', ST_SetSRID(ST_MakePoint(31.1843, 30.4667), 4326)::geography, true),
  ('faiyum', 'الفيوم', 'Faiyum', 'Faiyum', ST_SetSRID(ST_MakePoint(30.8418, 29.3084), 4326)::geography, true),
  ('beni-suef', 'بني سويف', 'Beni Suef', 'Beni Suef', ST_SetSRID(ST_MakePoint(31.0979, 29.0661), 4326)::geography, true),
  ('minya', 'المنيا', 'Minya', 'Minya', ST_SetSRID(ST_MakePoint(30.7503, 28.1099), 4326)::geography, true),
  ('asyut', 'أسيوط', 'Asyut', 'Asyut', ST_SetSRID(ST_MakePoint(31.1829, 27.1783), 4326)::geography, true),
  ('sohag', 'سوهاج', 'Sohag', 'Sohag', ST_SetSRID(ST_MakePoint(31.6948, 26.5591), 4326)::geography, true),
  ('qena', 'قنا', 'Qena', 'Qena', ST_SetSRID(ST_MakePoint(32.7267, 26.1551), 4326)::geography, true),
  ('luxor', 'الأقصر', 'Luxor', 'Luxor', ST_SetSRID(ST_MakePoint(32.6396, 25.6872), 4326)::geography, true),
  ('aswan', 'أسوان', 'Aswan', 'Aswan', ST_SetSRID(ST_MakePoint(32.8998, 24.0889), 4326)::geography, true),
  ('hurghada', 'الغردقة', 'Hurghada', 'Red Sea', ST_SetSRID(ST_MakePoint(33.8116, 27.2579), 4326)::geography, true),
  ('sharm-el-sheikh', 'شرم الشيخ', 'Sharm El Sheikh', 'South Sinai', ST_SetSRID(ST_MakePoint(34.3299, 27.9158), 4326)::geography, true),
  ('marsa-matruh', 'مرسى مطروح', 'Marsa Matruh', 'Matrouh', ST_SetSRID(ST_MakePoint(27.2373, 31.3543), 4326)::geography, true),
  ('el-alamein', 'العلمين', 'El Alamein', 'Matrouh', ST_SetSRID(ST_MakePoint(28.9550, 30.8481), 4326)::geography, true),
  ('borg-el-arab', 'برج العرب', 'Borg El Arab', 'Alexandria', ST_SetSRID(ST_MakePoint(29.6960, 30.9177), 4326)::geography, true),
  ('arish', 'العريش', 'Arish', 'North Sinai', ST_SetSRID(ST_MakePoint(33.8000, 31.1321), 4326)::geography, true)
ON CONFLICT (slug) DO UPDATE SET
  name_ar = EXCLUDED.name_ar,
  name_en = EXCLUDED.name_en,
  governorate_en = EXCLUDED.governorate_en,
  location = EXCLUDED.location,
  is_active = true;
