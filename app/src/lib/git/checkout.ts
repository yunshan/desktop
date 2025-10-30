import { git, IGitStringExecutionOptions } from './core'
import { Repository } from '../../models/repository'
import { Branch, BranchType } from '../../models/branch'
import { ICheckoutProgress } from '../../models/progress'
import {
  CheckoutProgressParser,
  executionOptionsWithProgress,
  IGitOutput,
} from '../progress'
import { AuthenticationErrors } from './authentication'
import { enableRecurseSubmodulesFlag } from '../feature-flag'
import {
  envForRemoteOperation,
  getFallbackUrlForProxyResolve,
} from './environment'
import { WorkingDirectoryFileChange } from '../../models/status'
import { ManualConflictResolution } from '../../models/manual-conflict-resolution'
import { CommitOneLine, shortenSHA } from '../../models/commit'
import { IRemote } from '../../models/remote'

export type ProgressCallback = (progress: ICheckoutProgress) => void

const SubmoduleUpdateStepWeight = 0.1

function getCheckoutArgs(progressCallback?: ProgressCallback) {
  return ['checkout', ...(progressCallback ? ['--progress'] : [])]
}

async function getBranchCheckoutArgs(branch: Branch) {
  return [
    branch.name,
    ...(branch.type === BranchType.Remote
      ? ['-b', branch.nameWithoutRemote]
      : []),
    '--',
  ]
}

async function getCheckoutOpts(
  repository: Repository,
  title: string,
  target: string,
  currentRemote: IRemote | null,
  progressCallback?: ProgressCallback,
  initialDescription?: string
): Promise<IGitStringExecutionOptions> {
  const opts: IGitStringExecutionOptions = {
    env: await envForRemoteOperation(
      getFallbackUrlForProxyResolve(repository, currentRemote)
    ),
    expectedErrors: AuthenticationErrors,
  }

  if (!progressCallback) {
    return opts
  }

  const kind = 'checkout'

  // Initial progress
  progressCallback({
    kind,
    title,
    description: initialDescription ?? title,
    value: 0,
    target,
  })

  return await executionOptionsWithProgress(
    { ...opts, trackLFSProgress: true },
    new CheckoutProgressParser(),
    progress => {
      if (progress.kind === 'progress') {
        const description = progress.details.text
        const value = progress.percent

        progressCallback({
          kind,
          title,
          description,
          value,
          target,
        })
      }
    }
  )
}

/**
 * Update submodules after a checkout operation.
 *
 * @param repository - The repository in which to update submodules
 * @param title - The title to use for progress reporting
 * @param target - The target branch/commit being checked out
 * @param currentRemote - The current remote for environment setup
 * @param progressCallback - An optional function which will be invoked
 *                           with information about the current progress
 *                           of the submodule update operation.
 */
async function updateSubmodulesAfterCheckout(
  repository: Repository,
  title: string,
  target: string,
  currentRemote: IRemote | null,
  progressCallback: ProgressCallback | undefined,
  allowFileProtocol: boolean
): Promise<void> {
  if (!enableRecurseSubmodulesFlag()) {
    return
  }

  const opts: IGitStringExecutionOptions = {
    env: await envForRemoteOperation(
      getFallbackUrlForProxyResolve(repository, currentRemote)
    ),
    expectedErrors: AuthenticationErrors,
  }

  const args = [
    ...(allowFileProtocol ? ['-c', 'protocol.file.allow=always'] : []),
    'submodule',
    'update',
    '--init',
    '--recursive',
  ]

  if (!progressCallback) {
    await git(args, repository.path, 'updateSubmodules', opts)
    return
  }

  // Initial progress
  progressCallback({
    kind: 'checkout',
    title,
    description: 'Updating submodules',
    value: 0,
    target,
  })

  const kind = 'checkout'

  const progressOpts = await executionOptionsWithProgress(
    { ...opts, trackLFSProgress: true },
    {
      parse(line: string): IGitOutput {
        return {
          kind: 'context',
          text: `Updating submodules: ${line}`,
          percent: 0.5,
        }
      },
    },
    progress => {
      const description =
        progress.kind === 'progress' ? progress.details.text : progress.text

      const value = progress.percent

      progressCallback({
        kind,
        title,
        description,
        value,
        target,
      })
    }
  )

  await git(args, repository.path, 'updateSubmodules', progressOpts)

  // Final progress
  progressCallback({
    kind,
    title,
    description: 'Submodules updated',
    value: 1,
    target,
  })
}

/**
 * Check out the given branch.
 *
 * @param repository - The repository in which the branch checkout should
 *                     take place
 *
 * @param branch     - The branch name that should be checked out
 *
 * @param progressCallback - An optional function which will be invoked
 *                           with information about the current progress
 *                           of the checkout operation. When provided this
 *                           enables the '--progress' command line flag for
 *                           'git checkout'.
 */
export async function checkoutBranch(
  repository: Repository,
  branch: Branch,
  currentRemote: IRemote | null,
  progressCallback?: ProgressCallback,
  allowFileProtocol: boolean = false
): Promise<true> {
  const title = `Checking out branch ${branch.name}`
  const opts = await getCheckoutOpts(
    repository,
    title,
    branch.name,
    currentRemote,
    progressCallback
      ? progress =>
          progressCallback({
            ...progress,
            value: progress.value * (1 - SubmoduleUpdateStepWeight),
          })
      : undefined,
    `Switching to ${__DARWIN__ ? 'Branch' : 'branch'}`
  )

  const baseArgs = getCheckoutArgs(progressCallback)
  const args = [...baseArgs, ...(await getBranchCheckoutArgs(branch))]

  await git(args, repository.path, 'checkoutBranch', opts)

  // Update submodules after checkout
  await updateSubmodulesAfterCheckout(
    repository,
    title,
    branch.name,
    currentRemote,
    progressCallback
      ? progress =>
          progressCallback({
            ...progress,
            value:
              1 -
              SubmoduleUpdateStepWeight +
              progress.value * SubmoduleUpdateStepWeight,
          })
      : undefined,
    allowFileProtocol
  )

  // we return `true` here so `GitStore.performFailableGitOperation`
  // will return _something_ differentiable from `undefined` if this succeeds
  return true
}

/**
 * Check out the given commit.
 * Literally invokes `git checkout <commit SHA>`.
 *
 * @param repository - The repository in which the branch checkout should
 *                     take place
 *
 * @param commit     - The commit that should be checked out
 *
 * @param progressCallback - An optional function which will be invoked
 *                           with information about the current progress
 *                           of the checkout operation. When provided this
 *                           enables the '--progress' command line flag for
 *                           'git checkout'.
 */
export async function checkoutCommit(
  repository: Repository,
  commit: CommitOneLine,
  currentRemote: IRemote | null,
  progressCallback?: ProgressCallback,
  allowFileProtocol: boolean = false
): Promise<true> {
  const title = `Checking out ${__DARWIN__ ? 'Commit' : 'commit'}`
  const target = shortenSHA(commit.sha)
  const opts = await getCheckoutOpts(
    repository,
    title,
    target,
    currentRemote,
    progressCallback
      ? progress =>
          progressCallback({
            ...progress,
            value: progress.value * (1 - SubmoduleUpdateStepWeight),
          })
      : undefined
  )

  const baseArgs = getCheckoutArgs(progressCallback)
  const args = [...baseArgs, commit.sha]

  await git(args, repository.path, 'checkoutCommit', opts)

  // Update submodules after checkout
  await updateSubmodulesAfterCheckout(
    repository,
    title,
    target,
    currentRemote,
    progressCallback
      ? progress =>
          progressCallback({
            ...progress,
            value:
              1 -
              SubmoduleUpdateStepWeight +
              progress.value * SubmoduleUpdateStepWeight,
          })
      : undefined,
    allowFileProtocol
  )

  // we return `true` here so `GitStore.performFailableGitOperation`
  // will return _something_ differentiable from `undefined` if this succeeds
  return true
}

/** Check out the paths at HEAD. */
export async function checkoutPaths(
  repository: Repository,
  paths: ReadonlyArray<string>
): Promise<void> {
  await git(
    ['checkout', 'HEAD', '--', ...paths],
    repository.path,
    'checkoutPaths'
  )
}

/**
 * Check out either stage #2 (ours) or #3 (theirs) for a conflicted
 * file.
 */
export async function checkoutConflictedFile(
  repository: Repository,
  file: WorkingDirectoryFileChange,
  resolution: ManualConflictResolution
) {
  await git(
    ['checkout', `--${resolution}`, '--', file.path],
    repository.path,
    'checkoutConflictedFile'
  )
}
