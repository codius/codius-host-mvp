'use strict'

const fs = require('fs-extra')
const debug = require('debug')('codius-host')
const path = require('path')
const crypto = require('crypto')
const Koa = require('koa')
const Router = require('koa-router')
const Logger = require('koa-logger')
const BodyParser = require('koa-bodyparser')
const Ilp = require('koa-ilp')
const Boom = require('boom')
const canonicalJson = require('canonical-json')
const getPort = require('get-port')
const ILP = require('ilp')

const Config = require('./config')

const dollarsPerMonth = process.env.CODIUS_DOLLARS_PER_MONTH || 5
const dollarsPerXrp = 0.2
const dropsPerXrp = Math.pow(10, 6)
const xrpPerMonth = dollarsPerMonth / dollarsPerXrp
const dropsPerMonth = xrpPerMonth * dropsPerXrp

const { spawnSync } = require('child_process')

class App {
  constructor (deps) {
    this.config = deps(Config)
    this.koa = deps(Koa)
    this.router = deps(Router)

    this.contracts = {}

    const { ilpPlugin, ilpCredentials } = this.config

    const Plugin = require(ilpPlugin)
    const plugin = this.plugin = new Plugin(ilpCredentials)
    this.ilp = new Ilp({ plugin })
  }

  listen () {
    const app = this.koa
    const router = this.router
    const { port } = this.config

    app.use(Logger())
    app.use(BodyParser())
    app.use(router.routes())
    app.use(router.allowedMethods({
      throw: true,
      notImplemented: () => Boom.notImplemented(),
      methodNotAllowed: () => Boom.methodNotAllowed()
    }))

    const SHA256_REGEX = /^[0-9a-fA-F]{64}$/

    const digestToPath = (digest) =>
      path.resolve(__dirname, 'data', digest.substring(0, 2), digest)

    const price = (ctx) => {
      const { manifest } = ctx.request.body
      const manifestHash = crypto.createHash('sha256').update(canonicalJson(manifest)).digest('hex')
      return this.contracts[manifestHash] ? 0 : dropsPerMonth
    }

    router.options('/start', this.ilp.options({ price }))
    router.post('/start', this.ilp.paid({ price }), async (ctx) => {
      const { manifest } = ctx.request.body
      const { image, environment, port } = manifest
      const command = manifest.command || []

      const manifestHash = crypto.createHash('sha256').update(canonicalJson(manifest)).digest('hex')

      ctx.body = {
        manifestHash
      }

      if (this.contracts[manifestHash]) {
        ctx.status = 200
        return
      }

      const hostPort = await getPort()

      const environmentOpts = []
      for (const key of Object.keys(environment)) {
        environmentOpts.push('-e')
        environmentOpts.push(`${key}=${environment[key]}`)
      }

      spawnSync('docker', [ 'pull', image ], { stdio: 'inherit' })
      spawnSync('docker', [
        'run', '-d',
        '-p', `${hostPort}:${port}`,
        '--name', manifestHash.substring(0, 16),
        ...environmentOpts,
        image,
        ...command
      ], { stdio: 'inherit' })

      this.contracts[manifestHash] = {
        manifest
      }

      debug('started', manifestHash)
      ctx.status = 201
    })

    router.get('/', (ctx) => {
      ctx.body = 'Hello World!'
    })

    app.listen(port)

    console.log(`Codius listening on port ${port}`)
  }
}

module.exports = App