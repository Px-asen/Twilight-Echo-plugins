import assert from 'node:assert/strict'
import test from 'node:test'
import { parseStackTrace } from './runtime/stack.js'

test('QuickJS stack frames expose the CallSite methods used by depd', () => {
  const frames = parseStackTrace([
    '    at load (D:\\plugins\\provider.js:123)',
    '    at <anonymous> (/android/provider.js:456:7)',
    '    at next (native)',
    '    at <eval> (<plugin-call>:1)',
    ''
  ].join('\n'))
  assert.equal(frames.length, 4)
  assert.equal(frames[0].getFileName(), 'D:\\plugins\\provider.js')
  assert.equal(frames[0].getLineNumber(), 123)
  assert.equal(frames[0].getColumnNumber(), null)
  assert.equal(frames[0].getFunctionName(), 'load')
  assert.equal(frames[0].getThis(), undefined)
  assert.equal(frames[0].getTypeName(), null)
  assert.equal(frames[0].getMethodName(), null)
  assert.equal(frames[0].isEval(), false)
  assert.equal(String(frames[0]), 'load (D:\\plugins\\provider.js:123)')
  assert.equal(frames[1].getColumnNumber(), 7)
  assert.equal(frames[2].getFileName(), null)
  assert.equal(frames[2].getLineNumber(), null)
  assert.equal(frames[3].isEval(), true)
  assert.equal(frames[3].getEvalOrigin(), '<plugin-call>:1')
})
