// Reactアプリをブラウザへ取り付け、画面全体の入口を作ります。
import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
