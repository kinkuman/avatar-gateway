// Reactアプリをブラウザへ取り付け、画面全体の入口を作ります。
import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App'
import { loadLocales } from './i18n'
import './styles.css'

/** 辞書の準備後に描画し、起動直後の言語一覧の入れ替わりを避けます。 */
async function main() {
  await loadLocales()
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

void main()
