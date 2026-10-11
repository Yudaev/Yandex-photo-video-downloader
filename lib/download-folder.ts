function accessStore<T>(name: 'settings' | 'downloads', mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const open = indexedDB.open('yandex-photo-downloader', 3);
    open.onupgradeneeded = () => {
      for (const store of ['settings', 'downloads']) {
        if (!open.result.objectStoreNames.contains(store)) open.result.createObjectStore(store);
      }
      const downloads = open.transaction!.objectStore('downloads');
      if (!downloads.indexNames.contains('status')) downloads.createIndex('status', 'status');
    };
    open.onerror = () => reject(open.error);
    open.onblocked = () => { blocked = true; reject(new Error('Хранилище настроек занято. Закройте другие окна расширения.')); };
    open.onsuccess = () => {
      const db = open.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => db.close();
      const transaction = db.transaction(name, mode);
      transaction.onabort = () => {
        db.close();
        reject(transaction.error ?? new Error('Не удалось сохранить настройки.'));
      };
      try {
        const request = operation(transaction.objectStore(name));
        transaction.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
      } catch (error) {
        transaction.abort();
        db.close();
        reject(error);
      }
    };
  });
}

export function getDownloadFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  return accessStore('settings', 'readonly', (store) => store.get('downloadFolder'));
}

export async function setDownloadFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  await accessStore('settings', 'readwrite', (store) => store.put(handle, 'downloadFolder'));
}

export interface DownloadItem {
  key: string;
  account: string;
  id: string;
  name: string;
  type: 'photo' | 'video';
  created?: string;
  modified?: string;
  sizeLabel?: string;
  error?: string;
}

export interface DownloadResult extends DownloadItem {
  status: 'saving' | 'success' | 'error';
  folder: FileSystemDirectoryHandle;
  savedName?: string;
  bytes?: number;
  localModified?: number;
  createdAt?: string;
  modifiedAt?: string;
}

export function getDownloadResult(key: string): Promise<DownloadResult | undefined> {
  return accessStore('downloads', 'readonly', (store) => store.get(key));
}

export async function setDownloadResult(result: DownloadResult): Promise<void> {
  await accessStore('downloads', 'readwrite', (store) => store.put(result, result.key));
}

export function getUnfinishedDownloads(): Promise<DownloadResult[]> {
  return accessStore('downloads', 'readonly', (store) => store.index('status').getAll('saving'));
}

export function getSuccessfulDownloads(): Promise<DownloadResult[]> {
  return accessStore('downloads', 'readonly', (store) => store.index('status').getAll('success'));
}
