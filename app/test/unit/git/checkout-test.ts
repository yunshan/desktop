import { describe, it } from 'node:test'
import assert from 'node:assert'
import * as Path from 'path'
import * as FSE from 'fs-extra'
import { shell } from '../../helpers/test-app-shell'
import {
  setupEmptyRepository,
  setupFixtureRepository,
  setupRepositoryWithUninitializedSubmodule,
} from '../../helpers/repositories'

import { Repository } from '../../../src/models/repository'
import { checkoutBranch, getBranches, createBranch } from '../../../src/lib/git'
import { TipState, IValidBranch } from '../../../src/models/tip'
import { GitStore } from '../../../src/lib/stores'
import { Branch, BranchType } from '../../../src/models/branch'
import { getStatusOrThrow } from '../../helpers/status'
import { exec } from 'dugite'
import { TestStatsStore } from '../../helpers/test-stats-store'

describe('git/checkout', () => {
  it('throws when invalid characters are used for branch name', async t => {
    const repository = await setupEmptyRepository(t)

    const branch: Branch = {
      name: '..',
      nameWithoutRemote: '..',
      upstream: null,
      upstreamWithoutRemote: null,
      type: BranchType.Local,
      tip: { sha: '' },
      remoteName: null,
      upstreamRemoteName: null,
      isDesktopForkRemoteBranch: false,
      ref: '',
    }

    await assert.rejects(
      checkoutBranch(repository, branch, null),
      /fatal: invalid reference: ..\n/
    )
  })

  it('can checkout a valid branch name in an existing repository', async t => {
    const path = await setupFixtureRepository(t, 'repo-with-many-refs')
    const repository = new Repository(path, -1, null, false)

    const branches = await getBranches(
      repository,
      'refs/heads/commit-with-long-description'
    )

    if (branches.length === 0) {
      throw new Error(`Could not find branch: commit-with-long-description`)
    }

    await checkoutBranch(repository, branches[0], null)

    const store = new GitStore(repository, shell, new TestStatsStore())
    await store.loadStatus()
    const tip = store.tip

    assert.equal(tip.kind, TipState.Valid)

    const validBranch = tip as IValidBranch
    assert.equal(validBranch.branch.name, 'commit-with-long-description')
  })

  it('can checkout a branch when it exists on multiple remotes', async t => {
    const path = await setupFixtureRepository(t, 'checkout-test-cases')
    const repository = new Repository(path, -1, null, false)

    const expectedBranch = 'first'
    const firstRemote = 'first-remote'
    const secondRemote = 'second-remote'

    const branches = await getBranches(repository)
    const firstBranch = `${firstRemote}/${expectedBranch}`
    const firstRemoteBranch = branches.find(b => b.name === firstBranch)

    if (firstRemoteBranch == null) {
      throw new Error(`Could not find branch: '${firstBranch}'`)
    }

    const secondBranch = `${secondRemote}/${expectedBranch}`
    const secondRemoteBranch = branches.find(b => b.name === secondBranch)

    if (secondRemoteBranch == null) {
      throw new Error(`Could not find branch: '${secondBranch}'`)
    }

    await checkoutBranch(repository, firstRemoteBranch, null)

    const store = new GitStore(repository, shell, new TestStatsStore())
    await store.loadStatus()
    const tip = store.tip

    assert.equal(tip.kind, TipState.Valid)

    const validBranch = tip as IValidBranch
    assert.equal(validBranch.branch.name, expectedBranch)
    assert.equal(validBranch.branch.type, BranchType.Local)
    assert.equal(validBranch.branch.upstreamRemoteName, 'first-remote')
  })

  it('will fail when an existing branch matches the remote branch', async t => {
    const path = await setupFixtureRepository(t, 'checkout-test-cases')
    const repository = new Repository(path, -1, null, false)

    const expectedBranch = 'first'
    const firstRemote = 'first-remote'

    const branches = await getBranches(repository)
    const firstBranch = `${firstRemote}/${expectedBranch}`
    const remoteBranch = branches.find(b => b.name === firstBranch)

    if (remoteBranch == null) {
      throw new Error(`Could not find branch: '${firstBranch}'`)
    }

    await createBranch(repository, expectedBranch, null)

    await assert.rejects(
      checkoutBranch(repository, remoteBranch, null),
      /A branch with that name already exists./
    )
  })

  describe('with submodules', () => {
    it('cleans up an submodule that no longer exists', async t => {
      const path = await setupFixtureRepository(t, 'test-submodule-checkouts')
      const repository = new Repository(path, -1, null, false)

      // put the repository into a known good state
      await exec(
        ['checkout', 'add-private-repo', '-f', '--recurse-submodules'],
        path
      )

      const branches = await getBranches(repository)
      const masterBranch = branches.find(b => b.name === 'master')

      if (masterBranch == null) {
        throw new Error(`Could not find branch: 'master'`)
      }

      await checkoutBranch(repository, masterBranch, null)

      const status = await getStatusOrThrow(repository)

      assert.equal(status.workingDirectory.files.length, 0)
    })

    it('updates a changed submodule reference', async t => {
      const path = await setupFixtureRepository(t, 'test-submodule-checkouts')
      const repository = new Repository(path, -1, null, false)

      // put the repository into a known good state
      await exec(['checkout', 'master', '-f', '--recurse-submodules'], path)

      const branches = await getBranches(repository)
      const devBranch = branches.find(b => b.name === 'dev')

      if (devBranch == null) {
        throw new Error(`Could not find branch: 'dev'`)
      }

      await checkoutBranch(repository, devBranch, null)

      const status = await getStatusOrThrow(repository)
      assert.equal(status.workingDirectory.files.length, 0)
    })

    it('initializes an uninitialized submodule when checking out a branch', async t => {
      const repository = await setupRepositoryWithUninitializedSubmodule(t)

      const branches = await getBranches(repository)
      const branchWithSubmodule = branches.find(b => b.name !== 'master')

      if (branchWithSubmodule == null) {
        throw new Error(`Could not find branch other than 'master'`)
      }

      await checkoutBranch(repository, branchWithSubmodule, null)

      // Verify we're on the correct branch
      const statusOutput = await exec(['status'], repository.path)
      assert.ok(
        statusOutput.stdout.includes(`On branch ${branchWithSubmodule.name}`)
      )

      // Verify the submodule is initialized and has the correct commits
      const submodulePath = Path.join(repository.path, 'test-submodule')
      const submoduleGitPath = Path.join(submodulePath, '.git')

      // Check that submodule .git exists (either as file or directory)
      const submoduleGitExists = await FSE.pathExists(submoduleGitPath)
      assert.equal(
        submoduleGitExists,
        true,
        'Submodule .git should exist after checkout'
      )

      // Verify submodule has two commits
      const submoduleLog = await exec(['log', '--oneline'], submodulePath)
      assert.equal(submoduleLog.stdout.split('\n').length, 2)

      // Verify submodule is in branch 'master'
      const submoduleStatus = await exec(['status'], submodulePath)
      assert.ok(
        submoduleStatus.stdout.includes('On branch master'),
        'Submodule should be on branch master after checkout'
      )
    })
  })
})
