import { IDB_NAME, IDB_STORE, IDB_VERSION, MODELS } from "../constants"
import type { ModelKey } from "../types"

const MODEL_FETCH_TIMEOUT_MS = 10 * 60 * 1000
const MODEL_STALL_TIMEOUT_MS = 30 * 1000
const MIN_MODEL_SIZE_BYTES = 1024 * 1024

export interface ModelBufferResult {
  buffer: ArrayBuffer
  source: "cache" | "network"
}

/**
 * Opens (or creates) the IndexedDB database used to cache ONNX model buffers.
 * On first run the object store is created via the `onupgradeneeded` event.
 */
export const openModelDB = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

/**
 * Retrieves a cached ArrayBuffer from IndexedDB by its key.
 * Returns `null` when the entry does not exist yet.
 */
export const getFromIDB = (
  db: IDBDatabase,
  key: string
): Promise<ArrayBuffer | null> =>
  new Promise((resolve, reject) => {
    const req = db
      .transaction(IDB_STORE, "readonly")
      .objectStore(IDB_STORE)
      .get(key)
    req.onsuccess = () => resolve((req.result as ArrayBuffer) ?? null)
    req.onerror = () => reject(req.error)
  })

/**
 * Persists an ArrayBuffer in IndexedDB under the given key.
 * Overwrites any existing entry with the same key.
 */
export const saveToIDB = (
  db: IDBDatabase,
  key: string,
  buf: ArrayBuffer
): Promise<void> =>
  new Promise((resolve, reject) => {
    const req = db
      .transaction(IDB_STORE, "readwrite")
      .objectStore(IDB_STORE)
      .put(buf, key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })

/** Removes one model cache entry without affecting the rest of the database. */
export const deleteFromIDB = (db: IDBDatabase, key: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const req = db
      .transaction(IDB_STORE, "readwrite")
      .objectStore(IDB_STORE)
      .delete(key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })

const saveModelBestEffort = async (
  db: IDBDatabase,
  cacheKey: string,
  buffer: ArrayBuffer
) => {
  try {
    await saveToIDB(db, cacheKey, buffer)
  } catch (error) {
    // Caching is an optimization. A full browser storage quota must not make
    // an otherwise valid, already downloaded model unusable.
    console.warn(
      "[model-cache] Unable to persist model; using it in memory",
      error
    )
  }
}

/**
 * Returns `true` when the given model is already stored in IndexedDB.
 * Used to show the "Cached" status badge without a full download attempt.
 */
export const isModelCached = async (modelKey: ModelKey): Promise<boolean> => {
  const db = await openModelDB()
  const buf = await getFromIDB(db, MODELS[modelKey].cacheKey)
  return buf !== null && buf.byteLength >= MIN_MODEL_SIZE_BYTES
}

/**
 * Ensures the ONNX model binary is available locally.
 *
 * Flow:
 *  1. Open IndexedDB.
 *  2. If the model buffer already exists, return it immediately (cache hit).
 *  3. Otherwise stream-download from HuggingFace, reporting byte-level
 *     progress via `onProgress` (0–100).
 *  4. Assemble chunks into a single ArrayBuffer, attempt to persist it, then
 *     return the buffer even when the optional cache write is unavailable.
 *
 * @param modelKey   - Which model variant to fetch ("quantized" | "fp16").
 * @param onProgress - Called repeatedly with a percentage value (0–100).
 * @returns          - The raw ONNX model and whether it came from cache.
 */
export const checkAndDownloadModel = async (
  modelKey: ModelKey,
  onProgress: (pct: number) => void,
  options: { forceRefresh?: boolean } = {}
): Promise<ModelBufferResult> => {
  const { url, cacheKey } = MODELS[modelKey]
  const db = await openModelDB()

  // ── Cache hit ────────────────────────────────────────────────────────────
  if (options.forceRefresh) {
    await deleteFromIDB(db, cacheKey).catch((error) => {
      console.warn("[model-cache] Unable to clear the cached model", error)
    })
  }

  const cached = options.forceRefresh ? null : await getFromIDB(db, cacheKey)
  if (cached && cached.byteLength >= MIN_MODEL_SIZE_BYTES) {
    onProgress(100)
    return { buffer: cached, source: "cache" }
  }

  if (cached) {
    await deleteFromIDB(db, cacheKey).catch((error) => {
      console.warn(
        "[model-cache] Unable to remove an invalid cache entry",
        error
      )
    })
  }

  // ── Network fetch ────────────────────────────────────────────────────────
  const controller = new AbortController()
  const fetchTimeoutId = setTimeout(
    () => controller.abort(),
    MODEL_FETCH_TIMEOUT_MS
  )

  try {
    const res = await fetch(url, {
      headers: { Accept: "*/*" },
      signal: controller.signal,
    })

    if (!res.ok)
      throw new Error(`Model fetch failed: ${res.status} ${res.statusText}`)

    if (!res.body) {
      const arrayBuffer = await res.arrayBuffer()
      await saveModelBestEffort(db, cacheKey, arrayBuffer)
      onProgress(100)
      return { buffer: arrayBuffer, source: "network" }
    }

    const total = parseInt(res.headers.get("Content-Length") ?? "0", 10)
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0

    const readWithTimeout = async () => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () =>
                reject(
                  new Error(
                    "Model download stalled. Please check your connection."
                  )
                ),
              MODEL_STALL_TIMEOUT_MS
            )
          }),
        ])
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
      }
    }

    while (true) {
      const { done, value } = await readWithTimeout()

      if (done) break

      chunks.push(value)
      received += value.length

      // Report progress only when Content-Length is known
      if (total > 0) {
        onProgress(Math.min(99, Math.round((received / total) * 100)))
      } else {
        // Keep visible progress feedback when server omits Content-Length.
        const pseudo = Math.min(95, Math.round(chunks.length * 1.5))
        onProgress(pseudo)
      }
    }

    // ── Assemble buffer ────────────────────────────────────────────────────
    const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }

    const arrayBuffer = merged.buffer

    // ── Persist to cache ───────────────────────────────────────────────────
    await saveModelBestEffort(db, cacheKey, arrayBuffer)
    onProgress(100)

    return { buffer: arrayBuffer, source: "network" }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(
        `Model download timed out after ${Math.round(
          MODEL_FETCH_TIMEOUT_MS / 1000
        )}s.`
      )
    }
    throw err
  } finally {
    clearTimeout(fetchTimeoutId)
  }
}
