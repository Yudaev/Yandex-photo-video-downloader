import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  return (
    <main>
      <h1>Yandex Photo &amp; Video Downloader</h1>
      <p>Расширение для скачивания фото и видео из безлимитного хранилища Яндекс Диска.</p>
      <p>Проект в разработке. Выбор файлов и скачивание пока недоступны.</p>
      <a href="https://disk.yandex.ru/client/photo" target="_blank" rel="noopener noreferrer">
        Открыть «Фото» Яндекс Диска
      </a>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
