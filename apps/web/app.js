(() => {
  'use strict';
  const API_BASE = (window.CARPOOL_API_BASE || 'http://localhost:4000/api/v1').replace(/\/$/, '');
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const state = { token: sessionStorage.getItem('carpool_access_token') || '', user: null, cities: [], vehicles: [], trips: [], lang: 'ar' };
  const arDate = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
  const money = n => new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 0 }).format(Number(n || 0));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  let toastTimer;

  function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3600); }
  function message(id, text, error = false) { const el = $(id); if (!el) return; el.textContent = text || ''; el.classList.toggle('error', !!error); }
  function showModal(id) { $(id).classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
  function closeModal(id) { $(id).classList.add('hidden'); if (!$('.modal:not(.hidden)')) document.body.style.overflow = ''; }
  function setBusy(form, busy) { form.classList.toggle('loading', busy); $$('button', form).forEach(b => b.disabled = busy); }
  function apiError(data, status) { return data?.message || data?.error?.message || data?.error || data?.detail || `حصل خطأ في الاتصال بالخادم (${status || 'غير معروف'}).`; }

  async function api(path, options = {}, retry = true) {
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes((options.method || 'GET').toUpperCase())) headers.set('X-Requested-With', 'fetch');
    let response;
    try { response = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include' }); }
    catch (_) { throw new Error('مش قادر أوصل بخادم سِكّة. اتأكد إن رابط API المنشور صحيح وإن الخادم شغال وإعدادات CORS تسمح لرابط الموقع.'); }
    if (response.status === 401 && retry && !path.startsWith('/auth/')) {
      const refreshed = await refreshToken();
      if (refreshed) return api(path, options, false);
    }
    if (response.status === 204) return null;
    const text = await response.text(); let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) throw new Error(apiError(data, response.status));
    return data;
  }
  async function refreshToken() {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'fetch', 'Accept': 'application/json' } });
      if (!res.ok) { clearSession(false); return false; }
      const data = await res.json(); setToken(data.accessToken); return true;
    } catch { return false; }
  }
  function setToken(token) { state.token = token || ''; if (token) sessionStorage.setItem('carpool_access_token', token); else sessionStorage.removeItem('carpool_access_token'); }
  function clearSession(update = true) { setToken(''); state.user = null; if (update) { updateHeader(); message('#account-message', 'تم تسجيل الخروج.'); } }
  async function loadMe() { if (!state.token) return null; try { state.user = await api('/me'); updateHeader(); return state.user; } catch { clearSession(false); updateHeader(); return null; } }
  function updateHeader() {
    $('#auth-open').classList.toggle('hidden', !!state.user); $('#account-open').classList.toggle('hidden', !state.user);
    if (state.user) { $('#account-open').textContent = (state.user.fullName || 'ح').trim().charAt(0); $('#account-summary').innerHTML = `<strong>${esc(state.user.fullName)}</strong><small>${esc(state.user.email)}</small><small>${state.user.emailVerified ? 'البريد الإلكتروني مؤكد' : 'البريد الإلكتروني غير مؤكد'}</small>`; }
  }

  async function loadCities() {
    try {
      state.cities = await api('/cities');
      if (!Array.isArray(state.cities)) state.cities = [];
      const opts = state.cities.map(c => `<option value="${esc(c.slug)}">${esc(c.nameAr)}${c.governorateEn && c.governorateEn !== c.nameEn ? ` — ${esc(c.governorateEn)}` : ''}</option>`).join('');
      ['#search-from', '#search-to'].forEach((id, i) => { const el = $(id); el.innerHTML = `<option value="">${i ? 'اختار الوجهة' : 'اختار مدينة البداية'}</option>${opts}`; });
      ['#trip-from', '#trip-to'].forEach((id, i) => { const el = $(id); el.innerHTML = `<option value="">${i ? 'اختار الوجهة' : 'مدينة البداية'}</option>${opts}`; });
      $('#search-status').textContent = `${money(state.cities.length)} مدينة متاحة للاختيار. ابدأ بالبحث عن رحلة.`;
    } catch (e) { $('#search-status').textContent = e.message; }
  }

  function cityName(slug) { const c = state.cities.find(x => x.slug === slug); return c?.nameAr || slug || 'مدينة غير محددة'; }
  function formatDate(date) { try { return arDate.format(new Date(date)); } catch { return date || 'موعد غير محدد'; } }
  function renderTrips(items) {
    const host = $('#search-results');
    if (!items?.length) { host.innerHTML = '<div class="empty-results"><strong>مفيش رحلات مطابقة حاليًا</strong><br />جرّب تاريخ تاني أو غيّر المدن. النتائج بتظهر لما تكون فيه رحلات منشورة فعلًا.</div>'; return; }
    host.innerHTML = items.map(t => `<article class="trip-card"><div class="trip-card-top"><div><h3>${esc(t.from?.name || cityName(t.from?.city))} <span style="color:#8db4a7">←</span> ${esc(t.to?.name || cityName(t.to?.city))}</h3><div class="trip-date">${esc(formatDate(t.from?.departAt))}</div></div><div class="trip-price">${money((t.pricePerSeatMinor || 0) / 100)} ج.م<small>للمقعد الواحد</small></div></div><div class="trip-route"><div><strong>${esc(t.from?.name || cityName(t.from?.city))}</strong><small>التحرك · ${esc(new Date(t.from?.departAt).toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'}))}</small></div><div class="trip-route-arrow">←</div><div><strong>${esc(t.to?.name || cityName(t.to?.city))}</strong><small>الوصول · ${esc(new Date(t.to?.arriveAt).toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'}))}</small></div></div><div class="trip-meta"><span>♙ ${esc(t.driver?.fullName || 'السائق')}</span><span>▰ ${esc([t.vehicle?.make,t.vehicle?.model].filter(Boolean).join(' ') || 'بيانات العربية')}</span><span>♧ ${money(t.seatsAvailable)} مقعد متاح</span></div><button class="button button-outline book-trip" data-trip="${esc(t.tripId)}" data-from="${esc(t.from?.stopId)}" data-to="${esc(t.to?.stopId)}">تفاصيل / طلب حجز</button></article>`).join('');
  }

  $('#search-form').addEventListener('submit', async e => {
    e.preventDefault(); const from = $('#search-from').value, to = $('#search-to').value;
    if (!from || !to) return toast('اختار مدينة البداية والوجهة الأول.');
    if (from === to) return toast('مدينة البداية لازم تختلف عن الوجهة.');
    const params = new URLSearchParams({ fromCity: from, toCity: to, seats: $('#search-seats').value, pageSize: '20', page: '1', sort: 'departure' });
    if ($('#search-date').value) params.set('date', $('#search-date').value);
    const submit = $('.search-submit'); submit.disabled = true; submit.innerHTML = 'جاري البحث…'; $('#search-status').textContent = 'بندور على رحلات مطابقة من الخادم…'; $('#search-results').innerHTML = '';
    try { const data = await api(`/trips/search?${params}`); const items = Array.isArray(data) ? data : (data?.items || data?.data || []); $('#search-status').textContent = `عدد النتائج: ${money(data?.total ?? items.length)}`; renderTrips(items); }
    catch (err) { $('#search-status').textContent = err.message; $('#search-results').innerHTML = '<div class="empty-results error-note">تعذر تحميل الرحلات. راجع اتصال الـ API وإعدادات قاعدة البيانات.</div>'; }
    finally { submit.disabled = false; submit.innerHTML = '<span>⌕</span> ابحث عن رحلة'; }
  });
  $('#swap-cities').addEventListener('click', () => { const a = $('#search-from'), b = $('#search-to'), temp = a.value; a.value = b.value; b.value = temp; });
  $('#search-results').addEventListener('click', async e => {
    const btn = e.target.closest('.book-trip'); if (!btn) return;
    if (!state.user) { showModal('#auth-modal'); toast('سجّل دخولك الأول عشان تقدر تطلب حجز.'); return; }
    try {
      const trip = await api(`/trips/${encodeURIComponent(btn.dataset.trip)}`);
      const fromStop = trip.stops?.find(s => s.id === btn.dataset.from) || trip.stops?.find(s => s.seq === 0);
      const toStop = trip.stops?.find(s => s.id === btn.dataset.to) || trip.stops?.find(s => s.seq > (fromStop?.seq ?? 0));
      if (!fromStop || !toStop) throw new Error('تعذر تحديد محطات الرحلة للحجز.');
      const seats = Number($('#search-seats').value);
      if (!confirm(`طلب حجز ${seats} مقعد؟\n${fromStop.name} ← ${toStop.name}\nالسعر الظاهر للرحلة: ${money((trip.segments || []).filter(s => s.seq >= fromStop.seq && s.seq < toStop.seq).reduce((sum,s)=>sum+(s.priceMinor||0),0)/100*seats)} جنيه\nقد يكون الحجز متوقفًا حتى تفعيل الخدمة من الإدارة.`)) return;
      const key = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 120);
      await api(`/trips/${encodeURIComponent(btn.dataset.trip)}/bookings`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ fromStopId: fromStop.id, toStopId: toStop.id, seats }) });
      toast('تم إرسال طلب الحجز. راجع حجوزاتك للحالة.');
    } catch (err) { toast(err.message); }
  });

  $('#auth-open').addEventListener('click', () => { showModal('#auth-modal'); message('#auth-message', ''); });
  $('#account-open').addEventListener('click', async () => { showModal('#account-modal'); message('#account-message', ''); $('#account-data').innerHTML = ''; if (state.user) $('#account-summary').innerHTML = `<strong>${esc(state.user.fullName)}</strong><small>${esc(state.user.email)}</small><small>${state.user.emailVerified ? 'البريد الإلكتروني مؤكد' : 'البريد الإلكتروني غير مؤكد'}</small>`; });
  $$('[data-close]').forEach(el => el.addEventListener('click', () => closeModal(`#${el.dataset.close}-modal`)));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal:not(.hidden)').forEach(m => closeModal(`#${m.id}`)); });
  $$('[data-auth-tab]').forEach(btn => btn.addEventListener('click', () => { $$('[data-auth-tab]').forEach(b => b.classList.toggle('active', b === btn)); $('#login-form').classList.toggle('hidden', btn.dataset.authTab !== 'login'); $('#register-form').classList.toggle('hidden', btn.dataset.authTab !== 'register'); $('#auth-title').textContent = btn.dataset.authTab === 'login' ? 'أهلًا بيك في سِكّة' : 'حساب جديد على سِكّة'; message('#auth-message', ''); }));

  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault(); const form = e.currentTarget; setBusy(form, true); message('#auth-message', 'جاري تسجيل الدخول…');
    const fd = new FormData(form);
    try { const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }) }); setToken(data.accessToken); state.user = data.user || await api('/me'); updateHeader(); closeModal('#auth-modal'); form.reset(); toast(`أهلًا ${state.user.fullName || ''}`); }
    catch (err) { message('#auth-message', err.message, true); }
    finally { setBusy(form, false); }
  });
  $('#register-form').addEventListener('submit', async e => {
    e.preventDefault(); const form = e.currentTarget; setBusy(form, true); message('#auth-message', 'جاري إنشاء الحساب…');
    const fd = new FormData(form);
    try { await api('/auth/register', { method: 'POST', body: JSON.stringify({ fullName: fd.get('fullName'), email: fd.get('email'), password: fd.get('password'), locale: 'ar' }) }); message('#auth-message', 'تم إنشاء الحساب. ارجع لتبويب تسجيل الدخول واستخدم بياناتك. قد تحتاج لتأكيد البريد الإلكتروني قبل التقديم كسائق.'); form.reset(); }
    catch (err) { message('#auth-message', err.message, true); }
    finally { setBusy(form, false); }
  });
  $('#logout-button').addEventListener('click', async () => { try { await api('/auth/logout', { method: 'POST' }); } catch (_) {} clearSession(); closeModal('#account-modal'); toast('تم تسجيل الخروج.'); });

  async function showAccountData(path, title) {
    if (!state.user) { showModal('#auth-modal'); return; }
    message('#account-message', 'جاري تحميل البيانات…'); $('#account-data').innerHTML = '';
    try { const data = await api(path); const items = Array.isArray(data) ? data : (data?.items || data?.data || []); message('#account-message', `${title}: ${money(data?.total ?? items.length)}`); if (!items.length) { $('#account-data').innerHTML = '<div class="empty-results">مفيش بيانات لعرضها حاليًا.</div>'; return; }
      $('#account-data').innerHTML = items.map(item => `<div class="data-row"><div><strong>${esc(item.from?.name || item.fullName || item.status || item.id || title)}</strong><div style="color:#6f8380;margin-top:4px">${esc(item.to?.name || item.email || item.bookingMode || '')}</div></div><span>${esc(item.departureAt ? formatDate(item.departureAt) : item.status || '')}</span></div>`).join('');
    } catch (err) { message('#account-message', err.message, true); }
  }
  $('#my-bookings').addEventListener('click', () => showAccountData('/me/bookings?page=1&pageSize=20', 'حجوزاتي'));
  $('#my-trips').addEventListener('click', () => showAccountData('/me/trips?page=1&pageSize=20', 'رحلاتي'));
  $('#publish-start').addEventListener('click', () => { if (!state.user) { showModal('#auth-modal'); toast('سجّل الدخول الأول عشان تبدأ ملف السائق.'); return; } openDriver(); });
  $('#driver-apply').addEventListener('click', () => { closeModal('#account-modal'); if (!state.user) showModal('#auth-modal'); else openDriver(); });
  $('#mobile-menu').addEventListener('click', () => { const existing = $('#mobile-nav'); if (existing) { existing.remove(); return; } const nav = document.createElement('div'); nav.id = 'mobile-nav'; nav.style.cssText = 'position:fixed;top:100px;left:12px;right:12px;z-index:30;padding:15px;background:#fff;border:1px solid #e1ebe6;border-radius:16px;box-shadow:0 15px 45px #16333120;display:grid;gap:14px;font-size:13px;font-weight:800'; nav.innerHTML = '<a href="#search">ابحث عن رحلة</a><a href="#how">إزاي بتشتغل؟</a><a href="#publish">اعرض مشوارك</a>'; nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => nav.remove())); document.body.appendChild(nav); });

  async function openDriver() { showModal('#driver-modal'); message('#driver-message', ''); message('#trip-message', ''); await loadVehicles(); }
  $('#driver-apply-modal').addEventListener('click', async () => { message('#driver-message', 'جاري إرسال طلب المراجعة…'); try { const data = await api('/drivers/apply', { method: 'POST', body: '{}' }); message('#driver-message', `تم التعامل مع الطلب. الحالة الحالية: ${data?.verificationStatus || data?.status || 'قيد المراجعة'}`); toast('راجع حالة طلب السائق من حسابك.'); } catch (e) { message('#driver-message', e.message, true); } });
  $('#vehicle-form').addEventListener('submit', async e => { e.preventDefault(); const form = e.currentTarget; setBusy(form, true); message('#driver-message', 'جاري تسجيل العربية…'); const fd = new FormData(form); const body = { make: fd.get('make'), model: fd.get('model'), color: fd.get('color'), seats: Number(fd.get('seats')), plateNumber: fd.get('plateNumber') }; try { const vehicle = await api('/vehicles', { method: 'POST', body: JSON.stringify(body) }); message('#driver-message', `تم تسجيل العربية. حالة المراجعة: ${vehicle.verificationStatus || 'قيد المراجعة'}`); form.reset(); await loadVehicles(); } catch (err) { message('#driver-message', err.message, true); } finally { setBusy(form, false); } });
  async function loadVehicles() { const select = $('#trip-vehicle'); select.innerHTML = '<option value="">جاري تحميل العربيات…</option>'; try { state.vehicles = await api('/me/vehicles'); select.innerHTML = '<option value="">اختار العربية</option>' + state.vehicles.map(v => `<option value="${esc(v.id)}" ${v.verificationStatus !== 'approved' ? 'disabled' : ''}>${esc(`${v.make} ${v.model} — ${v.color}`)} (${esc(v.verificationStatus)})</option>`).join(''); if (!state.vehicles.length) select.innerHTML = '<option value="">سجّل عربية الأول</option>'; } catch (e) { select.innerHTML = '<option value="">تعذر تحميل العربيات</option>'; message('#driver-message', e.message, true); } }
  $('#trip-form').addEventListener('submit', async e => {
    e.preventDefault(); const form = e.currentTarget; const fd = new FormData(form); const from = state.cities.find(c => c.slug === $('#trip-from').value); const to = state.cities.find(c => c.slug === $('#trip-to').value);
    if (!from || !to || from.id === to.id) { message('#trip-message', 'اختار مدينتين مختلفتين.', true); return; }
    const departureLocal = new Date(fd.get('departureAt')); if (Number.isNaN(departureLocal.getTime())) { message('#trip-message', 'اكتب موعد تحرك صحيح.', true); return; }
    const durationMinutes = 180;
    const body = { vehicleId: fd.get('vehicleId'), departureAt: departureLocal.toISOString(), seatsTotal: Number(fd.get('seatsTotal')), bookingMode: fd.get('bookingMode'), notes: fd.get('notes') || undefined, stops: [{ cityId: from.id, name: from.nameAr, lat: Number(from.lat), lng: Number(from.lng), offsetMinutes: 0 }, { cityId: to.id, name: to.nameAr, lat: Number(to.lat), lng: Number(to.lng), offsetMinutes: durationMinutes }], segmentPricesMinor: [Math.round(Number(fd.get('price')) * 100)] };
    setBusy(form, true); message('#trip-message', 'جاري محاولة نشر الرحلة…');
    try { const trip = await api('/trips', { method: 'POST', body: JSON.stringify(body) }); message('#trip-message', `تم إنشاء الرحلة. رقمها: ${trip.id || 'تم الإنشاء'}، وحالة النشر يحددها إعداد النظام.`); form.reset(); }
    catch (err) { message('#trip-message', `${err.message}\nلو ظهر إن النشر متوقف أو إن السائق/العربية مش معتمدين، فده معناه إن إعدادات النظام الحالية مانعة النشر لحد مراجعة الإدارة.`, true); }
    finally { setBusy(form, false); }
  });

  $('#year').textContent = new Date().getFullYear();
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); $('#search-date').min = new Date().toISOString().slice(0,10); $('#trip-departure').min = new Date().toISOString().slice(0,16); $('#trip-departure').value = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset()*60000).toISOString().slice(0,16);
  (async () => { await loadCities(); await loadMe(); updateHeader(); })();
})();
