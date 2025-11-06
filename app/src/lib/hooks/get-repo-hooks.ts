import { exec } from 'dugite'
import { access, constants, readdir } from 'fs/promises'
import { join, resolve } from 'path'

const isExecutable = (path: string) =>
  access(path, constants.X_OK)
    .then(() => true)
    .catch(() => false)

const knownHooks = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'p4-changelist',
  'p4-prepare-changelist',
  'p4-post-changelist',
  'p4-pre-submit',
  'post-index-change',
]

export async function* getRepoHooks(path: string, filter?: string[]) {
  const { exitCode, stdout } = await exec(
    ['config', '-z', '--get', 'core.hooksPath'],
    path
  )

  const hooksPath =
    exitCode === 0
      ? resolve(path, stdout.split('\0')[0])
      : join(path, '.git', 'hooks')

  const files = await readdir(hooksPath, { withFileTypes: true })
    .then(entries => entries.filter(x => x.isFile()))
    .catch(() => [])

  for (const hook of files) {
    const hookName = hook.name.endsWith('.exe')
      ? hook.name.slice(0, -4)
      : hook.name

    if (filter && !filter.includes(hookName)) {
      continue
    }

    if (!knownHooks.includes(hookName)) {
      continue
    }

    if (hookName.endsWith('.sample')) {
      continue
    }

    const hookPath = join(hook.parentPath, hook.name)

    if (__WIN32__) {
      // On Windows we have to assume that any valid hook name is executable
      // because the executable bit is not used there. Git looks for a shebang
      // but that seems expensive to check here :shrug:
      yield hookPath
    } else {
      if (await isExecutable(hookPath)) {
        yield hookPath
      }
    }
  }
}
