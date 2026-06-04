import { useState, useEffect, useRef } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { getToken, validateToken } from './auth'
import LoginScreen from './LoginScreen.jsx'
import ChatList from './components/ChatList.jsx'
import ChatView from './components/ChatView.jsx'
import UpdateChecker from './UpdateModal.jsx'
import { setupPushNotifications } from './notifications.js'

export default function App() {
  const [token, setToken_] = useState(() => validateToken() ? getToken() : null)
  const [activeChatId, setActiveChatId] = useState(null)
  const [exitHint, setExitHint] = useState(false)
  const exitTimerRef = useRef(null)

  useEffect(() => {
    if (token) setupPushNotifications().catch(() => {})
  }, [token])

  // Android hardware back: navigate within the UI instead of leaving the app.
  // On the home list a single press shows a "back again to exit" toast.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let handle
    CapacitorApp.addListener('backButton', () => {
      if (activeChatId) {
        setActiveChatId(null)
        return
      }
      if (exitHint) {
        CapacitorApp.exitApp()
        return
      }
      setExitHint(true)
      clearTimeout(exitTimerRef.current)
      exitTimerRef.current = setTimeout(() => setExitHint(false), 2000)
    }).then(h => { handle = h })
    return () => { handle && handle.remove(); clearTimeout(exitTimerRef.current) }
  }, [activeChatId, exitHint])

  if (!token) {
    return <>
      <UpdateChecker />
      <LoginScreen onLogin={() => setToken_(getToken())} />
    </>
  }

  const content = activeChatId
    ? <ChatView chatId={activeChatId} onBack={() => setActiveChatId(null)} />
    : <ChatList onOpenChat={setActiveChatId} />

  return (
    <>
      <UpdateChecker />
      {content}
      {exitHint && (
        <div className="fixed bottom-6 left-0 right-0 flex justify-center pointer-events-none z-[70]">
          <div className="bg-slate-800 border border-slate-700 text-slate-100 text-sm px-4 py-2 rounded-full shadow-lg">
            Pulsa atrás otra vez para salir
          </div>
        </div>
      )}
    </>
  )
}
