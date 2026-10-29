-- Reference cities (idempotent). Coordinates are city-centre approximations: ST_MakePoint(lng, lat).
INSERT INTO cities(slug, name_ar, name_en, governorate_en, location) VALUES
 ('cairo','القاهرة','Cairo','Cairo', ST_SetSRID(ST_MakePoint(31.2357,30.0444),4326)::geography),
 ('giza','الجيزة','Giza','Giza', ST_SetSRID(ST_MakePoint(31.2118,29.9870),4326)::geography),
 ('alexandria','الإسكندرية','Alexandria','Alexandria', ST_SetSRID(ST_MakePoint(29.9187,31.2001),4326)::geography),
 ('port-said','بورسعيد','Port Said','Port Said', ST_SetSRID(ST_MakePoint(32.3019,31.2653),4326)::geography),
 ('suez','السويس','Suez','Suez', ST_SetSRID(ST_MakePoint(32.5498,29.9668),4326)::geography),
 ('ismailia','الإسماعيلية','Ismailia','Ismailia', ST_SetSRID(ST_MakePoint(32.2715,30.5965),4326)::geography),
 ('zagazig','الزقازيق','Zagazig','Sharqia', ST_SetSRID(ST_MakePoint(31.5020,30.5877),4326)::geography),
 ('mansoura','المنصورة','Mansoura','Dakahlia', ST_SetSRID(ST_MakePoint(31.3785,31.0409),4326)::geography),
 ('tanta','طنطا','Tanta','Gharbia', ST_SetSRID(ST_MakePoint(31.0004,30.7865),4326)::geography),
 ('damanhur','دمنهور','Damanhur','Beheira', ST_SetSRID(ST_MakePoint(30.4682,31.0341),4326)::geography),
 ('kafr-el-sheikh','كفر الشيخ','Kafr El Sheikh','Kafr El Sheikh', ST_SetSRID(ST_MakePoint(30.9388,31.1107),4326)::geography),
 ('fayoum','الفيوم','Fayoum','Fayoum', ST_SetSRID(ST_MakePoint(30.8428,29.3084),4326)::geography),
 ('beni-suef','بني سويف','Beni Suef','Beni Suef', ST_SetSRID(ST_MakePoint(31.0994,29.0661),4326)::geography),
 ('minya','المنيا','Minya','Minya', ST_SetSRID(ST_MakePoint(30.7503,28.1099),4326)::geography),
 ('asyut','أسيوط','Asyut','Asyut', ST_SetSRID(ST_MakePoint(31.1859,27.1783),4326)::geography),
 ('sohag','سوهاج','Sohag','Sohag', ST_SetSRID(ST_MakePoint(31.6957,26.5591),4326)::geography),
 ('qena','قنا','Qena','Qena', ST_SetSRID(ST_MakePoint(32.7160,26.1551),4326)::geography),
 ('luxor','الأقصر','Luxor','Luxor', ST_SetSRID(ST_MakePoint(32.6396,25.6872),4326)::geography),
 ('aswan','أسوان','Aswan','Aswan', ST_SetSRID(ST_MakePoint(32.8998,24.0889),4326)::geography),
 ('hurghada','الغردقة','Hurghada','Red Sea', ST_SetSRID(ST_MakePoint(33.8116,27.2579),4326)::geography),
 ('sharm-el-sheikh','شرم الشيخ','Sharm El Sheikh','South Sinai', ST_SetSRID(ST_MakePoint(34.3300,27.9158),4326)::geography),
 ('marsa-matrouh','مرسى مطروح','Marsa Matrouh','Matrouh', ST_SetSRID(ST_MakePoint(27.2373,31.3543),4326)::geography),
 ('el-alamein','العلمين','El Alamein','Matrouh', ST_SetSRID(ST_MakePoint(28.9540,30.8300),4326)::geography)
ON CONFLICT (slug) DO UPDATE SET
  name_ar = EXCLUDED.name_ar, name_en = EXCLUDED.name_en,
  governorate_en = EXCLUDED.governorate_en, location = EXCLUDED.location;
