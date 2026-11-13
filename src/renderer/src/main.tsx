import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import 'highlight.js/styles/github.css'
import type { DeskApi } from '../../shared/api'

declare global { interface Window { desk: DeskApi } }

createRoot(document.getElementById('root')!).render(<App />)
