// ⚠️ TEMPORARY in-memory conversation store, keyed by the patient's phone number.
// It resets whenever the server restarts. We replace this with Postgres in the
// database / Zoho step so history and leads survive restarts and can be queried.

const store = new Map();
const MAX_TURNS = 20; // keep the last N turns to bound token usage

export function getHistory(userId) {
  return store.get(userId) || [];
}

export function appendTurn(userId, role, content) {
  const history = store.get(userId) || [];
  history.push({ role, content });
  if (history.length > MAX_TURNS) history.splice(0, history.length - MAX_TURNS);
  store.set(userId, history);
  return history;
}

export function resetConversation(userId) {
  store.delete(userId);
}