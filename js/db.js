/**
 * db.js — localStorage CRUD layer
 * All app state lives here. Admin writes, index reads.
 */

const DB_KEY = 'albumapp_v1';

const _defaultState = () => ({
  categories: [],
  albumTypes: [],
  distributors: [],
  stores: [],
  unpoCards: [],
  purchases: [],
  notices: [],
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

function dbLoad() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (e) {
    return null;
  }
}

let _bc = null;
try { _bc = new BroadcastChannel('albumapp_sync'); } catch(e) {}

function dbSave(state) {
  // Separate large image data to avoid quota issues
  const lightState = { ...state };
  const imgData = {};

  if (state.unpoCards) {
    lightState.unpoCards = state.unpoCards.map(uc => ({
      ...uc,
      sets: uc.sets.map(set => ({
        memo: set.memo || '',
        cards: set.cards.map(c => ({ owned: c.owned || false, note: c.note || '' })),
      })),
    }));

    state.unpoCards.forEach(uc => {
      uc.sets.forEach((set, si) => {
        set.cards.forEach((c, ci) => {
          if (c.img) {
            if (!imgData[uc.id]) imgData[uc.id] = {};
            if (!imgData[uc.id][si]) imgData[uc.id][si] = {};
            imgData[uc.id][si][ci] = c.img;
          }
        });
      });
    });
  }

  try {
    localStorage.setItem(DB_KEY, JSON.stringify(lightState));
    localStorage.setItem(DB_KEY + '_imgs', JSON.stringify(imgData));
    try { if (_bc) _bc.postMessage({ type: 'db-updated', ts: Date.now() }); } catch(e) {}
  } catch (e) {
    // Retry without purchases if quota exceeded
    try {
      const minimal = { ...lightState, unpoCards: [] };
      localStorage.setItem(DB_KEY, JSON.stringify(minimal));
    } catch (e2) {}
  }
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
        sets: uc.sets.map((set, si) => ({
          ...set,
          cards: set.cards.map((c, ci) => ({
            ...c,
            img: imgData[uc.id]?.[si]?.[ci] || c.img || null,
          })),
        })),
      })),
    };
  } catch (e) {
    return state;
  }
}

function dbInit() {
  let state = dbLoad();
  if (!state) {
    state = _defaultState();
    dbSave(state);
  }
  return dbMergeImages(state);
}

function dbGet() {
  const state = dbLoad() || _defaultState();
  return dbMergeImages(state);
}

function dbUpdate(updater) {
  const state = dbGet();
  const next = updater(state);
  dbSave(next);
  return next;
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
  const state = dbGet();
  // Strip owned flag (personal data at card level) from each unpo card
  const unpoCards = (state.unpoCards || []).map(uc => ({
    ...uc,
    sets: (uc.sets || []).map(set => ({
      ...set,
      cards: (set.cards || []).map(({ owned, ...card }) => card),
    })),
  }));
  const safe = {
    ...state,
    purchases: undefined,   // personal data — not synced to GitHub
    unpoCards,
    settings: {
      ...state.settings,
      adminPw: undefined,
      github: {
        ...state.settings?.github,
        token: undefined,
      },
    },
  };
  return JSON.stringify(safe, null, 2);
}

function dbImportJSON(json) {
  try {
    const parsed = JSON.parse(json);
    dbSave(parsed);
    return true;
  } catch (e) {
    return false;
  }
}
