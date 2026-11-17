import assert from 'node:assert'
import { describe, it } from 'node:test'
import * as React from 'react'

import { Resizable } from '../../../src/ui/resizable/resizable'
import { render } from '../../helpers/ui/render'

describe('Resizable', () => {
  it('applies at most one resize per animation frame while dragging', t => {
    const frames = new Array<FrameRequestCallback>()
    t.mock.method(
      globalThis,
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => frames.push(cb)
    )
    t.mock.method(globalThis, 'cancelAnimationFrame', () => {})
    const widths = new Array<number>()

    const view = render(
      <Resizable
        width={250}
        description="Sidebar"
        onResize={w => widths.push(w)}
        onReset={() => {}}
      >
        <div />
      </Resizable>
    )
    const handle = view.container.querySelector('.resize-handle')
    assert.ok(handle)

    const mouse = (type: string, clientX: number) =>
      new MouseEvent(type, { clientX, bubbles: true, cancelable: true })

    handle.dispatchEvent(mouse('mousedown', 100))
    document.dispatchEvent(mouse('mousemove', 110))
    document.dispatchEvent(mouse('mousemove', 120))
    document.dispatchEvent(mouse('mousemove', 130))
    assert.deepStrictEqual(widths, [])
    assert.equal(frames.length, 1)

    frames[0](0)
    assert.deepStrictEqual(widths, [280])

    // The final position is applied right away when the drag ends
    document.dispatchEvent(mouse('mousemove', 140))
    document.dispatchEvent(mouse('mouseup', 140))
    assert.deepStrictEqual(widths, [280, 290])
  })
})
