const DATABASE_NAME = "missiongo-drafts";
const STORE_NAME = "attachment-drafts";
const MAX_PERSISTED_BYTES = 50 * 1024 * 1024;

interface StoredFile {
  readonly name: string;
  readonly type: string;
  readonly lastModified: number;
  readonly bytes: Blob;
}

interface StoredDraft {
  readonly productId: string;
  readonly files: readonly StoredFile[];
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (!("indexedDB" in window)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "productId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function loadDraftFiles(productId: string): Promise<readonly File[]> {
  const database = await openDatabase().catch(() => null);
  if (!database) return [];
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(productId);
    const stored = await new Promise<StoredDraft | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as StoredDraft | undefined);
      request.onerror = () => reject(request.error);
    });
    return (stored?.files ?? []).map((file) => new File([file.bytes], file.name, {
      type: file.type,
      lastModified: file.lastModified,
    }));
  } finally {
    database.close();
  }
}

export async function saveDraftFiles(productId: string, files: readonly File[]): Promise<"saved" | "too-large" | "unavailable"> {
  const database = await openDatabase().catch(() => null);
  if (!database) return "unavailable";
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    if (files.reduce((total, file) => total + file.size, 0) > MAX_PERSISTED_BYTES) {
      store.delete(productId);
      await complete(transaction);
      return "too-large";
    }
    if (files.length === 0) store.delete(productId);
    else {
      store.put({
        productId,
        files: files.map((file) => ({
          name: file.name,
          type: file.type,
          lastModified: file.lastModified,
          bytes: file.slice(),
        })),
      } satisfies StoredDraft);
    }
    await complete(transaction);
    return "saved";
  } catch {
    return "unavailable";
  } finally {
    database.close();
  }
}

export async function clearDraftFiles(productId: string): Promise<void> {
  await saveDraftFiles(productId, []);
}
