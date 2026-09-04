import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './store/authStore.tsx'
import { ToastProvider } from './components/ui/Toast.tsx'
import { LoaderProvider } from './components/ui/FullScreenLoader.tsx'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import { SocketProvider } from './contexts/SocketContext.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <SocketProvider>
          <ToastProvider>
            <LoaderProvider>
              <App />
            </LoaderProvider>
          </ToastProvider>
        </SocketProvider>
      </AuthProvider>
    </ErrorBoundary>
  </StrictMode>,
)
