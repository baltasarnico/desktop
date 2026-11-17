import assert from 'node:assert'
import { describe, it, mock } from 'node:test'
import * as React from 'react'

import { render } from '../../helpers/ui/render'

describe('Terminal', () => {
  it('keeps output written before xterm.js has loaded', async () => {
    const written = new Array<string>()
    class FakeXTerm {
      public attachCustomKeyEventHandler() {}
      public open() {}
      public dispose() {}
      public write(data: string) {
        written.push(data)
      }
    }
    mock.module('@xterm/xterm', { namedExports: { Terminal: FakeXTerm } })
    const { Terminal } = await import('../../../src/ui/terminal')

    const ref = React.createRef<InstanceType<typeof Terminal>>()
    render(<Terminal ref={ref} terminalOutput="initial" />)
    ref.current?.write('early')

    await new Promise(resolve => setTimeout(resolve, 50))
    ref.current?.write('late')

    assert.deepStrictEqual(written, ['\x1b[?25l', 'initial', 'early', 'late'])
  })
})
