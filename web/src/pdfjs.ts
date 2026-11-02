// pdf.js, loaded on first use (search indexing and the phone PDF viewer).
let loading: Promise<typeof import('pdfjs-dist')> | null = null

export function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  loading ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
    return pdfjs
  })
  return loading
}
