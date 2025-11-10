import { cp, mkdtemp, rm } from 'fs/promises'
import { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { createProxyProcessServer } from 'process-proxy'
import { enableHooksEnvironment } from '../feature-flag'
import type { IGitExecutionOptions } from '../git/core'
import { getRepoHooks } from './get-repo-hooks'
import { createHooksProxy } from './hooks-proxy'
import { getShellEnv } from './get-shell-env'

export async function withHooksEnv<T>(
  fn: (env: Record<string, string | undefined> | undefined) => Promise<T>,
  path: string,
  options: IGitExecutionOptions | undefined
): Promise<T> {
  const interceptHooks = options?.interceptHooks ?? false

  if (!interceptHooks || !enableHooksEnvironment()) {
    return fn(options?.env)
  }

  const repoHooks = await Array.fromAsync(
    getRepoHooks(
      path,
      typeof interceptHooks === 'object' ? interceptHooks : undefined
    )
  )

  if (repoHooks.length === 0) {
    return fn(options?.env)
  }

  const shellEnvStartTime = Date.now()
  const shellEnv = await getShellEnv()
  log.debug(
    `hooks: loaded shell environment in ${Date.now() - shellEnvStartTime}ms`
  )

  const ext = __WIN32__ ? '.exe' : ''
  const processProxyPath = join(__dirname, `process-proxy${ext}`)

  const token = crypto.randomUUID()
  const tmpHooksDir = await mkdtemp(join(tmpdir(), 'desktop-git-hooks-'))
  const hooksProxy = createHooksProxy(
    repoHooks,
    tmpHooksDir,
    shellEnv,
    options?.onHookProgress,
    options?.onHookFailure
  )

  const server = createProxyProcessServer(
    conn =>
      hooksProxy(conn).catch(err => {
        log.error(`hooks proxy failed:`, err)
        conn.exit(1).catch(() => {})
      }),
    { validateConnection: async receivedToken => receivedToken === token }
  )
  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
  try {
    for (const hook of repoHooks) {
      const cleanHooksName = __WIN32__
        ? basename(hook).replace(/\.exe$/i, '')
        : basename(hook)

      await cp(processProxyPath, join(tmpHooksDir, `${cleanHooksName}${ext}`))
    }

    const existingGitEnvConfig =
      options?.env?.['GIT_CONFIG_PARAMETERS'] ??
      process.env['GIT_CONFIG_PARAMETERS'] ??
      ''

    const gitEnvConfigPrefix =
      existingGitEnvConfig.length > 0 ? `${existingGitEnvConfig} ` : ''

    return await fn({
      // TODO: Do we need to escape tmpHooksDir? Could it possibly include a single quote?
      // probably not?
      GIT_CONFIG_PARAMETERS: `${gitEnvConfigPrefix}'core.hooksPath=${tmpHooksDir}'`,
      PROCESS_PROXY_PORT: `${port}`,
      PROCESS_PROXY_TOKEN: token,
    })
  } finally {
    server.close()
    // Clean up the temporary directory
    await rm(tmpHooksDir, { recursive: true, force: true }).catch(() => {
      // Ignore errors
    })
  }
}
