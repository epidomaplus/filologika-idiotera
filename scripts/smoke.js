// End-to-end API smoke test: node scripts/smoke.js [baseUrl]
const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:3000';
const rnd = Math.random().toString(36).slice(2, 8);
function client() {
  let cookie = '';
  return async (path, { method = 'GET', body, raw } = {}) => {
    const headers = { 'X-App': '1' };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    if (raw) return r;
    const j = await r.json().catch(() => null);
    return { status: r.status, body: j };
  };
}
const ok = (c, msg) => { if (!c) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); };
(async () => {
  const h = await (await fetch(BASE + '/healthz')).json();
  ok(h.ok && h.storage === 'postgres', 'healthz postgres');
  const T = client(), T2 = client(), S = client(), S2 = client();
  const tEmail = `teacher-${rnd}@example.com`;
  let r = await T('/api/auth/signup', { method: 'POST', body: { email: tEmail, password: 'teacherpass1', name: 'Δοκιμή Καθηγήτρια' } });
  ok(r.status === 201 && r.body.user.role === 'teacher', 'teacher signup');
  r = await T('/api/data');
  ok(Array.isArray(r.body.students), 'teacher data loads');
  const data = r.body;
  data.students.push({ id: 'st1', name: 'Νίκος Μαθητής', level: "Γ' Λυκείου", rate: 20, subjects: ['Αρχαία Ελληνικά'] });
  data.students.push({ id: 'st2', name: 'Ελένη Μαθήτρια', level: "Β' Λυκείου", rate: 20, subjects: [] });
  data.appointments.push({ id: 'a1', date: '2026-10-20', time: '17:00', studentId: 'st1', subject: 'Αρχαία Ελληνικά', duration: 60, status: 'completed', amount: 20, paid: true, lessonNotes: 'Θουκυδίδης', homework: 'Μετάφραση' });
  data.appointments.push({ id: 'a2', date: '2026-11-03', time: '18:00', studentId: 'st1', subject: 'Έκθεση', duration: 60, status: 'scheduled', amount: 20, paid: false });
  data.appointments.push({ id: 'a3', date: '2026-11-04', time: '18:00', studentId: 'st2', subject: 'Λατινικά', duration: 60, status: 'scheduled', amount: 20, paid: false });
  r = await T('/api/data', { method: 'PUT', body: data }); ok(r.status === 200, 'teacher saves data');
  r = await T('/api/data'); ok(r.body.students.length === 2 && r.body.appointments.length === 3, 'data persisted');

  const sEmail = `student-${rnd}@example.com`;
  r = await T('/api/students/st1/account', { method: 'POST', body: { email: sEmail, password: 'studentpw1' } });
  ok(r.status === 200, 'teacher creates student login');
  r = await T('/api/students/st2/invite', { method: 'POST' }); ok(r.body.code, 'teacher creates invite');
  const code = r.body.code;

  const pdf = Buffer.from('%PDF-1.4 test file').toString('base64');
  r = await T('/api/materials', { method: 'POST', body: { kind: 'exercise', targetType: 'student', studentRef: 'st1', title: 'Άσκηση Θουκυδίδη', body: 'Μετάφρασε 2.40', attachments: [{ filename: 'askisi.pdf', mime: 'application/pdf', dataBase64: pdf }] } });
  ok(r.status === 201 && r.body.attachments.length === 1, 'material for student with attachment');
  const attId = r.body.attachments[0].id;
  r = await T('/api/materials', { method: 'POST', body: { kind: 'note', targetType: 'class', classLabel: "Γ' Λυκείου", title: 'Σημειώσεις τάξης' } });
  ok(r.status === 201, 'material for class');
  r = await T('/api/materials', { method: 'POST', body: { kind: 'note', targetType: 'class', classLabel: "Β' Λυκείου", title: 'Μόνο Β Λυκείου' } });
  r = await T('/api/materials', { method: 'POST', body: { kind: 'note', targetType: 'all', title: 'Για όλους' } });

  r = await S('/api/auth/login', { method: 'POST', body: { email: sEmail, password: 'studentpw1' } });
  ok(r.status === 200 && r.body.user.role === 'student', 'student logs in');
  r = await S('/api/portal');
  ok(r.status === 200 && r.body.appointments.length === 2, 'student sees only own 2 appointments');
  const titles = r.body.materials.map(m => m.title).sort();
  ok(JSON.stringify(titles) === JSON.stringify(['Άσκηση Θουκυδίδη', 'Για όλους', 'Σημειώσεις τάξης'].sort()), 'student sees student+class+all materials only: ' + titles.join(', '));
  let fr = await S(`/api/attachments/${attId}`, { raw: true });
  ok(fr.status === 200 && (await fr.text()).startsWith('%PDF'), 'student downloads attachment');
  r = await S('/api/data'); ok(r.status === 403, 'student cannot read teacher data');

  r = await S2('/api/auth/signup', { method: 'POST', body: { email: `student2-${rnd}@example.com`, password: 'studentpw2', inviteCode: code } });
  ok(r.status === 201 && r.body.user.role === 'student', 'student signs up with invite');
  r = await S2('/api/portal');
  ok(r.body.student.name === 'Ελένη Μαθήτρια' && r.body.appointments.length === 1, 'invited student linked');
  fr = await S2(`/api/attachments/${attId}`, { raw: true }); ok(fr.status === 404, 'other student cannot download');

  r = await T2('/api/auth/signup', { method: 'POST', body: { email: `teacher2-${rnd}@example.com`, password: 'teacherpass2' } });
  r = await T2('/api/data'); ok(r.body.students.length === 0, 'second teacher isolated');
  r = await T2('/api/materials'); ok(r.body.length === 0, 'second teacher sees no materials');
  fr = await T2(`/api/attachments/${attId}`, { raw: true }); ok(fr.status === 404, 'second teacher cannot download');
  r = await T2('/api/students/st1/account', { method: 'POST', body: { email: `x-${rnd}@example.com`, password: 'whatever12' } });
  ok(r.status === 404, 'second teacher cannot create login for foreign student');

  const csrf = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok(csrf.status === 403, 'mutations without X-App header rejected');

  // delete student st1 -> its login is removed
  data.students = data.students.filter(s => s.id !== 'st1');
  data.appointments = data.appointments.filter(a => a.studentId !== 'st1');
  await T('/api/data', { method: 'PUT', body: data });
  r = await S('/api/portal'); ok(r.status === 401, 'deleted student login revoked');
  r = await T('/api/auth/logout', { method: 'POST' });
  r = await T('/api/data'); ok(r.status === 401, 'logout works');
  console.log('\nALL SMOKE TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
