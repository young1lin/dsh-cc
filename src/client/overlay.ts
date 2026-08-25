/**
 * The single "a floating layer is open" signal for the Claude Code surface.
 *
 * Escape closes the whole surface only when NOTHING is layered on top of it.
 * The layers are scattered — App-level modals, the rail's inline directory
 * picker, a row's rename edit — so each one reports itself through this
 * context while open, and the surface reads the live count from a ref at
 * key-press time. A ref, not state: a dialog that closes itself from a
 * `document` bubble listener makes React flush between that listener and the
 * surface's own capture listener, and only a ref sees the truth at both
 * moments.
 *
 * @module dsh-cc/client/overlay
 */

import { createContext, useContext, useEffect } from 'react'

/**
 * The registration handle App provides for the whole surface. Registering
 * twice from one component is fine: the count is what matters, not names.
 */
export interface OverlaySignal {
  /**
   * Report one open overlay.
   * @returns the deregister function for the same overlay.
   */
  register(): () => void
}

/** Carries the signal down to whichever layer wants to report itself. */
export const OverlayContext = createContext<OverlaySignal | undefined>(undefined)

/**
 * Report this component as an open overlay while `active` is true.
 * @param active - whether the layer is currently open.
 */
export function useOverlay(active: boolean): void {
  const signal = useContext(OverlayContext)
  useEffect(() => {
    if (!active || signal === undefined) return
    return signal.register()
  }, [active, signal])
}
