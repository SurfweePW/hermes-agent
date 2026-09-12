import { type FormEvent, type KeyboardEvent, useEffect, useRef } from 'react'

interface MessageComposerProps {
  id: string
  draft: string
  disabled?: boolean
  label: string
  placeholder: string
  sendLabel: string
  submitting?: boolean
  hint?: string
  onDraftChange(draft: string): void
  onSubmit(): void
}

export function MessageComposer({
  id,
  draft,
  disabled = false,
  label,
  placeholder,
  sendLabel,
  submitting = false,
  hint,
  onDraftChange,
  onSubmit
}: MessageComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const canSubmit = !disabled && !submitting && Boolean(draft.trim())

  useEffect(() => {
    const textarea = textareaRef.current

    if (!textarea) {return}
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 176)}px`
  }, [draft])

  const submit = () => {
    if (canSubmit) {onSubmit()}
  }

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter'
      && (event.metaKey || event.ctrlKey)
      && !event.nativeEvent.isComposing
      && !event.repeat) {
      event.preventDefault()
      submit()
    }
  }

  return <div className="composer-dock">
    <form className="composer" onSubmit={(event: FormEvent) => {event.preventDefault(); submit()}}>
      <label className="sr-only" htmlFor={id}>{label}</label>
      <textarea id={id} onChange={(event) => onDraftChange(event.target.value)} onKeyDown={keyDown} placeholder={placeholder} ref={textareaRef} rows={5} value={draft} />
      <button aria-label={sendLabel} disabled={!canSubmit} type="submit">{submitting ? '…' : '↑'}</button>
    </form>
    {hint && <p className="composer-hint">{hint}</p>}
  </div>
}
