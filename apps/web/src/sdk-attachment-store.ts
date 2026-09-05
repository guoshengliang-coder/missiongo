export interface StoredSdkAttachment {
  readonly id: string;
  readonly file: File;
}

interface AttachmentRecord {
  readonly key: string;
  readonly draftId: string;
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly lastModified: number;
  readonly blob: Blob;
  readonly createdAt: number;
}

const DATABASE_NAME = "missiongo-sdk-feedback";
const STORE_NAME = "attachments";
const MAX_AGE_MILLISECONDS = 24 * 60 * 60 * 1_000;

function openDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in globalThis)) return Promise.reject(new Error("IndexedDB is unavailable."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      store.createIndex("draftId", "draftId", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open attachment storage."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Attachment storage was aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Attachment storage failed."));
  });
}

async function deleteDraftRecords(store: IDBObjectStore, draftId: string): Promise<void> {
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const request = store.index("draftId").getAllKeys(IDBKeyRange.only(draftId));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not read stored attachment keys."));
  });
  keys.forEach((key) => store.delete(key));
}

async function cleanupExpired(database: IDBDatabase): Promise<void> {
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const cutoff = Date.now() - MAX_AGE_MILLISECONDS;
  store.openCursor().onsuccess = (event) => {
    const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
    if (!cursor) return;
    if ((cursor.value as AttachmentRecord).createdAt < cutoff) cursor.delete();
    cursor.continue();
  };
  await transactionDone(transaction);
}

export async function loadSdkAttachments(draftId: string): Promise<readonly StoredSdkAttachment[]> {
  const database = await openDatabase();
  try {
    await cleanupExpired(database);
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).index("draftId").getAll(IDBKeyRange.only(draftId));
    const records = await new Promise<AttachmentRecord[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as AttachmentRecord[]);
      request.onerror = () => reject(request.error ?? new Error("Could not restore attachments."));
    });
    await transactionDone(transaction);
    return records
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => ({
        id: record.id,
        file: new File([record.blob], record.name, { type: record.type, lastModified: record.lastModified }),
      }));
  } finally {
    database.close();
  }
}

export async function replaceSdkAttachments(
  draftId: string,
  attachments: readonly StoredSdkAttachment[],
): Promise<void> {
  const database = await openDatabase();
  try {
    await cleanupExpired(database);
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    await deleteDraftRecords(store, draftId);
    const createdAt = Date.now();
    attachments.forEach(({ id, file }, index) => {
      const record: AttachmentRecord = {
        key: `${draftId}:${id}`,
        draftId,
        id,
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
        blob: file,
        createdAt: createdAt + index,
      };
      store.put(record);
    });
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}
