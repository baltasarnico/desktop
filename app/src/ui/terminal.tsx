import type {
  ITerminalOptions,
  ITerminalInitOnlyOptions,
  Terminal as XTermTerminal,
} from '@xterm/xterm'
import React from 'react'
import { getMonospaceFontFamily } from './get-monospace-font-family'
import { TerminalOutput } from '../lib/git'

export const defaultTerminalOptions: Readonly<ITerminalOptions> = {
  convertEol: true,
  fontFamily: getMonospaceFontFamily(),
  fontSize: 12,
  screenReaderMode: true,
}

export type TerminalProps = ITerminalOptions &
  ITerminalInitOnlyOptions & {
    readonly terminalOutput?: TerminalOutput
    readonly hideCursor?: boolean
  }

/**
 * A read only terminal for showing Git output.
 *
 * xterm.js is loaded when the first terminal is shown rather than at startup,
 * output written before it has loaded is buffered.
 */
export class Terminal extends React.Component<TerminalProps> {
  private terminalRef = React.createRef<HTMLDivElement>()
  private terminal: XTermTerminal | null = null
  private pendingOutput = new Array<TerminalOutput>()
  private unmounted = false

  public get Terminal() {
    return this.terminal
  }

  public write(data: TerminalOutput) {
    if (this.terminal === null) {
      this.pendingOutput.push(data)
      return
    }

    if (Array.isArray(data)) {
      data.forEach(chunk => this.terminal?.write(chunk))
    } else {
      this.terminal?.write(data)
    }
  }

  public componentWillUnmount(): void {
    this.unmounted = true
    this.pendingOutput = []
    this.terminal?.dispose()
  }

  public async componentDidMount() {
    const { Terminal: XTermTerminal } = await import('@xterm/xterm')
    if (this.unmounted) {
      return
    }

    const { terminalOutput, hideCursor, ...initOpts } = this.props
    const terminal = new XTermTerminal({
      ...defaultTerminalOptions,
      ...initOpts,

      rows: this.props.rows ?? 20,
      cols: this.props.cols ?? 80,
    })

    this.terminal = terminal
    terminal.attachCustomKeyEventHandler((key: KeyboardEvent) => {
      if (key.key === 'Tab') {
        // We don't want to handle tab key events in the terminal as it
        // breaks tab navigation in the app. The terminal is read only and
        // doesn't support tab input, so we can safely ignore it.
        return false
      }
      return true
    })

    if (this.terminalRef.current) {
      terminal.open(this.terminalRef.current)

      if (hideCursor !== false) {
        terminal.write('\x1b[?25l') // hide cursor
        if (terminalOutput) {
          this.write(terminalOutput)
        }
      }
    }

    const pending = this.pendingOutput
    this.pendingOutput = []
    pending.forEach(output => this.write(output))
  }

  public render() {
    return <div ref={this.terminalRef}></div>
  }
}
