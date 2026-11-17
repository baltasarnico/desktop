import assert from 'node:assert'
import { describe, it } from 'node:test'
import * as React from 'react'

import { AugmentedSectionFilterList } from '../../../src/ui/lib/augmented-filter-list'
import { IFilterListGroup } from '../../../src/ui/lib/filter-list'
import { render } from '../../helpers/ui/render'

interface ITestItem {
  readonly id: string
  readonly text: ReadonlyArray<string>
}

const items: ReadonlyArray<ITestItem> = Array.from({ length: 50 }, (_, i) => ({
  id: `file-${i}`,
  text: [`src/file-${i}.ts`],
}))

const groups: ReadonlyArray<IFilterListGroup<ITestItem>> = [
  { identifier: 'changes', items },
]

function renderList(
  props: {
    readonly groups?: ReadonlyArray<IFilterListGroup<ITestItem>>
    readonly selectedItems?: ReadonlyArray<ITestItem>
    readonly filterText?: string
  },
  ref: React.RefObject<AugmentedSectionFilterList<ITestItem>>
) {
  return (
    <AugmentedSectionFilterList<ITestItem>
      ref={ref}
      rowHeight={29}
      groups={props.groups ?? groups}
      selectedItems={props.selectedItems ?? []}
      filterText={props.filterText}
      renderItem={item => <span>{item.id}</span>}
      invalidationProps={null}
    />
  )
}

describe('AugmentedSectionFilterList', () => {
  it('selects the rows of every selected item', () => {
    const ref = React.createRef<AugmentedSectionFilterList<ITestItem>>()
    render(renderList({ selectedItems: [items[3], items[40]] }, ref))

    assert.deepStrictEqual(ref.current?.state.selectedRows, [
      { section: 0, row: 3 },
      { section: 0, row: 40 },
    ])
  })

  it('reuses rows when re-rendered with the same inputs', () => {
    const ref = React.createRef<AugmentedSectionFilterList<ITestItem>>()
    const view = render(renderList({ filterText: 'file-1' }, ref))
    const rows = ref.current?.state.rows
    assert.ok(rows !== undefined && rows.length > 0)

    // A parent re-render with a new selection but identical groups/filter
    view.rerender(
      renderList({ filterText: 'file-1', selectedItems: [items[10]] }, ref)
    )
    assert.strictEqual(ref.current?.state.rows, rows)
    assert.deepStrictEqual(ref.current?.state.selectedRows, [
      {
        section: 0,
        row: rows[0].findIndex(
          r => r.kind === 'item' && r.item.id === 'file-10'
        ),
      },
    ])

    // New groups (e.g. after a status refresh) are matched again
    view.rerender(
      renderList({ groups: [{ ...groups[0] }], filterText: 'file-1' }, ref)
    )
    assert.notStrictEqual(ref.current?.state.rows, rows)
  })

  it('selects the first visible row when the selection is filtered out', () => {
    const ref = React.createRef<AugmentedSectionFilterList<ITestItem>>()
    render(
      renderList({ filterText: 'file-49', selectedItems: [items[0]] }, ref)
    )

    assert.deepStrictEqual(ref.current?.state.selectedRows, [
      { section: 0, row: 0 },
    ])
  })
})
