// lib/graphStore.ts
// ─────────────────────────────────────────────────────────────────────────────
// IndexedDB-backed cache for analyzed graphs.
//
// WHY: sessionStorage has a hard ~5MB quota — big repos (ghost, talawa-api)
// silently failed to load because the graph JSON never fit. IndexedDB allows
// hundreds of MB and survives tab reloads and browser restarts.
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = "codemap";
const DB_VERSION = 1;
const STORE = "graphs";

export interface StoredGraphPayload {
  owner: string;
  repo: string;
  commitSha?: string;
  defaultBranch?: string;
  stats?: unknown;
  fileGraphUrl?: string | null;
  functionsBaseUrl?: string | null;
  _inlineFileGraph: unknown;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function graphKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

export async function saveGraphPayload(key: string, payload: Omit<StoredGraphPayload, "savedAt">): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ ...payload, savedAt: Date.now() }, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function loadGraphPayload(key: string): Promise<StoredGraphPayload | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => { db.close(); resolve((req.result as StoredGraphPayload) ?? null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch {
    return null;
  }
}

export async function deleteGraphPayload(key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    });
  } catch {
    // best-effort
  }
}
