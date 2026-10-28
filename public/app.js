// ==================== API (Express + Postgres backend) ====================
// Αντικαθιστά το Firebase: εγγραφή/σύνδεση με email+κωδικό, αποθήκευση σε Postgres.
async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: { 'X-App': '1' }, credentials: 'same-origin' };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    const res = await fetch(path, init);
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw new Error((data && data.error) || `Σφάλμα (${res.status})`);
    return data;
}

function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const defaultData = () => ({
    students: [],
    appointments: [],
    settings: {
        teacherName: '',
        defaultRate: 15,
        subjects: 'Μαθηματικά, Φυσική, Χημεία, Αγγλικά, Νέα Ελληνικά, Ιστορία'
    },
    theme: 'light'
});

let currentUser = null;
let appData = defaultData();
let studentAccounts = { accounts: [], invites: [] };
let materials = [];

// ==================== AUTH ====================
function showScreen(which) {
    document.getElementById('auth-screen').style.display = which === 'auth' ? 'flex' : 'none';
    document.getElementById('main-app').style.display = which === 'teacher' ? 'flex' : 'none';
    document.getElementById('portal-app').style.display = which === 'student' ? 'flex' : 'none';
}

async function onLoggedIn(user) {
    currentUser = user;
    if (user.role === 'student') {
        showScreen('student');
        document.getElementById('portal-email').textContent = user.email;
        await initPortal();
        return;
    }
    showScreen('teacher');
    document.getElementById('user-email').textContent = user.email;
    await loadData();
    initApp();
}

function initAuth() {
    const params = new URLSearchParams(location.search);
    const invite = params.get('invite');
    const regFields = document.getElementById('register-fields');
    if (invite) {
        regFields.style.display = 'block';
        document.getElementById('auth-invite').value = invite;
        document.getElementById('auth-hint').textContent = 'Έχεις πρόσκληση μαθητή: συμπλήρωσε email, κωδικό και πάτα «Εγγραφή».';
    }

    const creds = () => ({
        email: document.getElementById('auth-email').value.trim(),
        password: document.getElementById('auth-password').value
    });

    document.getElementById('login-btn').addEventListener('click', async () => {
        try {
            const { user } = await api('/api/auth/login', { method: 'POST', body: creds() });
            await onLoggedIn(user);
        } catch (e) { showAuthError(e.message); }
    });

    document.getElementById('register-btn').addEventListener('click', async () => {
        if (regFields.style.display === 'none') {
            regFields.style.display = 'block';
            document.getElementById('auth-name').focus();
            return;
        }
        const body = { ...creds(), name: document.getElementById('auth-name').value.trim(), inviteCode: document.getElementById('auth-invite').value.trim() };
        if (body.password.length < 8) { showAuthError('Ο κωδικός πρέπει να έχει τουλάχιστον 8 χαρακτήρες'); return; }
        try {
            const { user } = await api('/api/auth/signup', { method: 'POST', body });
            if (invite) history.replaceState(null, '', location.pathname);
            await onLoggedIn(user);
        } catch (e) { showAuthError(e.message); }
    });

    document.getElementById('auth-password').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('login-btn').click();
    });

    const logout = async () => {
        try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
        location.href = location.pathname;
    };
    document.getElementById('logout-btn').addEventListener('click', logout);
    document.getElementById('portal-logout').addEventListener('click', logout);

    api('/api/me').then(({ user }) => {
        if (user) onLoggedIn(user); else showScreen('auth');
    }).catch(() => showScreen('auth'));
}

function showAuthError(msg) {
    const el = document.getElementById('auth-error');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 5000);
}

// ==================== DATA (Postgres via API) ====================
async function loadData() {
    try {
        const data = await api('/api/data');
        appData = { ...defaultData(), ...data, settings: { ...defaultData().settings, ...(data.settings || {}) } };
    } catch (e) {
        console.error('Load error', e);
        showToast('Σφάλμα φόρτωσης δεδομένων', 'error');
    }
    await refreshStudentAccounts();
    await refreshMaterials();
}

let saveChain = Promise.resolve();
function saveData() {
    if (!currentUser || currentUser.role !== 'teacher') return Promise.resolve();
    const snapshot = JSON.parse(JSON.stringify(appData));
    saveChain = saveChain.then(() => api('/api/data', { method: 'PUT', body: snapshot })).catch(e => {
        console.error('Save error', e);
        showToast('Σφάλμα αποθήκευσης: ' + e.message, 'error');
    });
    return saveChain;
}

async function refreshStudentAccounts() {
    try { studentAccounts = await api('/api/student-accounts'); } catch { studentAccounts = { accounts: [], invites: [] }; }
}
async function refreshMaterials() {
    try { materials = await api('/api/materials'); } catch { materials = []; }
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// ==================== UI HELPERS ====================
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 3000);
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('el-GR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function getStudentById(id) {
    return appData.students.find(s => s.id === id);
}

function getSubjects() {
    return appData.settings.subjects.split(',').map(s => s.trim()).filter(Boolean);
}

function getStatusText(status) {
    const map = { scheduled: 'Προγραμματισμένο', completed: 'Ολοκληρωμένο', cancelled: 'Ακυρωμένο' };
    return map[status] || status;
}

// ==================== NAVIGATION ====================
function initNavigation() {
    document.querySelectorAll('#main-app .nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#main-app .nav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const page = btn.dataset.page;
            document.querySelectorAll('#main-app .page').forEach(p => p.classList.remove('active'));
            document.getElementById(page).classList.add('active');
            document.getElementById('page-title').textContent = btn.textContent.trim();
            if (page === 'dashboard') renderDashboard();
            if (page === 'students') renderStudents();
            if (page === 'appointments') renderAppointments();
            if (page === 'calendar') renderCalendar();
            if (page === 'progress') renderProgress();
            if (page === 'finances') renderFinances();
            if (page === 'materials') renderMaterials();
            if (page === 'settings') renderSettings();
        });
    });
}

// ==================== THEME ====================
function initTheme() {
    const theme = appData.theme || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    document.getElementById('theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙';

    document.getElementById('theme-toggle').addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        document.getElementById('theme-toggle').textContent = next === 'dark' ? '☀️' : '🌙';
        appData.theme = next;
        saveData();
    });
}

// ==================== DASHBOARD ====================
function renderDashboard() {
    const today = new Date().toISOString().split('T')[0];
    const todayAppts = appData.appointments.filter(a => a.date === today && a.status !== 'cancelled');
    document.getElementById('today-count').textContent = todayAppts.length;
    document.getElementById('students-count').textContent = appData.students.length;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const monthIncome = appData.appointments
        .filter(a => a.date >= monthStart && a.paid)
        .reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0);
    document.getElementById('month-income').textContent = monthIncome.toFixed(0) + '€';

    const pending = appData.appointments
        .filter(a => a.status === 'completed' && !a.paid)
        .reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0);
    document.getElementById('pending-amount').textContent = pending.toFixed(0) + '€';

    const todayList = document.getElementById('today-appointments');
    todayList.innerHTML = todayAppts.length === 0
        ? '<p style="color:var(--text-secondary)">Δεν υπάρχουν ραντεβού σήμερα.</p>'
        : todayAppts.map(a => {
            const student = getStudentById(a.studentId);
            return `<div class="list-item">
                <div class="info">
                    <strong>${a.time || ''} - ${student ? student.name : 'Άγνωστος'}</strong>
                    <span>${a.subject || ''} • ${a.duration || 60} λεπτά</span>
                </div>
                <span class="status-badge status-${a.status}">${getStatusText(a.status)}</span>
            </div>`;
        }).join('');

    const weekLater = new Date();
    weekLater.setDate(weekLater.getDate() + 7);
    const weekLaterStr = weekLater.toISOString().split('T')[0];
    const upcoming = appData.appointments
        .filter(a => a.date > today && a.date <= weekLaterStr && a.status !== 'cancelled')
        .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));

    const upcomingList = document.getElementById('upcoming-appointments');
    upcomingList.innerHTML = upcoming.length === 0
        ? '<p style="color:var(--text-secondary)">Δεν υπάρχουν επερχόμενα ραντεβού.</p>'
        : upcoming.slice(0, 10).map(a => {
            const student = getStudentById(a.studentId);
            return `<div class="list-item">
                <div class="info">
                    <strong>${formatDate(a.date)} ${a.time || ''} - ${student ? student.name : 'Άγνωστος'}</strong>
                    <span>${a.subject || ''}</span>
                </div>
            </div>`;
        }).join('');
}

// ==================== STUDENTS ====================
function renderStudents() {
    const search = document.getElementById('student-search').value.toLowerCase();
    const filtered = appData.students.filter(s =>
        s.name.toLowerCase().includes(search) ||
        (s.phone || '').includes(search) ||
        (s.level || '').toLowerCase().includes(search)
    );

    const tbody = document.getElementById('students-tbody');
    tbody.innerHTML = filtered.length === 0
        ? '<tr><td colspan="6" style="text-align:center;color:var(--text-secondary)">Δεν βρέθηκαν μαθητές.</td></tr>'
        : filtered.map(s => `
            <tr>
                <td><strong>${esc(s.name)}</strong> ${studentAccounts.accounts.some(a => a.student_ref === s.id) ? '<span title="Έχει λογαριασμό μαθητή">🔑</span>' : ''}<br><small style="color:var(--text-secondary)">${esc(s.email || '')}</small></td>
                <td>${s.phone || '-'}</td>
                <td>${s.level || '-'}</td>
                <td>${(s.subjects || []).join(', ') || '-'}</td>
                <td>${s.rate || appData.settings.defaultRate}€</td>
                <td class="actions">
                    <button onclick="viewStudent('${s.id}')">Προβολή</button>
                    <button onclick="editStudent('${s.id}')">Επεξεργασία</button>
                    <button onclick="deleteStudent('${s.id}')" style="color:var(--danger)">Διαγραφή</button>
                </td>
            </tr>
        `).join('');
}

function openStudentModal(student = null) {
    const isEdit = !!student;
    document.getElementById('modal-title').textContent = isEdit ? 'Επεξεργασία Μαθητή' : 'Νέος Μαθητής';

    const subjects = getSubjects();
    const subjectOptions = subjects.map(sub => 
        `<option value="${sub}" ${student && student.subjects && student.subjects.includes(sub) ? 'selected' : ''}>${sub}</option>`
    ).join('');

    document.getElementById('modal-body').innerHTML = `
        <div class="form-group">
            <label>Όνομα *</label>
            <input type="text" id="s-name" value="${student?.name || ''}" required>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>Τηλέφωνο</label>
                <input type="tel" id="s-phone" value="${student?.phone || ''}">
            </div>
            <div class="form-group">
                <label>Email</label>
                <input type="email" id="s-email" value="${student?.email || ''}">
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>Τάξη / Επίπεδο</label>
                <input type="text" id="s-level" value="${student?.level || ''}" placeholder="π.χ. Γ' Λυκείου">
            </div>
            <div class="form-group">
                <label>Τιμή/ώρα (€)</label>
                <input type="number" id="s-rate" value="${student?.rate || appData.settings.defaultRate}" min="0" step="0.5">
            </div>
        </div>
        <div class="form-group">
            <label>Μαθήματα</label>
            <select id="s-subjects" multiple style="height:100px">
                ${subjectOptions}
            </select>
            <small style="color:var(--text-secondary)">Κράτα Ctrl/Cmd για πολλαπλή επιλογή</small>
        </div>
        <div class="form-group">
            <label>Σημειώσεις</label>
            <textarea id="s-notes">${student?.notes || ''}</textarea>
        </div>
    `;

    document.getElementById('modal-overlay').classList.remove('hidden');

    document.getElementById('modal-save').onclick = () => {
        const name = document.getElementById('s-name').value.trim();
        if (!name) {
            showToast('Το όνομα είναι υποχρεωτικό', 'error');
            return;
        }

        const subjectsSelect = document.getElementById('s-subjects');
        const selectedSubjects = Array.from(subjectsSelect.selectedOptions).map(o => o.value);

        const studentData = {
            name,
            phone: document.getElementById('s-phone').value.trim(),
            email: document.getElementById('s-email').value.trim(),
            level: document.getElementById('s-level').value.trim(),
            rate: parseFloat(document.getElementById('s-rate').value) || appData.settings.defaultRate,
            subjects: selectedSubjects,
            notes: document.getElementById('s-notes').value.trim()
        };

        if (isEdit) {
            Object.assign(student, studentData);
        } else {
            studentData.id = generateId();
            appData.students.push(studentData);
        }

        saveData();
        closeModal();
        renderStudents();
        renderDashboard();
        showToast(isEdit ? 'Ο μαθητής ενημερώθηκε' : 'Ο μαθητής προστέθηκε');
    };
}

function editStudent(id) {
    const student = getStudentById(id);
    if (student) openStudentModal(student);
}

function deleteStudent(id) {
    if (!confirm('Διαγραφή μαθητή; Θα διαγραφούν και όλα τα σχετικά ραντεβού.')) return;
    appData.students = appData.students.filter(s => s.id !== id);
    appData.appointments = appData.appointments.filter(a => a.studentId !== id);
    saveData().then(() => Promise.all([refreshStudentAccounts(), refreshMaterials()]));
    renderStudents();
    renderDashboard();
    showToast('Ο μαθητής διαγράφηκε');
}

function viewStudent(id) {
    const student = getStudentById(id);
    if (!student) return;

    const sessions = appData.appointments
        .filter(a => a.studentId === id)
        .sort((a, b) => b.date.localeCompare(a.date));

    const totalPaid = sessions.filter(a => a.paid).reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0);
    const totalPending = sessions.filter(a => a.status === 'completed' && !a.paid).reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0);
    const completed = sessions.filter(a => a.status === 'completed').length;

    document.getElementById('modal-title').textContent = student.name;
    document.getElementById('modal-body').innerHTML = `
        <div style="margin-bottom:1rem">
            <p><strong>Τηλέφωνο:</strong> ${student.phone || '-'}</p>
            <p><strong>Email:</strong> ${student.email || '-'}</p>
            <p><strong>Επίπεδο:</strong> ${student.level || '-'}</p>
            <p><strong>Τιμή:</strong> ${student.rate}€/ώρα</p>
            <p><strong>Μαθήματα:</strong> ${(student.subjects || []).join(', ') || '-'}</p>
            ${student.notes ? `<p><strong>Σημειώσεις:</strong> ${student.notes}</p>` : ''}
            <p style="margin-top:0.5rem"><strong>Ολοκληρωμένα:</strong> ${completed} | <strong>Πληρωμένα:</strong> ${totalPaid.toFixed(0)}€ | <strong>Εκκρεμή:</strong> ${totalPending.toFixed(0)}€</p>
        </div>
        <div id="student-account-box" style="background:var(--bg);padding:0.75rem;border-radius:8px;margin-bottom:1rem"></div>
        <h4>Ιστορικό μαθημάτων</h4>
        <div class="list" style="max-height:300px">
            ${sessions.length === 0 ? '<p>Δεν υπάρχουν καταγεγραμμένα μαθήματα.</p>' :
                sessions.map(a => `
                    <div class="list-item" style="flex-direction:column;align-items:flex-start">
                        <div style="display:flex;justify-content:space-between;width:100%">
                            <strong>${formatDate(a.date)} ${a.time || ''} - ${a.subject || ''}</strong>
                            <span class="status-badge status-${a.status}">${getStatusText(a.status)}</span>
                        </div>
                        ${a.lessonNotes ? `<p style="margin-top:0.4rem;font-size:0.9rem">${a.lessonNotes}</p>` : ''}
                        ${a.homework ? `<p style="font-size:0.85rem;color:var(--text-secondary)">Εργασία: ${a.homework}</p>` : ''}
                        <div style="margin-top:0.3rem;font-size:0.85rem">
                            ${a.duration || 60} λεπτά • ${a.amount || 0}€ • 
                            <span class="${a.paid ? 'paid-yes' : 'paid-no'}">${a.paid ? 'Πληρώθηκε' : 'Εκκρεμεί'}</span>
                        </div>
                    </div>
                `).join('')
            }
        </div>
    `;

    document.getElementById('modal-save').textContent = 'Κλείσιμο';
    document.getElementById('modal-save').onclick = closeModal;
    document.getElementById('modal-cancel').style.display = 'none';
    document.getElementById('modal-overlay').classList.remove('hidden');
    renderStudentAccountBox(student);
}

// ==================== APPOINTMENTS ====================
function renderAppointments() {
    const filterStudent = document.getElementById('filter-student');
    const currentVal = filterStudent.value;
    filterStudent.innerHTML = '<option value="">Όλοι οι μαθητές</option>' +
        appData.students.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    filterStudent.value = currentVal;

    const dateFilter = document.getElementById('filter-date').value;
    const statusFilter = document.getElementById('filter-status').value;
    const studentFilter = document.getElementById('filter-student').value;

    let filtered = appData.appointments.filter(a => {
        if (dateFilter && a.date !== dateFilter) return false;
        if (statusFilter && a.status !== statusFilter) return false;
        if (studentFilter && a.studentId !== studentFilter) return false;
        return true;
    }).sort((a, b) => b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || ''));

    const tbody = document.getElementById('appointments-tbody');
    tbody.innerHTML = filtered.length === 0
        ? '<tr><td colspan="8" style="text-align:center;color:var(--text-secondary)">Δεν βρέθηκαν ραντεβού.</td></tr>'
        : filtered.map(a => {
            const student = getStudentById(a.studentId);
            return `<tr>
                <td>${formatDate(a.date)}</td>
                <td>${a.time || '-'}</td>
                <td>${student ? student.name : 'Διαγραμμένος'}</td>
                <td>${a.subject || '-'}</td>
                <td>${a.duration || 60}'</td>
                <td><span class="status-badge status-${a.status}">${getStatusText(a.status)}</span></td>
                <td class="${a.paid ? 'paid-yes' : 'paid-no'}">${a.paid ? 'Ναι' : 'Όχι'} (${a.amount || 0}€)</td>
                <td class="actions">
                    <button onclick="editAppointment('${a.id}')">Επεξεργασία</button>
                    <button onclick="deleteAppointment('${a.id}')" style="color:var(--danger)">Διαγραφή</button>
                </td>
            </tr>`;
        }).join('');
}

function openAppointmentModal(appointment = null) {
    const isEdit = !!appointment;
    document.getElementById('modal-title').textContent = isEdit ? 'Επεξεργασία Ραντεβού' : 'Νέο Ραντεβού';

    const studentOptions = appData.students.map(s => 
        `<option value="${s.id}" ${appointment && appointment.studentId === s.id ? 'selected' : ''}>${s.name}</option>`
    ).join('');

    const subjects = getSubjects();
    const subjectOptions = subjects.map(sub => 
        `<option value="${sub}" ${appointment && appointment.subject === sub ? 'selected' : ''}>${sub}</option>`
    ).join('');

    const today = new Date().toISOString().split('T')[0];

    document.getElementById('modal-body').innerHTML = `
        <div class="form-row">
            <div class="form-group">
                <label>Ημερομηνία *</label>
                <input type="date" id="a-date" value="${appointment?.date || today}" required>
            </div>
            <div class="form-group">
                <label>Ώρα</label>
                <input type="time" id="a-time" value="${appointment?.time || '17:00'}">
            </div>
        </div>
        <div class="form-group">
            <label>Μαθητής *</label>
            <select id="a-student" required>
                <option value="">Επιλέξτε μαθητή</option>
                ${studentOptions}
            </select>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>Μάθημα</label>
                <select id="a-subject">
                    <option value="">--</option>
                    ${subjectOptions}
                </select>
            </div>
            <div class="form-group">
                <label>Διάρκεια (λεπτά)</label>
                <input type="number" id="a-duration" value="${appointment?.duration || 60}" min="15" step="15">
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>Κατάσταση</label>
                <select id="a-status">
                    <option value="scheduled" ${!appointment || appointment.status === 'scheduled' ? 'selected' : ''}>Προγραμματισμένο</option>
                    <option value="completed" ${appointment && appointment.status === 'completed' ? 'selected' : ''}>Ολοκληρωμένο</option>
                    <option value="cancelled" ${appointment && appointment.status === 'cancelled' ? 'selected' : ''}>Ακυρωμένο</option>
                </select>
            </div>
            <div class="form-group">
                <label>Ποσό (€)</label>
                <input type="number" id="a-amount" value="${appointment?.amount || ''}" min="0" step="0.5">
            </div>
        </div>
        <div class="form-group">
            <label style="display:flex;align-items:center;gap:0.5rem">
                <input type="checkbox" id="a-paid" ${appointment?.paid ? 'checked' : ''}>
                Πληρώθηκε
            </label>
        </div>
        ${!isEdit ? `
        <div class="form-group" style="background:var(--bg);padding:0.75rem;border-radius:8px;margin-top:0.5rem">
            <label style="display:flex;align-items:center;gap:0.5rem;font-weight:600">
                <input type="checkbox" id="a-recurring">
                Επαναλαμβανόμενο ραντεβού
            </label>
            <div id="recurring-options" style="display:none;margin-top:0.75rem">
                <div class="form-row">
                    <div class="form-group">
                        <label>Συχνότητα</label>
                        <select id="a-freq">
                            <option value="7">Κάθε εβδομάδα</option>
                            <option value="14">Κάθε 2 εβδομάδες</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Επαναλήψεις</label>
                        <input type="number" id="a-repeats" value="8" min="1" max="52">
                    </div>
                </div>
                <small style="color:var(--text-secondary)">Θα δημιουργηθούν επιπλέον ραντεβού με τις ίδιες ρυθμίσεις.</small>
            </div>
        </div>
        ` : ''}
        <div class="form-group">
            <label>Σημειώσεις μαθήματος (τι έγινε)</label>
            <textarea id="a-notes" placeholder="Τι διδάχθηκε, πρόοδος, παρατηρήσεις...">${appointment?.lessonNotes || ''}</textarea>
        </div>
        <div class="form-group">
            <label>Εργασία για το σπίτι</label>
            <textarea id="a-homework">${appointment?.homework || ''}</textarea>
        </div>
    `;

    // Auto amount
    const studentSelect = document.getElementById('a-student');
    const durationInput = document.getElementById('a-duration');
    const amountInput = document.getElementById('a-amount');

    function calcAmount() {
        if (amountInput.value && isEdit) return;
        const sid = studentSelect.value;
        if (!sid) return;
        const student = getStudentById(sid);
        const rate = student?.rate || appData.settings.defaultRate;
        const duration = parseInt(durationInput.value) || 60;
        amountInput.value = ((rate * duration) / 60).toFixed(1);
    }

    studentSelect.addEventListener('change', calcAmount);
    durationInput.addEventListener('input', calcAmount);
    if (!isEdit) calcAmount();

    // Recurring toggle
    if (!isEdit) {
        const recCheck = document.getElementById('a-recurring');
        const recOpts = document.getElementById('recurring-options');
        recCheck.addEventListener('change', () => {
            recOpts.style.display = recCheck.checked ? 'block' : 'none';
        });
    }

    document.getElementById('modal-overlay').classList.remove('hidden');

    document.getElementById('modal-save').onclick = () => {
        const date = document.getElementById('a-date').value;
        const studentId = document.getElementById('a-student').value;
        if (!date || !studentId) {
            showToast('Ημερομηνία και μαθητής είναι υποχρεωτικά', 'error');
            return;
        }

        const baseData = {
            time: document.getElementById('a-time').value,
            studentId,
            subject: document.getElementById('a-subject').value,
            duration: parseInt(document.getElementById('a-duration').value) || 60,
            status: document.getElementById('a-status').value,
            amount: parseFloat(document.getElementById('a-amount').value) || 0,
            paid: document.getElementById('a-paid').checked,
            lessonNotes: document.getElementById('a-notes').value.trim(),
            homework: document.getElementById('a-homework').value.trim()
        };

        if (isEdit) {
            Object.assign(appointment, { date, ...baseData });
        } else {
            // First appointment
            const first = { id: generateId(), date, ...baseData };
            appData.appointments.push(first);

            // Recurring
            const recCheck = document.getElementById('a-recurring');
            if (recCheck && recCheck.checked) {
                const freq = parseInt(document.getElementById('a-freq').value) || 7;
                const repeats = parseInt(document.getElementById('a-repeats').value) || 1;
                let current = new Date(date + 'T00:00:00');
                for (let i = 1; i <= repeats; i++) {
                    current.setDate(current.getDate() + freq);
                    const newDate = current.toISOString().split('T')[0];
                    appData.appointments.push({
                        id: generateId(),
                        date: newDate,
                        ...baseData,
                        status: 'scheduled',
                        paid: false,
                        lessonNotes: '',
                        homework: ''
                    });
                }
                showToast(`Δημιουργήθηκαν ${repeats + 1} ραντεβού`);
            } else {
                showToast('Το ραντεβού προστέθηκε');
            }
        }

        saveData();
        closeModal();
        renderAppointments();
        renderDashboard();
        if (isEdit) showToast('Το ραντεβού ενημερώθηκε');
    };
}

function editAppointment(id) {
    const appt = appData.appointments.find(a => a.id === id);
    if (appt) openAppointmentModal(appt);
}

function deleteAppointment(id) {
    if (!confirm('Διαγραφή ραντεβού;')) return;
    appData.appointments = appData.appointments.filter(a => a.id !== id);
    saveData();
    renderAppointments();
    renderDashboard();
    showToast('Το ραντεβού διαγράφηκε');
}

// ==================== CALENDAR ====================
let calYear, calMonth;

function initCalendar() {
    const now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();

    document.getElementById('cal-prev').addEventListener('click', () => {
        calMonth--;
        if (calMonth < 0) { calMonth = 11; calYear--; }
        renderCalendar();
    });
    document.getElementById('cal-next').addEventListener('click', () => {
        calMonth++;
        if (calMonth > 11) { calMonth = 0; calYear++; }
        renderCalendar();
    });
    document.getElementById('cal-today').addEventListener('click', () => {
        const n = new Date();
        calYear = n.getFullYear();
        calMonth = n.getMonth();
        renderCalendar();
    });
}

function renderCalendar() {
    const months = ['Ιανουάριος','Φεβρουάριος','Μάρτιος','Απρίλιος','Μάιος','Ιούνιος','Ιούλιος','Αύγουστος','Σεπτέμβριος','Οκτώβριος','Νοέμβριος','Δεκέμβριος'];
    document.getElementById('cal-title').textContent = `${months[calMonth]} ${calYear}`;

    const firstDay = new Date(calYear, calMonth, 1);
    let startDay = firstDay.getDay(); // 0=Sun
    startDay = startDay === 0 ? 6 : startDay - 1; // make Monday=0

    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const prevDays = new Date(calYear, calMonth, 0).getDate();

    const grid = document.getElementById('calendar-grid');
    grid.innerHTML = '';

    const todayStr = new Date().toISOString().split('T')[0];

    // Previous month days
    for (let i = startDay - 1; i >= 0; i--) {
        const day = prevDays - i;
        const d = new Date(calYear, calMonth - 1, day);
        const dateStr = d.toISOString().split('T')[0];
        grid.appendChild(createCalDay(dateStr, day, true, todayStr));
    }

    // Current month
    for (let day = 1; day <= daysInMonth; day++) {
        const d = new Date(calYear, calMonth, day);
        const dateStr = d.toISOString().split('T')[0];
        grid.appendChild(createCalDay(dateStr, day, false, todayStr));
    }

    // Next month to fill
    const totalCells = grid.children.length;
    const remaining = 42 - totalCells; // 6 weeks
    for (let day = 1; day <= remaining; day++) {
        const d = new Date(calYear, calMonth + 1, day);
        const dateStr = d.toISOString().split('T')[0];
        grid.appendChild(createCalDay(dateStr, day, true, todayStr));
    }
}

function createCalDay(dateStr, dayNum, otherMonth, todayStr) {
    const div = document.createElement('div');
    div.className = 'cal-day' + (otherMonth ? ' other-month' : '') + (dateStr === todayStr ? ' today' : '');
    div.innerHTML = `<div class="cal-day-num">${dayNum}</div>`;

    const events = appData.appointments
        .filter(a => a.date === dateStr && a.status !== 'cancelled')
        .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

    events.forEach(a => {
        const student = getStudentById(a.studentId);
        const name = student ? student.name.split(' ')[0] : '?';
        const ev = document.createElement('div');
        ev.className = 'cal-event' + (a.status === 'completed' ? ' completed' : '');
        ev.textContent = `${a.time || ''} ${name}`;
        ev.title = `${a.time || ''} - ${student ? student.name : ''} (${a.subject || ''})`;
        ev.onclick = () => editAppointment(a.id);
        div.appendChild(ev);
    });

    return div;
}

// ==================== PROGRESS ====================
let sessionsChart, incomeChart;

function renderProgress() {
    const total = appData.appointments.length;
    const completed = appData.appointments.filter(a => a.status === 'completed').length;
    document.getElementById('total-sessions').textContent = total;
    document.getElementById('completed-sessions').textContent = completed;

    // Prepare last 6 months data
    const months = [];
    const sessionCounts = [];
    const incomes = [];
    const now = new Date();

    for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const label = d.toLocaleDateString('el-GR', { month: 'short', year: '2-digit' });
        months.push(label);

        const start = d.toISOString().split('T')[0];
        const endDate = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        const end = endDate.toISOString().split('T')[0];

        const monthAppts = appData.appointments.filter(a => a.date >= start && a.date <= end);
        sessionCounts.push(monthAppts.filter(a => a.status === 'completed').length);
        incomes.push(monthAppts.filter(a => a.paid).reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0));
    }

    // Destroy previous charts if exist
    if (sessionsChart) sessionsChart.destroy();
    if (incomeChart) incomeChart.destroy();

    const ctx1 = document.getElementById('sessionsChart').getContext('2d');
    sessionsChart = new Chart(ctx1, {
        type: 'bar',
        data: {
            labels: months,
            datasets: [{
                label: 'Ολοκληρωμένα μαθήματα',
                data: sessionCounts,
                backgroundColor: '#4f46e5',
                borderRadius: 6
            }]
        },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
    });

    const ctx2 = document.getElementById('incomeChart').getContext('2d');
    incomeChart = new Chart(ctx2, {
        type: 'line',
        data: {
            labels: months,
            datasets: [{
                label: 'Εισπράξεις (€)',
                data: incomes,
                borderColor: '#10b981',
                backgroundColor: 'rgba(16,185,129,0.1)',
                fill: true,
                tension: 0.3
            }]
        },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
    });

    // Per student progress
    const list = document.getElementById('student-progress-list');
    const studentStats = appData.students.map(s => {
        const appts = appData.appointments.filter(a => a.studentId === s.id);
        const comp = appts.filter(a => a.status === 'completed').length;
        const paid = appts.filter(a => a.paid).reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0);
        return { name: s.name, completed: comp, total: appts.length, paid };
    }).filter(s => s.total > 0).sort((a, b) => b.completed - a.completed);

    list.innerHTML = studentStats.length === 0
        ? '<p style="color:var(--text-secondary)">Δεν υπάρχουν δεδομένα προόδου ακόμα.</p>'
        : studentStats.map(s => `
            <div class="list-item">
                <div class="info">
                    <strong>${s.name}</strong>
                    <span>${s.completed} ολοκληρωμένα από ${s.total} ραντεβού • ${s.paid.toFixed(0)}€</span>
                </div>
                <div style="width:80px;height:8px;background:var(--border);border-radius:4px;overflow:hidden">
                    <div style="width:${s.total ? (s.completed/s.total*100) : 0}%;height:100%;background:var(--success)"></div>
                </div>
            </div>
        `).join('');
}

// ==================== FINANCES ====================
function renderFinances() {
    const totalIncome = appData.appointments.filter(a => a.paid).reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0);
    const totalPending = appData.appointments.filter(a => a.status === 'completed' && !a.paid).reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0);

    document.getElementById('total-income').textContent = totalIncome.toFixed(0) + '€';
    document.getElementById('total-pending').textContent = totalPending.toFixed(0) + '€';

    const list = document.getElementById('finances-list');
    const items = appData.appointments
        .filter(a => a.status === 'completed' || a.paid)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 50);

    list.innerHTML = items.length === 0
        ? '<p style="color:var(--text-secondary)">Δεν υπάρχουν καταγραφές.</p>'
        : items.map(a => {
            const student = getStudentById(a.studentId);
            return `<div class="list-item">
                <div class="info">
                    <strong>${formatDate(a.date)} - ${student ? student.name : 'Άγνωστος'}</strong>
                    <span>${a.subject || ''} • ${a.amount || 0}€</span>
                </div>
                <span class="${a.paid ? 'paid-yes' : 'paid-no'}">${a.paid ? 'Πληρώθηκε' : 'Εκκρεμεί'}</span>
            </div>`;
        }).join('');
}

// ==================== SETTINGS ====================
function renderSettings() {
    document.getElementById('teacher-name').value = appData.settings.teacherName || '';
    document.getElementById('default-rate').value = appData.settings.defaultRate || 15;
    document.getElementById('subjects-list').value = appData.settings.subjects || '';
}

function initSettings() {
    document.getElementById('save-settings').addEventListener('click', () => {
        appData.settings.teacherName = document.getElementById('teacher-name').value.trim();
        appData.settings.defaultRate = parseFloat(document.getElementById('default-rate').value) || 15;
        appData.settings.subjects = document.getElementById('subjects-list').value.trim();
        saveData();
        showToast('Οι ρυθμίσεις αποθηκεύτηκαν');
    });

    document.getElementById('clear-data').addEventListener('click', () => {
        if (confirm('Σίγουρα θέλεις να διαγράψεις ΟΛΑ τα δεδομένα; Αυτή η ενέργεια δεν αναιρείται.')) {
            appData = defaultData();
            saveData().then(() => location.reload());
        }
    });
}

// ==================== IMPORT / EXPORT ====================
function initImportExport() {
    document.getElementById('export-btn').addEventListener('click', () => {
        const dataStr = JSON.stringify(appData, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `philologist-backup-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('Τα δεδομένα εξήχθησαν');
    });

    document.getElementById('import-btn').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const imported = JSON.parse(ev.target.result);
                    if (imported.students && imported.appointments) {
                        if (confirm('Εισαγωγή δεδομένων; Θα αντικαταστήσουν τα τρέχοντα.')) {
                            appData = { ...defaultData(), ...imported, settings: { ...defaultData().settings, ...(imported.settings || {}) } };
                            saveData().then(() => location.reload());
                        }
                    } else {
                        showToast('Μη έγκυρο αρχείο backup', 'error');
                    }
                } catch {
                    showToast('Σφάλμα ανάγνωσης αρχείου', 'error');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    });
}

// ==================== STUDENT ACCOUNTS (teacher side) ====================
function renderStudentAccountBox(student) {
    const box = document.getElementById('student-account-box');
    if (!box) return;
    const acct = studentAccounts.accounts.find(a => a.student_ref === student.id);
    const inv = studentAccounts.invites.find(i => i.student_ref === student.id);
    box.innerHTML = `
        <h4 style="margin-bottom:0.5rem">🔑 Λογαριασμός μαθητή (portal)</h4>
        ${acct ? `<p style="font-size:0.9rem">Ενεργός λογαριασμός: <strong>${esc(acct.email)}</strong></p>`
               : '<p style="font-size:0.9rem;color:var(--text-secondary)">Ο μαθητής δεν έχει ακόμα λογαριασμό.</p>'}
        <div class="form-row" style="margin-top:0.5rem">
            <div class="form-group"><label>Email σύνδεσης μαθητή</label><input type="email" id="acct-email" value="${esc(acct?.email || student.email || '')}"></div>
            <div class="form-group"><label>${acct ? 'Νέος κωδικός' : 'Κωδικός'} (8+)</label><input type="text" id="acct-pass" placeholder="π.χ. ${generatePassword()}"></div>
        </div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
            <button class="btn-primary" id="acct-save">${acct ? 'Αλλαγή στοιχείων' : 'Δημιουργία λογαριασμού'}</button>
            <button class="btn-secondary" id="acct-invite">Σύνδεσμος πρόσκλησης</button>
            ${acct ? '<button class="btn-danger" id="acct-delete">Κατάργηση λογαριασμού</button>' : ''}
        </div>
        <div id="acct-invite-out" style="margin-top:0.5rem;font-size:0.85rem;word-break:break-all">${inv ? `Ενεργή πρόσκληση: κωδικός <strong>${esc(inv.code)}</strong> — ${esc(location.origin)}/?invite=${esc(inv.code)}` : ''}</div>
    `;
    document.getElementById('acct-save').onclick = async () => {
        const email = document.getElementById('acct-email').value.trim();
        let password = document.getElementById('acct-pass').value.trim();
        if (!password) password = document.getElementById('acct-pass').placeholder.replace('π.χ. ', '');
        try {
            await api(`/api/students/${encodeURIComponent(student.id)}/account`, { method: 'POST', body: { email, password } });
            await refreshStudentAccounts();
            renderStudentAccountBox(student);
            renderStudents();
            document.getElementById('acct-invite-out').innerHTML = `Δώσε στον μαθητή: <strong>${esc(location.origin)}</strong> — email <strong>${esc(email)}</strong>, κωδικός <strong>${esc(password)}</strong>`;
            showToast('Ο λογαριασμός μαθητή αποθηκεύτηκε');
        } catch (e) { showToast(e.message, 'error'); }
    };
    document.getElementById('acct-invite').onclick = async () => {
        try {
            const r = await api(`/api/students/${encodeURIComponent(student.id)}/invite`, { method: 'POST' });
            await refreshStudentAccounts();
            document.getElementById('acct-invite-out').innerHTML = `Κωδικός πρόσκλησης <strong>${esc(r.code)}</strong> (ισχύει ${r.expiresInDays} ημέρες):<br><a href="${esc(r.link)}" target="_blank">${esc(r.link)}</a>`;
            try { await navigator.clipboard.writeText(r.link); showToast('Ο σύνδεσμος αντιγράφηκε'); } catch { /* ignore */ }
        } catch (e) { showToast(e.message, 'error'); }
    };
    const del = document.getElementById('acct-delete');
    if (del) del.onclick = async () => {
        if (!confirm('Κατάργηση του λογαριασμού μαθητή; Ο μαθητής δεν θα μπορεί να συνδεθεί.')) return;
        try {
            await api(`/api/students/${encodeURIComponent(student.id)}/account`, { method: 'DELETE' });
            await refreshStudentAccounts();
            renderStudentAccountBox(student);
            renderStudents();
            showToast('Ο λογαριασμός καταργήθηκε');
        } catch (e) { showToast(e.message, 'error'); }
    };
}

function generatePassword() {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const arr = new Uint32Array(10);
    crypto.getRandomValues(arr);
    return Array.from(arr, n => chars[n % chars.length]).join('');
}

// ==================== MATERIALS (notes / exercises) ====================
function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
function getLevels() { return [...new Set(appData.students.map(s => (s.level || '').trim()).filter(Boolean))]; }

function materialTargetText(m) {
    if (m.target_type === 'all') return 'Όλοι οι μαθητές';
    if (m.target_type === 'class') return 'Τάξη: ' + (m.class_label || '');
    const st = getStudentById(m.student_ref);
    return 'Μαθητής: ' + (st ? st.name : '—');
}

function materialHtml(m, teacherView) {
    return `<div class="list-item" style="flex-direction:column;align-items:flex-start">
        <div style="display:flex;justify-content:space-between;width:100%;gap:0.5rem">
            <strong>${m.kind === 'exercise' ? '✏️ Άσκηση' : '📄 Σημείωση'}: ${esc(m.title)}</strong>
            <span style="font-size:0.8rem;color:var(--text-secondary)">${new Date(m.created_at).toLocaleDateString('el-GR')}</span>
        </div>
        ${teacherView ? `<span style="font-size:0.8rem;color:var(--text-secondary)">${esc(materialTargetText(m))}</span>` : ''}
        ${m.due_date ? `<span style="font-size:0.85rem">Προθεσμία: <strong>${esc(formatDate(m.due_date))}</strong></span>` : ''}
        ${m.body ? `<p style="margin-top:0.4rem;font-size:0.9rem;white-space:pre-wrap">${esc(m.body)}</p>` : ''}
        ${(m.attachments || []).length ? `<div style="margin-top:0.4rem;display:flex;flex-wrap:wrap;gap:0.5rem">${m.attachments.map(f =>
            `<a href="/api/attachments/${f.id}" style="font-size:0.85rem">📎 ${esc(f.filename)} (${fmtSize(f.size)})</a>`).join('')}</div>` : ''}
        ${teacherView ? `<button class="btn-secondary" style="margin-top:0.5rem;font-size:0.8rem;color:var(--danger)" onclick="deleteMaterial(${m.id})">Διαγραφή</button>` : ''}
    </div>`;
}

function renderMaterials() {
    const sel = document.getElementById('mat-filter');
    const cur = sel.value;
    sel.innerHTML = '<option value="">Όλο το υλικό</option><option value="all">Για όλους</option>' +
        getLevels().map(l => `<option value="class:${esc(l)}">Τάξη: ${esc(l)}</option>`).join('') +
        appData.students.map(s => `<option value="student:${esc(s.id)}">Μαθητής: ${esc(s.name)}</option>`).join('');
    sel.value = cur;
    const f = sel.value;
    const list = materials.filter(m => {
        if (!f) return true;
        if (f === 'all') return m.target_type === 'all';
        if (f.startsWith('class:')) return m.target_type === 'class' && m.class_label === f.slice(6);
        if (f.startsWith('student:')) return m.target_type === 'student' && m.student_ref === f.slice(8);
        return true;
    });
    document.getElementById('materials-list').innerHTML = list.length === 0
        ? '<p style="color:var(--text-secondary)">Δεν υπάρχει αναρτημένο υλικό.</p>'
        : list.map(m => materialHtml(m, true)).join('');
}

function readFileB64(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] || '');
        r.onerror = reject;
        r.readAsDataURL(file);
    });
}

function openMaterialModal() {
    document.getElementById('modal-title').textContent = 'Νέα σημείωση / άσκηση';
    const levels = getLevels();
    document.getElementById('modal-body').innerHTML = `
        <div class="form-row">
            <div class="form-group">
                <label>Τύπος</label>
                <select id="m-kind"><option value="note">Σημείωση</option><option value="exercise">Άσκηση</option></select>
            </div>
            <div class="form-group">
                <label>Παραλήπτης</label>
                <select id="m-target">
                    <option value="student">Συγκεκριμένος μαθητής</option>
                    <option value="class">Τάξη / επίπεδο</option>
                    <option value="all">Όλοι οι μαθητές</option>
                </select>
            </div>
        </div>
        <div class="form-group" id="m-student-wrap">
            <label>Μαθητής</label>
            <select id="m-student"><option value="">Επιλέξτε μαθητή</option>${appData.students.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>
        </div>
        <div class="form-group" id="m-class-wrap" style="display:none">
            <label>Τάξη / επίπεδο (όπως στην καρτέλα μαθητή)</label>
            <input type="text" id="m-class" list="m-levels" placeholder="π.χ. Γ' Λυκείου">
            <datalist id="m-levels">${levels.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
        </div>
        <div class="form-group"><label>Τίτλος *</label><input type="text" id="m-title"></div>
        <div class="form-group"><label>Κείμενο</label><textarea id="m-body" style="min-height:120px" placeholder="Σημειώσεις, εκφώνηση άσκησης, οδηγίες..."></textarea></div>
        <div class="form-row">
            <div class="form-group"><label>Προθεσμία (προαιρετικά)</label><input type="date" id="m-due"></div>
            <div class="form-group"><label>Συνημμένα (έως 5 αρχεία, 5MB το καθένα)</label><input type="file" id="m-files" multiple></div>
        </div>
    `;
    const target = document.getElementById('m-target');
    target.onchange = () => {
        document.getElementById('m-student-wrap').style.display = target.value === 'student' ? '' : 'none';
        document.getElementById('m-class-wrap').style.display = target.value === 'class' ? '' : 'none';
    };
    document.getElementById('modal-overlay').classList.remove('hidden');
    const saveBtn = document.getElementById('modal-save');
    saveBtn.onclick = async () => {
        const files = Array.from(document.getElementById('m-files').files);
        if (files.length > 5) { showToast('Έως 5 αρχεία', 'error'); return; }
        const big = files.find(f => f.size > 5 * 1024 * 1024);
        if (big) { showToast(`Το ${big.name} ξεπερνά τα 5MB`, 'error'); return; }
        saveBtn.disabled = true;
        try {
            const attachments = await Promise.all(files.map(async f => ({ filename: f.name, mime: f.type, dataBase64: await readFileB64(f) })));
            const m = await api('/api/materials', { method: 'POST', body: {
                kind: document.getElementById('m-kind').value,
                targetType: target.value,
                studentRef: document.getElementById('m-student').value,
                classLabel: document.getElementById('m-class').value.trim(),
                title: document.getElementById('m-title').value.trim(),
                body: document.getElementById('m-body').value,
                dueDate: document.getElementById('m-due').value,
                attachments
            } });
            materials.unshift(m);
            closeModal();
            renderMaterials();
            showToast('Το υλικό αναρτήθηκε');
        } catch (e) {
            showToast(e.message, 'error');
        } finally { saveBtn.disabled = false; }
    };
}

async function deleteMaterial(id) {
    if (!confirm('Διαγραφή υλικού; Θα χαθεί και από το portal του μαθητή.')) return;
    try {
        await api(`/api/materials/${id}`, { method: 'DELETE' });
        materials = materials.filter(m => m.id !== id);
        renderMaterials();
        showToast('Διαγράφηκε');
    } catch (e) { showToast(e.message, 'error'); }
}

// ==================== STUDENT PORTAL ====================
let portalChart;
async function initPortal() {
    const theme = localStorage.getItem('fi-theme') || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    const tbtn = document.getElementById('portal-theme');
    tbtn.textContent = theme === 'dark' ? '☀️' : '🌙';
    tbtn.onclick = () => {
        const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        tbtn.textContent = next === 'dark' ? '☀️' : '🌙';
        localStorage.setItem('fi-theme', next);
    };
    document.querySelectorAll('#portal-app .portal-nav').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('#portal-app .portal-nav').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('#portal-app .page').forEach(p => p.classList.remove('active'));
            document.getElementById(btn.dataset.ppage).classList.add('active');
            document.getElementById('portal-title').textContent = btn.textContent.trim();
        };
    });
    document.getElementById('p-pw-save').onclick = async () => {
        try {
            await api('/api/auth/password', { method: 'POST', body: { current: document.getElementById('p-pw-cur').value, next: document.getElementById('p-pw-new').value } });
            document.getElementById('p-pw-cur').value = document.getElementById('p-pw-new').value = '';
            showToast('Ο κωδικός άλλαξε');
        } catch (e) { showToast(e.message, 'error'); }
    };

    let p;
    try { p = await api('/api/portal'); } catch (e) {
        document.getElementById('p-upcoming').innerHTML = `<p>${esc(e.message)}</p>`;
        return;
    }
    document.getElementById('portal-teacher').textContent = p.teacherName ? `Καθ.: ${p.teacherName}` : 'Portal μαθητή';
    document.getElementById('portal-title').textContent = `Γεια σου, ${p.student.name}!`;

    const today = new Date().toISOString().split('T')[0];
    const completed = p.appointments.filter(a => a.status === 'completed');
    const upcoming = p.appointments.filter(a => a.date >= today && a.status === 'scheduled')
        .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
    document.getElementById('p-completed').textContent = completed.length;
    document.getElementById('p-upcoming-count').textContent = upcoming.length;
    document.getElementById('p-materials-count').textContent = p.materials.length;

    document.getElementById('p-upcoming').innerHTML = upcoming.length === 0
        ? '<p style="color:var(--text-secondary)">Δεν υπάρχουν προγραμματισμένα μαθήματα.</p>'
        : upcoming.slice(0, 8).map(a => `<div class="list-item"><div class="info">
            <strong>${esc(formatDate(a.date))} ${esc(a.time || '')}</strong>
            <span>${esc(a.subject || '')} • ${esc(a.duration || 60)} λεπτά</span></div></div>`).join('');
    document.getElementById('p-recent').innerHTML = p.materials.length === 0
        ? '<p style="color:var(--text-secondary)">Δεν έχει αναρτηθεί υλικό ακόμα.</p>'
        : p.materials.slice(0, 3).map(m => materialHtml(m, false)).join('');
    document.getElementById('p-mat-list').innerHTML = p.materials.length === 0
        ? '<p style="color:var(--text-secondary)">Δεν έχει αναρτηθεί υλικό ακόμα.</p>'
        : p.materials.map(m => materialHtml(m, false)).join('');

    document.getElementById('p-appt-list').innerHTML = p.appointments.length === 0
        ? '<p style="color:var(--text-secondary)">Δεν υπάρχουν μαθήματα.</p>'
        : p.appointments.map(a => `<div class="list-item" style="flex-direction:column;align-items:flex-start">
            <div style="display:flex;justify-content:space-between;width:100%">
                <strong>${esc(formatDate(a.date))} ${esc(a.time || '')} - ${esc(a.subject || '')}</strong>
                <span class="status-badge status-${esc(a.status)}">${esc(getStatusText(a.status))}</span>
            </div>
            ${a.lessonNotes ? `<p style="margin-top:0.4rem;font-size:0.9rem">${esc(a.lessonNotes)}</p>` : ''}
            ${a.homework ? `<p style="font-size:0.85rem;color:var(--text-secondary)">Εργασία: ${esc(a.homework)}</p>` : ''}
            <div style="margin-top:0.3rem;font-size:0.85rem">${esc(a.duration || 60)} λεπτά • ${esc(a.amount || 0)}€ •
                <span class="${a.paid ? 'paid-yes' : 'paid-no'}">${a.paid ? 'Πληρώθηκε' : 'Εκκρεμεί'}</span></div>
        </div>`).join('');

    const total = p.appointments.filter(a => a.status !== 'cancelled').length;
    const homeworkCount = p.appointments.filter(a => a.homework).length;
    document.getElementById('p-progress').innerHTML = `
        <p style="margin-bottom:0.5rem">${completed.length} ολοκληρωμένα από ${total} μαθήματα • ${homeworkCount} εργασίες για το σπίτι</p>
        <div style="height:10px;background:var(--border);border-radius:5px;overflow:hidden;margin-bottom:1rem">
            <div style="width:${total ? (completed.length / total * 100) : 0}%;height:100%;background:var(--success)"></div>
        </div>`;
    const labels = [], counts = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        labels.push(d.toLocaleDateString('el-GR', { month: 'short', year: '2-digit' }));
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        counts.push(completed.filter(a => (a.date || '').startsWith(ym)).length);
    }
    if (window.Chart) {
        if (portalChart) portalChart.destroy();
        portalChart = new Chart(document.getElementById('pChart').getContext('2d'), {
            type: 'bar',
            data: { labels, datasets: [{ label: 'Μαθήματα', data: counts, backgroundColor: '#4f46e5', borderRadius: 6 }] },
            options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
        });
    }
}

// ==================== MODAL ====================
function closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('modal-save').textContent = 'Αποθήκευση';
    document.getElementById('modal-cancel').style.display = '';
    document.getElementById('modal-save').onclick = null;
}

function initModal() {
    document.querySelector('.close-modal').addEventListener('click', closeModal);
    document.getElementById('modal-cancel').addEventListener('click', closeModal);
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
        if (e.target.id === 'modal-overlay') closeModal();
    });
}

// ==================== INIT ====================
function initApp() {
    initNavigation();
    initTheme();
    initModal();
    initSettings();
    initImportExport();
    initCalendar();

    document.getElementById('add-student-btn').addEventListener('click', () => openStudentModal());
    document.getElementById('add-appointment-btn').addEventListener('click', () => openAppointmentModal());
    document.getElementById('add-material-btn').addEventListener('click', () => openMaterialModal());
    document.getElementById('mat-filter').addEventListener('change', renderMaterials);
    document.getElementById('student-search').addEventListener('input', renderStudents);

    document.getElementById('filter-date').addEventListener('change', renderAppointments);
    document.getElementById('filter-status').addEventListener('change', renderAppointments);
    document.getElementById('filter-student').addEventListener('change', renderAppointments);

    renderDashboard();
    renderStudents();
    renderAppointments();
    renderFinances();
    renderSettings();

    if (appData.settings.teacherName) {
        document.querySelector('#main-app .logo p').textContent = appData.settings.teacherName;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initAuth();
});

// Global functions
window.editStudent = editStudent;
window.deleteStudent = deleteStudent;
window.viewStudent = viewStudent;
window.editAppointment = editAppointment;
window.deleteAppointment = deleteAppointment;
window.deleteMaterial = deleteMaterial;