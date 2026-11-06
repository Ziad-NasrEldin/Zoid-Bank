export function replaceStorageSnapshot(storage, key, snapshot) {
  const previous = storage.getItem(key);
  const next = JSON.stringify(snapshot);
  try {
    storage.setItem(key, next);
    return { previous, next };
  } catch (error) {
    try {
      if (previous === null) storage.removeItem(key);
      else storage.setItem(key, previous);
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  }
}
