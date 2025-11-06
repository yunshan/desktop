import * as React from 'react'

import { Dialog, DialogContent, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { TerminalOutputListener } from '../../lib/git'

interface ICommitProgressProps {
  readonly subscribeToCommitOutput: TerminalOutputListener
  readonly onDismissed: () => void
}

interface ICommitProgressState {
  readonly output: ReadonlyArray<string>
}

/** A component to confirm and then discard changes. */
export class CommitProgress extends React.Component<
  ICommitProgressProps,
  ICommitProgressState
> {
  private unsubscribe?: () => void | null

  public constructor(props: ICommitProgressProps) {
    super(props)
    this.state = {
      output: [],
    }
  }

  private onDismissed = () => {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.props.onDismissed()
  }

  public componentDidMount() {
    const { unsubscribe } = this.props.subscribeToCommitOutput(chunk => {
      this.setState(prevState => ({
        output: [...prevState.output, chunk.toString()],
      }))
    })
    this.unsubscribe = unsubscribe
  }

  public componentWillUnmount() {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  public render() {
    return (
      <Dialog
        id="hook-failure"
        title={`Committing changes`}
        onDismissed={this.onDismissed}
        onSubmit={this.onDismissed}
      >
        <DialogContent>
          <pre
            style={{
              maxHeight: '400px',
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {this.state.output.join('')}
          </pre>
        </DialogContent>

        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText={'Close'}
            cancelButtonVisible={false}
          />
        </DialogFooter>
      </Dialog>
    )
  }
}
