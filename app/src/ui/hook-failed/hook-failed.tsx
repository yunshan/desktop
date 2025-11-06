import * as React from 'react'

import { Dialog, DialogContent, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { Terminal } from '@xterm/xterm'

interface IHookFailedProps {
  readonly hookName: string
  readonly terminalOutput: string
  readonly resolve: (value: 'abort' | 'ignore') => void
  readonly onDismissed: () => void
}

/** A component to confirm and then discard changes. */
export class HookFailed extends React.Component<IHookFailedProps> {
  private terminalRef = React.createRef<HTMLDivElement>()
  private terminal: Terminal | null = null

  private getDialogTitle() {
    return `${this.props.hookName} ${__DARWIN__ ? 'Failed' : 'failed'}`
  }

  private onDismissed = () => {
    this.props.resolve('abort')
    this.props.onDismissed()
  }

  private onIgnore = () => {
    this.props.resolve('ignore')
    this.props.onDismissed()
  }

  public componentDidMount(): void {
    if (this.terminalRef.current) {
      this.terminal = new Terminal({
        disableStdin: true,
        convertEol: true,
        rows: 10,
        cols: 80,
        fontSize: 12,
        fontFamily:
          "SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace, 'Apple Color Emoji', 'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Symbol'",
      })
      this.terminal.open(this.terminalRef.current)
      this.terminal.write(this.props.terminalOutput)
    }
  }

  public componentWillUnmount(): void {
    this.terminal?.dispose()
    this.terminal = null
  }

  public render() {
    return (
      <Dialog
        id="hook-failed-dialog"
        title={this.getDialogTitle()}
        onDismissed={this.onDismissed}
        onSubmit={this.onIgnore}
        type="warning"
        role="alertdialog"
        ariaDescribedBy="hook-failure-message"
      >
        <DialogContent>
          <p id="hook-failure-message">
            The {this.props.hookName} hook failed. What would you like to do?
          </p>
          <div ref={this.terminalRef}></div>
        </DialogContent>

        <DialogFooter>
          <OkCancelButtonGroup
            destructive={true}
            okButtonText={'Ignore and Continue'}
            cancelButtonText={'Abort commit'}
          />
        </DialogFooter>
      </Dialog>
    )
  }
}
