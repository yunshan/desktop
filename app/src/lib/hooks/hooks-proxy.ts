import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { createWriteStream } from 'fs'
import memoizeOne from 'memoize-one'
import { basename, join } from 'path'
import { ProcessProxyConnection } from 'process-proxy'
import { Shescape } from 'shescape'
import { Writable } from 'stream'
import { pipeline } from 'stream/promises'

const hooksUsingStdin = ['post-rewrite']

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

export const createHooksProxy = (repoHooks: string[], tmpDir: string) => {
  return async (connection: ProcessProxyConnection) => {
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
        ([k]) => k.startsWith('GIT_') && !excludedEnvVars.has(k)
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

    // We don't have to clean this up since it's in the tmpdir created by the
    // hooks env.
    const stdinFilePath = join(
      tmpDir,
      `${hookName}-stdin-${randomBytes(8).toString('hex')}`
    )

    const hasStdin = hooksUsingStdin.includes(hookName)

    if (hasStdin) {
      await pipeline(
        connection.stdin,
        createWriteStream(stdinFilePath, { mode: 0o600 })
      )
    }

    const { shell, args: shellArgs, quote } = getShell()

    const cmdArgs = [
      'git',
      'hook',
      'run',
      hookName,
      ...(hasStdin ? ['--to-stdin', stdinFilePath] : []),
      '--',
      ...proxyArgs.slice(1),
    ]
    const cmd = cmdArgs.map(quote).join(' ')

    const { code } = await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>((resolve, reject) => {
      const abortController = new AbortController()
      connection.on('close', () => abortController.abort())

      const child = spawn(shell, [...shellArgs, cmd], {
        cwd: proxyCwd,
        env: safeEnv,
        signal: abortController.signal,
      })
        .on('spawn', () => {
          // TODO: Do hooks ever write to stdout? Probably not?
          // https://github.com/git/git/blob/4cf919bd7b946477798af5414a371b23fd68bf93/hook.c#L73C6-L73C22
          child.stdout.pipe(connection.stdout).on('error', reject)
          child.stderr.pipe(connection.stderr).on('error', reject)
          child.on('close', (code, signal) => resolve({ code, signal }))
        })
        .on('error', reject)
    })

    await Promise.all([
      waitForWritableFinished(connection.stdout),
      waitForWritableFinished(connection.stderr),
    ]).catch(e => {
      debug(`waiting for writable to finish failed`, e)
    })

    if (code !== 0) {
      debug(`exiting proxy with code ${code}`)
    }
    await connection
      .exit(code ?? 0)
      .catch(err => debug(`failed to exit proxy:`, err))
  }
}
