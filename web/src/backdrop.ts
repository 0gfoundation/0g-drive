import type { MouseEvent } from 'react'

/**
 * A modal backdrop's handlers: close on a click pressed and released on the
 * backdrop itself. A drag between the dialog and the backdrop (selecting a
 * field's text and letting go outside, or the other way round) is also a
 * click on the backdrop, the nearest element holding both ends, and must
 * not close the dialog.
 */
export function closeOnBackdrop(close: () => unknown) {
  const on = (e: MouseEvent<HTMLElement>) => (e.target === e.currentTarget ? '1' : '')
  return {
    onMouseDown: (e: MouseEvent<HTMLElement>) => {
      e.currentTarget.dataset.pressed = on(e)
    },
    onMouseUp: (e: MouseEvent<HTMLElement>) => {
      e.currentTarget.dataset.released = on(e)
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      const { pressed, released } = e.currentTarget.dataset
      e.currentTarget.dataset.pressed = e.currentTarget.dataset.released = ''
      if (pressed === '1' && released === '1' && e.target === e.currentTarget) close()
    },
  }
}
