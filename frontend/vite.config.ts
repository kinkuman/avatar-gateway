// 開発時も本番と同じAPIパスで接続できるよう、FastAPIへの中継を定義します。
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // 分割後に残るThree.js本体の実サイズを基準にし、再肥大化だけを警告対象にします。
    chunkSizeWarningLimit: 625,
    rollupOptions: {
      output: {
        /** VRM描画と会話UIを分け、初期HTMLが一つの巨大なJavaScriptを抱えないようにします。 */
        manualChunks(id) {
          if (id.includes('/node_modules/three/')) return 'three'
          if (id.includes('/node_modules/@pixiv/')) return 'vrm'
          if (id.includes('/node_modules/react-markdown/') || id.includes('/node_modules/remark-')) {
            return 'markdown'
          }
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/')) {
            return 'react'
          }
          return undefined
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      // 開発時も製品同梱VRMAをFastAPIから読み、本番と同じURLを維持します。
      '/assets/motions': 'http://127.0.0.1:8000',
      // 同梱壁紙もVite自身のJS/CSS用/assetsへ誤配信せず、FastAPIから取得します。
      '/assets/backgrounds': 'http://127.0.0.1:8000',
      '/local-assets': 'http://127.0.0.1:8000',
    },
  },
})
