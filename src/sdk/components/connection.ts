import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { ConnectionState, NoriClient } from '../index'

/**
 * The shared client's connection state. Calls onReconnect when the sidecar
 * answers again after being offline, so an island can reload its data.
 */
export function useNoriConnection(client: NoriClient, onReconnect?: () => void): ConnectionState {
  const state = useSyncExternalStore(
    client.subscribe,
    () => client.connectionState,
    () => 'checking' as const,
  )
  const previous = useRef(state)
  const reconnect = useRef(onReconnect)
  reconnect.current = onReconnect
  useEffect(() => {
    const prev = previous.current
    previous.current = state
    if (prev === 'offline' && state === 'online') reconnect.current?.()
  }, [state])
  return state
}
