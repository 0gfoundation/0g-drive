// Saving a downloaded file to the device. Chrome on iPhone doesn't save a
// download link's file: it holds it in a bar ("Save…" / ✕) and, from then
// on, won't open the page's file picker, even after the bar is closed. There
// the file goes to the share sheet instead (Save to Files, Photos, …), which
// closes when it's done. The share sheet opens only right after a tap, and
// a download that had to be fetched first is past it: the caller then offers
// a Save button, whose tap opens it.

export type Saved = 'saved' | 'shared' | 'cancelled' | 'needs-tap'

/** Chrome on iPhone and iPad (its user agent names CriOS) */
export const isChromeIOS = () => /\bCriOS\//.test(navigator.userAgent)

export function fileOf(data: Uint8Array, name: string, mime: string): File {
  return new File([data as unknown as BlobPart], name, { type: mime || 'application/octet-stream' })
}

/** The file to the share sheet: 'needs-tap' when it may only open after a tap. */
async function shareFile(file: File): Promise<Saved> {
  try {
    await navigator.share({ files: [file] })
    return 'shared'
  } catch (e) {
    const name = (e as Error).name
    if (name === 'AbortError') return 'cancelled'
    if (name === 'NotAllowedError') return 'needs-tap'
    throw e
  }
}

const canShareFile = (file: File) => typeof navigator.share === 'function' && navigator.canShare?.({ files: [file] }) === true

/** A file saved by a download link: the browser saves or asks. */
function saveByLink(file: File) {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.click()
  // some browsers read the link a moment after the click
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** 'needs-tap': nothing saved yet; call again from a tap (e.g. a Save button). */
export async function saveFile(file: File): Promise<Saved> {
  if (isChromeIOS() && canShareFile(file)) {
    try {
      return await shareFile(file)
    } catch {
      // the share sheet failed: the download link, as elsewhere
    }
  }
  saveByLink(file)
  return 'saved'
}

export const saveBytes = (data: Uint8Array, name: string, mime: string) => saveFile(fileOf(data, name, mime))
