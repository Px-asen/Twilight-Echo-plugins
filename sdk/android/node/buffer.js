import { Buffer, constants, kMaxLength } from '../runtime/buffer.js'
import { atob, btoa } from '../runtime/encoding.js'
import { Blob, File } from '../runtime/fetch.js'

export { Buffer, constants, kMaxLength, atob, btoa, Blob, File }

export const SlowBuffer = Buffer
export const INSPECT_MAX_BYTES = 50
export const kStringMaxLength = constants.MAX_STRING_LENGTH

export function isUtf8(input) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(input)
    return true
  } catch {
    return false
  }
}

export default { Buffer, SlowBuffer, constants, kMaxLength, kStringMaxLength, INSPECT_MAX_BYTES, atob, btoa, Blob, File, isUtf8 }
