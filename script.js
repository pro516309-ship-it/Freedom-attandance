/**
 * MBBS Attendance Manager
 * Vanilla JavaScript
 * 
 * Features:
 * - Multi-session timetable data model with unique IDs & date-keyed attendance.
 * - Instant attendance tap cycling (unlocked) + 5s hold to toggle lock/unlock.
 * - Semester Timetable template builder (Sunday to Saturday day-by-day sub-timetables).
 * - Theory vs Practical class type option for each class (excluded for clinical postings).
 * - Standard 19 MBBS Subjects dropdown selector throughout the app.
 * - Clinical Timetable: posting rotations scheduler with active posting visible on Home Page.
 * - Replace Classes: date-specific subject substitutions, cancellations, and extra compensatory classes.
 * - Calculation and Storing of Attendance: Theory (75% NMC min), Practical (80% NMC min), and Clinical Postings (80%).
 * - Full Overview Attendance statistical dashboard with bunk margin and shortage recovery metrics.
 * - Modern, distraction-free minimalist mobile architecture.
 */

/* ==========================================================================
   STANDARD 19 MBBS SUBJECTS (NMC / MCI Curriculum)
   ========================================================================== */
const MBBS_19_SUBJECTS = [
  'Anatomy',
  'Physiology',
  'Biochemistry',
  'Pharmacology',
  'Pathology',
  'Microbiology',
  'Forensic Medicine (FMT)',
  'Community Medicine (PSM)',
  'Ophthalmology (Eye)',
  'ENT (Otorhinolaryngology)',
  'General Medicine',
  'General Surgery',
  'Obstetrics & Gynaecology (OBG)',
  'Pediatrics',
  'Orthopaedics',
  'Dermatology (Skin & VD)',
  'Psychiatry',
  'Respiratory Medicine (Pulmonology)',
  'Anaesthesiology'
];

function renderSubjectOptions(selectedSubject, includeClinicalOption = true) {
  const current = (selectedSubject || '').trim();
  let found = false;
  let html = `<option value="">-- Select Subject (19 MBBS Subjects) --</option>`;

  MBBS_19_SUBJECTS.forEach(subj => {
    const isSel = current.toLowerCase() === subj.toLowerCase();
    if (isSel) found = true;
    html += `<option value="${escapeHTML(subj)}" ${isSel ? 'selected' : ''}>${escapeHTML(subj)}</option>`;
  });

  if (includeClinicalOption) {
    const isClin = current.toLowerCase() === 'clinical posting';
    if (isClin) found = true;
    html += `<option value="Clinical Posting" ${isClin ? 'selected' : ''}>🏥 Clinical Posting (Dynamic)</option>`;
  }

  // Preserve existing custom subject if not in the standard 19
  if (current && !found) {
    html += `<option value="${escapeHTML(current)}" selected>${escapeHTML(current)}</option>`;
  }

  return html;
}

/* ==========================================================================
   1. STORAGE MODULE: ATTENDANCE RECORDS (mbbs_attendance_v1)
   ========================================================================== */
const AttendanceStorage = (() => {
  const STORAGE_KEY = 'mbbs_attendance_v1';
  const CURRENT_SCHEMA_VERSION = 1;

  function isStorageAvailable() {
    try {
      const probe = '__mbbs_storage_probe__';
      localStorage.setItem(probe, probe);
      localStorage.removeItem(probe);
      return true;
    } catch (e) {
      return false;
    }
  }

  function loadRootStore() {
    if (!isStorageAvailable()) {
      return { version: CURRENT_SCHEMA_VERSION, records: {} };
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { version: CURRENT_SCHEMA_VERSION, records: {} };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.records) {
        return { version: CURRENT_SCHEMA_VERSION, records: {} };
      }
      return parsed;
    } catch (err) {
      console.error('MBBS Attendance: Storage read error:', err);
      return { version: CURRENT_SCHEMA_VERSION, records: {} };
    }
  }

  function saveRootStore(store) {
    if (!isStorageAvailable()) {
      return { success: false, error: 'Storage unavailable: browser localStorage is restricted.' };
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      return { success: true };
    } catch (err) {
      console.error('MBBS Attendance: Storage save error:', err);
      let errorMsg = 'Failed to save attendance record locally.';
      if (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014) {
        errorMsg = 'Storage limit exceeded. Attendance could not be saved.';
      }
      return { success: false, error: errorMsg };
    }
  }

  function makeKey(dateStr, sessionId, semesterId) {
    if (semesterId) {
      return `${dateStr}::${semesterId}::${sessionId}`;
    }
    return `${dateStr}::${sessionId}`;
  }

  function getRecord(dateStr, sessionId, semesterId) {
    const store = loadRootStore();

    if (semesterId) {
      const semKey = `${dateStr}::${semesterId}::${sessionId}`;
      if (store.records[semKey]) return store.records[semKey];
    }

    const directKey = `${dateStr}::${sessionId}`;
    if (store.records[directKey]) return store.records[directKey];

    if (sessionId && sessionId.startsWith('tt_')) {
      const bareId = sessionId.substring(3);
      if (semesterId && store.records[`${dateStr}::${semesterId}::${bareId}`]) {
        return store.records[`${dateStr}::${semesterId}::${bareId}`];
      }
      if (store.records[`${dateStr}::${bareId}`]) return store.records[`${dateStr}::${bareId}`];
    } else if (sessionId) {
      const prefixed = 'tt_' + sessionId;
      if (semesterId && store.records[`${dateStr}::${semesterId}::${prefixed}`]) {
        return store.records[`${dateStr}::${semesterId}::${prefixed}`];
      }
      if (store.records[`${dateStr}::${prefixed}`]) return store.records[`${dateStr}::${prefixed}`];
    }

    return null;
  }

  function saveRecord({ date, sessionId, semesterId, subject, classType, startTime, endTime, status, isLocked }) {
    const store = loadRootStore();

    const validStates = ['unmarked', 'empty', 'holiday', 'present', 'absent'];
    let cleanStatus = validStates.includes(status) ? status : 'unmarked';
    if (cleanStatus === 'empty') cleanStatus = 'unmarked';

    const recordData = {
      date,
      sessionId,
      semesterId: semesterId || null,
      subject: subject || '',
      classType: classType || null, // 'theory' | 'practical' | null
      startTime: startTime || '',
      endTime: endTime || '',
      status: cleanStatus,
      isLocked: Boolean(isLocked),
      updatedAt: Date.now()
    };

    const primaryKey = makeKey(date, sessionId, semesterId);
    store.records[primaryKey] = recordData;

    // Also store under the short key for backward-compatible getRecord lookups,
    // but mark it as a duplicate so the calculator can skip it.
    if (semesterId) {
      const shortKey = `${date}::${sessionId}`;
      store.records[shortKey] = { ...recordData, _duplicateOf: primaryKey };
    }

    return saveRootStore(store);
  }

  function getAllRecords() {
    const store = loadRootStore();
    const records = store.records || {};
    const result = {};
    Object.keys(records).forEach(key => {
      const rec = records[key];
      if (!rec) return;
      // Skip duplicate short-key entries (marked by saveRecord or detected by key pattern)
      if (rec._duplicateOf) return;
      // Detect old-format duplicates: if key has no semesterId segment (exactly one "::" separator)
      // but a semesterId-prefixed version of the same record exists, skip this short key.
      const parts = key.split('::');
      if (parts.length === 2 && rec.semesterId) {
        const longKey = `${parts[0]}::${rec.semesterId}::${parts[1]}`;
        if (records[longKey]) return; // The long-key version exists, skip this duplicate
      }
      result[key] = rec;
    });
    return result;
  }

  // One-time migration: mark old duplicate short-key records with _duplicateOf
  function migrateDeduplicateRecords() {
    const store = loadRootStore();
    const records = store.records || {};
    let changed = false;
    Object.keys(records).forEach(key => {
      const rec = records[key];
      if (!rec || rec._duplicateOf) return;
      const parts = key.split('::');
      // Short key with 2 segments (date::sessionId) that also has a semesterId
      if (parts.length === 2 && rec.semesterId) {
        const longKey = `${parts[0]}::${rec.semesterId}::${parts[1]}`;
        if (records[longKey]) {
          records[key] = { ...rec, _duplicateOf: longKey };
          changed = true;
        }
      }
    });
    if (changed) {
      store.records = records;
      saveRootStore(store);
    }
  }

  return {
    isStorageAvailable,
    getRecord,
    saveRecord,
    getAllRecords,
    migrateDeduplicateRecords
  };
})();

/* ==========================================================================
   2. STORAGE MODULE: SEMESTER TIMETABLE TEMPLATES (mbbs_semesters_v1)
   ========================================================================== */
const SemesterStorage = (() => {
  const SEMESTERS_KEY = 'mbbs_semesters_v1';
  const ACTIVE_SEMESTER_KEY = 'mbbs_active_semester_v1';
  const CURRENT_SCHEMA_VERSION = 1;

  function loadSemestersStore() {
    if (!AttendanceStorage.isStorageAvailable()) {
      return { version: CURRENT_SCHEMA_VERSION, semesters: [] };
    }
    try {
      const raw = localStorage.getItem(SEMESTERS_KEY);
      if (!raw) return { version: CURRENT_SCHEMA_VERSION, semesters: [] };
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.semesters)) {
        return { version: CURRENT_SCHEMA_VERSION, semesters: [] };
      }
      return parsed;
    } catch (err) {
      console.error('MBBS Semester: Storage read error:', err);
      return { version: CURRENT_SCHEMA_VERSION, semesters: [] };
    }
  }

  function saveSemestersStore(store) {
    if (!AttendanceStorage.isStorageAvailable()) {
      return { success: false, error: 'Storage unavailable: localStorage is disabled.' };
    }
    try {
      localStorage.setItem(SEMESTERS_KEY, JSON.stringify(store));
      return { success: true };
    } catch (err) {
      console.error('MBBS Semester: Storage save error:', err);
      return { success: false, error: 'Failed to save semesters locally.' };
    }
  }

  function loadActiveInfo() {
    if (!AttendanceStorage.isStorageAvailable()) {
      return { version: CURRENT_SCHEMA_VERSION, currentSemesterId: null, activationHistory: [] };
    }
    try {
      const raw = localStorage.getItem(ACTIVE_SEMESTER_KEY);
      if (!raw) return { version: CURRENT_SCHEMA_VERSION, currentSemesterId: null, activationHistory: [] };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return { version: CURRENT_SCHEMA_VERSION, currentSemesterId: null, activationHistory: [] };
      }
      if (!Array.isArray(parsed.activationHistory)) {
        parsed.activationHistory = [];
      }
      return parsed;
    } catch (err) {
      console.error('MBBS Active Semester: Storage read error:', err);
      return { version: CURRENT_SCHEMA_VERSION, currentSemesterId: null, activationHistory: [] };
    }
  }

  function saveActiveInfo(info) {
    if (!AttendanceStorage.isStorageAvailable()) {
      return { success: false, error: 'Storage unavailable: localStorage is disabled.' };
    }
    try {
      localStorage.setItem(ACTIVE_SEMESTER_KEY, JSON.stringify(info));
      return { success: true };
    } catch (err) {
      console.error('MBBS Active Semester: Storage save error:', err);
      return { success: false, error: 'Failed to save active semester info.' };
    }
  }

  function getSemesters() {
    return loadSemestersStore().semesters;
  }

  function getSemesterById(id) {
    const list = getSemesters();
    return list.find(s => s.id === id) || null;
  }

  function saveSemester({ id, label, entries }) {
    const cleanLabel = (label || '').trim();
    if (!cleanLabel) {
      return { success: false, error: 'Semester label / name is required.' };
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      return { success: false, error: 'Add at least one class session to this semester.' };
    }

    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const REQUIRED_DAYS = [1, 2, 3, 4, 5, 6];

    const missingDays = REQUIRED_DAYS.filter(d =>
      !entries.some(e => Array.isArray(e.days) && e.days.includes(d) && (e.subject || '').trim())
    );

    if (missingDays.length > 0) {
      const missingNames = missingDays.map(d => DAY_NAMES[d]).join(', ');
      return {
        success: false,
        error: `Semester timetable must be filled from Monday to Saturday. Missing classes for: ${missingNames}.`
      };
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const subj = (entry.subject || '').trim();
      const dayNum = (Array.isArray(entry.days) && entry.days.length > 0) ? entry.days[0] : 1;
      const dayName = DAY_NAMES[dayNum] || `Day ${dayNum}`;

      if (!subj) {
        return { success: false, error: `${dayName}: Class subject name is required.` };
      }
      if (!entry.startTime || !entry.endTime) {
        return { success: false, error: `${dayName} (${subj}): Start and end times are required.` };
      }
      const sMin = timeToMinutes(entry.startTime);
      const eMin = timeToMinutes(entry.endTime);
      if (isNaN(sMin) || isNaN(eMin) || sMin >= eMin) {
        return { success: false, error: `${dayName} (${subj}): Start time must be strictly before end time.` };
      }
    }

    const store = loadSemestersStore();
    const now = Date.now();
    let semId = id;

    const cleanedEntries = entries.map((entry, idx) => {
      const subj = (entry.subject || '').trim();
      const isPosting = subj.toLowerCase() === 'clinical posting';
      const cleanType = isPosting ? null : (entry.classType === 'practical' ? 'practical' : 'theory');

      return {
        id: entry.id || `ent_${now}_${idx}_${Math.random().toString(36).substring(2, 7)}`,
        subject: subj,
        classType: cleanType,
        startTime: entry.startTime,
        endTime: entry.endTime,
        days: entry.days.map(d => parseInt(d, 10)).sort((a, b) => a - b),
        note: ''
      };
    });

    let isNew = false;
    if (semId) {
      const idx = store.semesters.findIndex(s => s.id === semId);
      if (idx >= 0) {
        store.semesters[idx] = {
          ...store.semesters[idx],
          label: cleanLabel,
          entries: cleanedEntries,
          updatedAt: now
        };
      } else {
        isNew = true;
      }
    } else {
      isNew = true;
    }

    if (isNew) {
      semId = `sem_${now}_${Math.random().toString(36).substring(2, 7)}`;
      store.semesters.push({
        id: semId,
        label: cleanLabel,
        entries: cleanedEntries,
        createdAt: now,
        updatedAt: now
      });
    }

    const saveRes = saveSemestersStore(store);
    if (!saveRes.success) return saveRes;

    const activeInfo = loadActiveInfo();
    if (!activeInfo.currentSemesterId || store.semesters.length === 1) {
      const todayISO = formatDateISO(new Date());
      activateSemester(semId, todayISO);
    }

    return { success: true, semesterId: semId };
  }

  function deleteSemester(id) {
    const activeInfo = loadActiveInfo();
    if (activeInfo.currentSemesterId === id) {
      return { success: false, error: 'Cannot delete the currently active semester.' };
    }
    const store = loadSemestersStore();
    store.semesters = store.semesters.filter(s => s.id !== id);
    return saveSemestersStore(store);
  }

  function activateSemester(semesterId, activationDateStr) {
    const sem = getSemesterById(semesterId);
    if (!sem) {
      return { success: false, error: 'Semester not found.' };
    }

    const todayISO = activationDateStr || formatDateISO(new Date());
    const activeInfo = loadActiveInfo();

    activeInfo.currentSemesterId = semesterId;
    activeInfo.activationHistory.push({
      semesterId,
      activationDate: todayISO,
      timestamp: Date.now()
    });

    return saveActiveInfo(activeInfo);
  }

  function getActiveSemester() {
    const activeInfo = loadActiveInfo();
    if (!activeInfo.currentSemesterId) return null;
    return getSemesterById(activeInfo.currentSemesterId);
  }

  function getSemesterForDate(targetDateStr) {
    const store = loadSemestersStore();
    if (store.semesters.length === 0) return null;

    const activeInfo = loadActiveInfo();
    if (!activeInfo.activationHistory || activeInfo.activationHistory.length === 0) {
      return getActiveSemester();
    }

    const eligible = activeInfo.activationHistory.filter(h => h.activationDate <= targetDateStr);
    if (eligible.length === 0) {
      return null;
    }

    eligible.sort((a, b) => {
      if (a.activationDate < b.activationDate) return -1;
      if (a.activationDate > b.activationDate) return 1;
      return (a.timestamp || 0) - (b.timestamp || 0);
    });

    const latestEvent = eligible[eligible.length - 1];
    return getSemesterById(latestEvent.semesterId);
  }

  function getActiveActivationDate(semesterId) {
    const activeInfo = loadActiveInfo();
    const history = activeInfo.activationHistory || [];
    const events = history.filter(h => h.semesterId === semesterId);
    if (events.length === 0) return null;
    return events[events.length - 1].activationDate;
  }

  function checkAndMigrateLegacyTimetable() {
    const semStore = loadSemestersStore();
    if (semStore.semesters.length > 0) return;

    try {
      const raw = localStorage.getItem('mbbs_timetable_v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.entries) && parsed.entries.length > 0) {
          const semId = `sem_migrated_${Date.now()}`;
          const migratedSem = {
            id: semId,
            label: 'Current Semester',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            entries: parsed.entries.map(e => ({
              ...e,
              classType: e.classType || 'theory'
            }))
          };
          semStore.semesters.push(migratedSem);
          saveSemestersStore(semStore);

          const activeInfo = {
            version: CURRENT_SCHEMA_VERSION,
            currentSemesterId: semId,
            activationHistory: [{
              semesterId: semId,
              activationDate: '2000-01-01',
              timestamp: Date.now()
            }]
          };
          saveActiveInfo(activeInfo);
        }
      }
    } catch (e) {
      console.warn('MBBS: Legacy migration skipped:', e);
    }
  }

  return {
    isStorageAvailable: AttendanceStorage.isStorageAvailable,
    getSemesters,
    getSemesterById,
    saveSemester,
    deleteSemester,
    activateSemester,
    getActiveSemester,
    getActiveInfo: loadActiveInfo,
    getActiveActivationDate,
    getSemesterForDate,
    checkAndMigrateLegacyTimetable
  };
})();

/* ==========================================================================
   3. STORAGE MODULE: CLINICAL TIMETABLE / POSTINGS (mbbs_clinical_postings_v1)
   ========================================================================== */
const ClinicalPostingStorage = (() => {
  const POSTINGS_KEY = 'mbbs_clinical_postings_v1';
  const CURRENT_SCHEMA_VERSION = 1;

  function loadPostingsStore() {
    if (!AttendanceStorage.isStorageAvailable()) {
      return { version: CURRENT_SCHEMA_VERSION, postings: [] };
    }
    try {
      const raw = localStorage.getItem(POSTINGS_KEY);
      if (!raw) return { version: CURRENT_SCHEMA_VERSION, postings: [] };
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.postings)) {
        return { version: CURRENT_SCHEMA_VERSION, postings: [] };
      }
      return parsed;
    } catch (err) {
      console.error('MBBS Clinical Postings: Storage read error:', err);
      return { version: CURRENT_SCHEMA_VERSION, postings: [] };
    }
  }

  function savePostingsStore(store) {
    if (!AttendanceStorage.isStorageAvailable()) {
      return { success: false, error: 'Storage unavailable: localStorage is disabled.' };
    }
    try {
      localStorage.setItem(POSTINGS_KEY, JSON.stringify(store));
      return { success: true };
    } catch (err) {
      console.error('MBBS Clinical Postings: Storage save error:', err);
      return { success: false, error: 'Failed to save clinical postings locally.' };
    }
  }

  function getPostings() {
    return loadPostingsStore().postings;
  }

  function getPostingById(id) {
    const list = getPostings();
    return list.find(p => p.id === id) || null;
  }

  function calculateDurationText(startDateStr, endDateStr) {
    const d1 = parseISODate(startDateStr);
    const d2 = parseISODate(endDateStr);
    const diffDays = Math.round((d2 - d1) / (1000 * 60 * 60 * 24)) + 1;
    if (diffDays <= 0) return '0 Days';
    const weeks = Math.round(diffDays / 7);
    if (weeks >= 1 && diffDays % 7 === 0) {
      return `${weeks} Week${weeks > 1 ? 's' : ''}`;
    }
    return `${diffDays} Day${diffDays > 1 ? 's' : ''}`;
  }

  function savePosting({ id, subject, startDate, endDate, startTime, endTime, unit }) {
    const cleanSubj = (subject || '').trim();
    if (!cleanSubj) {
      return { success: false, error: 'Please select a clinical posting department.' };
    }
    if (!startDate || !endDate) {
      return { success: false, error: 'Start date and End date are both required.' };
    }
    if (startDate > endDate) {
      return { success: false, error: 'Start date cannot be after End date.' };
    }

    const store = loadPostingsStore();
    const now = Date.now();
    let postingId = id;

    const postingData = {
      id: postingId || `post_${now}_${Math.random().toString(36).substring(2, 7)}`,
      subject: cleanSubj,
      startDate,
      endDate,
      startTime: startTime || '09:00',
      endTime: endTime || '12:00',
      unit: (unit || '').trim(),
      durationText: calculateDurationText(startDate, endDate),
      updatedAt: now
    };

    if (postingId) {
      const idx = store.postings.findIndex(p => p.id === postingId);
      if (idx >= 0) {
        store.postings[idx] = postingData;
      } else {
        store.postings.push(postingData);
      }
    } else {
      store.postings.push(postingData);
    }

    const saveRes = savePostingsStore(store);
    if (!saveRes.success) return saveRes;

    return { success: true, postingId: postingData.id };
  }

  function deletePosting(id) {
    const store = loadPostingsStore();
    store.postings = store.postings.filter(p => p.id !== id);
    return savePostingsStore(store);
  }

  function getActivePostingForDate(dateStr) {
    const list = getPostings();
    return list.find(p => p.startDate <= dateStr && dateStr <= p.endDate) || null;
  }

  function seedDefaultPostings() {
    const store = loadPostingsStore();
    if (store.postings.length > 0) return;

    const DEFAULT_SCHEDULE = [
      { subject: 'Community Medicine (PSM)', startDate: '2025-11-17', endDate: '2025-12-14', unit: '4 Weeks' },
      { subject: 'General Surgery', startDate: '2025-12-15', endDate: '2026-01-11', unit: '4 Weeks' },
      { subject: 'Obstetrics & Gynaecology (OBG)', startDate: '2026-01-12', endDate: '2026-02-08', unit: '4 Weeks' },
      { subject: 'General Medicine', startDate: '2026-02-09', endDate: '2026-03-08', unit: '4 Weeks' },
      { subject: 'Orthopaedics', startDate: '2026-03-16', endDate: '2026-04-12', unit: '4 Weeks' },
      { subject: 'General Surgery', startDate: '2026-04-13', endDate: '2026-05-17', unit: '5 Weeks' },
      { subject: 'General Surgery', startDate: '2026-06-01', endDate: '2026-06-07', unit: '1 Week' },
      { subject: 'Community Medicine (PSM)', startDate: '2026-06-15', endDate: '2026-07-12', unit: '4 Weeks' },
      { subject: 'General Medicine', startDate: '2026-07-13', endDate: '2026-08-23', unit: '6 Weeks' },
      { subject: 'Pediatrics', startDate: '2026-08-24', endDate: '2026-08-28', unit: '1 Week' },
      { subject: 'Pediatrics', startDate: '2026-09-07', endDate: '2026-10-11', unit: '5 Weeks' },
      { subject: 'General Medicine', startDate: '2026-10-12', endDate: '2026-11-15', unit: 'ID / Medicine (4 Weeks)' },
      { subject: 'Anaesthesiology', startDate: '2026-11-21', endDate: '2026-12-06', unit: '2 Weeks' },
      { subject: 'Dermatology (Skin & VD)', startDate: '2026-12-07', endDate: '2026-12-20', unit: '2 Weeks' }
    ];

    const now = Date.now();
    store.postings = DEFAULT_SCHEDULE.map((s, idx) => ({
      id: `post_init_${now}_${idx}`,
      subject: s.subject,
      startDate: s.startDate,
      endDate: s.endDate,
      startTime: '09:00',
      endTime: '12:00',
      unit: s.unit || '',
      durationText: calculateDurationText(s.startDate, s.endDate),
      updatedAt: now
    }));

    savePostingsStore(store);
  }

  return {
    getPostings,
    getPostingById,
    savePosting,
    deletePosting,
    getActivePostingForDate,
    seedDefaultPostings
  };
})();

/* ==========================================================================
   4. STORAGE MODULE: CLASS REPLACEMENTS / SUBSTITUTIONS (mbbs_class_replacements_v1)
   Manages date-specific substitutions, cancellations, and compensatory classes.
   ========================================================================== */
const ClassReplacementStorage = (() => {
  const STORAGE_KEY = 'mbbs_class_replacements_v1';
  const CURRENT_SCHEMA_VERSION = 1;

  function loadStore() {
    if (!AttendanceStorage.isStorageAvailable()) {
      return { version: CURRENT_SCHEMA_VERSION, dates: {} };
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { version: CURRENT_SCHEMA_VERSION, dates: {} };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.dates) {
        return { version: CURRENT_SCHEMA_VERSION, dates: {} };
      }
      return parsed;
    } catch (e) {
      console.error('MBBS Replacements Storage error:', e);
      return { version: CURRENT_SCHEMA_VERSION, dates: {} };
    }
  }

  function saveStore(store) {
    if (!AttendanceStorage.isStorageAvailable()) return { success: false };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      return { success: true };
    } catch (e) {
      return { success: false, error: 'Failed to save class replacement locally.' };
    }
  }

  function getReplacementsForDate(dateStr) {
    const store = loadStore();
    const dateData = store.dates[dateStr] || {};
    return {
      substitutions: dateData.substitutions || {},
      cancellations: Array.isArray(dateData.cancellations) ? dateData.cancellations : [],
      extraClasses: Array.isArray(dateData.extraClasses) ? dateData.extraClasses : []
    };
  }

  function setSubstitution(dateStr, sessionId, subData) {
    const store = loadStore();
    if (!store.dates[dateStr]) {
      store.dates[dateStr] = { substitutions: {}, cancellations: [], extraClasses: [] };
    }
    store.dates[dateStr].cancellations = (store.dates[dateStr].cancellations || []).filter(id => id !== sessionId);
    store.dates[dateStr].substitutions[sessionId] = {
      newSubject: subData.newSubject,
      classType: subData.classType || 'theory',
      startTime: subData.startTime,
      endTime: subData.endTime,
      note: (subData.note || '').trim(),
      originalSubject: subData.originalSubject || '',
      originalStartTime: subData.originalStartTime || '',
      originalEndTime: subData.originalEndTime || '',
      updatedAt: Date.now()
    };
    return saveStore(store);
  }

  function toggleCancellation(dateStr, sessionId) {
    const store = loadStore();
    if (!store.dates[dateStr]) {
      store.dates[dateStr] = { substitutions: {}, cancellations: [], extraClasses: [] };
    }
    const cancellations = store.dates[dateStr].cancellations || [];
    const isCurrentlyCancelled = cancellations.includes(sessionId);
    if (isCurrentlyCancelled) {
      store.dates[dateStr].cancellations = cancellations.filter(id => id !== sessionId);
    } else {
      store.dates[dateStr].cancellations.push(sessionId);
      if (store.dates[dateStr].substitutions && store.dates[dateStr].substitutions[sessionId]) {
        delete store.dates[dateStr].substitutions[sessionId];
      }
    }
    saveStore(store);
    return { success: true, isCancelled: !isCurrentlyCancelled };
  }

  function resetSessionToOriginal(dateStr, sessionId) {
    const store = loadStore();
    if (!store.dates[dateStr]) return { success: true };
    if (store.dates[dateStr].substitutions) {
      delete store.dates[dateStr].substitutions[sessionId];
    }
    if (store.dates[dateStr].cancellations) {
      store.dates[dateStr].cancellations = store.dates[dateStr].cancellations.filter(id => id !== sessionId);
    }
    return saveStore(store);
  }

  function addExtraClass(dateStr, { subject, classType, startTime, endTime, note }) {
    const store = loadStore();
    if (!store.dates[dateStr]) {
      store.dates[dateStr] = { substitutions: {}, cancellations: [], extraClasses: [] };
    }
    if (!store.dates[dateStr].extraClasses) store.dates[dateStr].extraClasses = [];
    const extra = {
      id: `extra_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      subject: (subject || '').trim(),
      classType: classType || 'theory',
      startTime: startTime || '14:00',
      endTime: endTime || '15:00',
      note: (note || '').trim()
    };
    store.dates[dateStr].extraClasses.push(extra);
    const res = saveStore(store);
    return { ...res, extra };
  }

  function deleteExtraClass(dateStr, extraId) {
    const store = loadStore();
    if (!store.dates[dateStr] || !store.dates[dateStr].extraClasses) return { success: true };
    store.dates[dateStr].extraClasses = store.dates[dateStr].extraClasses.filter(e => e.id !== extraId);
    return saveStore(store);
  }

  function getModifiedDates() {
    const store = loadStore();
    const dates = Object.keys(store.dates).filter(d => {
      const data = store.dates[d];
      const hasSub = data.substitutions && Object.keys(data.substitutions).length > 0;
      const hasCanc = data.cancellations && data.cancellations.length > 0;
      const hasExtra = data.extraClasses && data.extraClasses.length > 0;
      return hasSub || hasCanc || hasExtra;
    });
    return dates.sort();
  }

  return {
    getReplacementsForDate,
    setSubstitution,
    toggleCancellation,
    resetSessionToOriginal,
    addExtraClass,
    deleteExtraClass,
    getModifiedDates
  };
})();

/* ==========================================================================
   4B. STORAGE MODULE: ATTENDANCE HISTORY (mbbs_attendance_history_v1)
   Stores past college portal baseline attendance history per subject.
   ========================================================================== */
const AttendanceHistoryStorage = (() => {
  const STORAGE_KEY = 'mbbs_attendance_history_v1';
  const CURRENT_SCHEMA_VERSION = 1;

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { version: CURRENT_SCHEMA_VERSION, history: [] };
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.history)) {
        return { version: CURRENT_SCHEMA_VERSION, history: [] };
      }
      return parsed;
    } catch (e) {
      console.error('MBBS Attendance History storage error:', e);
      return { version: CURRENT_SCHEMA_VERSION, history: [] };
    }
  }

  function saveStore(store) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      return { success: true };
    } catch (e) {
      return { success: false, error: 'Failed to save attendance history locally.' };
    }
  }

  function getAllHistory() {
    return loadStore().history;
  }

  function getHistoryById(id) {
    return loadStore().history.find(h => h.id === id) || null;
  }

  function getHistoryBySubject(subject) {
    const list = loadStore().history;
    return list.find(h => h.subject.toLowerCase() === (subject || '').trim().toLowerCase()) || null;
  }

  function saveHistoryRecord(record) {
    const store = loadStore();
    const existingIndex = store.history.findIndex(h => h.id === record.id || h.subject.toLowerCase() === record.subject.toLowerCase());

    const totalHeld = Math.max(1, parseInt(record.totalHeld, 10) || 0);
    const attended = Math.min(totalHeld, Math.max(0, parseInt(record.attended, 10) || 0));
    const absent = Math.max(0, totalHeld - attended);
    const pct = Math.round((attended / totalHeld) * 1000) / 10;

    const cleanRecord = {
      id: record.id || `ah_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      subject: record.subject.trim(),
      totalHeld,
      attended,
      absent,
      percentage: pct,
      theoryHeld: parseInt(record.theoryHeld, 10) || 0,
      theoryAttended: parseInt(record.theoryAttended, 10) || 0,
      theoryPct: record.theoryPct != null && !isNaN(record.theoryPct) ? parseFloat(record.theoryPct) : null,
      practicalHeld: parseInt(record.practicalHeld, 10) || 0,
      practicalAttended: parseInt(record.practicalAttended, 10) || 0,
      practicalPct: record.practicalPct != null && !isNaN(record.practicalPct) ? parseFloat(record.practicalPct) : null,
      updatedAt: Date.now()
    };

    if (existingIndex >= 0) {
      cleanRecord.id = store.history[existingIndex].id;
      store.history[existingIndex] = cleanRecord;
    } else {
      store.history.push(cleanRecord);
    }

    const res = saveStore(store);
    return res.success ? { success: true, record: cleanRecord } : res;
  }

  function deleteHistoryRecord(id) {
    const store = loadStore();
    store.history = store.history.filter(h => h.id !== id);
    return saveStore(store);
  }

  return {
    getAllHistory,
    getHistoryById,
    getHistoryBySubject,
    saveHistoryRecord,
    deleteHistoryRecord
  };
})();

/**
 * Optimally partitions total classes held into Theory and Practical classes
 * by matching the user-supplied portal percentages against classes attended.
 *
 * Uses direct algebraic solution:
 *   rT * T + rP * (totalHeld - T) = totalAttended
 *   => T = (totalAttended - rP * totalHeld) / (rT - rP)
 *
 * When percentages are close (small rT-rP), the partition becomes very sensitive
 * to rounding, so we clamp practical to at least 15% of totalHeld (subjects
 * typically have weekly practicals) and recompute attended counts from the clamped
 * partition to preserve the user-entered percentages as closely as possible.
 */
function solveTheoryPracticalBreakdown(totalHeld, totalAttended, theoryPct, practicalPct) {
  totalHeld = Math.max(0, parseInt(totalHeld, 10) || 0);
  totalAttended = Math.min(totalHeld, Math.max(0, parseInt(totalAttended, 10) || 0));

  if (totalHeld === 0) {
    return { theoryHeld: 0, theoryAttended: 0, practicalHeld: 0, practicalAttended: 0 };
  }

  const hasT = theoryPct != null && !isNaN(theoryPct) && theoryPct >= 0 && theoryPct <= 100;
  const hasP = practicalPct != null && !isNaN(practicalPct) && practicalPct >= 0 && practicalPct <= 100;

  if (!hasT && !hasP) {
    return {
      theoryHeld: totalHeld,
      theoryAttended: totalAttended,
      practicalHeld: 0,
      practicalAttended: 0
    };
  }

  if (hasT && !hasP) {
    const tAtt = Math.min(totalAttended, Math.round(totalHeld * (theoryPct / 100)));
    return {
      theoryHeld: totalHeld,
      theoryAttended: tAtt,
      practicalHeld: 0,
      practicalAttended: 0
    };
  }

  if (!hasT && hasP) {
    const pAtt = Math.min(totalAttended, Math.round(totalHeld * (practicalPct / 100)));
    return {
      theoryHeld: 0,
      theoryAttended: 0,
      practicalHeld: totalHeld,
      practicalAttended: pAtt
    };
  }

  // Both percentages are supplied
  const rT = theoryPct / 100;
  const rP = practicalPct / 100;

  // If percentages are identical, can't distinguish — assign all to theory
  if (Math.abs(rT - rP) < 0.0001) {
    return {
      theoryHeld: totalHeld,
      theoryAttended: totalAttended,
      practicalHeld: 0,
      practicalAttended: 0
    };
  }

  // Direct algebraic solution for T (theory classes held)
  let solvedT = Math.round((totalAttended - rP * totalHeld) / (rT - rP));

  // Clamp to valid range
  solvedT = Math.max(0, Math.min(totalHeld, solvedT));
  let solvedP = totalHeld - solvedT;

  // Reasonableness check: if both percentages are provided, the user expects
  // a meaningful practical count. In MBBS, practicals are typically 1/week
  // over a year = ~40-60 classes, so practical should be at least ~15% of total.
  // If the solver gives an unreasonably low practical count due to close
  // percentages, clamp practical to a minimum floor.
  const MIN_PRACTICAL_FRACTION = 0.15; // at least 15% of total
  const minPractical = Math.max(1, Math.round(totalHeld * MIN_PRACTICAL_FRACTION));

  if (solvedP < minPractical && solvedP < totalHeld) {
    solvedP = Math.min(minPractical, totalHeld);
    solvedT = totalHeld - solvedP;
  }

  // Compute attended counts from the partition using the user's percentages
  let tAtt = Math.round(solvedT * rT);
  let pAtt = Math.round(solvedP * rP);

  // Clamp individual attended to their held values
  tAtt = Math.min(tAtt, solvedT);
  pAtt = Math.min(pAtt, solvedP);

  // Reconcile sum to strictly match totalAttended
  const sumAtt = tAtt + pAtt;
  if (sumAtt !== totalAttended) {
    const delta = totalAttended - sumAtt;
    if (delta > 0) {
      // Need more attended — add to whichever has room
      if (tAtt + delta <= solvedT) {
        tAtt += delta;
      } else {
        const rem = delta - (solvedT - tAtt);
        tAtt = solvedT;
        pAtt = Math.min(solvedP, pAtt + rem);
      }
    } else {
      // Need fewer attended — subtract from whichever can absorb
      if (tAtt + delta >= 0) {
        tAtt += delta;
      } else {
        const rem = delta + tAtt;
        tAtt = 0;
        pAtt = Math.max(0, pAtt + rem);
      }
    }
  }

  return {
    theoryHeld: solvedT,
    theoryAttended: tAtt,
    practicalHeld: solvedP,
    practicalAttended: pAtt
  };
}

/* ==========================================================================
   HELPERS
   ========================================================================== */
function timeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return NaN;
  const parts = timeStr.split(':');
  if (parts.length < 2) return NaN;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return NaN;
  return h * 60 + m;
}

function formatTime12h(timeStr) {
  if (!timeStr) return '';
  const parts = timeStr.split(':');
  if (parts.length < 2) return timeStr;
  let h = parseInt(parts[0], 10);
  const m = parts[1].padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

function escapeHTML(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseISODate(str) {
  if (!str) return new Date();
  const parts = str.split('-');
  if (parts.length === 3) {
    return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  }
  return new Date(str);
}

function formatDateDisplayShort(isoStr) {
  if (!isoStr) return '';
  const d = parseISODate(isoStr);
  const day = d.getDate();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function formatDateISO(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateDisplay(d) {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ==========================================================================
   4B. THEME MANAGER (Dark & Light Mode)
   ========================================================================== */
const ThemeManager = (() => {
  const THEME_KEY = 'mbbs_theme_v1';

  function getTheme() {
    try {
      return localStorage.getItem(THEME_KEY) || 'dark';
    } catch (_) {
      return 'dark';
    }
  }

  function applyTheme(theme) {
    const isLight = theme === 'light';
    if (isLight) {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (_) {}
    updateThemeUI(theme);
  }

  function toggleTheme() {
    const current = getTheme();
    const next = current === 'light' ? 'dark' : 'light';
    applyTheme(next);
    if (typeof showToast === 'function') {
      showToast(next === 'light' ? 'Switched to Light Mode' : 'Switched to Dark Mode');
    }
  }

  function updateThemeUI(theme) {
    const isLight = theme === 'light';
    const icon = document.getElementById('theme-icon');
    const desc = document.getElementById('theme-desc');
    if (icon) icon.textContent = isLight ? '☀️' : '🌙';
    if (desc) desc.textContent = isLight ? 'Light Mode' : 'Dark Mode';
  }

  function init() {
    const saved = getTheme();
    applyTheme(saved);
  }

  return {
    init,
    getTheme,
    applyTheme,
    toggleTheme,
    updateThemeUI
  };
})();

/* ==========================================================================
   5. APP STATE & INITIALIZATION
   ========================================================================== */
let activeDate = new Date();

function initClock() {
  const timeElem = document.getElementById('current-time');

  function updateClock() {
    const now = new Date();
    if (timeElem) {
      let hours = now.getHours();
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12;
      timeElem.textContent = `${hours}:${minutes} ${ampm}`;
    }
  }

  updateClock();
  setInterval(updateClock, 1000);
}

function initDateNavigation() {
  const dateValElem = document.getElementById('current-date');
  const dayValElem = document.getElementById('current-day');
  const prevBtn = document.getElementById('prev-date-btn');
  const nextBtn = document.getElementById('next-date-btn');
  const datePicker = document.getElementById('date-picker-input');
  const dateDisplayWrap = document.getElementById('date-display-wrap');

  // Normalize active date to noon to avoid daylight savings / timezone shift boundaries
  activeDate.setHours(12, 0, 0, 0);

  function updateDateHeader() {
    if (dateValElem) {
      dateValElem.textContent = formatDateDisplay(activeDate);
    }
    if (dayValElem) {
      dayValElem.textContent = WEEKDAYS[activeDate.getDay()];
    }
    if (datePicker) {
      datePicker.value = formatDateISO(activeDate);
    }
    loadAttendanceForDate(activeDate);
  }

  function openPicker() {
    if (!datePicker) return;
    try {
      if (typeof datePicker.showPicker === 'function') {
        datePicker.showPicker();
      } else {
        datePicker.focus();
        datePicker.click();
      }
    } catch (err) {
      datePicker.focus();
      datePicker.click();
    }
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      activeDate.setDate(activeDate.getDate() - 1);
      activeDate.setHours(12, 0, 0, 0);
      updateDateHeader();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      activeDate.setDate(activeDate.getDate() + 1);
      activeDate.setHours(12, 0, 0, 0);
      updateDateHeader();
    });
  }

  if (dateDisplayWrap) {
    dateDisplayWrap.addEventListener('click', (e) => {
      openPicker();
    });
    dateDisplayWrap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPicker();
      }
    });
  }

  if (datePicker) {
    datePicker.addEventListener('click', (e) => {
      e.stopPropagation();
      openPicker();
    });

    const handleDateSelect = () => {
      if (datePicker.value) {
        const parts = datePicker.value.split('-');
        if (parts.length === 3) {
          const y = parseInt(parts[0], 10);
          const m = parseInt(parts[1], 10) - 1;
          const d = parseInt(parts[2], 10);
          activeDate = new Date(y, m, d, 12, 0, 0);
          updateDateHeader();
        }
      }
    };

    datePicker.addEventListener('change', handleDateSelect);
    datePicker.addEventListener('input', handleDateSelect);
  }

  updateDateHeader();
}

/* ==========================================================================
   6. TIMETABLE RENDERER (Applies Semester, Clinical Rotation, & Replace Classes)
   ========================================================================== */
function loadAttendanceForDate(targetDate) {
  const dateStr = formatDateISO(targetDate);
  const dayIndex = targetDate.getDay();
  const timetableContainer = document.getElementById('timetable-boxes');
  const demoBanner = document.getElementById('demo-banner');

  if (!timetableContainer) return;

  // 1. Resolve Active Clinical Posting for today (if any)
  const activePosting = ClinicalPostingStorage.getActivePostingForDate(dateStr);

  // 2. Sunday is a holiday at home page
  if (dayIndex === 0) {
    if (demoBanner) demoBanner.classList.add('hidden');
    timetableContainer.innerHTML = `
      <div class="sunday-holiday-banner">
        <span class="sunday-icon">🏠</span>
        <span class="sunday-label">Sunday — Holiday</span>
        <span class="sunday-sub">Rest day at home. No classes scheduled.</span>
      </div>
    `;
    return;
  }

  // 3. Load date-specific class replacements (Substitutions, Cancellations, Extra Classes)
  const replacements = ClassReplacementStorage.getReplacementsForDate(dateStr);

  const allSemesters = SemesterStorage.getSemesters();
  if (allSemesters.length === 0) {
    // Unconfigured Demo Timetable Fallback
    if (demoBanner) demoBanner.classList.remove('hidden');

    const demoEntries = [
      { id: 'pediatric_0800_0900', subject: 'PEDIATRIC', startTime: '08:00 AM', endTime: '09:00 AM', classType: 'theory' },
      { id: 'clinical_posting_0900_1200', subject: activePosting ? `Clinical Posting (${activePosting.subject})` : 'Clinical posting', startTime: '09:00 AM', endTime: '12:00 PM', classType: null, isPosting: true },
      { id: 'surgery_1200_1300', subject: 'Surgery', startTime: '12:00 PM', endTime: '01:00 PM', classType: 'theory' }
    ];

    const processedDemo = [];
    demoEntries.forEach(entry => {
      const isCancelled = replacements.cancellations.includes(entry.id);
      const sub = replacements.substitutions[entry.id];

      if (isCancelled) {
        processedDemo.push({
          ...entry,
          isCancelled: true,
          subNote: 'Cancelled for today'
        });
      } else if (sub) {
        processedDemo.push({
          ...entry,
          subject: sub.newSubject,
          classType: sub.classType || entry.classType,
          startTime: formatTime12h(sub.startTime),
          endTime: formatTime12h(sub.endTime),
          isSubstituted: true,
          subNote: sub.note ? `Substituted: ${sub.note}` : `Substituted (originally ${entry.subject})`
        });
      } else {
        processedDemo.push(entry);
      }
    });

    timetableContainer.innerHTML = processedDemo.map(entry => {
      const noteHtml = entry.subNote ? `<span class="subject-note">${escapeHTML(entry.subNote)}</span>` : '';
      const cancelledStyle = entry.isCancelled ? 'text-decoration: line-through; opacity: 0.6;' : '';
      const isPosting = Boolean(entry.isPosting);

      let typeBadge = '';
      if (!isPosting && entry.classType) {
        const isPrac = entry.classType === 'practical';
        typeBadge = `<span class="class-type-badge ${isPrac ? 'badge-practical' : 'badge-theory'}">${isPrac ? 'Practical' : 'Theory'}</span>`;
      }

      return `
        <article class="class-box" 
          data-session-id="${entry.id}" 
          data-subject="${escapeHTML(entry.subject)}" 
          data-class-type="${entry.classType || ''}"
          data-start-time="${entry.startTime}" 
          data-end-time="${entry.endTime}" 
          data-state="empty" 
          data-locked="${entry.isCancelled ? 'true' : 'false'}" 
          role="button" 
          tabindex="0">
          <div class="unlock-progress-bar" aria-hidden="true"></div>
          <div class="lock-indicator" aria-hidden="true">
            <svg viewBox="0 0 24 24" class="lock-svg locked-svg"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
            <svg viewBox="0 0 24 24" class="lock-svg unlocked-svg"><path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5-2.28 0-4.27 1.54-4.84 3.75l1.93.52C14.47 3.86 15.66 3 17 3c1.66 0 3 1.34 3 3v2h-8c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2h-6z"/></svg>
            <span class="unlocked-badge">Unlocked</span>
          </div>
          <div class="box-content">
            <div class="box-main-info">
              <div class="subject-title-row">
                <span class="subject-title" style="${cancelledStyle}">${escapeHTML(entry.subject)}</span>
                ${typeBadge}
              </div>
              ${noteHtml}
            </div>
            <span class="subject-time">${entry.startTime} - ${entry.endTime}</span>
          </div>
        </article>
      `;
    }).join('');

  } else {
    // Configured Semester Timetable
    if (demoBanner) demoBanner.classList.add('hidden');

    const activeSem = SemesterStorage.getSemesterForDate(dateStr);
    const processedList = [];

    if (activeSem) {
      const scheduledEntries = activeSem.entries
        .filter(e => Array.isArray(e.days) && e.days.includes(dayIndex));

      // Process substitutions, cancellations, and extra sessions
      scheduledEntries.forEach(entry => {
        const isCancelled = replacements.cancellations.includes(entry.id);
        const sub = replacements.substitutions[entry.id];
        const isPosting = (entry.subject || '').toLowerCase() === 'clinical posting' || (entry.subject || '').toLowerCase().includes('clinic');
        const classType = isPosting ? null : (entry.classType || 'theory');

        if (isCancelled) {
          processedList.push({
            id: entry.id,
            semesterId: activeSem.id,
            subject: entry.subject,
            classType: classType,
            isPosting: isPosting,
            startTime: entry.startTime,
            endTime: entry.endTime,
            isCancelled: true,
            subNote: 'Cancelled for today'
          });
        } else if (sub) {
          const subIsPosting = (sub.newSubject || '').toLowerCase() === 'clinical posting';
          processedList.push({
            id: entry.id,
            semesterId: activeSem.id,
            subject: sub.newSubject,
            classType: subIsPosting ? null : (sub.classType || classType || 'theory'),
            isPosting: subIsPosting,
            startTime: sub.startTime || entry.startTime,
            endTime: sub.endTime || entry.endTime,
            isSubstituted: true,
            subNote: sub.note ? `Substituted: ${sub.note}` : `Substituted (originally ${entry.subject})`
          });
        } else {
          let displaySubject = entry.subject;
          let displaySubtext = '';

          if (isPosting) {
            if (activePosting) {
              displaySubject = `Clinical Posting (${activePosting.subject})`;
              if (activePosting.unit) displaySubtext = activePosting.unit;
            } else {
              displaySubject = 'Clinical Posting';
            }
          }

          processedList.push({
            id: entry.id,
            semesterId: activeSem.id,
            subject: displaySubject,
            classType: isPosting ? null : classType,
            isPosting: isPosting,
            startTime: entry.startTime,
            endTime: entry.endTime,
            isCancelled: false,
            isSubstituted: false,
            subNote: displaySubtext
          });
        }
      });
    }

    // Auto-inject active Clinical Posting if not already in today's schedule (rotations run Mon–Sat)
    if (activePosting && dayIndex !== 0) {
      const alreadyHasPosting = processedList.some(e => e.isPosting);
      if (!alreadyHasPosting) {
        const postingId = `clinical_posting_${activePosting.id}`;
        const isCancelled = replacements.cancellations.includes(postingId);
        const sub = replacements.substitutions[postingId];

        if (isCancelled) {
          processedList.push({
            id: postingId,
            semesterId: activeSem ? activeSem.id : 'clinical_rotations',
            subject: `Clinical Posting (${activePosting.subject})`,
            classType: null,
            isPosting: true,
            startTime: activePosting.startTime || '09:00',
            endTime: activePosting.endTime || '12:00',
            isCancelled: true,
            isSubstituted: false,
            subNote: 'Cancelled for today'
          });
        } else if (sub) {
          const subIsPosting = (sub.newSubject || '').toLowerCase() === 'clinical posting';
          processedList.push({
            id: postingId,
            semesterId: activeSem ? activeSem.id : 'clinical_rotations',
            subject: sub.newSubject,
            classType: subIsPosting ? null : (sub.classType || 'theory'),
            isPosting: subIsPosting,
            startTime: sub.startTime || activePosting.startTime || '09:00',
            endTime: sub.endTime || activePosting.endTime || '12:00',
            isCancelled: false,
            isSubstituted: true,
            subNote: sub.note ? `Substituted: ${sub.note}` : 'Substituted (originally Clinical Posting)'
          });
        } else {
          processedList.push({
            id: postingId,
            semesterId: activeSem ? activeSem.id : 'clinical_rotations',
            subject: `Clinical Posting (${activePosting.subject})`,
            classType: null,
            isPosting: true,
            startTime: activePosting.startTime || '09:00',
            endTime: activePosting.endTime || '12:00',
            isCancelled: false,
            isSubstituted: false,
            subNote: activePosting.unit || ''
          });
        }
      }
    }

    // Add Extra classes for today
    replacements.extraClasses.forEach(extra => {
      const extraIsPosting = (extra.subject || '').toLowerCase() === 'clinical posting';
      processedList.push({
        id: extra.id,
        semesterId: 'extra',
        subject: extra.subject,
        classType: extraIsPosting ? null : (extra.classType || 'theory'),
        isPosting: extraIsPosting,
        startTime: extra.startTime,
        endTime: extra.endTime,
        isCancelled: false,
        isSubstituted: false,
        isExtra: true,
        subNote: extra.note ? `Extra: ${extra.note}` : 'Extra / Compensatory Class'
      });
    });

    // Sort chronologically by start time
    processedList.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

    if (processedList.length === 0) {
      if (!activeSem) {
        timetableContainer.innerHTML = `
          <div class="tt-empty-msg">
            No active semester on ${formatDateDisplay(targetDate)}.<br>
            <span style="font-size:0.8rem; color:#64748b; margin-top:4px; display:inline-block;">(Semester timetables apply from their date of activation forward)</span>
          </div>
        `;
      } else {
        timetableContainer.innerHTML = `
          <div class="tt-empty-msg">
            No classes scheduled for ${WEEKDAYS[dayIndex]} in ${escapeHTML(activeSem.label)}.
          </div>
        `;
      }
      return;
    }

    timetableContainer.innerHTML = processedList.map(entry => {
      const formattedStart = formatTime12h(entry.startTime);
      const formattedEnd = formatTime12h(entry.endTime);
      const noteHtml = entry.subNote ? `<span class="subject-note">${escapeHTML(entry.subNote)}</span>` : '';
      const cancelledStyle = entry.isCancelled ? 'text-decoration: line-through; opacity: 0.6;' : '';
      const isPosting = Boolean(entry.isPosting);

      let typeBadge = '';
      if (!isPosting && entry.classType) {
        const isPrac = entry.classType === 'practical';
        typeBadge = `<span class="class-type-badge ${isPrac ? 'badge-practical' : 'badge-theory'}">${isPrac ? 'Practical' : 'Theory'}</span>`;
      }

      return `
        <article class="class-box" 
          data-session-id="${entry.id}" 
          data-semester-id="${entry.semesterId}"
          data-subject="${escapeHTML(entry.subject)}" 
          data-class-type="${entry.classType || ''}"
          data-start-time="${formattedStart}" 
          data-end-time="${formattedEnd}" 
          data-state="empty" 
          data-locked="${entry.isCancelled ? 'true' : 'false'}" 
          role="button" 
          tabindex="0" 
          aria-label="${escapeHTML(entry.subject)} Class Box">
          <div class="unlock-progress-bar" aria-hidden="true"></div>
          <div class="lock-indicator" aria-hidden="true">
            <svg viewBox="0 0 24 24" class="lock-svg locked-svg"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
            <svg viewBox="0 0 24 24" class="lock-svg unlocked-svg"><path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5-2.28 0-4.27 1.54-4.84 3.75l1.93.52C14.47 3.86 15.66 3 17 3c1.66 0 3 1.34 3 3v2h-8c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2h-6z"/></svg>
            <span class="unlocked-badge">Unlocked</span>
          </div>
          <div class="box-content">
            <div class="box-main-info">
              <div class="subject-title-row">
                <span class="subject-title" style="${cancelledStyle}">${escapeHTML(entry.subject)}</span>
                ${typeBadge}
              </div>
              ${noteHtml}
            </div>
            <span class="subject-time">${formattedStart} - ${formattedEnd}</span>
          </div>
        </article>
      `;
    }).join('');
  }

  // Bind state and interactions to all rendered cards
  const renderedBoxes = timetableContainer.querySelectorAll('.class-box');
  renderedBoxes.forEach(box => {
    const sessionId = box.getAttribute('data-session-id');
    const semesterId = box.getAttribute('data-semester-id');
    if (!sessionId) return;

    const record = AttendanceStorage.getRecord(dateStr, sessionId, semesterId);
    if (record) {
      const uiState = (record.status === 'unmarked' || !record.status) ? 'empty' : record.status;
      box.setAttribute('data-state', uiState);
      box.setAttribute('data-locked', record.isLocked ? 'true' : 'false');
    } else {
      box.setAttribute('data-state', 'empty');
      box.setAttribute('data-locked', 'false');
    }

    attachClassBoxInteraction(box);
  });
}

/* ==========================================================================
   7. ATTENDANCE INTERACTION
   ========================================================================== */
function showToast(message) {
  const toastElem = document.getElementById('status-toast');
  if (!toastElem) return;
  toastElem.textContent = message;
  toastElem.classList.add('show');
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => {
    toastElem.classList.remove('show');
  }, 2400);
}

function attachClassBoxInteraction(box) {
  if (box.dataset.hasAttendanceListener === 'true') return;
  box.dataset.hasAttendanceListener = 'true';

  const progressBar = box.querySelector('.unlock-progress-bar');
  const stateSequence = ['empty', 'holiday', 'present', 'absent'];

  let holdTimer = null;
  let holdAnimationId = null;
  let holdStartTime = 0;
  let isLongPressTriggered = false;
  let startX = 0;
  let startY = 0;
  const HOLD_DURATION = 5000;

  box.addEventListener('contextmenu', (e) => e.preventDefault());

  function resetHoldProgress() {
    if (holdTimer) clearTimeout(holdTimer);
    if (holdAnimationId) cancelAnimationFrame(holdAnimationId);
    holdTimer = null;
    holdAnimationId = null;
    box.classList.remove('holding');
    if (progressBar) progressBar.style.width = '0%';
  }

  function animateProgress() {
    const elapsed = Date.now() - holdStartTime;
    const progressPercent = Math.min(100, (elapsed / HOLD_DURATION) * 100);
    if (progressBar) progressBar.style.width = `${progressPercent}%`;
    if (elapsed < HOLD_DURATION) {
      holdAnimationId = requestAnimationFrame(animateProgress);
    }
  }

  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    startX = e.clientX;
    startY = e.clientY;
    isLongPressTriggered = false;

    box.classList.add('holding');
    holdStartTime = Date.now();
    holdAnimationId = requestAnimationFrame(animateProgress);

    holdTimer = setTimeout(() => {
      isLongPressTriggered = true;
      resetHoldProgress();

      const currentlyLocked = box.getAttribute('data-locked') === 'true';
      const newLockedState = !currentlyLocked;
      const currentState = box.getAttribute('data-state') || 'empty';

      box.setAttribute('data-locked', newLockedState ? 'true' : 'false');

      const dateStr = formatDateISO(activeDate);
      const sessionId = box.getAttribute('data-session-id');
      const semesterId = box.getAttribute('data-semester-id') || null;
      const subject = box.getAttribute('data-subject') || '';
      const classType = box.getAttribute('data-class-type') || null;
      const startTime = box.getAttribute('data-start-time') || '';
      const endTime = box.getAttribute('data-end-time') || '';

      const saveRes = AttendanceStorage.saveRecord({
        date: dateStr,
        sessionId,
        semesterId,
        subject,
        classType,
        startTime,
        endTime,
        status: currentState,
        isLocked: newLockedState
      });

      if (!saveRes.success) {
        showToast(saveRes.error);
      } else {
        if (newLockedState) {
          showToast('Session locked. Hold 5s to unlock.');
        } else {
          showToast('Session unlocked! Tap to cycle attendance.');
        }
      }

      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    }, HOLD_DURATION);
  });

  box.addEventListener('pointermove', (e) => {
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 12) {
      resetHoldProgress();
    }
  });

  box.addEventListener('pointerup', (e) => {
    resetHoldProgress();

    if (isLongPressTriggered) {
      isLongPressTriggered = false;
      return;
    }

    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 12) return;

    const isLocked = box.getAttribute('data-locked') === 'true';
    const currentState = box.getAttribute('data-state') || 'empty';

    if (isLocked) {
      box.classList.remove('shake-locked');
      void box.offsetWidth;
      box.classList.add('shake-locked');
      showToast('Locked. Hold 5 seconds to unlock.');
      return;
    }

    const currentIndex = stateSequence.indexOf(currentState);
    const nextIndex = (currentIndex + 1) % stateSequence.length;
    const nextState = stateSequence[nextIndex];

    const dateStr = formatDateISO(activeDate);
    const sessionId = box.getAttribute('data-session-id');
    const semesterId = box.getAttribute('data-semester-id') || null;
    const subject = box.getAttribute('data-subject') || '';
    const classType = box.getAttribute('data-class-type') || null;
    const startTime = box.getAttribute('data-start-time') || '';
    const endTime = box.getAttribute('data-end-time') || '';

    const saveRes = AttendanceStorage.saveRecord({
      date: dateStr,
      sessionId,
      semesterId,
      subject,
      classType,
      startTime,
      endTime,
      status: nextState === 'empty' ? 'unmarked' : nextState,
      isLocked: false
    });

    if (!saveRes.success) {
      showToast(saveRes.error);
      return;
    }

    box.setAttribute('data-state', nextState);
    box.setAttribute('data-locked', 'false');

    if (nextState === 'empty') {
      showToast('Unmarked (Empty)');
    } else {
      const labels = { holiday: 'Holiday (Yellow)', present: 'Present (Green)', absent: 'Absent (Red)' };
      showToast(`Marked ${labels[nextState]}`);
    }
  });

  box.addEventListener('pointercancel', resetHoldProgress);
  box.addEventListener('pointerleave', resetHoldProgress);
}

/* ==========================================================================
   8. SEMESTER TIMETABLE PANEL (With 19 MBBS Subjects & Theory / Practical Toggle)
   ========================================================================== */
function initSemesterTimetablePanel() {
  const panel = document.getElementById('semester-timetable-panel');
  if (!panel) return;

  const backBtn = document.getElementById('sem-panel-back-btn');
  const addNewBtn = document.getElementById('sem-add-new-btn');
  const importBtn = document.getElementById('sem-import-btn');
  const countSpan = document.getElementById('sem-count');
  const semestersContainer = document.getElementById('semesters-container');

  const listView = document.getElementById('sem-list-view');
  const editorView = document.getElementById('sem-editor-view');
  const editorTitle = document.getElementById('sem-editor-title');
  const semEditId = document.getElementById('sem-edit-id');
  const semLabelInput = document.getElementById('sem-label-input');
  const builderRowsContainer = document.getElementById('sem-builder-rows');
  const builderCountSpan = document.getElementById('sem-builder-count');
  const addRowBtn = document.getElementById('sem-builder-add-row-btn');
  const editorErrorMsg = document.getElementById('sem-editor-error-msg');
  const editorCancelBtn = document.getElementById('sem-editor-cancel-btn');
  const editorSaveBtn = document.getElementById('sem-editor-save-btn');

  const viewModal = document.getElementById('sem-view-modal');
  const viewModalBody = document.getElementById('sem-view-modal-body');
  const viewModalTitle = document.getElementById('sem-view-modal-title');
  const viewModalCloseBtn = document.getElementById('sem-view-modal-close-btn');
  const viewModalDismissBtn = document.getElementById('sem-view-modal-dismiss-btn');

  const activateModal = document.getElementById('sem-activate-modal');
  const activateSemName = document.getElementById('activate-sem-name');
  const activateSemDate = document.getElementById('activate-sem-date');
  const activateModalCloseBtn = document.getElementById('activate-modal-close-btn');
  const activateCancelBtn = document.getElementById('activate-cancel-btn');
  const activateConfirmBtn = document.getElementById('activate-confirm-btn');

  // Share Modal Elements
  const shareModal = document.getElementById('sem-share-modal');
  const shareSemName = document.getElementById('share-sem-name');
  const shareCodeTextarea = document.getElementById('share-code-textarea');
  const shareModalCloseBtn = document.getElementById('share-modal-close-btn');
  const shareModalCancelBtn = document.getElementById('share-modal-cancel-btn');
  const shareCopyBtn = document.getElementById('share-copy-btn');
  const shareSendBtn = document.getElementById('share-send-btn');

  // Import Modal Elements
  const importModal = document.getElementById('sem-import-modal');
  const importModalCloseBtn = document.getElementById('import-modal-close-btn');
  const importModalCancelBtn = document.getElementById('import-modal-cancel-btn');
  const semClipboardPasteBtn = document.getElementById('sem-clipboard-paste-btn');
  const importCodeInput = document.getElementById('sem-import-code-input');
  const importPreview = document.getElementById('sem-import-preview');
  const importLabelInput = document.getElementById('sem-import-label');
  const importSessionCount = document.getElementById('sem-import-session-count');
  const importSubjectsList = document.getElementById('sem-import-subjects-list');
  const importError = document.getElementById('sem-import-error');
  const importConfirmBtn = document.getElementById('import-confirm-btn');

  let pendingImportPayload = null;
  let pendingShareSemesterId = null;
  let pendingActivateSemesterId = null;
  let tempKeyCounter = 0;
  let builderRows = [];

  function createBlankRow(day = 1) {
    tempKeyCounter++;
    return {
      tempId: 'row_' + Date.now() + '_' + tempKeyCounter,
      id: '',
      subject: '',
      classType: 'theory', // 'theory' | 'practical'
      startTime: '08:00',
      endTime: '09:00',
      days: [day],
      note: ''
    };
  }

  function openPanel() {
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    showListView();
    renderSemesterList();
  }

  function closePanel() {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    hideAllModals();
  }

  window.openSemesterTimetablePanel = openPanel;

  if (backBtn) backBtn.addEventListener('click', () => {
    if (!editorView.classList.contains('hidden')) {
      showListView();
    } else {
      closePanel();
      loadAttendanceForDate(activeDate);
    }
  });

  function showListView() {
    listView.classList.remove('hidden');
    editorView.classList.add('hidden');
    hideAllModals();
    renderSemesterList();
  }

  function showEditorView(semesterId) {
    listView.classList.add('hidden');
    editorView.classList.remove('hidden');
    hideAllModals();

    if (semesterId) {
      const sem = SemesterStorage.getSemesterById(semesterId);
      if (!sem) { showListView(); return; }
      editorTitle.textContent = 'Edit Semester';
      semEditId.value = sem.id;
      semLabelInput.value = sem.label;
      builderRows = (sem.entries || []).map((e) => {
        tempKeyCounter++;
        return {
          tempId: 'row_' + Date.now() + '_' + tempKeyCounter,
          id: e.id || '',
          subject: e.subject || '',
          classType: e.classType || 'theory',
          startTime: e.startTime || '08:00',
          endTime: e.endTime || '09:00',
          days: Array.isArray(e.days) ? [...e.days] : [1],
          note: ''
        };
      });
    } else {
      editorTitle.textContent = 'Create Semester';
      semEditId.value = '';
      semLabelInput.value = '';
      builderRows = [1, 2, 3, 4, 5, 6].map(d => createBlankRow(d));
    }
    renderBuilderRows();
    if (addNewBtn) addNewBtn.classList.add('hidden');
  }

  function renderSemesterList() {
    const semesters = SemesterStorage.getSemesters();
    const activeInfo = SemesterStorage.getActiveInfo();
    const currentActiveSemId = activeInfo.currentSemesterId;

    if (countSpan) countSpan.textContent = semesters.length;
    if (addNewBtn) addNewBtn.classList.remove('hidden');

    if (!semestersContainer) return;

    if (semesters.length === 0) {
      semestersContainer.innerHTML = `
        <div class="tt-empty-msg">No semesters created yet. Tap <strong>+ New Semester</strong> to create one.</div>
      `;
      return;
    }

    semestersContainer.innerHTML = semesters.map(sem => {
      const isActive = sem.id === currentActiveSemId;
      const activationDate = SemesterStorage.getActiveActivationDate(sem.id);
      const sessionCount = Array.isArray(sem.entries) ? sem.entries.length : 0;
      const badge = isActive
        ? `<span class="active-badge">ACTIVE</span>`
        : `<span class="inactive-badge">INACTIVE</span>`;
      const activationInfo = activationDate
        ? (isActive ? `Activated: ${activationDate}` : `Last activated: ${activationDate}`)
        : 'Not yet activated';
      const deleteBtn = !isActive
        ? `<button type="button" class="sem-btn btn-del" data-sem-id="${sem.id}">Delete</button>`
        : '';
      const activateBtn = !isActive
        ? `<button type="button" class="sem-btn btn-activate" data-sem-id="${sem.id}" data-sem-label="${escapeHTML(sem.label)}">Activate</button>`
        : '';

      return `
        <div class="semester-card ${isActive ? 'active-sem' : ''}" data-sem-id="${sem.id}">
          <div class="sem-card-top">
            <span class="sem-card-title">${escapeHTML(sem.label)}</span>
            ${badge}
          </div>
          <div class="sem-card-meta">
            <div class="sem-meta-row">
              <span>Sessions</span>
              <span class="sem-meta-val">${sessionCount} weekly classes</span>
            </div>
            <div class="sem-meta-row">
              <span>${isActive ? 'Activated' : 'Status'}</span>
              <span class="sem-meta-val">${activationInfo}</span>
            </div>
          </div>
          <div class="sem-card-actions">
            <button type="button" class="sem-btn btn-view" data-sem-id="${sem.id}">View Timetable</button>
            <button type="button" class="sem-btn" data-sem-edit-id="${sem.id}">Edit</button>
            <button type="button" class="sem-btn btn-share" data-sem-share-id="${sem.id}">🔗 Share</button>
            ${activateBtn}
            ${deleteBtn}
          </div>
        </div>
      `;
    }).join('');

    semestersContainer.querySelectorAll('.btn-view').forEach(btn => {
      btn.addEventListener('click', () => openViewModal(btn.getAttribute('data-sem-id')));
    });
    semestersContainer.querySelectorAll('.btn-share').forEach(btn => {
      btn.addEventListener('click', () => openShareModal(btn.getAttribute('data-sem-share-id')));
    });
    semestersContainer.querySelectorAll('[data-sem-edit-id]').forEach(btn => {
      btn.addEventListener('click', () => showEditorView(btn.getAttribute('data-sem-edit-id')));
    });
    semestersContainer.querySelectorAll('.btn-activate').forEach(btn => {
      btn.addEventListener('click', () => openActivateModal(
        btn.getAttribute('data-sem-id'),
        btn.getAttribute('data-sem-label')
      ));
    });
    semestersContainer.querySelectorAll('.btn-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-sem-id');
        const sem = SemesterStorage.getSemesterById(id);
        if (!sem) return;
        if (confirm(`Delete "${sem.label}"? This only removes the template. Your attendance records are preserved.`)) {
          const res = SemesterStorage.deleteSemester(id);
          if (!res.success) {
            showToast(res.error);
          } else {
            showToast(`"${sem.label}" deleted.`);
            renderSemesterList();
            loadAttendanceForDate(activeDate);
          }
        }
      });
    });
  }

  const DAY_FULL_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function renderBuilderRows() {
    if (!builderRowsContainer) return;

    if (addRowBtn) addRowBtn.style.display = 'none';

    const byDay = {};
    for (let d = 0; d <= 6; d++) byDay[d] = [];
    builderRows.forEach(row => {
      const day = (Array.isArray(row.days) && row.days.length > 0) ? row.days[0] : 1;
      if (byDay[day]) {
        byDay[day].push(row);
      } else {
        byDay[1].push(row);
      }
    });

    for (let d = 0; d <= 6; d++) {
      byDay[d].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    }

    const totalMonSatCount = [1, 2, 3, 4, 5, 6].reduce((sum, d) => sum + byDay[d].length, 0);
    if (builderCountSpan) builderCountSpan.textContent = totalMonSatCount;

    builderRowsContainer.innerHTML = [0, 1, 2, 3, 4, 5, 6].map(d => {
      if (d === 0) {
        return `
          <div class="sem-day-section sem-day-sunday" data-day="0">
            <div class="sem-day-header">
              <span class="sem-day-label">Sunday</span>
              <span class="sem-day-holiday-badge">Holiday</span>
            </div>
            <p class="sem-day-holiday-note">Rest day at home — no classes on Sundays</p>
          </div>
        `;
      }

      const sessions = byDay[d];
      const hasSessions = sessions.length > 0;

      const sessionsHtml = sessions.length === 0
        ? `<div class="sem-day-empty-hint" style="font-size:0.75rem; color:#64748b; font-style:italic; padding:6px 4px;">No classes added yet for ${DAY_FULL_NAMES[d]}. Tap "+ Add" below.</div>`
        : sessions.map(row => {
          const isPosting = (row.subject || '').toLowerCase() === 'clinical posting';
          const classType = isPosting ? null : (row.classType || 'theory');

          return `
            <div class="sem-session-row" data-day="${d}" data-temp-id="${row.tempId}">
              <select class="tt-input sem-sess-subject" required>
                ${renderSubjectOptions(row.subject, true)}
              </select>

              <!-- Theory vs Practical Toggle (Excluded for Clinical Posting) -->
              <div class="sem-sess-type-row" style="${isPosting ? 'display:none;' : 'display:flex;'}">
                <span class="sem-type-label">Class Type:</span>
                <div class="sem-type-toggle">
                  <button type="button" class="sem-type-btn ${classType !== 'practical' ? 'active' : ''}" data-type="theory">Theory</button>
                  <button type="button" class="sem-type-btn ${classType === 'practical' ? 'active' : ''}" data-type="practical">Practical</button>
                </div>
              </div>

              <div class="sem-sess-times">
                <input type="time" class="tt-input sem-sess-start" value="${row.startTime || '08:00'}" required>
                <span class="sem-time-sep">–</span>
                <input type="time" class="tt-input sem-sess-end" value="${row.endTime || '09:00'}" required>
                <button type="button" class="sem-sess-del-btn" data-del-temp-id="${row.tempId}" aria-label="Remove session">&times;</button>
              </div>
            </div>
          `;
        }).join('');

      return `
        <div class="sem-day-section ${hasSessions ? 'has-sessions' : 'no-sessions'}" data-day="${d}">
          <div class="sem-day-header">
            <span class="sem-day-label">${DAY_FULL_NAMES[d]}</span>
            <span class="sem-day-count">${sessions.length} class${sessions.length !== 1 ? 'es' : ''}</span>
            <button type="button" class="sem-day-add-btn" data-add-day="${d}">+ Add</button>
          </div>
          <div class="sem-day-sessions-list">${sessionsHtml}</div>
        </div>
      `;
    }).join('');

    // Wire Add button per day
    builderRowsContainer.querySelectorAll('.sem-day-add-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        syncRowsFromDOM();
        const day = parseInt(btn.getAttribute('data-add-day'), 10);
        builderRows.push(createBlankRow(day));
        renderBuilderRows();
        const sec = builderRowsContainer.querySelector(`.sem-day-section[data-day="${day}"]`);
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });

    // Wire Remove buttons
    builderRowsContainer.querySelectorAll('.sem-sess-del-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        syncRowsFromDOM();
        const delTempId = btn.getAttribute('data-del-temp-id');
        builderRows = builderRows.filter(r => r.tempId !== delTempId);
        renderBuilderRows();
      });
    });

    // Wire Theory / Practical Toggle buttons
    builderRowsContainer.querySelectorAll('.sem-type-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const rowEl = btn.closest('.sem-session-row');
        if (!rowEl) return;
        const tempId = rowEl.getAttribute('data-temp-id');
        const selectedType = btn.getAttribute('data-type');
        rowEl.querySelectorAll('.sem-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const rowObj = builderRows.find(r => r.tempId === tempId);
        if (rowObj) rowObj.classType = selectedType;
      });
    });

    // Wire Subject Select changes (dynamically toggle Theory/Practical row for Clinical Posting)
    builderRowsContainer.querySelectorAll('.sem-sess-subject').forEach(sel => {
      sel.addEventListener('change', () => {
        const rowEl = sel.closest('.sem-session-row');
        if (!rowEl) return;
        const tempId = rowEl.getAttribute('data-temp-id');
        const isPost = (sel.value || '').toLowerCase() === 'clinical posting';
        const typeRow = rowEl.querySelector('.sem-sess-type-row');
        if (typeRow) {
          typeRow.style.display = isPost ? 'none' : 'flex';
        }
        const rowObj = builderRows.find(r => r.tempId === tempId);
        if (rowObj) {
          rowObj.subject = sel.value;
          if (isPost) {
            rowObj.classType = null;
          } else if (!rowObj.classType) {
            rowObj.classType = 'theory';
          }
        }
      });
    });
  }

  function syncRowsFromDOM() {
    if (!builderRowsContainer) return;
    const newRows = [];
    for (let d = 1; d <= 6; d++) {
      const sec = builderRowsContainer.querySelector(`.sem-day-section[data-day="${d}"]`);
      if (!sec) continue;
      sec.querySelectorAll('.sem-session-row').forEach(rowEl => {
        const subjEl = rowEl.querySelector('.sem-sess-subject');
        const startEl = rowEl.querySelector('.sem-sess-start');
        const endEl = rowEl.querySelector('.sem-sess-end');
        const tempId = rowEl.getAttribute('data-temp-id') || ('row_' + Date.now() + '_' + Math.random());
        const existing = builderRows.find(r => r.tempId === tempId);

        const subjVal = subjEl ? subjEl.value : '';
        const isPosting = subjVal.toLowerCase() === 'clinical posting';
        const activeTypeBtn = rowEl.querySelector('.sem-type-btn.active');
        const classType = isPosting ? null : (activeTypeBtn ? activeTypeBtn.getAttribute('data-type') : (existing ? existing.classType : 'theory'));

        newRows.push({
          tempId: tempId,
          id: existing ? existing.id : '',
          subject: subjVal,
          classType: classType,
          startTime: startEl ? startEl.value : '08:00',
          endTime: endEl ? endEl.value : '09:00',
          days: [d],
          note: ''
        });
      });
    }
    builderRows = newRows;
  }

  if (addNewBtn) {
    addNewBtn.addEventListener('click', () => showEditorView(null));
  }

  if (addRowBtn) {
    addRowBtn.style.display = 'none';
  }

  if (editorCancelBtn) {
    editorCancelBtn.addEventListener('click', () => {
      showListView();
      if (addNewBtn) addNewBtn.classList.remove('hidden');
    });
  }

  if (editorSaveBtn) {
    editorSaveBtn.addEventListener('click', () => {
      syncRowsFromDOM();

      if (editorErrorMsg) {
        editorErrorMsg.classList.add('hidden');
        editorErrorMsg.textContent = '';
      }

      const label = semLabelInput ? semLabelInput.value.trim() : '';
      if (!label) {
        if (editorErrorMsg) {
          editorErrorMsg.textContent = 'Semester label / name is required (e.g. Semester 4).';
          editorErrorMsg.classList.remove('hidden');
        }
        return;
      }

      const id = semEditId ? semEditId.value : '';
      const res = SemesterStorage.saveSemester({
        id: id || null,
        label,
        entries: builderRows
      });

      if (!res.success) {
        if (editorErrorMsg) {
          editorErrorMsg.textContent = res.error;
          editorErrorMsg.classList.remove('hidden');
        }
        return;
      }

      showToast(`"${label}" saved successfully.`);
      showListView();
      if (addNewBtn) addNewBtn.classList.remove('hidden');
      loadAttendanceForDate(activeDate);
    });
  }

  function openViewModal(semesterId) {
    const sem = SemesterStorage.getSemesterById(semesterId);
    if (!sem || !viewModal) return;

    if (viewModalTitle) viewModalTitle.textContent = `${sem.label} — Weekly Timetable`;

    const dayOrder = [0, 1, 2, 3, 4, 5, 6];
    const html = dayOrder.map(di => {
      if (di === 0) {
        return `
          <div class="preview-day-card">
            <div class="preview-day-header">Sunday</div>
            <div class="preview-day-sessions">
              <div class="preview-no-classes" style="color:#facc15; font-style:normal;">Holiday — Rest Day (No classes)</div>
            </div>
          </div>
        `;
      }

      const sessions = (sem.entries || [])
        .filter(e => Array.isArray(e.days) && e.days.includes(di))
        .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

      const sessionHtml = sessions.length === 0
        ? `<div class="preview-no-classes">No classes</div>`
        : sessions.map(s => {
          const isPosting = (s.subject || '').toLowerCase() === 'clinical posting';
          const typeBadge = (!isPosting && s.classType)
            ? `<span class="sem-type-tag ${s.classType}">${s.classType.toUpperCase()}</span>`
            : '';

          return `
            <div class="preview-session-item">
              <span class="preview-session-name">${escapeHTML(s.subject)} ${typeBadge}</span>
              <span class="preview-session-time">${formatTime12h(s.startTime)} – ${formatTime12h(s.endTime)}</span>
            </div>
          `;
        }).join('');

      return `
        <div class="preview-day-card">
          <div class="preview-day-header">${DAY_FULL_NAMES[di]}</div>
          <div class="preview-day-sessions">${sessionHtml}</div>
        </div>
      `;
    }).join('');

    if (viewModalBody) viewModalBody.innerHTML = html;
    viewModal.classList.remove('hidden');
  }

  function closeViewModal() {
    if (viewModal) viewModal.classList.add('hidden');
  }

  if (viewModalCloseBtn) viewModalCloseBtn.addEventListener('click', closeViewModal);
  if (viewModalDismissBtn) viewModalDismissBtn.addEventListener('click', closeViewModal);

  function openActivateModal(semesterId, semLabel) {
    pendingActivateSemesterId = semesterId;
    if (activateSemName) activateSemName.textContent = semLabel || 'this semester';
    if (activateSemDate) activateSemDate.textContent = formatDateISO(new Date());
    if (activateModal) activateModal.classList.remove('hidden');
  }

  function closeActivateModal() {
    pendingActivateSemesterId = null;
    if (activateModal) activateModal.classList.add('hidden');
  }

  if (activateModalCloseBtn) activateModalCloseBtn.addEventListener('click', closeActivateModal);
  if (activateCancelBtn) activateCancelBtn.addEventListener('click', closeActivateModal);

  if (activateConfirmBtn) {
    activateConfirmBtn.addEventListener('click', () => {
      if (!pendingActivateSemesterId) return;
      const todayISO = formatDateISO(new Date());
      const res = SemesterStorage.activateSemester(pendingActivateSemesterId, todayISO);
      closeActivateModal();
      if (!res.success) {
        showToast(res.error || 'Activation failed.');
      } else {
        const sem = SemesterStorage.getSemesterById(pendingActivateSemesterId || res.semesterId);
        showToast(sem ? `"${sem.label}" is now active.` : 'Semester activated.');
        renderSemesterList();
        loadAttendanceForDate(activeDate);
      }
    });
  }

  // ==================== SEMESTER SHARE FEATURE ====================
  function openShareModal(semesterId) {
    const sem = SemesterStorage.getSemesterById(semesterId);
    if (!sem || !shareModal) return;
    pendingShareSemesterId = semesterId;

    if (shareSemName) shareSemName.textContent = sem.label;

    const payload = {
      app: 'mbbs_attendance',
      type: 'semester_timetable',
      v: 1,
      label: sem.label,
      entries: (sem.entries || []).map(e => ({
        subject: e.subject || '',
        classType: e.classType || 'theory',
        startTime: e.startTime || '08:00',
        endTime: e.endTime || '09:00',
        days: Array.isArray(e.days) ? [...e.days] : [1],
        note: e.note || ''
      }))
    };

    let shareCode = '';
    try {
      const jsonStr = JSON.stringify(payload);
      const b64 = btoa(encodeURIComponent(jsonStr).replace(/%([0-9A-F]{2})/g, (m, p1) => String.fromCharCode('0x' + p1)));
      shareCode = 'MBBSSHARE:' + b64;
    } catch (e) {
      shareCode = JSON.stringify(payload);
    }

    if (shareCodeTextarea) {
      shareCodeTextarea.value = shareCode;
      setTimeout(() => {
        shareCodeTextarea.focus();
        shareCodeTextarea.select();
      }, 100);
    }

    shareModal.classList.remove('hidden');
  }

  function closeShareModal() {
    pendingShareSemesterId = null;
    if (shareModal) shareModal.classList.add('hidden');
  }

  if (shareModalCloseBtn) shareModalCloseBtn.addEventListener('click', closeShareModal);
  if (shareModalCancelBtn) shareModalCancelBtn.addEventListener('click', closeShareModal);

  if (shareCopyBtn) {
    shareCopyBtn.addEventListener('click', () => {
      const code = shareCodeTextarea ? shareCodeTextarea.value : '';
      if (!code) return;

      if (window.AndroidApp && typeof window.AndroidApp.copyToClipboard === 'function') {
        window.AndroidApp.copyToClipboard('MBBS Timetable Code', code);
        showToast('Timetable code copied to clipboard!');
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(() => {
          showToast('Timetable code copied to clipboard!');
        }).catch(() => {
          if (shareCodeTextarea) {
            shareCodeTextarea.select();
            document.execCommand('copy');
            showToast('Timetable code copied!');
          }
        });
      } else {
        if (shareCodeTextarea) {
          shareCodeTextarea.select();
          document.execCommand('copy');
          showToast('Timetable code copied!');
        }
      }
    });
  }

  if (shareSendBtn) {
    shareSendBtn.addEventListener('click', () => {
      const sem = pendingShareSemesterId ? SemesterStorage.getSemesterById(pendingShareSemesterId) : null;
      const semLabel = sem ? sem.label : 'Semester Timetable';
      const code = shareCodeTextarea ? shareCodeTextarea.value : '';
      if (!code) return;

      const shareMsg = `MBBS Attendance Timetable: ${semLabel}\n\nCopy this code and tap '📥 Import' in your MBBS Attendance app to load this timetable:\n\n${code}`;

      if (window.AndroidApp && typeof window.AndroidApp.shareText === 'function') {
        window.AndroidApp.shareText(`MBBS Timetable - ${semLabel}`, shareMsg);
      } else if (navigator.share) {
        navigator.share({
          title: `MBBS Timetable - ${semLabel}`,
          text: shareMsg
        }).catch(() => {});
      } else {
        if (shareCopyBtn) shareCopyBtn.click();
      }
    });
  }

  // ==================== SEMESTER IMPORT FEATURE ====================
  function openImportModal() {
    closeShareModal();
    if (importCodeInput) importCodeInput.value = '';
    if (importPreview) importPreview.classList.add('hidden');
    if (importError) {
      importError.classList.add('hidden');
      importError.textContent = '';
    }
    if (importConfirmBtn) importConfirmBtn.disabled = true;
    pendingImportPayload = null;

    if (importModal) importModal.classList.remove('hidden');

    // Auto-read clipboard if available
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(text => {
        if (text && text.includes('MBBSSHARE:')) {
          if (importCodeInput) {
            importCodeInput.value = text.trim();
            handleImportInput(text.trim());
          }
        }
      }).catch(() => {});
    }
  }

  function closeImportModal() {
    pendingImportPayload = null;
    if (importCodeInput) importCodeInput.value = '';
    if (importPreview) importPreview.classList.add('hidden');
    if (importError) {
      importError.classList.add('hidden');
      importError.textContent = '';
    }
    if (importConfirmBtn) importConfirmBtn.disabled = true;
    if (importModal) importModal.classList.add('hidden');
  }

  if (importBtn) importBtn.addEventListener('click', openImportModal);
  if (importModalCloseBtn) importModalCloseBtn.addEventListener('click', closeImportModal);
  if (importModalCancelBtn) importModalCancelBtn.addEventListener('click', closeImportModal);

  if (semClipboardPasteBtn) {
    semClipboardPasteBtn.addEventListener('click', () => {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(text => {
          if (text) {
            if (importCodeInput) {
              importCodeInput.value = text.trim();
              handleImportInput(text.trim());
            }
          } else {
            showToast('Clipboard is empty.');
          }
        }).catch(() => {
          showToast('Clipboard read access denied. Please paste manually.');
          if (importCodeInput) importCodeInput.focus();
        });
      } else {
        showToast('Please paste the code into the box.');
        if (importCodeInput) importCodeInput.focus();
      }
    });
  }

  function handleImportInput(rawText) {
    if (importError) {
      importError.classList.add('hidden');
      importError.textContent = '';
    }
    if (importPreview) importPreview.classList.add('hidden');
    if (importConfirmBtn) importConfirmBtn.disabled = true;
    pendingImportPayload = null;

    if (!rawText || !rawText.trim()) return;

    const trimmed = rawText.trim();
    let parsed = null;

    // Try finding MBBSSHARE:
    const match = trimmed.match(/MBBSSHARE:([A-Za-z0-9+/=]+)/);
    let b64Str = match ? match[1] : null;

    if (b64Str) {
      try {
        const jsonStr = decodeURIComponent(Array.prototype.map.call(atob(b64Str), (c) => {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        try {
          parsed = JSON.parse(atob(b64Str));
        } catch (e2) {}
      }
    } else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {}
    }

    if (!parsed || !Array.isArray(parsed.entries) || parsed.entries.length === 0) {
      if (importError) {
        importError.textContent = 'Invalid or unrecognized timetable code. Please check that you copied the complete code.';
        importError.classList.remove('hidden');
      }
      return;
    }

    pendingImportPayload = parsed;

    // Show preview & allow rename
    if (importLabelInput) {
      importLabelInput.value = parsed.label || 'Imported Semester';
    }
    if (importSessionCount) {
      importSessionCount.textContent = `${parsed.entries.length} weekly classes`;
    }

    // Extract unique subjects
    const uniqueSubjects = [];
    parsed.entries.forEach(e => {
      const s = (e.subject || '').trim();
      if (s && !uniqueSubjects.includes(s)) uniqueSubjects.push(s);
    });

    if (importSubjectsList) {
      importSubjectsList.innerHTML = uniqueSubjects.map(sub => `<span class="sem-import-chip">${escapeHTML(sub)}</span>`).join('');
    }

    if (importPreview) importPreview.classList.remove('hidden');
    if (importConfirmBtn) importConfirmBtn.disabled = false;
  }

  if (importCodeInput) {
    importCodeInput.addEventListener('input', () => {
      handleImportInput(importCodeInput.value);
    });
  }

  if (importConfirmBtn) {
    importConfirmBtn.addEventListener('click', () => {
      if (!pendingImportPayload || !Array.isArray(pendingImportPayload.entries)) {
        showToast('No valid timetable to import.');
        return;
      }

      const label = (importLabelInput ? importLabelInput.value.trim() : '') || pendingImportPayload.label || 'Imported Semester';

      // Create entries with unique local IDs
      const entries = pendingImportPayload.entries.map((e, idx) => ({
        id: 'imported_' + Date.now() + '_' + idx + '_' + Math.random().toString(36).substr(2, 5),
        subject: e.subject || '',
        classType: e.classType || 'theory',
        startTime: e.startTime || '08:00',
        endTime: e.endTime || '09:00',
        days: Array.isArray(e.days) ? [...e.days] : [1],
        note: e.note || ''
      }));

      const res = SemesterStorage.saveSemester({
        id: null, // Always create as a new semester template
        label: label,
        entries: entries
      });

      if (!res.success) {
        if (importError) {
          importError.textContent = res.error || 'Failed to save imported semester.';
          importError.classList.remove('hidden');
        }
        return;
      }

      closeImportModal();
      showToast(`"${label}" imported successfully! You can now edit, rename, or activate it.`);
      renderSemesterList();
      loadAttendanceForDate(activeDate);
    });
  }

  function hideAllModals() {
    closeViewModal();
    closeActivateModal();
    closeShareModal();
    closeImportModal();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideAllModals();
  });
}

/* ==========================================================================
   9. CLINICAL TIMETABLE PANEL (Rotation Scheduler)
   ========================================================================== */
function initClinicalTimetablePanel() {
  const panel = document.getElementById('clinical-timetable-panel');
  if (!panel) return;

  const backBtn = document.getElementById('clinical-panel-back-btn');
  const addNewBtn = document.getElementById('clinical-add-new-btn');
  const countSpan = document.getElementById('clinical-count');
  const container = document.getElementById('clinical-postings-container');

  const listView = document.getElementById('clinical-list-view');
  const editorView = document.getElementById('clinical-editor-view');
  const editorTitle = document.getElementById('clinical-editor-title');
  const editIdInput = document.getElementById('clinical-edit-id');
  const subjectSelect = document.getElementById('clinical-subject-select');
  const startDateInput = document.getElementById('clinical-start-date');
  const endDateInput = document.getElementById('clinical-end-date');
  const startTimeInput = document.getElementById('clinical-start-time');
  const endTimeInput = document.getElementById('clinical-end-time');
  const unitInput = document.getElementById('clinical-unit-input');
  const errorMsg = document.getElementById('clinical-editor-error-msg');
  const cancelBtn = document.getElementById('clinical-editor-cancel-btn');
  const saveBtn = document.getElementById('clinical-editor-save-btn');

  function openPanel() {
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    showListView();
  }

  function closePanel() {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    loadAttendanceForDate(activeDate);
  }

  window.openClinicalTimetablePanel = openPanel;

  if (backBtn) {
    backBtn.addEventListener('click', () => {
      if (!editorView.classList.contains('hidden')) {
        showListView();
      } else {
        closePanel();
      }
    });
  }

  function showListView() {
    listView.classList.remove('hidden');
    editorView.classList.add('hidden');
    if (addNewBtn) addNewBtn.classList.remove('hidden');
    renderPostingsList();
  }

  function populateSubjectSelect(selectedSubj) {
    if (!subjectSelect) return;
    subjectSelect.innerHTML = renderSubjectOptions(selectedSubj, false);
  }

  function showEditorView(postingId) {
    listView.classList.add('hidden');
    editorView.classList.remove('hidden');
    if (addNewBtn) addNewBtn.classList.add('hidden');

    if (errorMsg) {
      errorMsg.classList.add('hidden');
      errorMsg.textContent = '';
    }

    if (postingId) {
      const p = ClinicalPostingStorage.getPostingById(postingId);
      if (!p) { showListView(); return; }
      editorTitle.textContent = 'Edit Clinical Posting';
      editIdInput.value = p.id;
      populateSubjectSelect(p.subject);
      startDateInput.value = p.startDate || '';
      endDateInput.value = p.endDate || '';
      startTimeInput.value = p.startTime || '09:00';
      endTimeInput.value = p.endTime || '12:00';
      unitInput.value = p.unit || '';
    } else {
      editorTitle.textContent = 'Add Clinical Posting';
      editIdInput.value = '';
      populateSubjectSelect('');
      const todayISO = formatDateISO(new Date());
      startDateInput.value = todayISO;
      const nextMonth = new Date();
      nextMonth.setDate(nextMonth.getDate() + 27);
      endDateInput.value = formatDateISO(nextMonth);
      startTimeInput.value = '09:00';
      endTimeInput.value = '12:00';
      unitInput.value = '';
    }
  }

  function renderPostingsList() {
    const postings = ClinicalPostingStorage.getPostings();
    if (countSpan) countSpan.textContent = postings.length;

    if (!container) return;

    if (postings.length === 0) {
      container.innerHTML = `
        <div class="tt-empty-msg">No clinical postings added yet. Tap <strong>+ New Posting</strong> to schedule your hospital rotations.</div>
      `;
      return;
    }

    const todayISO = formatDateISO(new Date());

    const sorted = [...postings].sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));

    container.innerHTML = sorted.map(p => {
      const isActive = p.startDate <= todayISO && todayISO <= p.endDate;
      const isUpcoming = p.startDate > todayISO;

      let badgeHtml = '';
      if (isActive) {
        badgeHtml = `<span class="badge-active-posting">Active Now</span>`;
      } else if (isUpcoming) {
        badgeHtml = `<span class="badge-upcoming-posting">Upcoming</span>`;
      } else {
        badgeHtml = `<span class="badge-completed-posting">Completed</span>`;
      }

      const cardClass = isActive ? 'clinical-card active-posting' : 'clinical-card';

      return `
        <div class="${cardClass}" data-posting-id="${p.id}">
          <div class="clinical-card-top">
            <span class="clinical-card-title">${escapeHTML(p.subject)}</span>
            ${badgeHtml}
          </div>
          <div class="clinical-meta-grid">
            <div class="clinical-meta-row">
              <span>Duration</span>
              <span class="clinical-meta-val">${escapeHTML(p.durationText || '')}</span>
            </div>
            <div class="clinical-meta-row">
              <span>Dates</span>
              <span class="clinical-meta-val">${formatDateDisplayShort(p.startDate)} – ${formatDateDisplayShort(p.endDate)}</span>
            </div>
            <div class="clinical-meta-row">
              <span>Hours</span>
              <span class="clinical-meta-val">${formatTime12h(p.startTime)} – ${formatTime12h(p.endTime)}</span>
            </div>
            ${p.unit ? `
              <div class="clinical-meta-row">
                <span>Unit / Ward</span>
                <span class="clinical-meta-val">${escapeHTML(p.unit)}</span>
              </div>
            ` : ''}
          </div>
          <div class="clinical-card-actions">
            <button type="button" class="sem-btn" data-posting-edit-id="${p.id}">Edit</button>
            <button type="button" class="sem-btn btn-del" data-posting-del-id="${p.id}">Delete</button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('[data-posting-edit-id]').forEach(btn => {
      btn.addEventListener('click', () => showEditorView(btn.getAttribute('data-posting-edit-id')));
    });

    container.querySelectorAll('[data-posting-del-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-posting-del-id');
        const p = ClinicalPostingStorage.getPostingById(id);
        if (!p) return;
        if (confirm(`Remove clinical posting for "${p.subject}" (${p.startDate} to ${p.endDate})?`)) {
          ClinicalPostingStorage.deletePosting(id);
          showToast('Clinical posting removed.');
          renderPostingsList();
          loadAttendanceForDate(activeDate);
        }
      });
    });
  }

  if (addNewBtn) {
    addNewBtn.addEventListener('click', () => showEditorView(null));
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', showListView);
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      if (errorMsg) {
        errorMsg.classList.add('hidden');
        errorMsg.textContent = '';
      }

      const subject = subjectSelect ? subjectSelect.value.trim() : '';
      const startDate = startDateInput ? startDateInput.value : '';
      const endDate = endDateInput ? endDateInput.value : '';
      const startTime = startTimeInput ? startTimeInput.value : '09:00';
      const endTime = endTimeInput ? endTimeInput.value : '12:00';
      const unit = unitInput ? unitInput.value.trim() : '';
      const id = editIdInput ? editIdInput.value : '';

      const res = ClinicalPostingStorage.savePosting({
        id: id || null,
        subject,
        startDate,
        endDate,
        startTime,
        endTime,
        unit
      });

      if (!res.success) {
        if (errorMsg) {
          errorMsg.textContent = res.error;
          errorMsg.classList.remove('hidden');
        }
        return;
      }

      showToast(`Saved clinical posting for ${subject}.`);
      showListView();
      loadAttendanceForDate(activeDate);
    });
  }
}

/* ==========================================================================
   10. REPLACE CLASSES PANEL (Substitutions, Cancellations, Extra Classes)
   ========================================================================== */
function initReplaceClassesPanel() {
  const panel = document.getElementById('replace-classes-panel');
  if (!panel) return;

  const backBtn = document.getElementById('rc-panel-back-btn');
  const addExtraBtn = document.getElementById('rc-add-extra-btn');
  const inlineAddExtraBtn = document.getElementById('rc-inline-add-extra-btn');

  // Date Navigation
  const prevDateBtn = document.getElementById('rc-prev-date-btn');
  const nextDateBtn = document.getElementById('rc-next-date-btn');
  const datePickerInput = document.getElementById('rc-date-picker-input');
  const dateValSpan = document.getElementById('rc-date-val');
  const dateLabelSpan = document.getElementById('rc-date-label');

  // Containers
  const scheduledContainer = document.getElementById('rc-classes-container');
  const scheduledCountSpan = document.getElementById('rc-scheduled-count');
  const extraContainer = document.getElementById('rc-extra-container');
  const extraCountSpan = document.getElementById('rc-extra-count');
  const historySection = document.getElementById('rc-history-section');
  const historyChipsContainer = document.getElementById('rc-history-chips');

  // Substitute Modal Elements
  const subModal = document.getElementById('rc-sub-modal');
  const subModalCloseBtn = document.getElementById('rc-sub-modal-close-btn');
  const subCancelBtn = document.getElementById('rc-sub-cancel-btn');
  const subSaveBtn = document.getElementById('rc-sub-save-btn');
  const subSessionIdInput = document.getElementById('rc-sub-session-id');
  const subOriginalSubjSpan = document.getElementById('rc-sub-original-subj');
  const subOriginalTimeSpan = document.getElementById('rc-sub-original-time');
  const subNewSubjectSelect = document.getElementById('rc-sub-new-subject');
  const subTypeTheory = document.getElementById('rc-sub-type-theory');
  const subTypePractical = document.getElementById('rc-sub-type-practical');
  const subTypeGroup = document.getElementById('rc-sub-type-group');
  const subStartTimeInput = document.getElementById('rc-sub-start-time');
  const subEndTimeInput = document.getElementById('rc-sub-end-time');
  const subNoteInput = document.getElementById('rc-sub-note');
  const subErrorMsg = document.getElementById('rc-sub-error-msg');

  // Extra Class Modal Elements
  const extraModal = document.getElementById('rc-extra-modal');
  const extraModalCloseBtn = document.getElementById('rc-extra-modal-close-btn');
  const extraCancelBtn = document.getElementById('rc-extra-cancel-btn');
  const extraSaveBtn = document.getElementById('rc-extra-save-btn');
  const extraDateSpan = document.getElementById('rc-extra-modal-date');
  const extraSubjectSelect = document.getElementById('rc-extra-subject-select');
  const extraTypeTheory = document.getElementById('rc-extra-type-theory');
  const extraTypePractical = document.getElementById('rc-extra-type-practical');
  const extraTypeGroup = document.getElementById('rc-extra-type-group');
  const extraStartTimeInput = document.getElementById('rc-extra-start-time');
  const extraEndTimeInput = document.getElementById('rc-extra-end-time');
  const extraNoteInput = document.getElementById('rc-extra-note');
  const extraErrorMsg = document.getElementById('rc-extra-error-msg');

  let currentSubOriginalData = null;
  let targetReplacementDate = new Date(activeDate);

  function openPanel() {
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    targetReplacementDate = new Date(activeDate);
    renderReplaceClassesView();
  }

  function closePanel() {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    hideModals();
    loadAttendanceForDate(activeDate);
  }

  window.openReplaceClassesPanel = openPanel;

  if (backBtn) backBtn.addEventListener('click', closePanel);

  function updateDateHeader() {
    const todayISO = formatDateISO(new Date());
    const selISO = formatDateISO(targetReplacementDate);

    if (dateValSpan) dateValSpan.textContent = formatDateDisplay(targetReplacementDate);
    if (datePickerInput) datePickerInput.value = selISO;

    if (dateLabelSpan) {
      if (selISO === todayISO) {
        dateLabelSpan.textContent = 'Today';
      } else {
        dateLabelSpan.textContent = SHORT_WEEKDAYS[targetReplacementDate.getDay()];
      }
    }
  }

  if (prevDateBtn) {
    prevDateBtn.addEventListener('click', () => {
      targetReplacementDate.setDate(targetReplacementDate.getDate() - 1);
      renderReplaceClassesView();
    });
  }

  if (nextDateBtn) {
    nextDateBtn.addEventListener('click', () => {
      targetReplacementDate.setDate(targetReplacementDate.getDate() + 1);
      renderReplaceClassesView();
    });
  }

  if (datePickerInput) {
    datePickerInput.addEventListener('change', () => {
      if (datePickerInput.value) {
        targetReplacementDate = parseISODate(datePickerInput.value);
        renderReplaceClassesView();
      }
    });
  }

  function renderReplaceClassesView() {
    updateDateHeader();
    const dateStr = formatDateISO(targetReplacementDate);
    const dayIndex = targetReplacementDate.getDay();

    const replacements = ClassReplacementStorage.getReplacementsForDate(dateStr);

    // 1. Scheduled Classes for today
    let baseSessions = [];
    const allSemesters = SemesterStorage.getSemesters();

    if (allSemesters.length === 0) {
      baseSessions = [
        { id: 'pediatric_0800_0900', subject: 'PEDIATRIC', classType: 'theory', startTime: '08:00', endTime: '09:00' },
        { id: 'clinical_posting_0900_1200', subject: 'Clinical posting', classType: null, startTime: '09:00', endTime: '12:00' },
        { id: 'surgery_1200_1300', subject: 'Surgery', classType: 'theory', startTime: '12:00', endTime: '13:00' }
      ];
    } else {
      const sem = SemesterStorage.getSemesterForDate(dateStr);
      if (sem && Array.isArray(sem.entries)) {
        baseSessions = sem.entries.filter(e => Array.isArray(e.days) && e.days.includes(dayIndex));
      }
    }

    const activePosting = ClinicalPostingStorage.getActivePostingForDate(dateStr);
    if (activePosting && dayIndex !== 0) {
      const hasPosting = baseSessions.some(e => (e.subject || '').toLowerCase() === 'clinical posting' || (e.subject || '').toLowerCase().includes('clinic'));
      if (!hasPosting) {
        baseSessions.push({
          id: `clinical_posting_${activePosting.id}`,
          subject: `Clinical Posting (${activePosting.subject})`,
          classType: null,
          startTime: activePosting.startTime || '09:00',
          endTime: activePosting.endTime || '12:00',
          isPosting: true
        });
      }
    }

    baseSessions.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

    if (scheduledCountSpan) scheduledCountSpan.textContent = baseSessions.length;

    if (!scheduledContainer) return;

    if (dayIndex === 0) {
      scheduledContainer.innerHTML = `
        <div class="tt-empty-msg" style="padding:14px 12px;">
          <strong>Sunday is a Holiday.</strong> No regular semester classes are scheduled.
        </div>
      `;
    } else if (baseSessions.length === 0) {
      scheduledContainer.innerHTML = `
        <div class="tt-empty-msg" style="padding:14px 12px;">
          No scheduled classes on ${WEEKDAYS[dayIndex]} for this date.
        </div>
      `;
    } else {
      scheduledContainer.innerHTML = baseSessions.map(session => {
        const isCancelled = replacements.cancellations.includes(session.id);
        const sub = replacements.substitutions[session.id];

        let badgeHtml = `<span class="rc-badge rc-badge-normal">Original</span>`;
        let cardClass = '';
        let subDetailsHtml = '';

        if (isCancelled) {
          badgeHtml = `<span class="rc-badge rc-badge-cancel">Cancelled</span>`;
          cardClass = 'is-cancelled';
          subDetailsHtml = `<div class="rc-sub-details" style="color:#f87171;">Marked as Cancelled for ${formatDateDisplayShort(dateStr)}. Home screen will show crossed-out class.</div>`;
        } else if (sub) {
          badgeHtml = `<span class="rc-badge rc-badge-sub">Swapped</span>`;
          cardClass = 'is-substituted';
          const subTypeLabel = sub.classType === 'practical' ? ' [Practical]' : ' [Theory]';
          subDetailsHtml = `
            <div class="rc-sub-details">
              Swapped to: <strong>${escapeHTML(sub.newSubject)}${subTypeLabel}</strong> (${formatTime12h(sub.startTime)} – ${formatTime12h(sub.endTime)})
              ${sub.note ? `<br><span style="color:#94a3b8; font-size:0.75rem;">Note: ${escapeHTML(sub.note)}</span>` : ''}
            </div>
          `;
        }

        const formattedTime = `${formatTime12h(session.startTime)} – ${formatTime12h(session.endTime)}`;

        const substituteBtn = !isCancelled
          ? `<button type="button" class="rc-btn rc-btn-swap btn-open-sub" data-session-id="${session.id}">${sub ? 'Edit Swap' : 'Swap Subject'}</button>`
          : '';

        const cancelToggleBtn = isCancelled
          ? `<button type="button" class="rc-btn rc-btn-reset btn-toggle-cancel" data-session-id="${session.id}">Un-cancel</button>`
          : `<button type="button" class="rc-btn rc-btn-cancel-action btn-toggle-cancel" data-session-id="${session.id}">Cancel for Today</button>`;

        const resetBtn = (sub || isCancelled)
          ? `<button type="button" class="rc-btn rc-btn-reset btn-reset-original" data-session-id="${session.id}">Revert</button>`
          : '';

        return `
          <div class="rc-class-card ${cardClass}" data-session-id="${session.id}">
            <div class="rc-class-top">
              <div>
                <span class="rc-class-title">${escapeHTML(session.subject)}</span>
                <div class="rc-class-time">${formattedTime}</div>
              </div>
              ${badgeHtml}
            </div>
            ${subDetailsHtml}
            <div class="rc-actions">
              ${substituteBtn}
              ${cancelToggleBtn}
              ${resetBtn}
            </div>
          </div>
        `;
      }).join('');

      // Wire Substitute buttons
      scheduledContainer.querySelectorAll('.btn-open-sub').forEach(btn => {
        btn.addEventListener('click', () => {
          const sId = btn.getAttribute('data-session-id');
          const session = baseSessions.find(s => s.id === sId);
          if (session) openSubstituteModal(session);
        });
      });

      // Wire Cancel toggle buttons
      scheduledContainer.querySelectorAll('.btn-toggle-cancel').forEach(btn => {
        btn.addEventListener('click', () => {
          const sId = btn.getAttribute('data-session-id');
          const res = ClassReplacementStorage.toggleCancellation(dateStr, sId);
          if (res.isCancelled) {
            showToast('Class cancelled for this date.');
          } else {
            showToast('Class restored to schedule.');
          }
          renderReplaceClassesView();
          loadAttendanceForDate(activeDate);
        });
      });

      // Wire Revert to original buttons
      scheduledContainer.querySelectorAll('.btn-reset-original').forEach(btn => {
        btn.addEventListener('click', () => {
          const sId = btn.getAttribute('data-session-id');
          ClassReplacementStorage.resetSessionToOriginal(dateStr, sId);
          showToast('Reverted to original scheduled class.');
          renderReplaceClassesView();
          loadAttendanceForDate(activeDate);
        });
      });
    }

    // 2. Extra Classes for today
    const extraList = replacements.extraClasses;
    if (extraCountSpan) extraCountSpan.textContent = extraList.length;

    if (extraContainer) {
      if (extraList.length === 0) {
        extraContainer.innerHTML = `
          <div class="tt-empty-msg" style="padding:10px 12px; font-size:0.78rem;">
            No extra classes scheduled for this date.
          </div>
        `;
      } else {
        extraContainer.innerHTML = extraList.map(extra => {
          const typeLabel = extra.classType === 'practical' ? ' [Practical]' : ' [Theory]';
          return `
            <div class="rc-extra-card" data-extra-id="${extra.id}">
              <div class="rc-extra-info">
                <span class="rc-extra-subj">${escapeHTML(extra.subject)}${typeLabel}</span>
                <span class="rc-extra-time">${formatTime12h(extra.startTime)} – ${formatTime12h(extra.endTime)}</span>
                ${extra.note ? `<span class="rc-extra-note">${escapeHTML(extra.note)}</span>` : ''}
              </div>
              <button type="button" class="sem-btn btn-del btn-del-extra" data-extra-id="${extra.id}">Remove</button>
            </div>
          `;
        }).join('');

        extraContainer.querySelectorAll('.btn-del-extra').forEach(btn => {
          btn.addEventListener('click', () => {
            const extraId = btn.getAttribute('data-extra-id');
            ClassReplacementStorage.deleteExtraClass(dateStr, extraId);
            showToast('Extra class removed.');
            renderReplaceClassesView();
            loadAttendanceForDate(activeDate);
          });
        });
      }
    }

    // 3. Modified Dates Quick History
    const modifiedDates = ClassReplacementStorage.getModifiedDates();
    if (historySection && historyChipsContainer) {
      if (modifiedDates.length === 0) {
        historySection.classList.add('hidden');
      } else {
        historySection.classList.remove('hidden');
        historyChipsContainer.innerHTML = modifiedDates.map(dStr => {
          const isCurrent = dStr === dateStr;
          return `<button type="button" class="rc-history-chip ${isCurrent ? 'active-chip' : ''}" data-date="${dStr}">${formatDateDisplayShort(dStr)}</button>`;
        }).join('');

        historyChipsContainer.querySelectorAll('.rc-history-chip').forEach(chip => {
          chip.addEventListener('click', () => {
            targetReplacementDate = parseISODate(chip.getAttribute('data-date'));
            renderReplaceClassesView();
          });
        });
      }
    }
  }

  // ---- Substitute Modal ----
  function openSubstituteModal(session) {
    if (!subModal) return;
    const dateStr = formatDateISO(targetReplacementDate);
    const replacements = ClassReplacementStorage.getReplacementsForDate(dateStr);
    const existingSub = replacements.substitutions[session.id];

    currentSubOriginalData = {
      sessionId: session.id,
      originalSubject: session.subject,
      originalClassType: session.classType || 'theory',
      originalStartTime: session.startTime,
      originalEndTime: session.endTime
    };

    if (subSessionIdInput) subSessionIdInput.value = session.id;
    if (subOriginalSubjSpan) subOriginalSubjSpan.textContent = session.subject;
    if (subOriginalTimeSpan) subOriginalTimeSpan.textContent = `${formatTime12h(session.startTime)} – ${formatTime12h(session.endTime)}`;

    const selectedNewSubj = existingSub ? existingSub.newSubject : '';
    if (subNewSubjectSelect) {
      subNewSubjectSelect.innerHTML = renderSubjectOptions(selectedNewSubj, false);
    }

    // Set class type
    const curType = existingSub ? existingSub.classType : (session.classType || 'theory');
    if (subTypeTheory && subTypePractical) {
      if (curType === 'practical') {
        subTypeTheory.classList.remove('active');
        subTypePractical.classList.add('active');
      } else {
        subTypeTheory.classList.add('active');
        subTypePractical.classList.remove('active');
      }
    }

    if (subStartTimeInput) subStartTimeInput.value = existingSub ? existingSub.startTime : session.startTime;
    if (subEndTimeInput) subEndTimeInput.value = existingSub ? existingSub.endTime : session.endTime;
    if (subNoteInput) subNoteInput.value = existingSub ? existingSub.note : '';
    if (subErrorMsg) subErrorMsg.classList.add('hidden');

    subModal.classList.remove('hidden');
  }

  function closeSubModal() {
    if (subModal) subModal.classList.add('hidden');
    currentSubOriginalData = null;
  }

  if (subTypeTheory && subTypePractical) {
    subTypeTheory.addEventListener('click', () => {
      subTypeTheory.classList.add('active');
      subTypePractical.classList.remove('active');
    });
    subTypePractical.addEventListener('click', () => {
      subTypePractical.classList.add('active');
      subTypeTheory.classList.remove('active');
    });
  }

  if (subModalCloseBtn) subModalCloseBtn.addEventListener('click', closeSubModal);
  if (subCancelBtn) subCancelBtn.addEventListener('click', closeSubModal);

  if (subSaveBtn) {
    subSaveBtn.addEventListener('click', () => {
      if (!currentSubOriginalData) return;

      const newSubject = subNewSubjectSelect ? subNewSubjectSelect.value.trim() : '';
      const startTime = subStartTimeInput ? subStartTimeInput.value : '';
      const endTime = subEndTimeInput ? subEndTimeInput.value : '';
      const note = subNoteInput ? subNoteInput.value.trim() : '';
      const classType = (subTypePractical && subTypePractical.classList.contains('active')) ? 'practical' : 'theory';

      if (!newSubject) {
        if (subErrorMsg) {
          subErrorMsg.textContent = 'Please select a replacement subject from the 19 MBBS subjects.';
          subErrorMsg.classList.remove('hidden');
        }
        return;
      }

      if (!startTime || !endTime) {
        if (subErrorMsg) {
          subErrorMsg.textContent = 'Start time and End time are required.';
          subErrorMsg.classList.remove('hidden');
        }
        return;
      }

      if (timeToMinutes(startTime) >= timeToMinutes(endTime)) {
        if (subErrorMsg) {
          subErrorMsg.textContent = 'Start time must be strictly before End time.';
          subErrorMsg.classList.remove('hidden');
        }
        return;
      }

      const dateStr = formatDateISO(targetReplacementDate);
      ClassReplacementStorage.setSubstitution(dateStr, currentSubOriginalData.sessionId, {
        newSubject,
        classType,
        startTime,
        endTime,
        note,
        originalSubject: currentSubOriginalData.originalSubject,
        originalStartTime: currentSubOriginalData.originalStartTime,
        originalEndTime: currentSubOriginalData.originalEndTime
      });

      closeSubModal();
      showToast(`Class replaced with ${newSubject} for today.`);
      renderReplaceClassesView();
      loadAttendanceForDate(activeDate);
    });
  }

  // ---- Extra Class Modal ----
  function openExtraModal() {
    if (!extraModal) return;
    if (extraDateSpan) extraDateSpan.textContent = formatDateDisplay(targetReplacementDate);
    if (extraSubjectSelect) extraSubjectSelect.innerHTML = renderSubjectOptions('', false);
    if (extraStartTimeInput) extraStartTimeInput.value = '14:00';
    if (extraEndTimeInput) extraEndTimeInput.value = '15:00';
    if (extraNoteInput) extraNoteInput.value = '';
    if (extraErrorMsg) extraErrorMsg.classList.add('hidden');

    if (extraTypeTheory && extraTypePractical) {
      extraTypeTheory.classList.add('active');
      extraTypePractical.classList.remove('active');
    }

    extraModal.classList.remove('hidden');
  }

  function closeExtraModal() {
    if (extraModal) extraModal.classList.add('hidden');
  }

  if (extraTypeTheory && extraTypePractical) {
    extraTypeTheory.addEventListener('click', () => {
      extraTypeTheory.classList.add('active');
      extraTypePractical.classList.remove('active');
    });
    extraTypePractical.addEventListener('click', () => {
      extraTypePractical.classList.add('active');
      extraTypeTheory.classList.remove('active');
    });
  }

  if (addExtraBtn) addExtraBtn.addEventListener('click', openExtraModal);
  if (inlineAddExtraBtn) inlineAddExtraBtn.addEventListener('click', openExtraModal);
  if (extraModalCloseBtn) extraModalCloseBtn.addEventListener('click', closeExtraModal);
  if (extraCancelBtn) extraCancelBtn.addEventListener('click', closeExtraModal);

  if (extraSaveBtn) {
    extraSaveBtn.addEventListener('click', () => {
      const subject = extraSubjectSelect ? extraSubjectSelect.value.trim() : '';
      const startTime = extraStartTimeInput ? extraStartTimeInput.value : '';
      const endTime = extraEndTimeInput ? extraEndTimeInput.value : '';
      const note = extraNoteInput ? extraNoteInput.value.trim() : '';
      const classType = (extraTypePractical && extraTypePractical.classList.contains('active')) ? 'practical' : 'theory';

      if (!subject) {
        if (extraErrorMsg) {
          extraErrorMsg.textContent = 'Please select a subject from the 19 MBBS subjects.';
          extraErrorMsg.classList.remove('hidden');
        }
        return;
      }

      if (!startTime || !endTime) {
        if (extraErrorMsg) {
          extraErrorMsg.textContent = 'Start time and End time are required.';
          extraErrorMsg.classList.remove('hidden');
        }
        return;
      }

      if (timeToMinutes(startTime) >= timeToMinutes(endTime)) {
        if (extraErrorMsg) {
          extraErrorMsg.textContent = 'Start time must be strictly before End time.';
          extraErrorMsg.classList.remove('hidden');
        }
        return;
      }

      const dateStr = formatDateISO(targetReplacementDate);
      ClassReplacementStorage.addExtraClass(dateStr, {
        subject,
        classType,
        startTime,
        endTime,
        note
      });

      closeExtraModal();
      showToast(`Added extra ${subject} class.`);
      renderReplaceClassesView();
      loadAttendanceForDate(activeDate);
    });
  }

  function hideModals() {
    closeSubModal();
    closeExtraModal();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open')) {
      hideModals();
    }
  });
}

/* ==========================================================================
   11. ATTENDANCE CALCULATION ENGINE (AttendanceCalculator)
   Computes NMC Theory (≥75%), Practical (≥75%), and Postings (≥80%) metrics.
   ========================================================================== */
const AttendanceCalculator = (() => {
  const NMC_THEORY_CRITERIA = 75; // 75%
  const NMC_PRACTICAL_CRITERIA = 75; // 75% (Updated to 75% requirement)
  const NMC_POSTING_CRITERIA = 80; // 80%

  function roundOneDecimal(num) {
    return Math.round(num * 10) / 10;
  }

  function computeMetrics(attended, conducted, targetPercent) {
    if (conducted === 0) {
      return {
        attended: 0,
        conducted: 0,
        absent: 0,
        percentage: null,
        percentageStr: '--%',
        status: 'none',
        canBunk: 0,
        mustAttend: 0,
        tipText: 'No classes logged yet'
      };
    }

    const pct = roundOneDecimal((attended / conducted) * 100);
    const targetRatio = targetPercent / 100;
    const isEligible = pct >= targetPercent;

    let canBunk = 0;
    let mustAttend = 0;
    let tipText = '';

    if (isEligible) {
      canBunk = Math.floor((attended - (targetRatio * conducted)) / targetRatio);
      if (canBunk > 0) {
        tipText = `✅ Safe: Can miss ${canBunk} class${canBunk > 1 ? 'es' : ''}`;
      } else {
        tipText = `⚠️ On edge: Cannot miss any classes`;
      }
    } else {
      mustAttend = Math.ceil(((targetRatio * conducted) - attended) / (1 - targetRatio));
      tipText = `⚠️ Shortage: Need ${mustAttend} class${mustAttend > 1 ? 'es' : ''} to reach ${targetPercent}%`;
    }

    return {
      attended,
      conducted,
      absent: conducted - attended,
      percentage: pct,
      percentageStr: `${pct}%`,
      status: isEligible ? 'eligible' : 'shortage',
      canBunk,
      mustAttend,
      tipText
    };
  }

  function calculate(filterSemesterId = null) {
    const allRecords = AttendanceStorage.getAllRecords();
    const activeSem = SemesterStorage.getActiveSemester();

    // Map session IDs to template classType for older records
    const sessionTypeMap = {};
    const semesters = SemesterStorage.getSemesters();
    semesters.forEach(s => {
      (s.entries || []).forEach(e => {
        if (e.id) {
          sessionTypeMap[e.id] = e.classType || 'theory';
        }
      });
    });

    const subjectStats = {};
    const clinicalStats = {};

    let totalTheoryAttended = 0;
    let totalTheoryConducted = 0;
    let totalPracticalAttended = 0;
    let totalPracticalConducted = 0;
    let totalClinicalAttended = 0;
    let totalClinicalConducted = 0;

    Object.values(allRecords).forEach(rec => {
      if (!rec || !rec.date) return;
      if (rec._duplicateOf) return; // Skip duplicate short-key entries
      if (rec.status !== 'present' && rec.status !== 'absent') return;

      if (filterSemesterId && filterSemesterId !== 'all') {
        if (rec.semesterId && rec.semesterId !== filterSemesterId && rec.semesterId !== 'extra' && rec.semesterId !== 'clinical_rotations') {
          return;
        }
      }

      const rawSubj = (rec.subject || '').trim();
      if (!rawSubj) return;

      const isPresent = rec.status === 'present';
      const isPosting = rawSubj.toLowerCase().includes('clinical posting') || rawSubj.toLowerCase().includes('clinic');

      if (isPosting) {
        totalClinicalConducted++;
        if (isPresent) totalClinicalAttended++;

        let rotationName = 'General Clinical Posting';
        const match = rawSubj.match(/\((.*?)\)/);
        if (match && match[1]) {
          rotationName = match[1].trim();
        }

        if (!clinicalStats[rotationName]) {
          clinicalStats[rotationName] = { attended: 0, conducted: 0 };
        }
        clinicalStats[rotationName].conducted++;
        if (isPresent) clinicalStats[rotationName].attended++;

        // --- MERGE CLINICAL POSTING INTO SUBJECT'S PRACTICAL ATTENDANCE ---
        // Clinical posting days are also counted toward the respective subject's practical.
        // "General Clinical Posting" (unnamed) is NOT merged — only named subjects are.
        if (rotationName !== 'General Clinical Posting') {
          const knownClinSubj = MBBS_19_SUBJECTS.find(s => s.toLowerCase() === rotationName.toLowerCase()) || rotationName;
          if (!subjectStats[knownClinSubj]) {
            subjectStats[knownClinSubj] = {
              theory: { attended: 0, conducted: 0 },
              practical: { attended: 0, conducted: 0 }
            };
          }
          subjectStats[knownClinSubj].practical.conducted++;
          if (isPresent) subjectStats[knownClinSubj].practical.attended++;
          // Track that this subject has clinical days merged (for label display)
          if (!subjectStats[knownClinSubj].clinicalMergedConducted) {
            subjectStats[knownClinSubj].clinicalMergedConducted = 0;
          }
          subjectStats[knownClinSubj].clinicalMergedConducted++;
          totalPracticalConducted++;
          if (isPresent) totalPracticalAttended++;
        }
        return;
      }

      let normSubject = rawSubj;
      const knownSubj = MBBS_19_SUBJECTS.find(s => s.toLowerCase() === rawSubj.toLowerCase());
      if (knownSubj) normSubject = knownSubj;

      let cType = rec.classType;
      if (!cType && rec.sessionId && sessionTypeMap[rec.sessionId]) {
        cType = sessionTypeMap[rec.sessionId];
      }
      if (cType !== 'practical') cType = 'theory';

      if (!subjectStats[normSubject]) {
        subjectStats[normSubject] = {
          theory: { attended: 0, conducted: 0 },
          practical: { attended: 0, conducted: 0 }
        };
      }

      if (cType === 'practical') {
        totalPracticalConducted++;
        if (isPresent) totalPracticalAttended++;
        subjectStats[normSubject].practical.conducted++;
        if (isPresent) subjectStats[normSubject].practical.attended++;
      } else {
        totalTheoryConducted++;
        if (isPresent) totalTheoryAttended++;
        subjectStats[normSubject].theory.conducted++;
        if (isPresent) subjectStats[normSubject].theory.attended++;
      }
    });

    // Integrate Past Attendance History (Baseline college portal records)
    const allHistory = AttendanceHistoryStorage.getAllHistory();
    allHistory.forEach(h => {
      const matchSubj = MBBS_19_SUBJECTS.find(s => s.toLowerCase() === (h.subject || '').toLowerCase()) || h.subject;
      if (!subjectStats[matchSubj]) {
        subjectStats[matchSubj] = {
          theory: { attended: 0, conducted: 0 },
          practical: { attended: 0, conducted: 0 }
        };
      }

      let tHeld = h.theoryHeld || 0;
      let tAtt = h.theoryAttended || 0;
      let pHeld = h.practicalHeld || 0;
      let pAtt = h.practicalAttended || 0;

      if (tHeld === 0 && pHeld === 0 && h.totalHeld > 0) {
        tHeld = h.totalHeld;
        tAtt = h.attended || 0;
      }

      subjectStats[matchSubj].theory.conducted += tHeld;
      subjectStats[matchSubj].theory.attended += tAtt;
      totalTheoryConducted += tHeld;
      totalTheoryAttended += tAtt;

      subjectStats[matchSubj].practical.conducted += pHeld;
      subjectStats[matchSubj].practical.attended += pAtt;
      totalPracticalConducted += pHeld;
      totalPracticalAttended += pAtt;
    });

    // Populate active semester subjects with 0s if not yet attended
    if (activeSem && Array.isArray(activeSem.entries)) {
      activeSem.entries.forEach(e => {
        const sName = (e.subject || '').trim();
        if (sName && sName.toLowerCase() !== 'clinical posting') {
          const matchSubj = MBBS_19_SUBJECTS.find(s => s.toLowerCase() === sName.toLowerCase()) || sName;
          if (!subjectStats[matchSubj]) {
            subjectStats[matchSubj] = {
              theory: { attended: 0, conducted: 0 },
              practical: { attended: 0, conducted: 0 }
            };
          }
        }
      });
    }

    const formattedSubjects = Object.keys(subjectStats).map(subj => {
      const data = subjectStats[subj];
      const theory = computeMetrics(data.theory.attended, data.theory.conducted, NMC_THEORY_CRITERIA);
      const practical = computeMetrics(data.practical.attended, data.practical.conducted, NMC_PRACTICAL_CRITERIA);
      const totalAttended = data.theory.attended + data.practical.attended;
      const totalConducted = data.theory.conducted + data.practical.conducted;
      const totalPct = totalConducted > 0 ? roundOneDecimal((totalAttended / totalConducted) * 100) : null;
      // Flag if this subject has clinical posting days merged into practical
      const hasClinicalMerged = Boolean(data.clinicalMergedConducted && data.clinicalMergedConducted > 0);

      return {
        subject: subj,
        theory,
        practical,
        totalAttended,
        totalConducted,
        totalPctStr: totalPct !== null ? `${totalPct}%` : '--%',
        hasActivity: totalConducted > 0,
        hasClinicalMerged
      };
    });

    formattedSubjects.sort((a, b) => {
      if (a.hasActivity && !b.hasActivity) return -1;
      if (!a.hasActivity && b.hasActivity) return 1;
      return a.subject.localeCompare(b.subject);
    });

    const formattedClinical = Object.keys(clinicalStats).map(name => {
      const rot = clinicalStats[name];
      const metrics = computeMetrics(rot.attended, rot.conducted, NMC_POSTING_CRITERIA);
      return {
        rotation: name,
        ...metrics
      };
    });

    return {
      theorySummary: computeMetrics(totalTheoryAttended, totalTheoryConducted, NMC_THEORY_CRITERIA),
      practicalSummary: computeMetrics(totalPracticalAttended, totalPracticalConducted, NMC_PRACTICAL_CRITERIA),
      clinicalSummary: computeMetrics(totalClinicalAttended, totalClinicalConducted, NMC_POSTING_CRITERIA),
      subjects: formattedSubjects,
      clinicalRotations: formattedClinical
    };
  }

  return {
    calculate
  };
})();

/* ==========================================================================
   12. OVERVIEW ATTENDANCE PANEL (Theory & Practical NMC Breakdown)
   ========================================================================== */
function initOverviewAttendancePanel() {
  const panel = document.getElementById('overview-attendance-panel');
  if (!panel) return;

  const backBtn = document.getElementById('overview-panel-back-btn');
  const refreshBtn = document.getElementById('overview-refresh-btn');
  const semSelect = document.getElementById('overview-sem-select');
  const subjectsContainer = document.getElementById('overview-subjects-container');
  const tabPills = document.querySelectorAll('.overview-tab-pill');

  // Theory summary card elements
  const theoryStatus = document.getElementById('metric-theory-status');
  const theoryPct = document.getElementById('metric-theory-pct');
  const theoryCounts = document.getElementById('metric-theory-counts');
  const theoryBar = document.getElementById('metric-theory-bar');
  const theoryMargin = document.getElementById('metric-theory-margin');

  // Practical summary card elements
  const practicalStatus = document.getElementById('metric-practical-status');
  const practicalPct = document.getElementById('metric-practical-pct');
  const practicalCounts = document.getElementById('metric-practical-counts');
  const practicalBar = document.getElementById('metric-practical-bar');
  const practicalMargin = document.getElementById('metric-practical-margin');

  // Clinical summary card elements
  const clinicalStatus = document.getElementById('metric-clinical-status');
  const clinicalPct = document.getElementById('metric-clinical-pct');
  const clinicalCounts = document.getElementById('metric-clinical-counts');
  const clinicalBar = document.getElementById('metric-clinical-bar');
  const clinicalMargin = document.getElementById('metric-clinical-margin');

  let currentTab = 'all'; // 'all' | 'theory' | 'practical' | 'clinical'

  function openPanel() {
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    populateSemesterFilter();
    renderOverview();
  }

  function closePanel() {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
  }

  window.openOverviewAttendancePanel = openPanel;

  if (backBtn) backBtn.addEventListener('click', closePanel);
  if (refreshBtn) refreshBtn.addEventListener('click', renderOverview);

  function populateSemesterFilter() {
    if (!semSelect) return;
    const semesters = SemesterStorage.getSemesters();
    const activeSem = SemesterStorage.getActiveSemester();

    let html = `<option value="all">All Semesters (Complete History)</option>`;
    if (activeSem) {
      html = `<option value="${activeSem.id}" selected>Active: ${escapeHTML(activeSem.label)}</option>` + html;
    }
    semesters.forEach(s => {
      if (activeSem && s.id === activeSem.id) return;
      html += `<option value="${s.id}">${escapeHTML(s.label)}</option>`;
    });

    semSelect.innerHTML = html;
  }

  if (semSelect) {
    semSelect.addEventListener('change', renderOverview);
  }

  tabPills.forEach(pill => {
    pill.addEventListener('click', () => {
      tabPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentTab = pill.getAttribute('data-tab');
      renderOverview();
    });
  });

  function renderOverview() {
    const semId = semSelect ? semSelect.value : null;
    const stats = AttendanceCalculator.calculate(semId);

    // 1. Update Theory Summary
    const t = stats.theorySummary;
    if (theoryPct) theoryPct.textContent = t.percentageStr;
    if (theoryCounts) theoryCounts.textContent = `${t.attended} / ${t.conducted} attended`;
    if (theoryBar) theoryBar.style.width = `${Math.min(100, t.percentage || 0)}%`;
    if (theoryStatus) {
      theoryStatus.className = `metric-status-badge status-badge-${t.status}`;
      theoryStatus.textContent = t.status === 'eligible' ? 'Eligible (≥75%)' : (t.status === 'shortage' ? 'Shortage (<75%)' : 'No Data');
    }
    if (theoryMargin) theoryMargin.textContent = t.tipText;

    // 2. Update Practical Summary
    const p = stats.practicalSummary;
    if (practicalPct) practicalPct.textContent = p.percentageStr;
    if (practicalCounts) practicalCounts.textContent = `${p.attended} / ${p.conducted} attended`;
    if (practicalBar) practicalBar.style.width = `${Math.min(100, p.percentage || 0)}%`;
    if (practicalStatus) {
      practicalStatus.className = `metric-status-badge status-badge-${p.status}`;
      practicalStatus.textContent = p.status === 'eligible' ? 'Eligible (≥75%)' : (p.status === 'shortage' ? 'Shortage (<75%)' : 'No Data');
    }
    if (practicalMargin) practicalMargin.textContent = p.tipText;

    // 3. Update Clinical Postings Summary (shows posting days & bunk tracking without artificial 80% limit)
    const c = stats.clinicalSummary;
    const clinicalBunked = (c.conducted || 0) - (c.attended || 0);
    if (clinicalPct) clinicalPct.textContent = c.percentageStr;
    if (clinicalCounts) clinicalCounts.textContent = `${c.attended} / ${c.conducted} attended`;
    if (clinicalBar) clinicalBar.style.width = `${Math.min(100, c.percentage || 0)}%`;
    if (clinicalStatus) {
      if (c.conducted === 0) {
        clinicalStatus.className = 'metric-status-badge stat-badge-none';
        clinicalStatus.textContent = 'No Clinical Logs';
      } else if (clinicalBunked === 0) {
        clinicalStatus.className = 'metric-status-badge status-badge-eligible';
        clinicalStatus.textContent = '0 Bunked (Full Attendance)';
      } else {
        clinicalStatus.className = 'metric-status-badge status-badge-shortage';
        clinicalStatus.textContent = `${clinicalBunked} Bunked (${clinicalBunked === 1 ? '1 day' : clinicalBunked + ' days'})`;
      }
    }
    if (clinicalMargin) {
      if (c.conducted === 0) {
        clinicalMargin.textContent = 'No clinical postings held yet';
      } else if (clinicalBunked === 0) {
        clinicalMargin.textContent = '✅ Attended 100% of clinical posting days';
      } else {
        clinicalMargin.textContent = `⚠️ Bunked ${clinicalBunked} day${clinicalBunked > 1 ? 's' : ''} (${c.attended} attended out of ${c.conducted})`;
      }
    }

    // 4. Render Breakdown Cards
    if (!subjectsContainer) return;

    if (currentTab === 'clinical') {
      if (stats.clinicalRotations.length === 0) {
        subjectsContainer.innerHTML = `
          <div class="overview-empty-state">
            <div class="overview-empty-icon">🏥</div>
            <div>No clinical postings logged yet.</div>
            <div style="font-size:0.75rem; color:#64748b; margin-top:4px;">When dates fall inside your clinical rotation, mark Present or Absent on the home screen to see stats here.</div>
          </div>
        `;
        return;
      }

      subjectsContainer.innerHTML = stats.clinicalRotations.map(rot => {
        const bunked = (rot.conducted || 0) - (rot.attended || 0);
        const bunkBadgeText = rot.conducted === 0 ? 'No logs' : (bunked === 0 ? '0 Bunked' : `${bunked} Bunked`);
        const bunkBadgeClass = rot.conducted === 0 ? 'stat-badge-none' : (bunked === 0 ? 'stat-badge-eligible' : 'stat-badge-shortage');
        const tipText = rot.conducted === 0 ? 'No clinics logged yet' : (bunked === 0 ? '✅ 100% Attended' : `Missed ${bunked} posting class${bunked > 1 ? 'es' : ''}`);
        return `
          <div class="subject-stat-card">
            <div class="subject-stat-head">
              <h4 class="subject-stat-title">🏥 ${escapeHTML(rot.rotation)}</h4>
              <span class="subject-stat-overall">${rot.attended} / ${rot.conducted} attended (${rot.percentageStr})</span>
            </div>
            <div class="subject-stat-body">
              <div class="stat-type-box type-clinical">
                <div class="stat-type-top">
                  <span class="stat-type-name">Clinical Posting Bunk Tracker</span>
                  <span class="stat-badge ${bunkBadgeClass}">${bunkBadgeText}</span>
                </div>
                <div class="stat-type-numbers">
                  <span>Attended: <strong>${rot.attended}</strong> • Bunked: <strong style="color:${bunked > 0 ? '#f87171' : '#4ade80'}">${bunked}</strong></span>
                  <span class="stat-bunk-tip" style="color:${bunked > 0 ? '#f87171' : '#4ade80'};">${escapeHTML(tipText)}</span>
                </div>
              </div>
            </div>
          </div>
        `;
      }).join('');
      return;
    }

    const filteredSubjects = stats.subjects.filter(subj => {
      if (currentTab === 'theory') return subj.theory.conducted > 0 || subj.hasActivity;
      if (currentTab === 'practical') return subj.practical.conducted > 0 || subj.hasActivity;
      return true;
    });

    if (filteredSubjects.length === 0) {
      subjectsContainer.innerHTML = `
        <div class="overview-empty-state">
          <div class="overview-empty-icon">📊</div>
          <div>No attendance records logged for this filter.</div>
          <div style="font-size:0.75rem; color:#64748b; margin-top:4px;">Cycle attendance on your home screen to see live Theory and Practical percentages here.</div>
        </div>
      `;
      return;
    }

    subjectsContainer.innerHTML = filteredSubjects.map(s => {
      const showTheory = currentTab === 'all' || currentTab === 'theory';
      const showPractical = currentTab === 'all' || currentTab === 'practical';

      const theoryBadgeClass = `stat-badge-${s.theory.status}`;
      const theoryBadgeText = s.theory.status === 'eligible'
        ? `${s.theory.percentageStr} (≥75%)`
        : (s.theory.status === 'shortage' ? `${s.theory.percentageStr} Shortage` : '0 classes');

      const practicalBadgeClass = `stat-badge-${s.practical.status}`;
      const practicalBadgeText = s.practical.status === 'eligible'
        ? `${s.practical.percentageStr} (≥75%)`
        : (s.practical.status === 'shortage' ? `${s.practical.percentageStr} Shortage` : '0 classes');

      const theoryHtml = showTheory ? `
        <div class="stat-type-box type-theory">
          <div class="stat-type-top">
            <span class="stat-type-name">Theory (75% Req)</span>
            <span class="stat-badge ${theoryBadgeClass}">${theoryBadgeText}</span>
          </div>
          <div class="stat-type-numbers">
            <span>Attended: <strong>${s.theory.attended}</strong> / ${s.theory.conducted}</span>
            <span class="stat-bunk-tip ${s.theory.status === 'shortage' ? 'text-shortage' : (s.theory.conducted === 0 ? 'text-muted' : '')}">${escapeHTML(s.theory.tipText)}</span>
          </div>
        </div>
      ` : '';

      const practicalHtml = showPractical ? `
        <div class="stat-type-box type-practical">
          <div class="stat-type-top">
            <span class="stat-type-name">Practical${s.hasClinicalMerged ? ' + Clinical' : ''} (75% Req)</span>
            <span class="stat-badge ${practicalBadgeClass}">${practicalBadgeText}</span>
          </div>
          <div class="stat-type-numbers">
            <span>Attended: <strong>${s.practical.attended}</strong> / ${s.practical.conducted}${s.hasClinicalMerged ? ' <span style="font-size:0.68rem;color:#0d9488;font-style:italic;">(incl. posting days)</span>' : ''}</span>
            <span class="stat-bunk-tip ${s.practical.status === 'shortage' ? 'text-shortage' : (s.practical.conducted === 0 ? 'text-muted' : '')}">${escapeHTML(s.practical.tipText)}</span>
          </div>
        </div>
      ` : '';

      return `
        <div class="subject-stat-card" data-subject="${escapeHTML(s.subject)}">
          <div class="subject-stat-head">
            <h4 class="subject-stat-title">${escapeHTML(s.subject)}</h4>
            <span class="subject-stat-overall">Overall: <strong>${s.totalPctStr}</strong> (${s.totalAttended}/${s.totalConducted})</span>
          </div>
          <div class="subject-stat-body">
            ${theoryHtml}
            ${practicalHtml}
          </div>
        </div>
      `;
    }).join('');
  }
}

/* ==========================================================================
   13. +1 OR -1 IMPACT PREDICTOR PANEL
   ========================================================================== */
function initPlusMinusPanel() {
  const panel = document.getElementById('plus-minus-panel');
  if (!panel) return;

  const backBtn = document.getElementById('pm-panel-back-btn');
  const refreshBtn = document.getElementById('pm-refresh-btn');
  const dateLabel = document.getElementById('pm-current-date-label');
  const subjectsContainer = document.getElementById('pm-subjects-container');
  const tabPills = document.querySelectorAll('.pm-tab-pill');

  let currentTab = 'all'; // 'all' | 'theory' | 'practical' | 'total'

  function openPanel() {
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    renderPlusMinusView();
  }

  function closePanel() {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
  }

  window.openPlusMinusPanel = openPanel;

  if (backBtn) backBtn.addEventListener('click', closePanel);
  if (refreshBtn) refreshBtn.addEventListener('click', renderPlusMinusView);

  tabPills.forEach(pill => {
    pill.addEventListener('click', () => {
      tabPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentTab = pill.getAttribute('data-tab');
      renderPlusMinusView();
    });
  });

  function calculateComponentMetrics(attended, conducted) {
    if (conducted === 0) {
      return {
        hasHistory: false,
        attended: 0,
        conducted: 0,
        pct: 0
      };
    }

    const curPct = (attended / conducted) * 100;

    // +1 class: Attend
    const plusAttended = attended + 1;
    const plusConducted = conducted + 1;
    const plusPct = (plusAttended / plusConducted) * 100;
    const gainDelta = plusPct - curPct;

    // -1 class: Bunk
    const minusAttended = attended;
    const minusConducted = conducted + 1;
    const minusPct = (minusAttended / minusConducted) * 100;
    const lossDelta = curPct - minusPct;

    // 1% sensitivity: classes to gain +1%
    let classesToGain1Pct = null;
    if (curPct < 99.0) {
      const targetGain = curPct + 1.0;
      const t = targetGain / 100.0;
      if (t < 1.0) {
        classesToGain1Pct = Math.max(1, Math.ceil((t * conducted - attended) / (1 - t)));
      }
    }

    // 1% sensitivity: classes to lose -1%
    let classesToLose1Pct = null;
    if (curPct > 1.0) {
      const targetLoss = curPct - 1.0;
      const tl = targetLoss / 100.0;
      if (tl > 0) {
        classesToLose1Pct = Math.max(1, Math.ceil((attended - tl * conducted) / tl));
      }
    }

    return {
      hasHistory: true,
      attended,
      conducted,
      curPct: Math.round(curPct * 100) / 100,
      plusPct: Math.round(plusPct * 100) / 100,
      gainDelta: Math.round(gainDelta * 100) / 100,
      minusPct: Math.round(minusPct * 100) / 100,
      lossDelta: Math.round(lossDelta * 100) / 100,
      classesToGain1Pct,
      classesToLose1Pct
    };
  }

  function renderPlusMinusView() {
    const todayStr = formatDateISO(activeDate);
    if (dateLabel) dateLabel.textContent = formatDateDisplay(activeDate);

    const allRecords = AttendanceStorage.getAllRecords();

    // Map sessions to classType
    const sessionTypeMap = {};
    const semesters = SemesterStorage.getSemesters();
    semesters.forEach(s => {
      (s.entries || []).forEach(e => {
        if (e.id) {
          sessionTypeMap[e.id] = e.classType || 'theory';
        }
      });
    });

    // Aggregate attendance up to activeDate
    const subjectStats = {};
    MBBS_19_SUBJECTS.forEach(s => {
      subjectStats[s] = {
        theory: { attended: 0, conducted: 0 },
        practical: { attended: 0, conducted: 0 }
      };
    });

    Object.values(allRecords).forEach(rec => {
      if (!rec || !rec.date) return;
      if (rec._duplicateOf) return; // Skip duplicate short-key entries
      if (rec.date > todayStr) return; // Only count up to current date!
      if (rec.status !== 'present' && rec.status !== 'absent') return;

      const rawSubj = (rec.subject || '').trim();
      if (!rawSubj) return;

      const isPresent = rec.status === 'present';
      const isPosting = rawSubj.toLowerCase().includes('clinical posting') || rawSubj.toLowerCase().includes('clinic');

      if (isPosting) {
        let rotationName = 'General Clinical Posting';
        const match = rawSubj.match(/\((.*?)\)/);
        if (match && match[1]) {
          rotationName = match[1].trim();
        }

        // Merge clinical postings into the respective subject's practical counts
        if (rotationName !== 'General Clinical Posting') {
          const normClinSubj = MBBS_19_SUBJECTS.find(s => s.toLowerCase() === rotationName.toLowerCase()) || rotationName;
          if (!subjectStats[normClinSubj]) {
            subjectStats[normClinSubj] = {
              theory: { attended: 0, conducted: 0 },
              practical: { attended: 0, conducted: 0 }
            };
          }
          subjectStats[normClinSubj].practical.conducted++;
          if (isPresent) subjectStats[normClinSubj].practical.attended++;
        }
        return;
      }

      const normSubject = MBBS_19_SUBJECTS.find(s => s.toLowerCase() === rawSubj.toLowerCase()) || rawSubj;
      if (!subjectStats[normSubject]) {
        subjectStats[normSubject] = {
          theory: { attended: 0, conducted: 0 },
          practical: { attended: 0, conducted: 0 }
        };
      }

      let cType = rec.classType;
      if (!cType && rec.sessionId && sessionTypeMap[rec.sessionId]) {
        cType = sessionTypeMap[rec.sessionId];
      }
      if (cType !== 'practical') cType = 'theory';

      if (cType === 'practical') {
        subjectStats[normSubject].practical.conducted++;
        if (isPresent) subjectStats[normSubject].practical.attended++;
      } else {
        subjectStats[normSubject].theory.conducted++;
        if (isPresent) subjectStats[normSubject].theory.attended++;
      }
    });

    // Integrate Past Attendance History (Baseline college portal records)
    const allHistory = AttendanceHistoryStorage.getAllHistory();
    allHistory.forEach(h => {
      const rawSubj = (h.subject || '').trim();
      if (!rawSubj) return;
      const normSubject = MBBS_19_SUBJECTS.find(s => s.toLowerCase() === rawSubj.toLowerCase()) || rawSubj;
      if (!subjectStats[normSubject]) {
        subjectStats[normSubject] = {
          theory: { attended: 0, conducted: 0 },
          practical: { attended: 0, conducted: 0 }
        };
      }

      let tHeld = h.theoryHeld || 0;
      let tAtt = h.theoryAttended || 0;
      let pHeld = h.practicalHeld || 0;
      let pAtt = h.practicalAttended || 0;

      if (tHeld === 0 && pHeld === 0 && h.totalHeld > 0) {
        tHeld = h.totalHeld;
        tAtt = h.attended || 0;
      }

      subjectStats[normSubject].theory.conducted += tHeld;
      subjectStats[normSubject].theory.attended += tAtt;
      subjectStats[normSubject].practical.conducted += pHeld;
      subjectStats[normSubject].practical.attended += pAtt;
    });

    if (!subjectsContainer) return;

    function renderComponentHtml(title, compClass, m) {
      if (!m.hasHistory) {
        return `
          <div class="pm-section-box ${compClass}">
            <div class="pm-section-top">
              <span class="pm-section-label">${title}</span>
            </div>
            <div class="pm-no-history">No history available (0 classes held till date)</div>
          </div>
        `;
      }

      let sensGainText = m.classesToGain1Pct !== null
        ? `<span>📈 Attend <strong>${m.classesToGain1Pct}</strong> class${m.classesToGain1Pct > 1 ? 'es' : ''} to gain <strong>+1%</strong></span>`
        : `<span>📈 Max attendance reached (cannot gain +1%)</span>`;

      let sensLossText = m.classesToLose1Pct !== null
        ? `<span>📉 Bunk <strong>${m.classesToLose1Pct}</strong> class${m.classesToLose1Pct > 1 ? 'es' : ''} to lose <strong>-1%</strong></span>`
        : `<span>📉 Min attendance reached</span>`;

      return `
        <div class="pm-section-box ${compClass}">
          <div class="pm-section-top">
            <span class="pm-section-label">${title}</span>
            <span class="pm-current-standing">Current: ${m.curPct}% (${m.attended}/${m.conducted})</span>
          </div>

          <div class="pm-shifts-row">
            <div class="pm-shift-item gain">
              <span class="pm-shift-label">If Attend (+1)</span>
              <div class="pm-shift-val-row">
                <span class="pm-new-pct">${m.plusPct}%</span>
                <span class="pm-delta-badge gain">+${m.gainDelta}%</span>
              </div>
            </div>

            <div class="pm-shift-item loss">
              <span class="pm-shift-label">If Bunk (-1)</span>
              <div class="pm-shift-val-row">
                <span class="pm-new-pct">${m.minusPct}%</span>
                <span class="pm-delta-badge loss">-${m.lossDelta}%</span>
              </div>
            </div>
          </div>

          <div class="pm-sensitivity-note">
            <div class="pm-sens-line">${sensGainText}</div>
            <div class="pm-sens-line">${sensLossText}</div>
          </div>
        </div>
      `;
    }

    const subjectList = Object.keys(subjectStats).map(subj => {
      const d = subjectStats[subj];
      const theory = calculateComponentMetrics(d.theory.attended, d.theory.conducted);
      const practical = calculateComponentMetrics(d.practical.attended, d.practical.conducted);
      const totalAtt = d.theory.attended + d.practical.attended;
      const totalCond = d.theory.conducted + d.practical.conducted;
      const total = calculateComponentMetrics(totalAtt, totalCond);
      const hasAnyHistory = totalCond > 0;

      return {
        subject: subj,
        theory,
        practical,
        total,
        hasAnyHistory
      };
    });

    subjectList.sort((a, b) => {
      if (a.hasAnyHistory && !b.hasAnyHistory) return -1;
      if (!a.hasAnyHistory && b.hasAnyHistory) return 1;
      return a.subject.localeCompare(b.subject);
    });

    subjectsContainer.innerHTML = subjectList.map(s => {
      const showTheory = currentTab === 'all' || currentTab === 'theory';
      const showPractical = currentTab === 'all' || currentTab === 'practical';
      const showTotal = currentTab === 'all' || currentTab === 'total';

      const theoryBox = showTheory ? renderComponentHtml('Theory', 'theory', s.theory) : '';
      const practicalBox = showPractical ? renderComponentHtml('Practical', 'practical', s.practical) : '';
      const totalBox = showTotal ? renderComponentHtml('Total (Combined)', 'total', s.total) : '';

      const subText = s.hasAnyHistory
        ? `Total logged: ${s.total.conducted} classes held`
        : `No classes held till date`;

      return `
        <div class="pm-card" data-subject="${escapeHTML(s.subject)}">
          <div class="pm-card-head">
            <span class="pm-card-title">${escapeHTML(s.subject)}</span>
            <span class="pm-card-sub">${subText}</span>
          </div>
          <div style="display:flex; flex-direction:column; gap:8px;">
            ${theoryBox}
            ${practicalBox}
            ${totalBox}
          </div>
        </div>
      `;
    }).join('');
  }
}

/* ==========================================================================
   14. BACKUP & RESTORE (EXPORT / IMPORT) PANEL
   ========================================================================== */
function initBackupPanel() {
  const panel = document.getElementById('backup-panel');
  if (!panel) return;

  const backBtn = document.getElementById('backup-panel-back-btn');
  const exportBtn = document.getElementById('btn-export-data');
  const shareBtn = document.getElementById('btn-share-data');
  const fileInput = document.getElementById('backup-file-input');
  const fileNameDisplay = document.getElementById('backup-file-name');
  const previewBox = document.getElementById('backup-import-preview');
  const previewDetails = document.getElementById('backup-preview-details');
  const confirmBtn = document.getElementById('btn-confirm-import');
  const statusMsg = document.getElementById('backup-status-msg');

  let pendingImportData = null;

  function openPanel() {
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    resetImportUI();
  }

  function closePanel() {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    resetImportUI();
  }

  window.openBackupPanel = openPanel;

  if (backBtn) backBtn.addEventListener('click', closePanel);

  function resetImportUI() {
    pendingImportData = null;
    if (fileInput) fileInput.value = '';
    if (fileNameDisplay) {
      fileNameDisplay.textContent = '';
      fileNameDisplay.classList.add('hidden');
    }
    if (previewBox) previewBox.classList.add('hidden');
    if (statusMsg) {
      statusMsg.className = 'backup-status-msg hidden';
      statusMsg.textContent = '';
    }
  }

  function getBackupBundle() {
    return {
      app: 'MBBS Attendance Manager',
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        mbbs_attendance_v1: localStorage.getItem('mbbs_attendance_v1') || '{}',
        mbbs_semesters_v1: localStorage.getItem('mbbs_semesters_v1') || '{"version":1,"semesters":[]}',
        mbbs_active_semester_v1: localStorage.getItem('mbbs_active_semester_v1') || '{"version":1,"currentSemesterId":null,"activationHistory":[]}',
        mbbs_clinical_postings_v1: localStorage.getItem('mbbs_clinical_postings_v1') || '{"version":1,"postings":[]}',
        mbbs_class_replacements_v1: localStorage.getItem('mbbs_class_replacements_v1') || '{"version":1,"dates":{}}',
        mbbs_attendance_history_v1: localStorage.getItem('mbbs_attendance_history_v1') || '{"version":1,"history":[]}'
      }
    };
  }

  // --- Export Data (Download to device) ---
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      try {
        const backupBundle = getBackupBundle();
        const jsonStr = JSON.stringify(backupBundle, null, 2);
        const todayStr = formatDateISO(new Date());
        const fileName = `mbbs_attendance_backup_${todayStr}.json`;

        // Native Android Bridge: direct write to Android Downloads folder
        if (window.AndroidApp && typeof window.AndroidApp.saveBackupFile === 'function') {
          const success = window.AndroidApp.saveBackupFile(jsonStr, fileName);
          if (success) {
            showToast('Backup saved to your Downloads folder!');
          }
          return;
        }

        // Web / desktop browser fallback
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('Backup file downloaded to your device!');
      } catch (err) {
        console.error('Export error:', err);
        showToast('Failed to export backup.');
      }
    });
  }

  // --- Share Backup (Google Drive, WhatsApp, Files) ---
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      try {
        const backupBundle = getBackupBundle();
        const jsonStr = JSON.stringify(backupBundle, null, 2);
        const todayStr = formatDateISO(new Date());
        const fileName = `mbbs_attendance_backup_${todayStr}.json`;

        // Native Android Bridge: opens Android system share sheet
        if (window.AndroidApp && typeof window.AndroidApp.shareBackupFile === 'function') {
          window.AndroidApp.shareBackupFile(jsonStr, fileName);
          return;
        }

        // Web Share API fallback
        if (navigator.share) {
          const file = new File([jsonStr], fileName, { type: 'application/json' });
          navigator.share({
            title: 'MBBS Attendance Backup',
            files: [file]
          }).catch((err) => {
            console.log('Share dismissed or failed:', err);
          });
        } else {
          showToast('Use "Download Backup File" to save to your device.');
        }
      } catch (err) {
        console.error('Share error:', err);
        showToast('Failed to share backup.');
      }
    });
  }

  // --- File Select / Import ---
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      if (fileNameDisplay) {
        fileNameDisplay.textContent = `Selected: ${file.name} (${Math.round(file.size / 1024)} KB)`;
        fileNameDisplay.classList.remove('hidden');
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const parsed = JSON.parse(event.target.result);
          if (!parsed || !parsed.data) {
            throw new Error('Invalid format: Missing backup data payload.');
          }

          pendingImportData = parsed;

          // Parse attendance records count
          let attendanceCount = 0;
          try {
            const att = JSON.parse(parsed.data.mbbs_attendance_v1 || '{}');
            if (att && att.records) attendanceCount = Object.keys(att.records).length;
          } catch (_) {}

          // Parse semesters count
          let semestersCount = 0;
          try {
            const sem = JSON.parse(parsed.data.mbbs_semesters_v1 || '{}');
            if (sem && Array.isArray(sem.semesters)) semestersCount = sem.semesters.length;
          } catch (_) {}

          // Parse clinical postings count
          let postingsCount = 0;
          try {
            const post = JSON.parse(parsed.data.mbbs_clinical_postings_v1 || '{}');
            if (post && Array.isArray(post.postings)) postingsCount = post.postings.length;
          } catch (_) {}

          // Parse past attendance history count
          let historyCount = 0;
          try {
            const hist = JSON.parse(parsed.data.mbbs_attendance_history_v1 || '{}');
            if (hist && Array.isArray(hist.history)) historyCount = hist.history.length;
          } catch (_) {}

          if (previewDetails) {
            previewDetails.innerHTML = `
              <div>• Exported Date: <strong>${parsed.exportedAt ? formatDateDisplayShort(parsed.exportedAt.substring(0, 10)) : 'Unknown'}</strong></div>
              <div>• Logged Attendance: <strong>${attendanceCount} records</strong></div>
              <div>• Past History Records: <strong>${historyCount} records</strong></div>
              <div>• Semester Templates: <strong>${semestersCount} configured</strong></div>
              <div>• Clinical Rotations: <strong>${postingsCount} postings</strong></div>
            `;
          }

          if (previewBox) previewBox.classList.remove('hidden');
          if (statusMsg) statusMsg.classList.add('hidden');
        } catch (err) {
          console.error('Import parse error:', err);
          pendingImportData = null;
          if (previewBox) previewBox.classList.add('hidden');
          if (statusMsg) {
            statusMsg.className = 'backup-status-msg error';
            statusMsg.textContent = 'Failed to read file: Not a valid MBBS Attendance backup JSON.';
            statusMsg.classList.remove('hidden');
          }
        }
      };

      reader.readAsText(file);
    });
  }

  // --- Confirm Import ---
  if (confirmBtn) {
    confirmBtn.addEventListener('click', () => {
      if (!pendingImportData || !pendingImportData.data) return;

      try {
        const d = pendingImportData.data;

        if (d.mbbs_attendance_v1) localStorage.setItem('mbbs_attendance_v1', d.mbbs_attendance_v1);
        if (d.mbbs_semesters_v1) localStorage.setItem('mbbs_semesters_v1', d.mbbs_semesters_v1);
        if (d.mbbs_active_semester_v1) localStorage.setItem('mbbs_active_semester_v1', d.mbbs_active_semester_v1);
        if (d.mbbs_clinical_postings_v1) localStorage.setItem('mbbs_clinical_postings_v1', d.mbbs_clinical_postings_v1);
        if (d.mbbs_class_replacements_v1) localStorage.setItem('mbbs_class_replacements_v1', d.mbbs_class_replacements_v1);
        if (d.mbbs_attendance_history_v1) localStorage.setItem('mbbs_attendance_history_v1', d.mbbs_attendance_history_v1);

        if (statusMsg) {
          statusMsg.className = 'backup-status-msg success';
          statusMsg.textContent = '✅ Data restored successfully! All attendance and schedules have been updated.';
          statusMsg.classList.remove('hidden');
        }

        if (previewBox) previewBox.classList.add('hidden');
        showToast('Backup restored successfully!');
        loadAttendanceForDate(activeDate);
      } catch (err) {
        console.error('Import restore error:', err);
        if (statusMsg) {
          statusMsg.className = 'backup-status-msg error';
          statusMsg.textContent = 'Failed to write data to local storage.';
          statusMsg.classList.remove('hidden');
        }
      }
    });
  }
}

/* ==========================================================================
   15. SECONDARY MENU & FEATURE ROUTING
   ========================================================================== */
function initMenuInteraction() {
  const starBtn = document.getElementById('star-menu-btn');
  const closeMenuBtn = document.getElementById('close-menu-btn');
  const settingsBtn = document.getElementById('menu-settings-btn');
  const menuOverlay = document.getElementById('menu-overlay');
  const menuBackdrop = document.getElementById('menu-backdrop');

  function openMenu() {
    menuOverlay.classList.add('open');
    menuOverlay.setAttribute('aria-hidden', 'false');
    starBtn.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    menuOverlay.classList.remove('open');
    menuOverlay.setAttribute('aria-hidden', 'true');
    starBtn.setAttribute('aria-expanded', 'false');
  }

  if (starBtn) starBtn.addEventListener('click', openMenu);
  if (closeMenuBtn) closeMenuBtn.addEventListener('click', closeMenu);
  if (menuBackdrop) menuBackdrop.addEventListener('click', closeMenu);
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      if (typeof window.openSettingsPanel === 'function') {
        window.openSettingsPanel();
      } else {
        showToast('Settings option ready.');
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuOverlay.classList.contains('open')) {
      closeMenu();
    }
  });
}

/* ==========================================================================
   14B. ATTENDANCE HISTORY PANEL (Past College Portal Records & Baseline Tracker)
   ========================================================================== */
function initAttendanceHistoryPanel() {
  const panel = document.getElementById('attendance-history-panel');
  if (!panel) return;

  const backBtn = document.getElementById('ah-panel-back-btn');
  const createNewBtn = document.getElementById('ah-create-new-btn');
  const listView = document.getElementById('ah-list-view');
  const editorView = document.getElementById('ah-editor-view');
  const recordsContainer = document.getElementById('ah-records-container');
  const countSpan = document.getElementById('ah-records-count');

  // Editor form controls (Separate Attended & Bunked inputs)
  const editorTitle = document.getElementById('ah-editor-title');
  const editIdInput = document.getElementById('ah-edit-id');
  const subjectSelect = document.getElementById('ah-subject-select');
  const totalHeldInput = document.getElementById('ah-total-held-input');
  const attendedInput = document.getElementById('ah-attended-input');
  const absentInput = document.getElementById('ah-absent-input');
  const calcHeldSpan = document.getElementById('ah-calc-held');
  const calcAttendedSpan = document.getElementById('ah-calc-attended');
  const calcAbsentSpan = document.getElementById('ah-calc-absent');
  const calcPctSpan = document.getElementById('ah-calc-pct');
  const theoryPctInput = document.getElementById('ah-theory-pct-input');
  const practicalPctInput = document.getElementById('ah-practical-pct-input');
  const solvedTheorySpan = document.getElementById('ah-solved-theory');
  const solvedPracticalSpan = document.getElementById('ah-solved-practical');
  const errorMsg = document.getElementById('ah-editor-error-msg');
  const cancelBtn = document.getElementById('ah-editor-cancel-btn');
  const saveBtn = document.getElementById('ah-editor-save-btn');

  function openPanel() {
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    showListView();
  }

  function closePanel() {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    hideEditor();
  }

  window.openAttendanceHistoryPanel = openPanel;

  if (backBtn) backBtn.addEventListener('click', closePanel);

  function showListView() {
    if (editorView) editorView.classList.add('hidden');
    if (listView) listView.classList.remove('hidden');
    renderHistoryList();
  }

  function hideEditor() {
    if (editorView) editorView.classList.add('hidden');
    if (listView) listView.classList.remove('hidden');
  }

  function showEditor(editId = null) {
    if (listView) listView.classList.add('hidden');
    if (editorView) editorView.classList.remove('hidden');

    if (errorMsg) {
      errorMsg.textContent = '';
      errorMsg.classList.add('hidden');
    }

    if (editId) {
      const record = AttendanceHistoryStorage.getHistoryById(editId);
      if (record) {
        if (editorTitle) editorTitle.textContent = `Edit Past Record: ${record.subject}`;
        if (editIdInput) editIdInput.value = record.id;
        if (subjectSelect) subjectSelect.innerHTML = renderSubjectOptions(record.subject, false);
        if (totalHeldInput) totalHeldInput.value = record.totalHeld;
        if (attendedInput) attendedInput.value = record.attended;
        if (absentInput) absentInput.value = record.absent;
        if (theoryPctInput) theoryPctInput.value = record.theoryPct != null ? record.theoryPct : '';
        if (practicalPctInput) practicalPctInput.value = record.practicalPct != null ? record.practicalPct : '';
      }
    } else {
      if (editorTitle) editorTitle.textContent = 'Create Past Record';
      if (editIdInput) editIdInput.value = '';
      if (subjectSelect) subjectSelect.innerHTML = renderSubjectOptions('', false);
      if (totalHeldInput) totalHeldInput.value = '';
      if (attendedInput) attendedInput.value = '';
      if (absentInput) absentInput.value = '';
      if (theoryPctInput) theoryPctInput.value = '';
      if (practicalPctInput) practicalPctInput.value = '';
    }

    updateLiveCalculations();
  }

  function updateLiveCalculations() {
    let held = parseInt(totalHeldInput && totalHeldInput.value !== '' ? totalHeldInput.value : 0, 10);
    let attended = parseInt(attendedInput && attendedInput.value !== '' ? attendedInput.value : 0, 10);
    let absent = parseInt(absentInput && absentInput.value !== '' ? absentInput.value : 0, 10);

    if (isNaN(held)) held = 0;
    if (isNaN(attended)) attended = 0;
    if (isNaN(absent)) absent = 0;

    if (held === 0 && (attended > 0 || absent > 0)) {
      held = attended + absent;
    }

    const pct = held > 0 ? (attended / held * 100).toFixed(1) : '0.0';

    if (calcHeldSpan) calcHeldSpan.textContent = held;
    if (calcAttendedSpan) calcAttendedSpan.textContent = attended;
    if (calcAbsentSpan) calcAbsentSpan.textContent = absent;
    if (calcPctSpan) calcPctSpan.textContent = `${pct}%`;

    // Solve Theory & Practical breakdown using portal percentages if entered
    const rawTheoryPct = theoryPctInput && theoryPctInput.value !== '' ? parseFloat(theoryPctInput.value) : null;
    const rawPracticalPct = practicalPctInput && practicalPctInput.value !== '' ? parseFloat(practicalPctInput.value) : null;

    const solved = solveTheoryPracticalBreakdown(held, attended, rawTheoryPct, rawPracticalPct);

    if (solvedTheorySpan) {
      if (solved.theoryHeld > 0) {
        const tPct = (solved.theoryAttended / solved.theoryHeld * 100).toFixed(1);
        solvedTheorySpan.textContent = `${solved.theoryAttended} / ${solved.theoryHeld} (${tPct}%)`;
      } else {
        solvedTheorySpan.textContent = '0 / 0 (--%)';
      }
    }

    if (solvedPracticalSpan) {
      if (solved.practicalHeld > 0) {
        const pPct = (solved.practicalAttended / solved.practicalHeld * 100).toFixed(1);
        solvedPracticalSpan.textContent = `${solved.practicalAttended} / ${solved.practicalHeld} (${pPct}%)`;
      } else {
        solvedPracticalSpan.textContent = '0 / 0 (--%)';
      }
    }
  }

  // Smart two-way binding between Total Held, Attended, and Absent
  if (totalHeldInput) {
    totalHeldInput.addEventListener('input', () => {
      const held = parseInt(totalHeldInput.value, 10);
      const attended = parseInt(attendedInput.value, 10);
      if (!isNaN(held) && !isNaN(attended) && attended <= held) {
        absentInput.value = held - attended;
      }
      updateLiveCalculations();
    });
  }

  if (attendedInput) {
    attendedInput.addEventListener('input', () => {
      const attended = parseInt(attendedInput.value, 10);
      const held = parseInt(totalHeldInput.value, 10);
      if (!isNaN(held) && !isNaN(attended)) {
        if (attended <= held) {
          absentInput.value = held - attended;
        }
      } else if (isNaN(held) && !isNaN(attended)) {
        const absent = parseInt(absentInput.value, 10);
        if (!isNaN(absent)) {
          totalHeldInput.value = attended + absent;
        }
      }
      updateLiveCalculations();
    });
  }

  if (absentInput) {
    absentInput.addEventListener('input', () => {
      const absent = parseInt(absentInput.value, 10);
      const held = parseInt(totalHeldInput.value, 10);
      if (!isNaN(held) && !isNaN(absent)) {
        if (absent <= held) {
          attendedInput.value = held - absent;
        }
      } else if (isNaN(held) && !isNaN(absent)) {
        const attended = parseInt(attendedInput.value, 10);
        if (!isNaN(attended)) {
          totalHeldInput.value = attended + absent;
        }
      }
      updateLiveCalculations();
    });
  }

  if (theoryPctInput) theoryPctInput.addEventListener('input', updateLiveCalculations);
  if (practicalPctInput) practicalPctInput.addEventListener('input', updateLiveCalculations);

  if (createNewBtn) {
    createNewBtn.addEventListener('click', () => showEditor(null));
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', showListView);
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      if (errorMsg) {
        errorMsg.classList.add('hidden');
        errorMsg.textContent = '';
      }

      const subject = subjectSelect ? subjectSelect.value.trim() : '';
      let totalHeld = parseInt(totalHeldInput ? totalHeldInput.value : 0, 10);
      let attended = parseInt(attendedInput ? attendedInput.value : 0, 10);
      let absent = parseInt(absentInput ? absentInput.value : 0, 10);

      if (!subject) {
        if (errorMsg) {
          errorMsg.textContent = 'Please select a subject from the 19 MBBS subjects.';
          errorMsg.classList.remove('hidden');
        }
        return;
      }

      if (isNaN(attended) || attended < 0) attended = 0;
      if (isNaN(absent) || absent < 0) absent = 0;

      if (isNaN(totalHeld) || totalHeld <= 0) {
        if (attended > 0 || absent > 0) {
          totalHeld = attended + absent;
          totalHeldInput.value = totalHeld;
        } else {
          if (errorMsg) {
            errorMsg.textContent = 'Please enter total number of classes held (greater than 0).';
            errorMsg.classList.remove('hidden');
          }
          return;
        }
      }

      if (attended + absent !== totalHeld) {
        // Auto reconcile if user typed one and didn't touch the other
        if (attended <= totalHeld && (!absentInput.value || absent === 0)) {
          absent = totalHeld - attended;
          absentInput.value = absent;
        } else if (absent <= totalHeld && (!attendedInput.value || attended === 0)) {
          attended = totalHeld - absent;
          attendedInput.value = attended;
        } else {
          if (errorMsg) {
            errorMsg.textContent = `Classes Attended (${attended}) + Classes Bunked (${absent}) must equal Total Classes Held (${totalHeld}).`;
            errorMsg.classList.remove('hidden');
          }
          return;
        }
      }

      const rawTheoryPct = theoryPctInput && theoryPctInput.value !== '' ? parseFloat(theoryPctInput.value) : null;
      const rawPracticalPct = practicalPctInput && practicalPctInput.value !== '' ? parseFloat(practicalPctInput.value) : null;

      const solved = solveTheoryPracticalBreakdown(totalHeld, attended, rawTheoryPct, rawPracticalPct);

      const id = editIdInput ? editIdInput.value : '';

      const res = AttendanceHistoryStorage.saveHistoryRecord({
        id: id || null,
        subject,
        totalHeld,
        attended,
        absent,
        theoryHeld: solved.theoryHeld,
        theoryAttended: solved.theoryAttended,
        theoryPct: rawTheoryPct,
        practicalHeld: solved.practicalHeld,
        practicalAttended: solved.practicalAttended,
        practicalPct: rawPracticalPct
      });

      if (!res.success) {
        if (errorMsg) {
          errorMsg.textContent = res.error;
          errorMsg.classList.remove('hidden');
        }
        return;
      }

      showToast(`Saved attendance history for ${subject}!`);
      showListView();
      loadAttendanceForDate(activeDate);
    });
  }

  function renderHistoryList() {
    const list = AttendanceHistoryStorage.getAllHistory();
    if (countSpan) countSpan.textContent = list.length;

    if (!recordsContainer) return;

    if (list.length === 0) {
      recordsContainer.innerHTML = `
        <div class="tt-empty-msg">
          No past attendance history logged yet.<br>
          Tap <strong>+ Create New</strong> at the top right to enter past college portal attendance.
        </div>
      `;
      return;
    }

    recordsContainer.innerHTML = list.map(item => {
      const isEligible = item.percentage >= 75;
      const statusClass = isEligible ? 'status-eligible' : 'status-shortage';

      let breakdownBadges = '';
      if (item.theoryHeld > 0 || item.practicalHeld > 0) {
        const tPct = item.theoryHeld > 0 ? (item.theoryAttended / item.theoryHeld * 100).toFixed(1) : '--';
        const pPct = item.practicalHeld > 0 ? (item.practicalAttended / item.practicalHeld * 100).toFixed(1) : '--';
        breakdownBadges = `
          <div class="ah-card-breakdown-row">
            ${item.theoryHeld > 0 ? `<span class="ah-tag-pill">📖 Theory: <strong>${item.theoryAttended}/${item.theoryHeld} (${tPct}%)</strong></span>` : ''}
            ${item.practicalHeld > 0 ? `<span class="ah-tag-pill">🔬 Practical: <strong>${item.practicalAttended}/${item.practicalHeld} (${pPct}%)</strong></span>` : ''}
          </div>
        `;
      }

      return `
        <div class="ah-card" data-history-id="${item.id}">
          <div class="ah-card-head">
            <span class="ah-card-title">${escapeHTML(item.subject)}</span>
            <span class="ah-card-pct-badge ${statusClass}">${item.percentage}%</span>
          </div>

          <div class="ah-card-stats-grid">
            <div class="ah-stat-col">
              <span class="ah-stat-lbl">Held</span>
              <span class="ah-stat-num">${item.totalHeld}</span>
            </div>
            <div class="ah-stat-col">
              <span class="ah-stat-lbl">Attended</span>
              <span class="ah-stat-num" style="color:#4ade80;">${item.attended}</span>
            </div>
            <div class="ah-stat-col">
              <span class="ah-stat-lbl">Bunked</span>
              <span class="ah-stat-num" style="color:#f87171;">${item.absent}</span>
            </div>
          </div>

          ${breakdownBadges}

          <div class="clinical-card-actions" style="margin-top:4px;">
            <button type="button" class="sem-btn" data-ah-edit-id="${item.id}">Edit</button>
            <button type="button" class="sem-btn btn-del" data-ah-del-id="${item.id}">Delete</button>
          </div>
        </div>
      `;
    }).join('');

    recordsContainer.querySelectorAll('[data-ah-edit-id]').forEach(btn => {
      btn.addEventListener('click', () => showEditor(btn.getAttribute('data-ah-edit-id')));
    });

    recordsContainer.querySelectorAll('[data-ah-del-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-ah-del-id');
        const item = AttendanceHistoryStorage.getHistoryById(id);
        if (!item) return;
        if (confirm(`Remove past attendance record for "${item.subject}" (${item.attended}/${item.totalHeld})?`)) {
          AttendanceHistoryStorage.deleteHistoryRecord(id);
          showToast(`Removed past record for ${item.subject}.`);
          renderHistoryList();
          loadAttendanceForDate(activeDate);
        }
      });
    });
  }
}

/* ==========================================================================
   16. FEATURE PANELS ROUTER & PLACEHOLDERS
   ========================================================================== */
function initFeaturePanel() {
  const menuPills = document.querySelectorAll('.menu-pill');
  const featurePanel = document.getElementById('feature-panel');
  const panelTitle = document.getElementById('panel-title');
  const panelDesc = document.getElementById('panel-desc');
  const panelBackBtn = document.getElementById('panel-back-btn');
  const menuOverlay = document.getElementById('menu-overlay');

  const featureDescriptions = {
    'Attendance History': 'Review past logged attendance dates, monthly records, and session history.'
  };

  function openFeature(featureName) {
    menuOverlay.classList.remove('open');
    menuOverlay.setAttribute('aria-hidden', 'true');

    if (featureName === 'Semester Timetable') {
      if (typeof window.openSemesterTimetablePanel === 'function') {
        window.openSemesterTimetablePanel();
      }
      return;
    }

    if (featureName === 'Clinical Timetable') {
      if (typeof window.openClinicalTimetablePanel === 'function') {
        window.openClinicalTimetablePanel();
      }
      return;
    }

    if (featureName === 'Replace Classes') {
      if (typeof window.openReplaceClassesPanel === 'function') {
        window.openReplaceClassesPanel();
      }
      return;
    }

    if (featureName === 'Overview Attendance') {
      if (typeof window.openOverviewAttendancePanel === 'function') {
        window.openOverviewAttendancePanel();
      }
      return;
    }

    if (featureName === '+1 or -1') {
      if (typeof window.openPlusMinusPanel === 'function') {
        window.openPlusMinusPanel();
      }
      return;
    }

    if (featureName === 'Export / Import') {
      if (typeof window.openBackupPanel === 'function') {
        window.openBackupPanel();
      }
      return;
    }

    if (featureName === 'Attendance History') {
      if (typeof window.openAttendanceHistoryPanel === 'function') {
        window.openAttendanceHistoryPanel();
      }
      return;
    }

    panelTitle.textContent = featureName;
    panelDesc.textContent = featureDescriptions[featureName] || 'Placeholder panel for this module.';

    featurePanel.classList.add('open');
    featurePanel.setAttribute('aria-hidden', 'false');
  }

  function closeFeature() {
    featurePanel.classList.remove('open');
    featurePanel.setAttribute('aria-hidden', 'true');
  }

  menuPills.forEach(pill => {
    pill.addEventListener('click', () => {
      const feature = pill.getAttribute('data-feature');
      openFeature(feature);
    });
  });

  if (panelBackBtn) {
    panelBackBtn.addEventListener('click', closeFeature);
  }
}

/* ==========================================================================
   17. SETTINGS PANEL (Feedback & Creator Credits)
   ========================================================================== */
function initSettingsPanel() {
  const panel = document.getElementById('settings-panel');
  if (!panel) return;

  const backBtn = document.getElementById('settings-panel-back-btn');
  const themeCard = document.getElementById('settings-theme-card');
  const themeSwitch = document.getElementById('theme-toggle-btn');
  const menuOverlay = document.getElementById('menu-overlay');

  function openPanel() {
    if (menuOverlay) {
      menuOverlay.classList.remove('open');
      menuOverlay.setAttribute('aria-hidden', 'true');
    }
    ThemeManager.updateThemeUI(ThemeManager.getTheme());
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
  }

  function closePanel() {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
  }

  window.openSettingsPanel = openPanel;

  if (backBtn) backBtn.addEventListener('click', closePanel);

  if (themeCard) {
    themeCard.addEventListener('click', (e) => {
      if (e.target && e.target.closest('#theme-toggle-btn')) return;
      ThemeManager.toggleTheme();
    });
  }

  if (themeSwitch) {
    themeSwitch.addEventListener('click', (e) => {
      e.stopPropagation();
      ThemeManager.toggleTheme();
    });
  }

  const tourCard = document.getElementById('settings-tour-card');
  if (tourCard) {
    tourCard.addEventListener('click', () => {
      closePanel();
      setTimeout(() => {
        TourManager.startTour(true);
      }, 250);
    });
  }
}

/* ==========================================================================
   17B. SPOTLIGHT INTRODUCTION TOUR (Onboarding Coach-Marks)
   ========================================================================== */
const TourManager = (() => {
  const TOUR_STORAGE_KEY = 'mbbs_intro_tour_v1';
  let currentStep = 0;
  let isTourActive = false;

  function closeAllPanels() {
    const menuOverlay = document.getElementById('menu-overlay');
    if (menuOverlay) menuOverlay.classList.remove('open');
    const settingsPanel = document.getElementById('settings-panel');
    if (settingsPanel) settingsPanel.classList.remove('open');
  }

  function openMenuOverlay() {
    const settingsPanel = document.getElementById('settings-panel');
    if (settingsPanel) settingsPanel.classList.remove('open');
    const menuOverlay = document.getElementById('menu-overlay');
    if (menuOverlay) {
      menuOverlay.classList.add('open');
      menuOverlay.setAttribute('aria-hidden', 'false');
    }
  }

  function openSettingsDirectly() {
    const menuOverlay = document.getElementById('menu-overlay');
    if (menuOverlay) menuOverlay.classList.remove('open');
    const settingsPanel = document.getElementById('settings-panel');
    if (settingsPanel) {
      settingsPanel.classList.add('open');
      settingsPanel.setAttribute('aria-hidden', 'false');
    }
  }

  const steps = [
    {
      // 1. Home: Date Stepper
      targetId: 'date-display-wrap',
      title: '📅 Smart Date Navigation',
      desc: 'Tap the arrows or the date to jump to any past or future day. Your classes, timetable replacements, and clinical postings adapt dynamically.',
      prepare: () => closeAllPanels()
    },
    {
      // 2. Home: First class box
      getTarget: () => document.querySelector('#timetable-boxes .class-box') || document.getElementById('timetable-boxes'),
      title: '⚡ Instant Tap & 5s Safety Lock',
      desc: 'Tap any session to cycle: Unmarked ➔ Holiday ➔ Present ➔ Absent. Press & hold 5 seconds to lock/unlock so you never change attendance accidentally.',
      prepare: () => closeAllPanels()
    },
    {
      // 3. Home: Star button
      targetId: 'star-menu-btn',
      title: '⭐ Master Control Center',
      desc: 'Tap this glowing star anytime to access your weekly timetable builders, clinical rotations, replacements, analytics, and settings.',
      prepare: () => closeAllPanels()
    },
    {
      // 4. Menu: Semester Timetable
      getTarget: () => document.querySelector('.menu-pill[data-feature="Semester Timetable"]'),
      title: '🏛️ Semester Timetable Builder',
      desc: 'Create Monday–Saturday weekly schedule templates with all 19 standard MBBS subjects and Theory vs Practical classification.',
      prepare: () => openMenuOverlay()
    },
    {
      // 5. Menu: Clinical Timetable
      getTarget: () => document.querySelector('.menu-pill[data-feature="Clinical Timetable"]'),
      title: '🏥 Clinical Timetable & Rotations',
      desc: 'Schedule clinical postings (Surgery, Medicine, OBG, etc.). Active postings auto-appear on home and merge into subject practicals.',
      prepare: () => openMenuOverlay()
    },
    {
      // 6. Menu: Replace Classes
      getTarget: () => document.querySelector('.menu-pill[data-feature="Replace Classes"]'),
      title: '🔄 Replace Classes & Compensatory',
      desc: 'Substitute subjects on specific dates, cancel sessions, or add extra compensatory classes without changing your semester template.',
      prepare: () => openMenuOverlay()
    },
    {
      // 7. Menu: Overview Attendance
      getTarget: () => document.querySelector('.menu-pill[data-feature="Overview Attendance"]'),
      title: '📊 NMC Overview & Bunk Tracker',
      desc: 'Track NMC 75% Theory & Practical thresholds, safe bunk margins, and your dedicated Clinical Postings bunk tracker.',
      prepare: () => openMenuOverlay()
    },
    {
      // 8. Menu: +1 or -1 Impact Predictor
      getTarget: () => document.querySelector('.menu-pill[data-feature="+1 or -1"]'),
      title: '🎯 +1 or -1 Attendance Impact',
      desc: 'Know before you bunk! Predict exactly how attending (+1) or bunking (-1) tomorrow\'s class will shift your attendance percentage.',
      prepare: () => openMenuOverlay()
    },
    {
      // 9. Menu: Data Backup & History
      getTarget: () => document.querySelector('.menu-pill[data-feature="Export / Import"]'),
      title: '💾 History & Data Backup',
      desc: 'Enter baseline past college portal records and export full offline .json backups to your phone storage to keep your data 100% safe.',
      prepare: () => openMenuOverlay()
    },
    {
      // 10. Checkpoint: Settings Button in Master Control
      targetId: 'menu-settings-btn',
      title: '⚙️ Settings & Customization',
      desc: 'Tap this gear icon at the top right of Master Control to access your app settings, switch themes, replay this tour, and share feedback.',
      prepare: () => openMenuOverlay()
    },
    {
      // 11. Settings: Dark & Light Mode
      targetId: 'settings-theme-card',
      title: '🌙 Dark & Light Theme',
      desc: 'Switch between the sleek high-contrast OLED Dark Mode and clean Light Mode anytime with instant persistence.',
      prepare: () => openSettingsDirectly()
    },
    {
      // 12. Settings: Feedback
      targetId: 'settings-feedback-btn',
      title: '💬 Feedback & Suggestions',
      desc: 'Have a feature suggestion or found a bug? Tap to open the Google Form and help shape upcoming updates to your MBBS app!',
      prepare: () => openSettingsDirectly()
    }
  ];

  function isTourCompleted() {
    try {
      return localStorage.getItem(TOUR_STORAGE_KEY) === 'completed';
    } catch (_) {
      return false;
    }
  }

  function setTourCompleted() {
    try {
      localStorage.setItem(TOUR_STORAGE_KEY, 'completed');
    } catch (_) {}
  }

  function updateCardAndSpotlight() {
    const overlay = document.getElementById('intro-tour-overlay');
    const step = steps[currentStep];
    if (!overlay || !step) return;

    if (typeof step.prepare === 'function') {
      step.prepare();
    }

    let targetElem = null;
    if (step.getTarget) {
      targetElem = step.getTarget();
    } else if (step.targetId) {
      targetElem = document.getElementById(step.targetId);
    }

    if (targetElem) {
      targetElem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    setTimeout(() => {
      const rect = targetElem ? targetElem.getBoundingClientRect() : { left: 20, top: 20, width: window.innerWidth - 40, height: 100 };
      const padding = 6;
      const x = Math.max(0, rect.left - padding);
      const y = Math.max(0, rect.top - padding);
      const width = Math.min(window.innerWidth, rect.width + (padding * 2));
      const height = rect.height + (padding * 2);

      const maskRect = document.getElementById('tour-spotlight-rect');
      if (maskRect) {
        maskRect.setAttribute('x', x);
        maskRect.setAttribute('y', y);
        maskRect.setAttribute('width', width);
        maskRect.setAttribute('height', height);
      }

      const highlightBox = document.getElementById('tour-highlight-box');
      if (highlightBox) {
        highlightBox.style.left = `${x}px`;
        highlightBox.style.top = `${y}px`;
        highlightBox.style.width = `${width}px`;
        highlightBox.style.height = `${height}px`;
        highlightBox.style.display = 'block';
      }

      const titleElem = document.getElementById('tour-title');
      const descElem = document.getElementById('tour-desc');
      const badgeElem = document.getElementById('tour-step-badge');
      const prevBtn = document.getElementById('tour-prev-btn');
      const nextBtn = document.getElementById('tour-next-btn');

      if (titleElem) titleElem.textContent = step.title;
      if (descElem) descElem.textContent = step.desc;
      if (badgeElem) badgeElem.textContent = `Step ${currentStep + 1} of ${steps.length}`;

      if (prevBtn) {
        if (currentStep === 0) {
          prevBtn.classList.add('hidden');
        } else {
          prevBtn.classList.remove('hidden');
        }
      }

      if (nextBtn) {
        nextBtn.innerHTML = currentStep === steps.length - 1 ? 'Get Started 🎉' : 'Next &rarr;';
      }

      const dotsContainer = document.getElementById('tour-dots');
      if (dotsContainer) {
        dotsContainer.innerHTML = steps.map((_, idx) => `
          <span class="tour-dot ${idx === currentStep ? 'active' : ''}"></span>
        `).join('');
      }

      const card = document.getElementById('tour-card');
      if (card) {
        const viewportHeight = window.innerHeight;
        const cardHeight = card.offsetHeight || 190;
        const margin = 14;

        if (y + height + cardHeight + margin > viewportHeight - 20) {
          card.style.top = `${Math.max(16, y - cardHeight - margin)}px`;
        } else {
          card.style.top = `${y + height + margin}px`;
        }
      }
    }, 140);
  }

  function startTour(force = false) {
    if (!force && isTourCompleted()) return;

    const overlay = document.getElementById('intro-tour-overlay');
    if (!overlay) return;

    currentStep = 0;
    isTourActive = true;
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');

    updateCardAndSpotlight();
  }

  function nextStep() {
    if (currentStep < steps.length - 1) {
      currentStep++;
      updateCardAndSpotlight();
    } else {
      endTour();
    }
  }

  function prevStep() {
    if (currentStep > 0) {
      currentStep--;
      updateCardAndSpotlight();
    }
  }

  function endTour() {
    isTourActive = false;
    const overlay = document.getElementById('intro-tour-overlay');
    if (overlay) {
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
    }
    const highlightBox = document.getElementById('tour-highlight-box');
    if (highlightBox) highlightBox.style.display = 'none';

    closeAllPanels();
    setTourCompleted();
  }

  function init() {
    const overlay = document.getElementById('intro-tour-overlay');
    if (!overlay) return;

    const nextBtn = document.getElementById('tour-next-btn');
    const prevBtn = document.getElementById('tour-prev-btn');
    const skipBtn = document.getElementById('tour-skip-btn');

    if (nextBtn) nextBtn.addEventListener('click', nextStep);
    if (prevBtn) prevBtn.addEventListener('click', prevStep);
    if (skipBtn) skipBtn.addEventListener('click', endTour);

    window.addEventListener('resize', () => {
      if (isTourActive) updateCardAndSpotlight();
    });

    if (!isTourCompleted()) {
      setTimeout(() => {
        startTour(false);
      }, 700);
    }
  }

  return {
    init,
    startTour,
    endTour
  };
})();

/* ==========================================================================
   18. GLOBAL APPLICATION INITIALIZATION (Executed after all modules loaded)
   ========================================================================== */
function safeInit(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error('MBBS Init error in ' + name + ':', err);
  }
}

function onAppReady() {
  safeInit('ThemeManager', () => ThemeManager.init());
  safeInit('SemesterStorage', () => SemesterStorage.checkAndMigrateLegacyTimetable());
  safeInit('ClinicalPostingStorage', () => ClinicalPostingStorage.seedDefaultPostings());
  safeInit('AttendanceStorage', () => AttendanceStorage.migrateDeduplicateRecords());

  safeInit('initClock', () => initClock());
  safeInit('initDateNavigation', () => initDateNavigation());
  safeInit('initSemesterTimetablePanel', () => initSemesterTimetablePanel());
  safeInit('initClinicalTimetablePanel', () => initClinicalTimetablePanel());
  safeInit('initReplaceClassesPanel', () => initReplaceClassesPanel());
  safeInit('initOverviewAttendancePanel', () => initOverviewAttendancePanel());
  safeInit('initPlusMinusPanel', () => initPlusMinusPanel());
  safeInit('initBackupPanel', () => initBackupPanel());
  safeInit('initAttendanceHistoryPanel', () => initAttendanceHistoryPanel());
  safeInit('initSettingsPanel', () => initSettingsPanel());
  safeInit('initMenuInteraction', () => initMenuInteraction());
  safeInit('initFeaturePanel', () => initFeaturePanel());

  safeInit('loadAttendanceForDate', () => loadAttendanceForDate(activeDate));
  safeInit('TourManager', () => TourManager.init());
}

// Support both standard DOMContentLoaded and instant-ready Android WebViews
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onAppReady);
} else {
  onAppReady();
}
