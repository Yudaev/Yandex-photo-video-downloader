import { defineConfig } from 'wxt';

const icons = {
  16: '/icon-16.png',
  20: '/icon-20.png',
  24: '/icon-24.png',
  28: '/icon-28.png',
  32: '/icon-32.png',
  40: '/icon-40.png',
  48: '/icon-48.png',
  64: '/icon-64.png',
  96: '/icon-96.png',
  128: '/icon-128.png',
  192: '/icon-192.png',
  256: '/icon-256.png',
  512: '/icon-512.png',
  1024: '/icon-1024.png',
  1254: '/icon-1254.png',
};

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  manifest: {
    name: 'Yandex Photo & Video Downloader',
    description: 'Скачивание фото и видео из безлимитного хранилища Яндекс Диска.',
    icons,
    permissions: ['storage', 'sidePanel', 'scripting', 'webRequest'],
    host_permissions: ['https://disk.yandex.ru/*', 'https://downloader.disk.yandex.ru/*', 'https://*.downloader.disk.yandex.ru/*', 'https://*.storage.yandex.net/*'],
    minimum_chrome_version: '116',
    web_accessible_resources: [{
      resources: ['icon-48.png'],
      matches: ['https://disk.yandex.ru/*'],
    }],
    action: {
      default_title: 'Открыть Yandex Photo & Video Downloader',
      default_icon: icons,
    },
  },
});
