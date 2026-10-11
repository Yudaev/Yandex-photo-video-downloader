export function syncPhotoButton(document: Document, pathname: string, iconUrl: string, openPanel: () => Promise<void>) {
  const existing = document.getElementById('yandex-photo-downloader');
  if (!/^\/client\/photo\/?$/.test(pathname)) {
    existing?.remove();
    return;
  }
  const upload = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
    .find((element) => (element.textContent?.trim() || element.getAttribute('aria-label')) === 'Загрузить');
  if (!upload) {
    existing?.remove();
    return;
  }
  if (existing?.nextElementSibling === upload) return;
  if (existing) {
    upload.before(existing);
    return;
  }
  const host = document.createElement('div');
  host.id = 'yandex-photo-downloader';
  host.style.cssText = 'display:block;width:100%;margin-bottom:6px;flex-shrink:0';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { color-scheme:dark; font-family:Arial,sans-serif; }
      button {
        box-sizing:border-box; display:flex; align-items:center; justify-content:center; gap:8px;
        width:100%; min-height:34px; padding:6px 12px; border:1px solid #9d6bff;
        border-radius:10px; color:white; font:600 14px Arial,sans-serif; cursor:pointer;
        background:linear-gradient(115deg,#292078,#683cff 60%,#be77ef);
        box-shadow:0 2px 8px #1d104c55;
      }
      button:hover { filter:brightness(1.12); }
      button:focus-visible { outline:2px solid #eac5ff; outline-offset:3px; }
      button:disabled { cursor:wait; }
      img { width:22px; height:22px; }
      [role="status"] { color:#eac5ff; font-size:12px; }
    </style>
    <button id="download-all" type="button"></button>
    <div role="status"></div>
  `;
  const button = root.querySelector<HTMLButtonElement>('button')!;
  const logo = document.createElement('img');
  logo.src = iconUrl;
  logo.alt = '';
  button.append(logo, document.createTextNode('Скачать все'));
  button.addEventListener('click', async () => {
    const status = root.querySelector<HTMLElement>('[role="status"]')!;
    status.textContent = '';
    button.disabled = true;
    try {
      await openPanel();
    } catch {
      status.textContent = 'Не удалось открыть панель. Обновите страницу и попробуйте снова.';
    } finally {
      button.disabled = false;
    }
  });
  upload.before(host);
}
