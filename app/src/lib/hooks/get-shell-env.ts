import { join } from 'path'
import { getShell } from './get-shell'
import { spawn } from 'child_process'

export const getShellEnv = async (): Promise<
  Record<string, string | undefined>
> => {
  const ext = __WIN32__ ? '.exe' : ''
  const printenvzPath = join(__dirname, `printenvz${ext}`)

  const { shell, args, quoteCommand, windowsVerbatimArguments, argv0 } =
    await getShell()

  return await new Promise((resolve, reject) => {
    const child = spawn(shell, [...args, quoteCommand(printenvzPath)], {
      env: {},
      windowsVerbatimArguments,
      argv0,
      stdio: 'pipe',
    })

    const chunks: Buffer[] = []

    child.stdout
      .on('data', chunk => chunks.push(chunk))
      .on('end', () => {
        const stdout = Buffer.concat(chunks).toString('utf8')
        const matches = stdout.matchAll(/([^=]+)=([^\0]*)\0/g)
        resolve(Object.fromEntries(Array.from(matches, m => [m[1], m[2]])))
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
