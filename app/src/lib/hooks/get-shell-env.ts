import { join } from 'path'
import { getShell } from './get-shell'
import { spawn } from 'child_process'
import { SupportedHooksEnvShell } from './config'

export type ShellEnvResult =
  | {
      kind: 'success'
      env: Record<string, string | undefined>
    }
  | {
      kind: 'failure'
      shellKind?: SupportedHooksEnvShell
    }

export const getShellEnv = async (
  cwd?: string,
  shellKind?: SupportedHooksEnvShell
): Promise<ShellEnvResult> => {
  const ext = __WIN32__ ? '.exe' : ''
  const printenvzPath = join(__dirname, `printenvz${ext}`)

  const shellInfo = await getShell(shellKind)

  if (!shellInfo) {
    return { kind: 'failure', shellKind }
  }

  const { shell, args, quoteCommand, windowsVerbatimArguments, argv0 } =
    shellInfo

  return await new Promise((resolve, reject) => {
    const child = spawn(shell, [...args, quoteCommand(printenvzPath)], {
      env: {},
      windowsVerbatimArguments,
      argv0,
      stdio: 'pipe',
      cwd,
    })

    const chunks: Buffer[] = []

    child.stdout
      .on('data', chunk => chunks.push(chunk))
      .on('end', () => {
        const stdout = Buffer.concat(chunks).toString('utf8')
        const matches = stdout.matchAll(/([^=]+)=([^\0]*)\0/g)
        resolve({
          kind: 'success',
          env: Object.fromEntries(Array.from(matches, m => [m[1], m[2]])),
        })
      })

    child.on('error', err => reject(err))

    child.on('close', (code, signal) => {
      if (code !== 0) {
        return reject(
          new Error(`child exited with code ${code} and signal ${signal}`)
        )
      }
    })
  })
}
