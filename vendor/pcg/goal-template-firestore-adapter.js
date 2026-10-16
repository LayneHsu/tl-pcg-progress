const TEMPLATE_COLLECTION = 'pcgModuleGoalTemplates';
const THEME_COLLECTION = 'pcgModuleThemeGoals';
const CONTROL_PATH = 'pcgModuleControl/current';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function requireDb(db) {
  if (!db || typeof db.runTransaction !== 'function' || typeof db.collection !== 'function'
    || typeof db.doc !== 'function') throw new Error('Firestore Compat db 无效');
}

function mapDocs(snapshot) {
  const result = {};
  for (const item of snapshot?.docs || []) result[item.id] = clone(item.data());
  return result;
}

function createTransactionAdapter(transaction, db) {
  const readDoc = async path => {
    const snapshot = await transaction.get(db.doc(path));
    return snapshot.exists ? clone(snapshot.data()) : null;
  };
  const list = async collectionName => mapDocs(await transaction.get(db.collection(collectionName)));
  return {
    listGoalTemplates: () => list(TEMPLATE_COLLECTION),
    getGoalTemplate: id => readDoc(`${TEMPLATE_COLLECTION}/${id}`),
    listThemeGoals: () => list(THEME_COLLECTION),
    getThemeGoal: id => readDoc(`${THEME_COLLECTION}/${id}`),
    getControlHead: () => readDoc(CONTROL_PATH),
    setGoalTemplate: (id, value) => transaction.set(db.doc(`${TEMPLATE_COLLECTION}/${id}`), clone(value)),
    deleteGoalTemplate: id => transaction.delete(db.doc(`${TEMPLATE_COLLECTION}/${id}`)),
    setThemeGoal: (id, value) => transaction.set(db.doc(`${THEME_COLLECTION}/${id}`), clone(value)),
    setControlHead: value => transaction.set(db.doc(CONTROL_PATH), clone(value)),
  };
}

export function createGoalTemplateFirestoreAdapter(db) {
  requireDb(db);
  return {
    max_atomic_writes: 500,
    runTransaction(handler) {
      return db.runTransaction(transaction => handler(createTransactionAdapter(transaction, db)));
    },
  };
}

export const GOAL_TEMPLATE_FIRESTORE_PATHS = Object.freeze({
  templates: TEMPLATE_COLLECTION,
  themes: THEME_COLLECTION,
  control: CONTROL_PATH,
});
