/**
 * db.js — localStorage CRUD layer
 *
 * Storage keys:
 *   albumapp_v1          — shared data (categories, stores, etc. synced via GitHub)
 *   albumapp_v1_personal — personal data (purchases, settings; never overwritten by sync)
 *   albumapp_v1_imgs     — unpoCard images (base64, separated for quota)
 */

const DB_KEY = 'albumapp_v1';
const PERSONAL_KEY = 'albumapp_v1_personal';
const PERSONAL_FIELDS = ['purchases', 'settings'];

const _defaultShared = () => ({
  categories: [],
  albumTypes: [],
  distributors: [],
  stores: [],
  unpoCards: [],
  notices: [],
});

const _defaultPersonal = () => ({
  purchases: [],
  settings: {
    rates: {
      JPY: { rate: 9.4537, manual: false, updAt: null },
      CNY: { rate: 218.3126, manual: false, updAt: null },
      USD: { rate: 1507.7751, manual: false, updAt: null },
      TWD: { rate: 47.1855, manual: false, updAt: null },
      HKD: { rate: 193.5, manual: false, updAt: null },
      OTHER: { rate: 1, manual: true, name: '기타', updAt: null },
    },
    ratesAt: null,
    theme: 'light',
    adminPw: '0312',
    github: {},
  },
});

let _bc = null;
try { _bc = new BroadcastChannel('albumapp_sync'); } catch(e) {}

function _parseLS(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

function _saveShared(shared) {
  // Separate images from unpoCards to avoid quota issues
  const imgData = {};
  const lightUnpoCards = (shared.unpoCards || []).map(uc => {
    (uc.sets || []).forEach((set, si) => {
      (set.cards || []).forEach((c, ci) => {
        if (c.img) {
          if (!imgData[uc.id]) imgData[uc.id] = {};
          if (!imgData[uc.id][si]) imgData[uc.id][si] = {};
          imgData[uc.id][si][ci] = c.img;
        }
      });
    });
    return {
      ...uc,
      sets: (uc.sets || []).map(set => ({
        memo: set.memo || '',
        luckyDraw: set.luckyDraw || false,
        cards: (set.cards || []).map(c => ({ owned: c.owned || false, note: c.note || '' })),
      })),
    };
  });

  const lightShared = { ...shared, unpoCards: lightUnpoCards };

  try {
    localStorage.setItem(DB_KEY, JSON.stringify(lightShared));
    localStorage.setItem(DB_KEY + '_imgs', JSON.stringify(imgData));
    try { if (_bc) _bc.postMessage({ type: 'db-updated', ts: Date.now() }); } catch(e) {}
  } catch(e) {
    try {
      localStorage.setItem(DB_KEY, JSON.stringify({ ...lightShared, unpoCards: [] }));
    } catch(e2) {}
  }
}

function _savePersonal(personal) {
  try {
    localStorage.setItem(PERSONAL_KEY, JSON.stringify(personal));
  } catch(e) {}
}

function dbMergeImages(state) {
  try {
    const raw = localStorage.getItem(DB_KEY + '_imgs');
    if (!raw) return state;
    const imgData = JSON.parse(raw);
    return {
      ...state,
      unpoCards: (state.unpoCards || []).map(uc => ({
        ...uc,
        sets: (uc.sets || []).map((set, si) => ({
          ...set,
          cards: (set.cards || []).map((c, ci) => ({
            ...c,
            img: imgData[uc.id]?.[si]?.[ci] || c.img || null,
          })),
        })),
      })),
    };
  } catch(e) {
    return state;
  }
}

function dbGet() {
  let shared = _parseLS(DB_KEY);
  let personal = _parseLS(PERSONAL_KEY);

  if (!shared && !personal) {
    _saveShared(_defaultShared());
    _savePersonal(_defaultPersonal());
    return { ..._defaultShared(), ..._defaultPersonal() };
  }

  if (!shared) shared = _defaultShared();

  if (!personal) {
    // Migration: extract personal fields from old single-key format
    personal = {
      purchases: shared.purchases || [],
      settings: shared.settings || _defaultPersonal().settings,
    };
    const cleanShared = { ...shared };
    PERSONAL_FIELDS.forEach(k => delete cleanShared[k]);
    _saveShared(cleanShared);
    _savePersonal(personal);
    shared = cleanShared;
  }

  return dbMergeImages({ ...shared, ...personal });
}

function dbUpdate(updater) {
  const state = dbGet();
  const next = updater(state);

  const shared = {}, personal = {};
  Object.keys(next).forEach(k => {
    if (PERSONAL_FIELDS.includes(k)) personal[k] = next[k];
    else shared[k] = next[k];
  });

  _saveShared(shared);
  _savePersonal(personal);
  return next;
}

// dbInit for backward compat (called on app start)
function dbInit() {
  return dbGet();
}

// ── ID generator ──
function genId(prefix = 'id') {
  return prefix + Date.now() + Math.random().toString(36).slice(2, 6);
}

// ── Generic CRUD helpers ──
function dbInsert(collection, item) {
  return dbUpdate(s => ({
    ...s,
    [collection]: [...(s[collection] || []), { ...item, id: item.id || genId(collection[0]) }],
  }));
}

function dbUpdateItem(collection, id, patch) {
  return dbUpdate(s => ({
    ...s,
    [collection]: (s[collection] || []).map(x => x.id === id ? { ...x, ...patch } : x),
  }));
}

function dbDeleteItem(collection, id) {
  return dbUpdate(s => ({
    ...s,
    [collection]: (s[collection] || []).filter(x => x.id !== id),
  }));
}

// ── Specific helpers ──
function dbSaveUnpoCards(storeId, albumTypeId, sets) {
  return dbUpdate(s => {
    const existing = s.unpoCards || [];
    const idx = existing.findIndex(uc => uc.storeId === storeId && uc.albumTypeId === albumTypeId);
    const newEntry = { id: genId('u'), storeId, albumTypeId, sets };
    if (idx >= 0) {
      return { ...s, unpoCards: existing.map((x, i) => i === idx ? { ...x, sets } : x) };
    }
    return { ...s, unpoCards: [...existing, newEntry] };
  });
}

function dbGetUnpoCards(storeId, albumTypeId) {
  const s = dbGet();
  return s.unpoCards?.find(uc => uc.storeId === storeId && uc.albumTypeId === albumTypeId) || null;
}

function dbUpdateSettings(patch) {
  return dbUpdate(s => ({ ...s, settings: { ...(s.settings || {}), ...patch } }));
}

function dbExportJSON() {
  return JSON.stringify(dbGet(), null, 2);
}

function dbExportForSync() {
  // Export shared data only — personal (purchases, settings) never included
  let shared = _parseLS(DB_KEY) || {};

  // Strip per-card owned flags from unpoCards before sync export
  if (shared.unpoCards) {
    shared = {
      ...shared,
      unpoCards: shared.unpoCards.map(uc => ({
        ...uc,
        sets: (uc.sets || []).map(set => ({
          ...set,
          cards: (set.cards || []).map(({ owned, ...card }) => card),
        })),
      })),
    };
  }

  return JSON.stringify(shared, null, 2);
}

function dbImportJSON(json) {
  try {
    const data = JSON.parse(json);

    // Build owned-flag map from existing shared unpoCards using composite key
    const existingShared = _parseLS(DB_KEY) || {};
    const ownedMap = {};
    (existingShared.unpoCards || []).forEach(uc => {
      (uc.sets || []).forEach((set, si) => {
        (set.cards || []).forEach((card, ci) => {
          if (card.owned) ownedMap[`${uc.storeId}__${uc.albumTypeId}__${si}__${ci}`] = true;
        });
      });
    });

    // Build new shared data; personal fields (purchases, settings) are NEVER overwritten
    const shared = {};
    Object.keys(data).forEach(k => {
      if (!PERSONAL_FIELDS.includes(k)) shared[k] = data[k];
    });

    // Restore owned flags in incoming unpoCards
    if (shared.unpoCards?.length) {
      shared.unpoCards = shared.unpoCards.map(uc => ({
        ...uc,
        sets: (uc.sets || []).map((set, si) => ({
          ...set,
          cards: (set.cards || []).map((card, ci) => ({
            ...card,
            owned: ownedMap[`${uc.storeId}__${uc.albumTypeId}__${si}__${ci}`] || false,
          })),
        })),
      }));
    }

    // Write to shared key only — PERSONAL_KEY is never touched
    localStorage.setItem(DB_KEY, JSON.stringify(shared));
    return true;
  } catch(e) {
    return false;
  }
}
