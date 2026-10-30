export const EOL = '\n'
export const constants = { signals: {}, errno: {} }

export function platform() {
  return 'android'
}
export function type() {
  return 'Linux'
}
export function arch() {
  return 'arm64'
}
export function release() {
  return 'android'
}
export function version() {
  return 'android'
}
export function machine() {
  return 'aarch64'
}
export function hostname() {
  return 'localhost'
}
export function homedir() {
  return '/'
}
export function tmpdir() {
  return '/tmp'
}
export function endianness() {
  return 'LE'
}
export function uptime() {
  return 0
}
export function totalmem() {
  return 0
}
export function freemem() {
  return 0
}
export function availableParallelism() {
  return 1
}
export function loadavg() {
  return [0, 0, 0]
}
export function cpus() {
  return [{ model: 'android', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }]
}
export function networkInterfaces() {
  return {}
}
export function userInfo() {
  return { uid: 0, gid: 0, username: 'plugin', homedir: '/', shell: null }
}

export const devNull = '/dev/null'

export default {
  EOL, constants, platform, type, arch, release, version, machine, hostname, homedir, tmpdir, endianness, uptime,
  totalmem, freemem, availableParallelism, loadavg, cpus, networkInterfaces, userInfo, devNull
}
