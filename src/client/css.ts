/**
 * Stylesheet registry: every client module owns its own CSS and registers it
 * under a unique id at module scope. One `<style>` element carries the whole
 * registry, so feature modules never edit a shared stylesheet file — the
 * property that lets several of them be developed in parallel.
 *
 * Registration is order-independent: sheets are emitted sorted by id, and a
 * sheet registered after the element exists rewrites it in place.
 *
 * @module dsh-cc/client/css
 */

/** Registered sheets by id; one entry per owning module. */
const sheets = new Map<string, string>()

/** The live style element, once mounted. */
let element: HTMLStyleElement | undefined

/** The DOM id of the single style element this registry owns. */
const STYLE_ELEMENT_ID = 'dsh-cc-styles'

/**
 * Register one module's stylesheet. Re-registering the same id replaces that
 * sheet, which is what a hot reload needs.
 * @param id - unique owner id, e.g. `transcript`; also the emit sort key.
 * @param css - the module's complete stylesheet text.
 */
export function registerCss(id: string, css: string): void {
  sheets.set(id, css)
  if (element !== undefined) element.textContent = composeSheet()
}

/**
 * Mount the registry into the document. Safe to call from every component's
 * mount effect: the element is created once and reused.
 */
export function mountCss(): void {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(STYLE_ELEMENT_ID)
  if (existing instanceof HTMLStyleElement) {
    element = existing
  } else {
    element = document.createElement('style')
    element.id = STYLE_ELEMENT_ID
    document.head.appendChild(element)
  }
  element.textContent = composeSheet()
}

/**
 * Concatenate the registry into one stylesheet.
 * @returns every registered sheet, ordered by owner id.
 */
function composeSheet(): string {
  return [...sheets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, css]) => `/* ${id} */\n${css}`)
    .join('\n')
}
