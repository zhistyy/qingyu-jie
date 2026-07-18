import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        setup: 'ui/setup.html',
        game: 'ui/game.html',
        chat: 'ui/chat.html',
        apilog: 'ui/api-log.html',
      },
    },
  },
  server: {
    open: '/ui/setup.html',
  },
});
