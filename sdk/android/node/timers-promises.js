import timers from './timers.js'

export const setTimeout = timers.promises.setTimeout
export const setImmediate = timers.promises.setImmediate
export const scheduler = timers.promises.scheduler

export default timers.promises
