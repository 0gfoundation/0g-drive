// What a file is about, as text: what its embedding is made from (D41).
// A file's opening is often not about its subject — a paper's permission
// notice, venue line, author list and affiliations; a letter's greeting and
// signature; a code file's license header; meeting notes' attendees — and
// the text model reads only the first ~600 characters, so on a paper it may
// never reach the abstract (on "Attention Is All You Need" the abstract
// starts at character 600). A paper is taken from its title and its
// abstract on; anything else is cleaned of what isn't about its subject.
// Pure: used by the indexer (in the worker), discover.ts and the tests.

const NAME = String.raw`\p{Lu}[\p{Ll}'’]+(?:[ -]\p{Lu}\.?(?:[\p{Ll}'’]+)?){1,2}`
// footnote marks and affiliation numbers, attached or spaced out as PDF text gives them ("Yao ∗ *,1 , Zhao 2 ,")
const MARKS = String.raw`(?:\s*[\d*∗†‡§¶¹²³⁴⁵⁶⁷⁸⁹⁰]+(?:\s*,\s*[\d*∗†‡§¶]+)*)*`
/** two or more personal names in a row: "Ming Zeng¹, Xiang Li*, and Wei Chen" */
const NAME_LIST = new RegExp(String.raw`${NAME}${MARKS}(?:\s*(?:,|;|\band\b|&)\s*${NAME}${MARKS})+`, 'gu')
/** Chinese names in a row: "张明, 李翔、王伟" */
const HAN_NAME_LIST = /\p{Script=Han}{2,3}(?:\s*[,，、]\s*\p{Script=Han}{2,3}){2,}/gu
/** a name after a greeting, a sign-off, a title or an email header: "Dear Ms. Chen", "Best regards, John Smith", "From: Li Wei" */
const cased = (words: string) => words.split(' ').map((w) => `[${w[0].toUpperCase()}${w[0]}]${w.slice(1)}`).join('|')
const ADDRESSED = new RegExp(
  // no i flag: with it \p{Lu} matches lowercase too ("best results" isn't a name)
  String.raw`(?:\b(?:${cased('dear hi hello regards sincerely thanks cheers best mr ms mrs dr prof')})\b[.,]?|(?:^|\s)(?:${cased('from to cc')})\s*:)\s+(?:(?:${cased('mr ms mrs dr prof')})\.?\s+)?${NAME.replace('{1,2}', '{0,1}')}`,
  'gmu'
)

/** Chinese institutions: "清华大学", "计算技术研究所"; and what every Chinese paper says ("摘要", "本文") */
const HAN_INSTITUTION = /\p{Script=Han}{0,8}(?:大学|学院|研究院|研究所|研究中心|实验室|公司|集团)|摘要|本文|提出/gu

/** license headers: "Copyright 2024 Google LLC.", "Licensed under the Apache License…", "SPDX-License-Identifier: MIT" */
const LICENSE = /\b(?:copyright|\(c\)|©|licensed under|spdx-license-identifier)[^.\n]*(?:[.\n]|$)/giu

/** The text with what isn't about the subject taken out. */
export function cleanText(raw: string): string {
  return raw
    .replace(LICENSE, ' ')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(NAME_LIST, ' ')
    .replace(HAN_NAME_LIST, ' ')
    .replace(HAN_INSTITUTION, ' ')
    .replace(ADDRESSED, ' ')
}


/** Attendee and participant lines of meeting notes: "Attendees: …", "参会人员：…" */
const ATTENDEES = /(?:^|\n)\s*(?:attendees?|participants?|present|参会人员|出席)\s*[:：][^\n]*/giu

/** Where a paper's abstract begins: "Abstract", "ABSTRACT", small caps as PDF text gives them ("A BSTRACT"), "摘要". */
// capitalized only: a lowercase "abstract" is a word ("abstract class", "abstract art"), not a heading
const ABSTRACT = /\b(?:Abstract|ABSTRACT|A\s?BSTRACT)\b[\s.:—–-]*|摘\s*要\s*[:：]?/

/** How far into the text an abstract may begin (title, authors, affiliations come first). */
const ABSTRACT_WITHIN = 3000

/** Before a paper's abstract, when no title came with it: all of it if short (a title, no author block), else its first line if short. */
function titleBefore(pre: string): string | undefined {
  const head = cleanText(pre).replace(/\s+/g, ' ').replace(/[\s.:—–-]+$/, '').trim()
  if (head && head.length <= TITLE_MAX) return head
  const line = pre.split('\n').map((l) => l.trim()).find(Boolean)
  return line && pre.includes('\n') && line.length <= TITLE_MAX ? line.replace(/^#+\s*/, '') : undefined
}

/** Longest text taken as a title. */
const TITLE_MAX = 200

/**
 * The text an embedding is made from: for a paper (an abstract begins
 * near the top), its title and its abstract on — the author block between
 * them left out; otherwise the text cleaned of what isn't about its subject.
 */
export function subjectText(raw: string | undefined, title?: string): string | undefined {
  if (!raw) return title?.trim() || undefined
  const at = raw.slice(0, ABSTRACT_WITHIN).search(ABSTRACT)
  if (at >= 0) {
    const body = raw.slice(at).replace(ABSTRACT, '').trim()
    return [title?.trim() || titleBefore(raw.slice(0, at)), body].filter(Boolean).join('. ').replace(/\s+/g, ' ').trim() || undefined
  }
  const cleaned = cleanText(raw.replace(ATTENDEES, '\n')).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
  return cleaned || undefined
}

/** A text item as pdf.js gives it: its string, and its transform (a, b, c, d: scale and rotation). */
export interface PdfItem {
  str: string
  transform: number[]
}

/**
 * A PDF's title from its first page: the largest horizontal text near the
 * top, if it reads as words — not a rotated stamp (arXiv's), nor small caps
 * pdf.js splits into letters ("R E A C T"). The PDF's own Title field is
 * usually empty.
 */
export function pdfTitle(items: PdfItem[]): string | undefined {
  const flat = items.filter((i) => i.str.trim() && i.transform[1] === 0 && i.transform[2] === 0).slice(0, 60)
  const size = (i: PdfItem) => Math.abs(i.transform[3])
  const max = Math.max(0, ...flat.map(size))
  const title = flat
    .filter((i) => size(i) >= max * 0.95)
    .map((i) => i.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  const words = title.split(' ').filter((w) => /\p{L}{3,}/u.test(w))
  return words.length >= 2 && title.length <= 200 ? title : undefined
}
