'use client';

import { useRef, useState } from 'react';
import { t } from '@/shared/i18n';

/**
 * Drag-and-drop ordering — with a keyboard path that is not an afterthought.
 *
 * Native HTML5 drag events rather than a library: the list is a dozen rows of text and a
 * thumbnail, and a drag-and-drop dependency would be the largest thing in this bundle for the
 * benefit of a gesture that already exists in the platform.
 *
 * The MOVE BUTTONS ARE THE REAL CONTROL and the drag is the shortcut, not the other way round.
 * Pointer drag is unreachable by keyboard, unreliable with a screen reader and genuinely hard on
 * a touch screen the size of a phone — which is where a shop owner actually does this, standing
 * in their own shop. Every reorder therefore has a button, each move announces itself through a
 * live region, and the whole order is submitted as ONE hidden field so a half-applied sequence
 * cannot exist.
 *
 * RTL note: "up" and "down" are the axis this list runs on, so they need no mirroring — which is
 * exactly why the buttons are vertical rather than "previous/next".
 */

export interface SortableItem {
  id: string;
  name: string;
  previewUrl: string | null;
  /** Pre-rendered on the server: price, status. Strings only — no copy is built here. */
  meta: string;
}

export function ProductSorter({
  items,
  action,
  submitLabel,
}: {
  items: SortableItem[];
  action: (formData: FormData) => void | Promise<void>;
  submitLabel: string;
}) {
  const [order, setOrder] = useState(items);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const dirty = useRef(false);

  function move(id: string, delta: number) {
    setOrder((current) => {
      const index = current.findIndex((item) => item.id === id);
      const next = index + delta;
      if (index === -1 || next < 0 || next >= current.length) return current;

      const copy = [...current];
      const [item] = copy.splice(index, 1);
      copy.splice(next, 0, item!);

      dirty.current = true;
      setAnnouncement(
        t('dashboard', 'products.movedTo', { name: item!.name, position: next + 1 }),
      );
      return copy;
    });
  }

  function drop(targetId: string) {
    setOrder((current) => {
      if (!dragging || dragging === targetId) return current;

      const from = current.findIndex((item) => item.id === dragging);
      const to = current.findIndex((item) => item.id === targetId);
      if (from === -1 || to === -1) return current;

      const copy = [...current];
      const [item] = copy.splice(from, 1);
      copy.splice(to, 0, item!);

      dirty.current = true;
      setAnnouncement(t('dashboard', 'products.movedTo', { name: item!.name, position: to + 1 }));
      return copy;
    });

    setDragging(null);
    setOver(null);
  }

  return (
    <form action={action}>
      <input type="hidden" name="order" value={order.map((item) => item.id).join(',')} />

      {/* Every reorder is spoken, once, in the language of the page. */}
      <p className="sbd-hint" role="status" aria-live="polite">
        {announcement}
      </p>

      <ol className="sbd-sortable">
        {order.map((item, index) => (
          <li
            key={item.id}
            draggable
            data-dragging={dragging === item.id ? 'true' : undefined}
            data-over={over === item.id && dragging !== item.id ? 'true' : undefined}
            onDragStart={() => setDragging(item.id)}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(item.id);
            }}
            onDrop={(event) => {
              event.preventDefault();
              drop(item.id);
            }}
          >
            <span className="sbd-grip" aria-hidden="true">
              ⋮⋮
            </span>

            {item.previewUrl ? (
              /*
                A CDN variant A3 already produced at 400px, not an upload — `next/image` would
                route it through the app server's optimiser, which invariant 4 forbids for public
                delivery, and pointing it at the CDN means a loader in `next.config.ts`, a
                forbidden shared file. Same reasoning A2 records in media-image.tsx.

                `alt=""` is deliberate: the product name is the accessible label immediately
                beside it, and a duplicate would make a screen reader say every product twice.
              */
              // eslint-disable-next-line @next/next/no-img-element
              <img className="sbd-thumb" src={item.previewUrl} alt="" width={48} height={48} />
            ) : (
              <span className="sbd-thumb" aria-hidden="true" />
            )}

            <span className="sbd-sortable-name">
              {item.name}
              <span className="sbd-hint">{item.meta}</span>
            </span>

            <button
              type="button"
              className="sbd-btn sbd-btn--sm"
              onClick={() => move(item.id, -1)}
              disabled={index === 0}
              aria-label={t('dashboard', 'products.moveUpOf', { name: item.name })}
            >
              {t('dashboard', 'products.moveUp')}
            </button>
            <button
              type="button"
              className="sbd-btn sbd-btn--sm"
              onClick={() => move(item.id, 1)}
              disabled={index === order.length - 1}
              aria-label={t('dashboard', 'products.moveDownOf', { name: item.name })}
            >
              {t('dashboard', 'products.moveDown')}
            </button>
          </li>
        ))}
      </ol>

      <div className="sbd-actions">
        <button type="submit" className="sbd-btn sbd-btn--primary">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
