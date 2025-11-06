import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { createWriteStream } from 'fs'
import { basename, join } from 'path'
import { ProcessProxyConnection } from 'process-proxy'
import { Writable } from 'stream'
import { pipeline } from 'stream/promises'
import type { HookProgress } from '../git'

const hooksUsingStdin = ['post-rewrite']

const debug = (message: string, error?: Error) => {
  log.debug(`hooks: ${message}`, error)
}

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

export const createHooksProxy = (
  repoHooks: string[],
  tmpDir: string,
  gitPath: string,
  shellEnv: Record<string, string | undefined>,
  onHookProgress?: (progress: HookProgress) => void
) => {
  return async (connection: ProcessProxyConnection) => {
    const startTime = Date.now()
    const proxyArgs = await connection.getArgs()
    const proxyEnv = await connection.getEnv()
    const proxyCwd = await connection.getCwd()

    const hookName = __WIN32__
      ? basename(proxyArgs[0]).replace(/\.exe$/i, '')
      : basename(proxyArgs[0])

    const abortController = new AbortController()

    onHookProgress?.({
      hookName,
      status: 'started',
      abort: () => abortController.abort(),
    })

    const excludedEnvVars = new Set([
      // Dugite sets these, we don't want to leak them into the hook environment
      'GIT_SYSTEM_CONFIG',
      'GIT_EXEC_PATH',
      'GIT_TEMPLATE_DIR',
      // We set this to point to a custom hooks path which we don't want
      // leaking into the hook's environment. Initially I thought we would have
      // to sanitize this to strip out the custom config we set and leave any
      // user-configured but since we're executing the hook in a separate
      // shell with login it would just get re-initialized there anyway.
      'GIT_CONFIG_PARAMETERS',

      'GIT_ASKPASS',
      'GIT_SSH_COMMAND',
      'GIT_USER_AGENT',
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

    // tmpdir is deleted when the Git call completes, so we can leave the file
    const stdinFilePath = join(tmpDir, `in-${randomBytes(8).toString('hex')}`)
    const hasStdin = hooksUsingStdin.includes(hookName)

    if (hasStdin) {
      await pipeline(connection.stdin, createWriteStream(stdinFilePath))
    }

    if (abortController.signal.aborted) {
      debug(`hook ${hookName} aborted before execution`)
      await exitWithError(connection, `Hook ${hookName} aborted`)
      return
    }

    const args = [
      'hook',
      'run',
      hookName,
      ...(hasStdin ? ['--to-stdin', stdinFilePath] : []),
      '--',
      ...proxyArgs.slice(1),
    ]
    const { code, signal } = await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>((resolve, reject) => {
      connection.on('close', () => abortController.abort())

      const child = spawn(gitPath, args, {
        cwd: proxyCwd,
        env: { ...shellEnv, ...safeEnv },
        signal: abortController.signal,
      })
        .on('close', (code, signal) => resolve({ code, signal }))
        .on('error', err => {
          debug(`failed to spawn hook process:`, err)
          reject(err)
        })

      // hooks never write to stdout
      // https://github.com/git/git/blob/4cf919bd7b946477798af5414a371b23fd68bf93/hook.c#L73C6-L73C22
      child.stderr.pipe(connection.stderr).on('error', reject)
      child.stderr.on('data', data =>
        console.log('hooks stderr:', data.toString())
      )
    })

    if (signal !== null) {
      debug(`hook ${hookName} was killed by signal ${signal}`)
      connection.stderr.write(
        `error: ${hookName} hook received signal ${signal}\n`
      )
    }

    await waitForWritableFinished(connection.stderr).catch(e => {
      debug(`waiting for stderr to finish failed`, e)
    })

    const elapsedSeconds = (Date.now() - startTime) / 1000
    debug(
      `executed ${hookName}: exited with code ${code} in ${elapsedSeconds}s`
    )

    const exitCode = code ?? 1
    await connection
      .exit(exitCode)
      .catch(err => debug(`failed to exit proxy:`, err))
      .then(() =>
        onHookProgress?.({
          hookName,
          status: exitCode === 0 ? 'finished' : 'failed',
        })
      )
  }
}
