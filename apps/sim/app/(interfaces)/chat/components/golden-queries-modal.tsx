import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  ChipModal,
  ChipModalBody,
  ChipModalFooter,
  ChipModalHeader,
  Tooltip,
} from '@sim/emcn'
import { Check, GripVertical, Loader2, Pencil, Trash2, X } from 'lucide-react'

interface GoldenQueryItem {
  id?: string
  query: string
}

interface GoldenQueriesModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  queries: GoldenQueryItem[]
  onSelectQuery: (query: string) => void
  onSaveQueries: (queries: GoldenQueryItem[], mode: 'hard' | 'soft') => Promise<void>
  disabled?: boolean
}

export function GoldenQueriesModal({
  open,
  onOpenChange,
  queries,
  onSelectQuery,
  onSaveQueries,
  disabled = false,
}: GoldenQueriesModalProps) {
  const normalizedQueries = useMemo(
    () =>
      queries
        .map((item) => ({ ...item, query: item.query.trim() }))
        .filter((item) => item.query.length > 0),
    [queries]
  )
  const [draftQueries, setDraftQueries] = useState<GoldenQueryItem[]>(normalizedQueries)
  const [mode, setMode] = useState<'add' | 'edit' | null>(null)
  const [draftValue, setDraftValue] = useState('')
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [dragHandleIndex, setDragHandleIndex] = useState<number | null>(null)
  const dragSnapshotRef = useRef<GoldenQueryItem[] | null>(null)
  const addInputRef = useRef<HTMLInputElement | null>(null)
  const dragDroppedRef = useRef(false)
  const [savingAction, setSavingAction] = useState<
    { type: 'save' } | { type: 'delete'; index: number } | { type: 'reorder' } | null
  >(null)

  useEffect(() => {
    if (!open) return
    setDraftQueries(normalizedQueries)
    setMode(null)
    setDraftValue('')
    setEditingIndex(null)
    setErrorMessage(null)
    setIsSaving(false)
    setSavingAction(null)
    setDragOverIndex(null)
    setDragHandleIndex(null)
    dragSnapshotRef.current = null
    dragDroppedRef.current = false
  }, [open, normalizedQueries])

  useEffect(() => {
    if (!open || mode !== 'add') return
    const timer = window.setTimeout(() => {
      addInputRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open, mode])

  const isAddDisabled = disabled || isSaving || mode !== null

  const handleAddClick = () => {
    setMode('add')
    setDraftValue('')
    setEditingIndex(null)
    setErrorMessage(null)
  }

  const handleEditClick = (index: number) => {
    setMode('edit')
    setEditingIndex(index)
    setDraftValue(draftQueries[index]?.query ?? '')
    setErrorMessage(null)
  }

  const handleCancel = () => {
    setMode(null)
    setDraftValue('')
    setEditingIndex(null)
    setErrorMessage(null)
  }

  const handleSave = async () => {
    const trimmedValue = draftValue.trim()
    if (!trimmedValue) {
      setErrorMessage('Query cannot be empty.')
      return
    }

    let nextQueries = draftQueries
    if (mode === 'add') {
      nextQueries = [...draftQueries, { query: trimmedValue }]
    }
    if (mode === 'edit' && editingIndex !== null) {
      nextQueries = draftQueries.map((item, index) =>
        index === editingIndex ? { ...item, query: trimmedValue } : item
      )
    }

    setIsSaving(true)
    setSavingAction({ type: 'save' })
    setErrorMessage(null)
    try {
      await onSaveQueries(nextQueries, 'hard')
      setDraftQueries(nextQueries)
      handleCancel()
    } catch {
      setErrorMessage('Failed to save query. Please try again.')
    } finally {
      setIsSaving(false)
      setSavingAction(null)
    }
  }

  const handleDelete = async (index: number) => {
    const nextQueries = draftQueries.filter((_, queryIndex) => queryIndex !== index)
    setIsSaving(true)
    setSavingAction({ type: 'delete', index })
    setErrorMessage(null)
    try {
      await onSaveQueries(nextQueries, 'soft')
      setDraftQueries(nextQueries)
      if (mode === 'edit' && editingIndex === index) {
        handleCancel()
      }
    } catch {
      setErrorMessage('Failed to delete query. Please try again.')
    } finally {
      setIsSaving(false)
      setSavingAction(null)
    }
  }

  const handlePersistReorder = async (nextQueries: GoldenQueryItem[]) => {
    setIsSaving(true)
    setSavingAction({ type: 'reorder' })
    setErrorMessage(null)
    try {
      await onSaveQueries(nextQueries, 'hard')
      setDraftQueries(nextQueries)
    } catch {
      setErrorMessage('Failed to reorder queries. Please try again.')
      if (dragSnapshotRef.current) {
        setDraftQueries(dragSnapshotRef.current)
      }
    } finally {
      setIsSaving(false)
      setSavingAction(null)
      dragSnapshotRef.current = null
      dragDroppedRef.current = false
    }
  }

  return (
    <ChipModal open={open} onOpenChange={onOpenChange} size='lg' srTitle='Golden queries'>
      <ChipModalHeader onClose={() => onOpenChange(false)}>Golden queries</ChipModalHeader>
      <ChipModalBody>
        <Tooltip.Provider>
          <div className='flex flex-col gap-3'>
            {draftQueries.length === 0 ? (
              <div className='flex items-center gap-3 text-[12px] text-[var(--text-secondary)]'>
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <Button variant='default' onClick={handleAddClick} disabled={isAddDisabled}>
                      Add Query
                    </Button>
                  </Tooltip.Trigger>
                  <Tooltip.Content>Add a new query</Tooltip.Content>
                </Tooltip.Root>
                <span>No queries added to this chat yet.</span>
              </div>
            ) : (
              <div className='flex flex-col gap-2'>
                {draftQueries.map((item, index) => {
                  const isEditing = mode === 'edit' && editingIndex === index
                  const isDragging = draggingIndex === index
                  const isDragOver = dragOverIndex === index && draggingIndex !== null
                  return (
                    <div
                      key={item.id ?? `${item.query}-${index}`}
                      className={`group flex items-center gap-2 rounded-[8px] px-3 py-2 text-left text-[13px] text-[var(--text-primary)] transition ${
                        isDragging
                          ? 'bg-[#E6EEF9] opacity-70 shadow-sm ring-1 ring-[var(--border-200)]'
                          : isDragOver
                            ? 'bg-[#E6EEF9] ring-2 ring-[var(--brand-primary-hover-hex)]'
                            : 'bg-[var(--color-ds-brand-surface)] hover:bg-[var(--color-ds-blue-200)]'
                      }`}
                      draggable={mode === null && !disabled && !isSaving}
                      onDragStart={(event) => {
                        if (dragHandleIndex !== index) {
                          event.preventDefault()
                          return
                        }
                        dragSnapshotRef.current = draftQueries
                        dragDroppedRef.current = false
                        setDraggingIndex(index)
                        setDragOverIndex(index)
                        event.dataTransfer.setData('text/plain', `${index}`)
                        event.dataTransfer.setDragImage(event.currentTarget, 0, 0)
                      }}
                      onDragOver={(event) => {
                        if (draggingIndex === null) return
                        event.preventDefault()
                        if (dragOverIndex !== index) {
                          setDragOverIndex(index)
                          const nextQueries = [...draftQueries]
                          const [moved] = nextQueries.splice(draggingIndex, 1)
                          nextQueries.splice(index, 0, moved)
                          setDraftQueries(nextQueries)
                          setDraggingIndex(index)
                        }
                      }}
                      onDrop={async (event) => {
                        if (draggingIndex === null) return
                        event.preventDefault()
                        dragDroppedRef.current = true
                        setDraggingIndex(null)
                        setDragOverIndex(null)
                        setDragHandleIndex(null)
                        await handlePersistReorder(draftQueries)
                      }}
                      onDragEnd={() => {
                        if (!dragDroppedRef.current && dragSnapshotRef.current) {
                          setDraftQueries(dragSnapshotRef.current)
                        }
                        setDraggingIndex(null)
                        setDragOverIndex(null)
                        setDragHandleIndex(null)
                        dragSnapshotRef.current = null
                        dragDroppedRef.current = false
                      }}
                    >
                      <div className='pt-0.5 opacity-0 transition group-hover:opacity-100'>
                        <Tooltip.Root>
                          <Tooltip.Trigger asChild>
                            <button
                              type='button'
                              draggable={mode === null && !disabled && !isSaving}
                              onMouseDown={() => setDragHandleIndex(index)}
                              onMouseUp={() => setDragHandleIndex(null)}
                              onMouseLeave={() => setDragHandleIndex(null)}
                              onTouchStart={() => setDragHandleIndex(index)}
                              onTouchEnd={() => setDragHandleIndex(null)}
                              className='cursor-grab rounded p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40'
                              aria-label='Drag to reorder'
                              disabled={disabled || isSaving || mode !== null}
                            >
                              {savingAction?.type === 'reorder' ? (
                                <Loader2 className='h-4 w-4 animate-spin' />
                              ) : (
                                <GripVertical className='h-4 w-4' />
                              )}
                            </button>
                          </Tooltip.Trigger>
                          <Tooltip.Content>Drag to reorder</Tooltip.Content>
                        </Tooltip.Root>
                      </div>
                      {isEditing ? (
                        <div className='flex flex-1 items-center gap-2'>
                          <input
                            value={draftValue}
                            onChange={(event) => setDraftValue(event.target.value)}
                            placeholder='Type your query'
                            disabled={disabled || isSaving}
                            className='h-[34px] flex-1 rounded-[6px] border border-[var(--border-200)] px-3 text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary-hover-hex)] disabled:cursor-not-allowed disabled:opacity-60'
                          />
                          <Tooltip.Root>
                            <Tooltip.Trigger asChild>
                              <Button
                                variant='ghost'
                                onClick={handleSave}
                                disabled={disabled || isSaving}
                                aria-label='Save query'
                              >
                                {savingAction?.type === 'save' ? (
                                  <Loader2 className='h-4 w-4 animate-spin' />
                                ) : (
                                  <Check className='h-4 w-4' />
                                )}
                              </Button>
                            </Tooltip.Trigger>
                            <Tooltip.Content>Save query</Tooltip.Content>
                          </Tooltip.Root>
                          <Tooltip.Root>
                            <Tooltip.Trigger asChild>
                              <Button
                                variant='ghost'
                                onClick={handleCancel}
                                disabled={disabled || isSaving}
                                aria-label='Cancel edit'
                              >
                                <X className='h-4 w-4' />
                              </Button>
                            </Tooltip.Trigger>
                            <Tooltip.Content>Cancel edit</Tooltip.Content>
                          </Tooltip.Root>
                        </div>
                      ) : (
                        <>
                          <button
                            type='button'
                            onClick={() => onSelectQuery(item.query)}
                            disabled={disabled || isSaving || mode !== null}
                            className='flex-1 text-left disabled:cursor-not-allowed disabled:opacity-60'
                          >
                            {item.query}
                          </button>
                          <div className='flex items-center gap-1 opacity-0 transition group-hover:opacity-100'>
                            <Tooltip.Root>
                              <Tooltip.Trigger asChild>
                                <button
                                  type='button'
                                  onClick={() => handleEditClick(index)}
                                  disabled={disabled || isSaving}
                                  className='rounded p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60'
                                  aria-label='Edit query'
                                >
                                  <Pencil className='h-3.5 w-3.5' />
                                </button>
                              </Tooltip.Trigger>
                              <Tooltip.Content>Edit query</Tooltip.Content>
                            </Tooltip.Root>
                            <Tooltip.Root>
                              <Tooltip.Trigger asChild>
                                <button
                                  type='button'
                                  onClick={() => handleDelete(index)}
                                  disabled={disabled || isSaving}
                                  className='rounded p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60'
                                  aria-label='Delete query'
                                >
                                  {savingAction?.type === 'delete' &&
                                  savingAction.index === index ? (
                                    <Loader2 className='h-3.5 w-3.5 animate-spin' />
                                  ) : (
                                    <Trash2 className='h-3.5 w-3.5' />
                                  )}
                                </button>
                              </Tooltip.Trigger>
                              <Tooltip.Content>Delete query</Tooltip.Content>
                            </Tooltip.Root>
                          </div>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {mode === 'add' && (
              <div className='rounded-[8px] border border-[var(--border-200)] bg-[var(--color-ds-surface-raised)] p-3'>
                <div className='flex items-center gap-2'>
                  <input
                    value={draftValue}
                    onChange={(event) => setDraftValue(event.target.value)}
                    placeholder='Type your query'
                    disabled={disabled || isSaving}
                    ref={addInputRef}
                    className='h-[34px] flex-1 rounded-[6px] border border-[var(--border-200)] px-3 text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary-hover-hex)] disabled:cursor-not-allowed disabled:opacity-60'
                  />
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <Button
                        variant='ghost'
                        onClick={handleSave}
                        disabled={disabled || isSaving}
                        aria-label='Save query'
                      >
                        {savingAction?.type === 'save' ? (
                          <Loader2 className='h-4 w-4 animate-spin' />
                        ) : (
                          <Check className='h-4 w-4' />
                        )}
                      </Button>
                    </Tooltip.Trigger>
                    <Tooltip.Content>Save query</Tooltip.Content>
                  </Tooltip.Root>
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <Button
                        variant='ghost'
                        onClick={handleCancel}
                        disabled={disabled || isSaving}
                        aria-label='Cancel add'
                      >
                        <X className='h-4 w-4' />
                      </Button>
                    </Tooltip.Trigger>
                    <Tooltip.Content>Cancel add</Tooltip.Content>
                  </Tooltip.Root>
                </div>
                {errorMessage && (
                  <div className='mt-2 text-[12px] text-[var(--text-error)]'>{errorMessage}</div>
                )}
              </div>
            )}

            {draftQueries.length > 0 && (
              <div className='flex justify-center pt-1'>
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <Button variant='default' onClick={handleAddClick} disabled={isAddDisabled}>
                      Add Query
                    </Button>
                  </Tooltip.Trigger>
                  <Tooltip.Content>Add a new query</Tooltip.Content>
                </Tooltip.Root>
              </div>
            )}
          </div>
        </Tooltip.Provider>
      </ChipModalBody>
      <ChipModalFooter
        cancelLabel='Close'
        onCancel={() => onOpenChange(false)}
        defaultAction='dismiss'
      />
    </ChipModal>
  )
}
