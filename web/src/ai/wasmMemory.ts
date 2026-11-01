/// <reference lib="webworker" />
// ONNX Runtime's WebAssembly memory, capped. Its builds are all threaded, so
// the memory is shared and declared able to grow to 4 GB; a shared memory
// can't move when it grows, so the browser reserves the whole maximum up
// front. iPhones give a tab little address space, and reservations from
// earlier page loads aren't freed at once: after some refreshes in one tab
// the reservation fails — "no available backend found. ERR: [wasm]
// RangeError: Out of memory" — before any model loads, while a new tab works.
// A smaller maximum is a valid import for the module (it only needs ≤ its
// declared one), so asking for less here is all it takes. This worker runs
// nothing else, so the wrapper touches only ONNX Runtime.

/**
 * 1 GB in 64 KiB pages. Measured (Chromium): 202 MB with the text model
 * loaded, 322 MB with the photo models too after indexing and searching.
 */
export const MAX_PAGES = 16384

declare global {
  // for the tests: the memory, and the maximum asked for and given (pages)
  // eslint-disable-next-line no-var
  var ortMemory: { memory: WebAssembly.Memory; asked?: number; given?: number } | undefined
}

const Native = WebAssembly.Memory
class CappedMemory extends Native {
  constructor(desc: WebAssembly.MemoryDescriptor) {
    const cap = desc.shared && desc.maximum !== undefined && desc.maximum > MAX_PAGES
    const given = cap ? { ...desc, maximum: Math.max(MAX_PAGES, desc.initial) } : desc
    super(given)
    if (desc.shared) self.ortMemory = { memory: this, asked: desc.maximum, given: given.maximum }
  }
}
WebAssembly.Memory = CappedMemory
