// 読み書きの成功は、リクエスト単体ではなくトランザクションの確定で判断する。
const DB = 'careman-recordings'

export interface PendingRecording {
  id: string
  clientId: string
  /** 録音を始めた書類（#152）。これより前に端末に残した録音にはない（主な書類につなぐ） */
  documentId?: string
  blob: Blob
  mime: string
  startedAt: number
  durationMs: number
}

function idb<T>(fn: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode = 'readonly'): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 2)
    open.onupgradeneeded = ({ oldVersion }) => {
      if (oldVersion === 0) {
        open.result.createObjectStore('pending')
        return
      }
      // 旧形式は利用者IDをキーにしていて、録音ID・開始時刻がない。
      const store = open.transaction!.objectStore('pending')
      const request = store.openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        const recording = cursor.value
        if (!recording.id && recording.clientId === cursor.primaryKey) {
          const id = crypto.randomUUID()
          store.add({ ...recording, id, startedAt: 0 }, id)
          cursor.delete()
        }
        cursor.continue()
      }
    }
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      try {
        const tx = db.transaction('pending', mode)
        const request = fn(tx.objectStore('pending'))
        tx.oncomplete = () => resolve(request.result)
        tx.onabort = () => reject(tx.error ?? request.error ?? new Error('IndexedDB transaction aborted'))
      } catch (error) {
        reject(error)
      } finally {
        // close() は開始済みのトランザクションが確定するまで待つ。
        db.close()
      }
    }
  })
}

export const saveRecording = (recording: PendingRecording) => idb((s) => s.put(recording, recording.id), 'readwrite')
export const deleteRecording = (id: string) => idb((s) => s.delete(id), 'readwrite')

export async function pendingRecordings(clientId: string): Promise<PendingRecording[]> {
  const recordings = await idb((s) => s.getAll() as IDBRequest<PendingRecording[]>)
  return recordings.filter((p) => p.id && p.clientId === clientId && p.blob.size > 0)
    .sort((a, b) => a.startedAt - b.startedAt)
}
