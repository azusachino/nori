import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { ConnectionState, NoriClient } from '../index'

/**
 * The shared client's connection state. Calls onRefresh when the sidecar
 * answers again after being offline, and when a hidden page becomes visible
 * again, so an island can reload its data (and llmConfigured) instead of
 * showing what it loaded hours ago.
 */
export function useNoriConnection(client: NoriClient, onRefresh?: () => void): ConnectionState {
  const state = useSyncExternalStore(
    client.subscribe,
    () => client.connectionState,
    () => 'checking' as const,
  )
  const previous = useRef(state)
  const refresh = useRef(onRefresh)
  refresh.current = onRefresh
  useEffect(() => {
    const prev = previous.current
    previous.current = state
    if (prev === 'offline' && state === 'online') refresh.current?.()
  }, [state])
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh.current?.()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])
  return state
}
