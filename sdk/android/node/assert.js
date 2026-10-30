import { isDeepStrictEqual } from './util.js'

export class AssertionError extends Error {
  constructor(options = {}) {
    super(options.message || 'Assertion failed')
    this.name = 'AssertionError'
    this.code = 'ERR_ASSERTION'
    this.actual = options.actual
    this.expected = options.expected
    this.operator = options.operator
  }
}

function fail(message, actual, expected, operator) {
  if (message instanceof Error) throw message
  throw new AssertionError({ message, actual, expected, operator })
}

export function ok(value, message) {
  if (!value) fail(message || 'The expression evaluated to a falsy value', value, true, '==')
}

const assert = (value, message) => ok(value, message)

export function equal(actual, expected, message) {
  // eslint-disable-next-line eqeqeq
  if (actual != expected) fail(message || `${actual} == ${expected}`, actual, expected, '==')
}
export function notEqual(actual, expected, message) {
  // eslint-disable-next-line eqeqeq
  if (actual == expected) fail(message || `${actual} != ${expected}`, actual, expected, '!=')
}
export function strictEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) fail(message || `Expected values to be strictly equal`, actual, expected, 'strictEqual')
}
export function notStrictEqual(actual, expected, message) {
  if (Object.is(actual, expected)) fail(message || `Expected values to be not strictly equal`, actual, expected, 'notStrictEqual')
}
export function deepStrictEqual(actual, expected, message) {
  if (!isDeepStrictEqual(actual, expected)) fail(message || 'Expected values to be deeply equal', actual, expected, 'deepStrictEqual')
}
export const deepEqual = deepStrictEqual
export function notDeepStrictEqual(actual, expected, message) {
  if (isDeepStrictEqual(actual, expected)) fail(message || 'Expected values not to be deeply equal', actual, expected, 'notDeepStrictEqual')
}
export const notDeepEqual = notDeepStrictEqual
export function throws(fn, expected, message) {
  try {
    fn()
  } catch {
    return
  }
  fail(typeof expected === 'string' ? expected : message || 'Missing expected exception.')
}
export function doesNotThrow(fn) {
  fn()
}
export function ifError(value) {
  if (value !== null && value !== undefined) throw value
}
export function match(text, pattern, message) {
  if (!pattern.test(text)) fail(message || `The input did not match ${pattern}`, text, pattern, 'match')
}

Object.assign(assert, {
  AssertionError, ok, equal, notEqual, strictEqual, notStrictEqual, deepEqual, deepStrictEqual, notDeepEqual,
  notDeepStrictEqual, throws, doesNotThrow, ifError, match, fail: (message) => fail(message)
})
assert.strict = assert

export { assert as strict }
export default assert
