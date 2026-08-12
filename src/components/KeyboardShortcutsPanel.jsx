import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import { registerShortcutsPanelOpener } from './shortcutsPanelOpener';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl';

const Kbd = ({ children }) => (
  <kbd className="px-2 py-1 rounded-md bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-[11px] font-mono font-bold text-gray-600 dark:text-gray-300 shadow-sm">
    {children}
  </kbd>
);

// 🟩 FEATURE: Linear/GitHub/Notion-style "?" shortcuts cheatsheet. Purely
// discoverability -- every shortcut listed here already works without
// this panel; this just tells people it exists. Opened via the global "?"
// key (see App.jsx) or the command palette's "Keyboard Shortcuts" entry.
const KeyboardShortcutsPanel = () => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);

  useEffect(() => {
    registerShortcutsPanelOpener(open);
  }, [open]);

  const groups = [
    {
      title: t('shortcuts.groupGeneral'),
      items: [
        { keys: [MOD, 'K'], label: t('shortcuts.commandPalette') },
        { keys: ['?'], label: t('shortcuts.openThisPanel') },
        { keys: ['Esc'], label: t('shortcuts.closeDialogs') },
      ],
    },
    {
      title: t('shortcuts.groupNavigation'),
      items: [
        { keys: ['↑', '↓'], label: t('shortcuts.navigateResults') },
        { keys: ['Enter'], label: t('shortcuts.selectResult') },
        { keys: ['Tab'], label: t('shortcuts.moveFocus') },
      ],
    },
  ];

  return (
    <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title={t('shortcuts.title')}>
      <div className="space-y-5">
        {groups.map((group) => (
          <div key={group.title}>
            <h3 className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">{group.title}</h3>
            <div className="space-y-2">
              {group.items.map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-gray-600 dark:text-gray-300 font-medium">{item.label}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    {item.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
};

export default KeyboardShortcutsPanel;
