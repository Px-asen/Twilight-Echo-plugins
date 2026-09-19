import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('miku scrolling styles avoid global subtree selectors and fixed blurred backgrounds', async () => {
  const css = await readFile(new URL('./theme.css', import.meta.url), 'utf8')
  assert.doesNotMatch(css, /body:has\(\.app-shell\)/)
  assert.doesNotMatch(css, /background-attachment:\s*fixed/)
  const library = await readFile(new URL('./library.css', import.meta.url), 'utf8')
  assert.doesNotMatch(library, /backdrop-filter:\s*blur\(/)
  assert.match(library, /var\(--miku-library-image\)/)
  assert.match(css, /body:has\(> :where\(#app\) > \.app-shell\)/)
})
