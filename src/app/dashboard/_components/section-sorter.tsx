'use client';

import { useState } from 'react';
import { t } from '@/shared/i18n';

/**
 * Section order and visibility, in ONE submit.
 *
 * Reordering and hiding are the same gesture on this screen, and two endpoints would let a
 * merchant leave the halves disagreeing — a section hidden in one save and moved in another with
 * a failed request in between. So the whole arrangement posts as one field plus one checkbox per
 * row, and the server writes it in one transaction.
 *
 * Same accessibility posture as the product sorter: the move buttons are the real control, the
 * drag is the shortcut, and every move is announced. A merchant does this on a phone.
 */

export interface SectionItem {
  id: string;
  label: string;
  enabled: boolean;
}

export function SectionSorter({ items, showLabel, hideLabel }: {
  items: SectionItem[];
  showLabel: string;
  hideLabel: string;
}) {
  const [order, setOrder] = useState(items);
  const [dragging, setDragging] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  function reorder(from: number, to: number) {
    setOrder((current) => {
      if (from === -1 || to < 0 || to >= current.length) return current;
      const copy = [...current];
      const [item] = copy.splice(from, 1);
      copy.splice(to, 0, item!);
      setAnnouncement(t('dashboard', 'products.movedTo', { name: item!.label, position: to + 1 }));
      return copy;
    });
  }

  return (
    <>
      <input type="hidden" name="order" value={order.map((item) => item.id).join(',')} />

      <p className="sbd-hint" role="status" aria-live="polite">
        {announcement}
      </p>

      <ol className="sbd-sortable">
        {order.map((item, index) => (
          <li
            key={item.id}
            draggable
            data-dragging={dragging === item.id ? 'true' : undefined}
            onDragStart={() => setDragging(item.id)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (!dragging) return;
              reorder(
                order.findIndex((row) => row.id === dragging),
                index,
              );
              setDragging(null);
            }}
          >
            <span className="sbd-grip" aria-hidden="true">
              ⋮⋮
            </span>

            <label className="sbd-check sbd-sortable-name">
              <input type="checkbox" name={`enabled-${item.id}`} defaultChecked={item.enabled} />
              <span>
                {item.label}
                <span className="sbd-hint">{item.enabled ? showLabel : hideLabel}</span>
              </span>
            </label>

            <button
              type="button"
              className="sbd-btn sbd-btn--sm"
              onClick={() => reorder(index, index - 1)}
              disabled={index === 0}
              aria-label={t('dashboard', 'products.moveUpOf', { name: item.label })}
            >
              {t('dashboard', 'products.moveUp')}
            </button>
            <button
              type="button"
              className="sbd-btn sbd-btn--sm"
              onClick={() => reorder(index, index + 1)}
              disabled={index === order.length - 1}
              aria-label={t('dashboard', 'products.moveDownOf', { name: item.label })}
            >
              {t('dashboard', 'products.moveDown')}
            </button>
          </li>
        ))}
      </ol>
    </>
  );
}
