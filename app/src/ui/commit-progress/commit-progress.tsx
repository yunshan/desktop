import * as React from 'react'

import { Dialog, DialogContent, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { TerminalOutputListener } from '../../lib/git'
import { Terminal } from '@xterm/xterm'

interface ICommitProgressProps {
  readonly subscribeToCommitOutput: TerminalOutputListener
  readonly onDismissed: () => void
}

/** A component to confirm and then discard changes. */
export class CommitProgress extends React.Component<ICommitProgressProps> {
  private unsubscribe?: () => void | null
  private terminalRef = React.createRef<HTMLDivElement>()
  private terminal: Terminal | null = null

  private onDismissed = () => {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.props.onDismissed()
  }

  public componentDidMount() {
    if (this.terminalRef.current) {
      this.terminal = new Terminal({
        disableStdin: true,
        convertEol: true,
        rows: 20,
        cols: 80,
        fontSize: 12,
        fontFamily:
          "SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace, 'Apple Color Emoji', 'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Symbol'",
      })

      this.terminal.open(this.terminalRef.current)
    }

    const { unsubscribe } = this.props.subscribeToCommitOutput(chunk => {
      this.terminal?.write(chunk)
    })

    this.unsubscribe = unsubscribe
  }

  public componentWillUnmount() {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.terminal?.dispose()
    this.terminal = null
  }

  public render() {
    return (
      <Dialog
        id="commit-progress-dialog"
        title={`Committing changes`}
        onDismissed={this.onDismissed}
        onSubmit={this.onDismissed}
      >
        <DialogContent>
          <div className="terminal-container" ref={this.terminalRef}></div>
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
