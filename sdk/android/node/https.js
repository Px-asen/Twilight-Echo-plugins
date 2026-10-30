import http, { Agent, ClientRequest, STATUS_CODES, METHODS, IncomingMessage, Server, ServerResponse } from './http.js'

export { Agent, STATUS_CODES, METHODS, IncomingMessage, Server, ServerResponse }

export const globalAgent = new Agent()

export function createServer(options, handler) {
  return http.createServer(options, handler)
}

export function request(input, options, callback) {
  return new ClientRequest(input, options, callback, 'https:')
}

export function get(input, options, callback) {
  const req = request(input, options, callback)
  req.end()
  return req
}

export default { Agent, globalAgent, STATUS_CODES, METHODS, IncomingMessage, Server, ServerResponse, createServer, request, get }
