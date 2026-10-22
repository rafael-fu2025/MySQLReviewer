import { useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { MoreHorizontal, Moon, Sparkles, Sun, X, type LucideIcon } from 'lucide-react';
import { IconButton, Modal } from './ui';
import { cn } from '@/lib/utils';

export interface BottomNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

/** Mirrors the store's theme preference, including the "system" option. */
type ThemePreference = 'dark' | 'light' | 'system';

interface BottomNavProps {
  /** Destinations shown directly in the bar. */
  items: BottomNavItem[];
  /** Destinations reached through the "More" sheet. */
  overflow: BottomNavItem[];
  /** Label and state for the AI provider shortcut. */
  aiLabel: string;
  aiActive: boolean;
  theme: ThemePreference;
  onToggleTheme: () => void;
}

/**
 * Phone navigation.
 *
 * The icon rail is hidden on narrow screens, where it would eat a seventh of
 * the viewport and sit out of thumb reach. This bar takes its place at the
 * bottom of the screen, with the less common destinations behind "More".
 */
export function BottomNav({
  items,
  overflow,
  aiLabel,
  aiActive,
  theme,
  onToggleTheme,
}: BottomNavProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const overflowActive = overflow.some((item) => location.pathname === item.to);

  const openSheet = (): void => setSheetOpen(true);
  const closeSheet = (): void => setSheetOpen(false);

  return (
    <>
      <nav className="bottom-nav" aria-label="Primary">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => cn('bottom-nav-item', isActive && 'active')}
            >
              <Icon size={19} />
              <span className="truncate">{item.label}</span>
            </NavLink>
          );
        })}
        <button
          type="button"
          className={cn('bottom-nav-item', overflowActive && 'active')}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          onClick={openSheet}
        >
          <MoreHorizontal size={19} />
          <span>More</span>
        </button>
      </nav>

      <Modal
        open={sheetOpen}
        onClose={closeSheet}
        ariaLabel="More sections"
        backdropStyle={{ alignItems: 'flex-end', padding: 0 }}
        panelStyle={{
          maxWidth: 560,
          borderRadius: '18px 18px 0 0',
          maxHeight: '78vh',
        }}
        header={
          <div className="sheet-head">
            <div className="sheet-title">More</div>
            <IconButton label="Close" onClick={closeSheet}>
              <X size={16} />
            </IconButton>
          </div>
        }
        bodyClassName="sheet-body"
      >
        {overflow.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => cn('sheet-item', isActive && 'active')}
              onClick={closeSheet}
            >
              <Icon size={17} />
              <span>{item.label}</span>
            </NavLink>
          );
        })}

        <div className="sheet-divider" />

        <button
          type="button"
          className="sheet-item"
          onClick={() => {
            closeSheet();
            navigate('/settings?tab=ai');
          }}
        >
          <Sparkles size={17} className={aiActive ? 'text-ember' : ''} />
          <span className="truncate">{aiLabel}</span>
        </button>

        <button type="button" className="sheet-item" onClick={onToggleTheme}>
          {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
          <span>{theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}</span>
        </button>
      </Modal>
    </>
  );
}
