/**
 * Minimal safe markdown renderer for assistant replies. Everything is
 * HTML-escaped first; only a fixed set of transforms run afterwards, so the
 * plugin-ui CSP (no remote resources) is never violated.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderMarkdown(source: string): string {
  const escaped = escapeHtml(source ?? '')
  const blocks: string[] = []
  // Extract fenced code blocks first so their content is never re-processed.
  const withPlaceholders = escaped.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    blocks.push(
      `<pre class="md-code"${lang ? ` data-lang="${lang}"` : ''}><code>${code.replace(/\n$/, '')}</code></pre>`
    )
    return `\uE000B${blocks.length - 1}\uE000B`
  })

  const lines = withPlaceholders.split('\n')
  const html: string[] = []
  let listOpen: 'ul' | 'ol' | null = null
  const closeList = () => {
    if (listOpen) {
      html.push(`</${listOpen}>`)
      listOpen = null
    }
  }
  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    const ordered = /^\s*\d+[.、]\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = heading[1].length
      html.push(`<h${level + 2} class="md-h">${inline(heading[2])}</h${level + 2}>`)
    } else if (bullet) {
      if (listOpen !== 'ul') {
        closeList()
        html.push('<ul class="md-list">')
        listOpen = 'ul'
      }
      html.push(`<li>${inline(bullet[1])}</li>`)
    } else if (ordered) {
      if (listOpen !== 'ol') {
        closeList()
        html.push('<ol class="md-list">')
        listOpen = 'ol'
      }
      html.push(`<li>${inline(ordered[1])}</li>`)
    } else if (line.trim() === '') {
      closeList()
    } else {
      closeList()
      html.push(`<p class="md-p">${inline(line)}</p>`)
    }
  }
  closeList()
  return html
    .join('')
    .replace(/\uE000B(\d+)\uE000B/g, (_match, index) => blocks[Number(index)] ?? '')
}

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
}
