import { EventEmitter } from './events.js'

// Raw sockets are not available to Android plugins.
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

export function isIPv4(value) {
  return IPV4.test(String(value))
}

export function isIPv6(value) {
  const text = String(value)
  return text.includes(':') && /^[0-9a-fA-F:.]+$/.test(text) && text.split('::').length <= 2
}

export function isIP(value) {
  return isIPv4(value) ? 4 : isIPv6(value) ? 6 : 0
}

export class Socket extends EventEmitter {
  constructor() {
    super()
    this.remoteAddress = undefined
  }
  connect() {
    throw new Error('net.Socket 在 Android 插件运行时中不可用')
  }
  setTimeout() {
    return this
  }
  setNoDelay() {
    return this
  }
  setKeepAlive() {
    return this
  }
  destroy() {
    return this
  }
  end() {
    return this
  }
}

export class BlockList {
  addAddress() {}
  addRange() {}
  addSubnet() {}
  check() {
    return false
  }
}

export function createConnection() {
  throw new Error('net.createConnection 在 Android 插件运行时中不可用')
}

export const connect = createConnection

export function createServer() {
  throw new Error('net.createServer 在 Android 插件运行时中不可用')
}

export default { isIP, isIPv4, isIPv6, Socket, BlockList, createConnection, connect, createServer }
