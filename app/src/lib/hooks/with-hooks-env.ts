import { tmpdir } from 'os'
import { enableHooksEnvironment } from '../feature-flag'
import { getRepoHooks } from './get-repo-hooks'
import { cp, mkdtemp, rm } from 'fs/promises'
import { join, basename } from 'path'
import { createProxyProcessServer, ProcessProxyConnection } from 'process-proxy'
import { AddressInfo } from 'net'
import { spawn } from 'child_process'
import { Readable, Writable } from 'stream'
import { Shescape } from 'shescape'
import memoizeOne from 'memoize-one'

const debug = (message: string, error?: Error) => {
  log.debug(`hooks: ${message}`, error)
}

const getShell = () => {
  // TODO: Windows:
  if (__WIN32__) {
    throw new Error('Not implemented')
  }

  if (process.env.SHELL) {
    try {
      return {
        shell: process.env.SHELL,
        args: ['-ilc'],
        ...getQuoteFn(process.env.SHELL),
      }
    } catch (err) {
      debug('Failed resolving shell', err)
    }
  }

  return {
    shell: '/bin/sh',
    args: ['-ilc'],
    ...getQuoteFn('/bin/sh'),
  }
}

const getQuoteFn = memoizeOne((shell: string) => {
  const shescape = new Shescape({ shell, flagProtection: false })
  return {
    escape: shescape.escape.bind(shescape),
    quote: shescape.quote.bind(shescape),
  }
})

const waitForWritableFinished = (stream: Writable) => {
  return new Promise<void>(resolve => {
    if (stream.writableFinished) {
      resolve()
    } else {
      stream.once('finish', () => resolve())
    }
  })
}

const exitWithError = (
  connection: ProcessProxyConnection,
  message: string,
  exitCode = 1
) => {
  return new Promise<void>((resolve, reject) => {
    connection.stderr.end(`${message}\n`, () => {
      connection.exit(exitCode).then(resolve, err => {
        debug(
          `failed to exit proxy: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        resolve()
      })
    })
  })
}

export async function withHooksEnv<T>(
  fn: (env: Record<string, string | undefined> | undefined) => Promise<T>,
  path: string,
  isBackgroundTask = false,
  customEnv?: Record<string, string | undefined>
): Promise<T> {
  if (!enableHooksEnvironment()) {
    return fn(customEnv)
  }

  const repoHooks = await Array.fromAsync(getRepoHooks(path))

  if (repoHooks.length === 0) {
    return fn(customEnv)
  }

  const ext = __WIN32__ ? '.exe' : ''
  const processProxyPath = join(__dirname, `process-proxy${ext}`)

  const token = crypto.randomUUID()
  const server = createProxyProcessServer(
    async connection => {
      const abortController = new AbortController()
      const proxyArgs = await connection.getArgs()
      const proxyEnv = await connection.getEnv()
      const proxyCwd = await connection.getCwd()

      const hookName = __WIN32__
        ? basename(proxyArgs[0]).replace(/\.exe$/i, '')
        : basename(proxyArgs[0])

      const excludedEnvVars = new Set([
        // Dugite sets this to point to a custom git config file which
        // we don't want to leak into the hook's environment
        'GIT_SYSTEM_CONFIG',
        // We set this to point to a custom hooks path which we don't want
        // leaking into the hook's environment. Initially I thought we would have
        // to sanitize this to strip out the custom config we set and leave any
        // user-configured but since we're executing the hook in a separate
        // shell with login it would just get re-initialized there anyway.
        'GIT_CONFIG_PARAMETERS',
      ])

      const safeEnv = Object.fromEntries(
        Object.entries(proxyEnv).filter(
          ([k]) => k.startsWith('GIT_') && excludedEnvVars.has(k)
        )
      )

      const hooksExecutable =
        repoHooks.find(hook => hook.endsWith(hookName)) ??
        (__WIN32__
          ? repoHooks.find(hook => hook.endsWith(`${hookName}.exe`))
          : undefined)

      if (!hooksExecutable) {
        debug(`hook executable not found for ${hookName}`)
        await exitWithError(
          connection,
          `Error: hook executable not found for ${hookName}`
        )
        return
      }

      const { shell, args: shellArgs, quote } = getShell()

      const cmdArgs = [hooksExecutable, ...proxyArgs.slice(1)]
      const cmd = cmdArgs.map(quote).join(' ')

      const child = spawn(shell, [...shellArgs, cmd], {
        cwd: proxyCwd,
        env: safeEnv,
        signal: abortController.signal,
      })
        .on('spawn', () => {
          const pipe = (from: Readable, to: Writable, name: string) => {
            from.pipe(to).on('error', err => {
              debug(`${name} pipe error:`, err)
              abortController.abort()
            })
          }

          pipe(connection.stdin, child.stdin, 'stdin')
          pipe(child.stdout, connection.stdout, 'stdout')
          pipe(child.stderr, connection.stderr, 'stderr')

          child.on('close', async (code, signal) => {
            await Promise.all([
              waitForWritableFinished(connection.stdout),
              waitForWritableFinished(connection.stderr),
            ])

            if (code !== 0) {
              debug(`exiting proxy with code ${code}`)
            }
            await connection.exit(code ?? 0).catch(err => {
              debug(`failed to exit proxy:`, err)
            })
          })
        })
        .on('error', async err => {
          debug(`child error:`, err)
          await exitWithError(
            connection,
            `Error: command failed: ${err.message}`
          )
        })
    },
    {
      validateConnection: async receivedToken => receivedToken === token,
    }
  )
  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
  const tmpHooksDir = await mkdtemp(join(tmpdir(), 'desktop-git-hooks-'))
  try {
    for (const hook of repoHooks) {
      const cleanHooksName = __WIN32__
        ? basename(hook).replace(/\.exe$/i, '')
        : basename(hook)

      await cp(processProxyPath, join(tmpHooksDir, `${cleanHooksName}${ext}`))
    }

    const existingGitEnvConfig =
      customEnv?.['GIT_CONFIG_PARAMETERS'] ??
      process.env['GIT_CONFIG_PARAMETERS'] ??
      ''

    const gitEnvConfigPrefix =
      existingGitEnvConfig.length > 0 ? `${existingGitEnvConfig} ` : ''

    return await fn({
      ...customEnv,
      // TODO: Do we need to escape tmpHooksDir? Could it possibly include a single quote?
      // probably not?
      GIT_CONFIG_PARAMETERS: `${gitEnvConfigPrefix}'core.hooksPath=${tmpHooksDir}'`,
      PROCESS_PROXY_PORT: `${port}`,
      PROCESS_PROXY_TOKEN: token,
    })
  } finally {
    // Clean up the temporary directory
    await rm(tmpHooksDir, { recursive: true, force: true }).catch(() => {
      // Ignore errors
    })
  }
}
