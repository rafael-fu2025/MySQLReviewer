import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ComboOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
  icon?: ReactNode;
  disabled?: boolean;
  keywords?: string;
}

interface Position {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

/**
 * The popover's DOM nodes.
 *
 * These are kept out of the state object below: the React compiler treats any
 * object that holds refs as ref-like and then rejects every property access
 * on it during render.
 */
interface ComboRefs<TTrigger extends HTMLElement> {
  buttonRef: RefObject<TTrigger | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
}

interface ComboState {
  id: string;
  open: boolean;
  position: Position | null;
  setOpen: (value: boolean) => void;
}

function useComboPopover<TTrigger extends HTMLElement = HTMLButtonElement>(
  maxHeight: number,
): { combo: ComboState; refs: ComboRefs<TTrigger> } {
  const [open, setOpenState] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const buttonRef = useRef<TTrigger | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const id = useId();

  const updatePosition = (): void => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const width = Math.min(Math.max(rect.width, 250), viewportWidth - 16);
    const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
    const below = viewportHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const openUp = below < 230 && above > below;
    const height = Math.max(160, Math.min(maxHeight, openUp ? above : below));
    const top = openUp ? Math.max(8, rect.top - height - 6) : rect.bottom + 6;
    setPosition({ left, top, width, maxHeight: height });
  };

  const setOpen = (value: boolean): void => {
    setOpenState(value);
    if (value) updatePosition();
    else setPosition(null);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onViewport = (): void => updatePosition();
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('resize', onViewport);
    window.addEventListener('scroll', onViewport, true);
    const timer = setTimeout(() => inputRef.current?.focus(), 20);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('scroll', onViewport, true);
      clearTimeout(timer);
    };
    // The position is recalculated each time the popover opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return {
    combo: { id, open, position, setOpen },
    refs: { buttonRef, popoverRef, inputRef },
  };
}

/**
 * Holds the search text and the highlighted option, and filters the options.
 *
 * The search box is reset when the popover opens. That adjusts state during
 * render rather than in an effect, so the list is already correct on the
 * frame it appears.
 */
function useComboSearch(
  options: ComboOption[],
  open: boolean,
): {
  query: string;
  setQuery: (value: string) => void;
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  filtered: ComboOption[];
} {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery('');
      setActiveIndex(0);
    }
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) =>
      [option.label, option.description ?? '', option.group ?? '', option.keywords ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [options, query]);

  return { query, setQuery, activeIndex, setActiveIndex, filtered };
}

function OptionRow({
  option,
  selected,
  active,
  onSelect,
  onHover,
  renderOption,
}: {
  option: ComboOption;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
  onHover: () => void;
  renderOption?: (option: ComboOption, selected: boolean) => ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={option.disabled}
      className={cn(
        'combo-option',
        active && 'combo-option-active',
        option.disabled && 'opacity-45',
      )}
      onMouseEnter={onHover}
      onClick={onSelect}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {selected ? <Check size={13} className="text-ember" /> : null}
      </span>
      {option.icon ? <span className="shrink-0 text-muted">{option.icon}</span> : null}
      <span className="min-w-0 flex-1 text-left">
        {renderOption ? (
          renderOption(option, selected)
        ) : (
          <>
            <span className="block truncate text-xs text-ink-soft">{option.label}</span>
            {option.description ? (
              <span className="block truncate text-2xs text-muted">{option.description}</span>
            ) : null}
          </>
        )}
      </span>
    </button>
  );
}

function ComboList({
  id,
  position,
  popoverRef,
  inputRef,
  searchQuery,
  onSearchQuery,
  onClose,
  options,
  activeIndex,
  onActiveIndex,
  isSelected,
  onSelect,
  multi,
  onDone,
  footer,
  renderOption,
  emptyText,
  searchPlaceholder,
  clearable,
  hasSelection,
  onClear,
}: {
  id: string;
  position: Position | null;
  popoverRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQuery: (value: string) => void;
  onClose: () => void;
  options: ComboOption[];
  activeIndex: number;
  onActiveIndex: (index: number) => void;
  isSelected: (option: ComboOption) => boolean;
  onSelect: (option: ComboOption) => void;
  multi: boolean;
  onDone: () => void;
  footer?: ReactNode;
  renderOption?: (option: ComboOption, selected: boolean) => ReactNode;
  emptyText: string;
  searchPlaceholder: string;
  clearable: boolean;
  hasSelection: boolean;
  onClear: () => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, ComboOption[]>();
    for (const option of options) {
      const group = option.group ?? '';
      const list = map.get(group) ?? [];
      list.push(option);
      map.set(group, list);
    }
    return Array.from(map.entries());
  }, [options]);

  const clampedActive = Math.max(0, Math.min(options.length - 1, activeIndex));

  return (
    <div
      ref={popoverRef}
      className="combo-popover"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        width: position?.width ?? 250,
        maxHeight: position?.maxHeight ?? 320,
      }}
      role="listbox"
      aria-multiselectable={multi || undefined}
      aria-labelledby={`${id}-trigger`}
    >
      <div className="combo-search">
        <Search size={13} className="shrink-0 text-muted" />
        <input
          ref={inputRef}
          value={searchQuery}
          onChange={(event) => {
            onSearchQuery(event.target.value);
            onActiveIndex(0);
          }}
          placeholder={searchPlaceholder}
          role="searchbox"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key === 'Tab') {
              onClose();
              return;
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              onActiveIndex(Math.min(options.length - 1, clampedActive + 1));
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              onActiveIndex(Math.max(0, clampedActive - 1));
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              const option = options[clampedActive];
              if (option && !option.disabled) onSelect(option);
              if (!multi) onDone();
            }
          }}
        />
      </div>

      <div className="combo-options">
        {options.length === 0 ? (
          <div className="px-3 py-5 text-center text-2xs text-muted">{emptyText}</div>
        ) : (
          groups.map(([group, items]) => (
            <div key={group || '_default'}>
              {group ? <div className="combo-group">{group}</div> : null}
              {items.map((option) => {
                const index = options.findIndex((item) => item.value === option.value);
                return (
                  <OptionRow
                    key={option.value}
                    option={option}
                    selected={isSelected(option)}
                    active={index === clampedActive}
                    onHover={() => onActiveIndex(index)}
                    onSelect={() => {
                      if (option.disabled) return;
                      onSelect(option);
                      if (!multi) onDone();
                    }}
                    renderOption={renderOption}
                  />
                );
              })}
            </div>
          ))
        )}
      </div>

      {(footer || multi || (clearable && hasSelection)) && (
        <div className="combo-footer">
          {clearable && hasSelection ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>
              Clear
            </button>
          ) : null}
          {footer}
          {multi ? (
            <button type="button" className="btn btn-primary btn-sm ml-auto" onClick={onDone}>
              Done
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No options match.',
  disabled,
  className,
  buttonClassName,
  maxHeight = 320,
  footer,
  clearable = true,
  renderOption,
  ariaLabel,
}: {
  options: ComboOption[];
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  buttonClassName?: string;
  maxHeight?: number;
  footer?: ReactNode;
  clearable?: boolean;
  renderOption?: (option: ComboOption, selected: boolean) => ReactNode;
  ariaLabel?: string;
}) {
  const { combo, refs } = useComboPopover(maxHeight);
  const { buttonRef } = refs;
  const { query, setQuery, activeIndex, setActiveIndex, filtered } = useComboSearch(
    options,
    combo.open,
  );
  const selected = options.find((option) => option.value === value) ?? null;

  return (
    <div className={cn('relative', className)}>
      <button
        ref={buttonRef}
        id={`${combo.id}-trigger`}
        type="button"
        className={cn('combo-button', buttonClassName)}
        disabled={disabled}
        onClick={() => combo.setOpen(!combo.open)}
        onKeyDown={(event) => {
          if (['ArrowDown', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            combo.setOpen(true);
          }
          if (event.key === 'Escape') combo.setOpen(false);
        }}
        aria-haspopup="listbox"
        aria-expanded={combo.open}
        aria-controls={combo.open ? `${combo.id}-list` : undefined}
        aria-label={ariaLabel}
      >
        {selected?.icon ? <span className="shrink-0 text-muted">{selected.icon}</span> : null}
        <span className={cn('min-w-0 flex-1 truncate text-left', !selected && 'text-muted')}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown
          size={13}
          className={cn('shrink-0 text-muted transition', combo.open && 'rotate-180')}
        />
      </button>

      {combo.open && combo.position
        ? createPortal(
            <div id={`${combo.id}-list`}>
              <ComboList
                id={combo.id}
                position={combo.position}
                popoverRef={refs.popoverRef}
                inputRef={refs.inputRef}
                searchQuery={query}
                onSearchQuery={setQuery}
                onClose={() => combo.setOpen(false)}
                options={filtered}
                activeIndex={activeIndex}
                onActiveIndex={setActiveIndex}
                isSelected={(option) => option.value === value}
                onSelect={(option) => onChange(option.value)}
                multi={false}
                onDone={() => combo.setOpen(false)}
                footer={footer}
                renderOption={renderOption}
                emptyText={emptyText}
                searchPlaceholder={searchPlaceholder}
                clearable={clearable}
                hasSelection={Boolean(selected)}
                onClear={() => onChange('')}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * A free-text field with the app's dropdown menu attached: any typed value is
 * kept, and known values render as suggestions in the combo popover. This
 * replaces the native `datalist` popup, which is OS-styled and clashes with
 * the design (the model fields on Practice and in ProviderForm).
 */
export function TextCombobox({
  value,
  onChange,
  options,
  placeholder = '',
  emptyText = 'No matches.',
  disabled,
  className,
  inputClassName,
  maxHeight = 280,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ComboOption[];
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  maxHeight?: number;
  ariaLabel?: string;
}) {
  const { combo, refs } = useComboPopover<HTMLDivElement>(maxHeight);
  const { buttonRef, popoverRef, inputRef } = refs;
  const [activeIndex, setActiveIndex] = useState(0);
  const [wasOpen, setWasOpen] = useState(combo.open);

  if (combo.open !== wasOpen) {
    setWasOpen(combo.open);
    if (combo.open) setActiveIndex(0);
  }

  // The typed value doubles as the filter, exactly like the datalist did.
  const needle = value.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      needle
        ? options.filter((option) =>
            [option.label, option.value, option.keywords ?? '']
              .join(' ')
              .toLowerCase()
              .includes(needle),
          )
        : options,
    [options, needle],
  );
  const clamped = Math.max(0, Math.min(filtered.length - 1, activeIndex));

  const commit = (option: ComboOption): void => {
    onChange(option.value);
    combo.setOpen(false);
  };

  return (
    <div ref={buttonRef} className={cn('relative', className)}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={combo.open}
        aria-controls={combo.open ? `${combo.id}-list` : undefined}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        className={cn('input pr-8', inputClassName)}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
          combo.setOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            combo.setOpen(true);
            setActiveIndex(Math.min(filtered.length - 1, clamped + 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex(Math.max(0, clamped - 1));
          } else if (event.key === 'Enter') {
            if (combo.open && filtered[clamped] && !filtered[clamped].disabled) {
              event.preventDefault();
              commit(filtered[clamped]);
            }
          } else if (event.key === 'Escape') {
            combo.setOpen(false);
          }
        }}
      />
      <span
        aria-hidden="true"
        className="pointer-events-auto absolute inset-y-0 right-0 flex w-7 cursor-pointer items-center justify-center text-muted"
        onMouseDown={(event) => {
          event.preventDefault();
          if (!disabled) combo.setOpen(!combo.open);
        }}
      >
        <ChevronDown size={13} className={cn('transition', combo.open && 'rotate-180')} />
      </span>

      {combo.open && combo.position
        ? createPortal(
            <div id={`${combo.id}-list`}>
              <div
                ref={popoverRef}
                className="combo-popover"
                style={{
                  left: combo.position.left,
                  top: combo.position.top,
                  width: combo.position.width,
                  maxHeight: combo.position.maxHeight,
                }}
                role="listbox"
                aria-label={ariaLabel}
              >
                <div className="combo-options">
                  {filtered.length === 0 ? (
                    <div className="px-3 py-5 text-center text-2xs text-muted">{emptyText}</div>
                  ) : (
                    filtered.map((option, index) => (
                      <OptionRow
                        key={option.value}
                        option={option}
                        selected={option.value === value}
                        active={index === clamped}
                        onHover={() => setActiveIndex(index)}
                        onSelect={() => commit(option)}
                      />
                    ))
                  )}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export function MultiSelect({
  options,
  values,
  onChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No options match.',
  disabled,
  className,
  buttonClassName,
  maxHeight = 320,
  footer,
  renderOption,
  showSelectAll = false,
  selectAllLabel = 'Select all',
}: {
  options: ComboOption[];
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  buttonClassName?: string;
  maxHeight?: number;
  footer?: ReactNode;
  renderOption?: (option: ComboOption, selected: boolean) => ReactNode;
  showSelectAll?: boolean;
  selectAllLabel?: string;
}) {
  const { combo, refs } = useComboPopover(maxHeight);
  const { buttonRef } = refs;
  const { query, setQuery, activeIndex, setActiveIndex, filtered } = useComboSearch(
    options,
    combo.open,
  );
  const selectedSet = new Set(values);
  const selectedOptions = options.filter((option) => selectedSet.has(option.value));
  const enabledOptions = options.filter((option) => !option.disabled);

  const toggle = (option: ComboOption): void => {
    if (option.disabled) return;
    if (selectedSet.has(option.value)) {
      onChange(values.filter((value) => value !== option.value));
    } else {
      onChange([...values, option.value]);
    }
  };

  return (
    <div className={cn('relative', className)}>
      <button
        ref={buttonRef}
        id={`${combo.id}-trigger`}
        type="button"
        className={cn('combo-button', buttonClassName)}
        disabled={disabled}
        onClick={() => combo.setOpen(!combo.open)}
        onKeyDown={(event) => {
          if (['ArrowDown', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            combo.setOpen(true);
          }
          if (event.key === 'Escape') combo.setOpen(false);
        }}
        aria-haspopup="listbox"
        aria-expanded={combo.open}
        aria-controls={combo.open ? `${combo.id}-list` : undefined}
      >
        <span
          className={cn('min-w-0 flex-1 truncate text-left', values.length === 0 && 'text-muted')}
        >
          {values.length === 0
            ? placeholder
            : values.length <= 2
              ? selectedOptions.map((option) => option.label).join(', ')
              : `${values.length} selected`}
        </span>
        <ChevronDown
          size={13}
          className={cn('shrink-0 text-muted transition', combo.open && 'rotate-180')}
        />
      </button>

      {combo.open && combo.position
        ? createPortal(
            <div id={`${combo.id}-list`}>
              <ComboList
                id={combo.id}
                position={combo.position}
                popoverRef={refs.popoverRef}
                inputRef={refs.inputRef}
                searchQuery={query}
                onSearchQuery={setQuery}
                onClose={() => combo.setOpen(false)}
                options={filtered}
                activeIndex={activeIndex}
                onActiveIndex={setActiveIndex}
                isSelected={(option) => selectedSet.has(option.value)}
                onSelect={toggle}
                multi
                onDone={() => combo.setOpen(false)}
                footer={
                  <>
                    {showSelectAll ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() =>
                          onChange(
                            values.length === enabledOptions.length
                              ? []
                              : enabledOptions.map((option) => option.value),
                          )
                        }
                      >
                        {values.length === enabledOptions.length ? 'Clear all' : selectAllLabel}
                      </button>
                    ) : null}
                    {footer}
                  </>
                }
                renderOption={renderOption}
                emptyText={emptyText}
                searchPlaceholder={searchPlaceholder}
                clearable
                hasSelection={values.length > 0}
                onClear={() => onChange([])}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
