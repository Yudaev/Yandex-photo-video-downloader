import { defineContentScript } from 'wxt/utils/define-content-script';
import { observeDownloadApi } from '../lib/observe-download-api';

export default defineContentScript({
  matches: ['https://disk.yandex.ru/client/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main: observeDownloadApi,
});
