import {
  createTextPreviewHighlighter,
  runDiffHighlighter,
  runHighlighter,
} from '@/lib/shiki/core'
import { expose, proxy } from 'comlink'

const api = {
  highlight: runHighlighter,
  highlightDiff: runDiffHighlighter,
  openTextPreview: (language: string) =>
    proxy(createTextPreviewHighlighter(language)),
}

expose(api)
