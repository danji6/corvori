import { httpRouter } from 'convex/server'

import { httpAction } from './_generated/server'
import { authHandler, oidcDiscoveryHandler } from './model/auth/http'
import { avatarUploadHandler } from './model/avatars/http'
import { termStreamHandler } from './model/shell/streamHttp'

const http = httpRouter()
const auth = httpAction(authHandler)
const oidcDiscovery = httpAction(oidcDiscoveryHandler)
const avatarUpload = httpAction(avatarUploadHandler)
const termStream = httpAction(termStreamHandler)

http.route({
  pathPrefix: '/api/auth/',
  method: 'GET',
  handler: auth,
})

http.route({
  pathPrefix: '/api/auth/',
  method: 'POST',
  handler: auth,
})

http.route({
  pathPrefix: '/api/auth/',
  method: 'OPTIONS',
  handler: auth,
})

http.route({
  path: '/.well-known/openid-configuration',
  method: 'GET',
  handler: oidcDiscovery,
})

http.route({
  path: '/io/avatar/upload',
  method: 'POST',
  handler: avatarUpload,
})

http.route({
  path: '/io/avatar/upload',
  method: 'OPTIONS',
  handler: avatarUpload,
})

http.route({
  path: '/shell/stream',
  method: 'GET',
  handler: termStream,
})

http.route({
  path: '/shell/stream',
  method: 'OPTIONS',
  handler: termStream,
})

export default http
