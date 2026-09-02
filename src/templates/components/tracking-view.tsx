'use client';

import { useState } from 'react';

/**
 * The public order-tracking page (Phase 8, items 5 and 6): the phone-last-4 gate, the order
 * itself, and — while the self-service window is open — edit and cancel.
 *
 * NO i18n IMPORT — matching every other storefront client component. `trackingCode` arrives from
 * the URL server-side and is trusted only as a display value and a request parameter; the phone
 * digits are the actual credential, re-sent with every call exactly as the routes require.
 */

interface TrackedOrderLine {
  id: string;
  nameSnapshot: string;
  priceAgorot: number;
  quantity: number;
  subtotalAgorot: number;
}

interface TrackedOrder {
  number: number;
  status: string;
  customerName: string;
  customerPhone: string;
  customerNote: string | null;
  deliveryArea: string | null;
  deliveryAddress: string | null;
  paymentMethod: string | null;
  subtotalAgorot: number | null;
  discountAgorot: number;
  deliveryFeeAgorot: number;
  totalAgorot: number;
  currency: string;
  trackingCode: string;
  placedAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  items: TrackedOrderLine[];
  canSelfService: boolean;
  editWindowEndsAt: string | null;
}

export interface TrackingViewLabels {
  gateTitle: string;
  gateHint: string;
  phoneLast4: string;
  gateSubmit: string;
  gateSubmitting: string;
  notFound: string;
  statuses: Record<string, string>;
  orderNumber: string;
  items: string;
  subtotal: string;
  discount: string;
  deliveryFee: string;
  total: string;
  deliveryArea: string;
  deliveryAddress: string;
  paymentMethod: string;
  paymentMethods: Record<string, string>;
  editUntil: string;
  edit: string;
  cancel: string;
  editHeading: string;
  name: string;
  phone: string;
  note: string;
  saveEdit: string;
  saving: string;
  cancelHeading: string;
  cancelReasonLabel: string;
  confirmCancel: string;
  cancelling: string;
  cancelledNotice: string;
  back: string;
  errors: TrackingErrorLabels;
}

/** See `CheckoutErrorLabels`'s own comment (checkout-view.tsx) — the same
 *  explicit-keys-plus-index-signature shape, for the same reason. */
export interface TrackingErrorLabels {
  failed: string;
  not_found: string;
  window_closed: string;
  [reason: string]: string;
}

export function TrackingView({ trackingCode, labels }: { trackingCode: string; labels: TrackingViewLabels }) {
  const [phoneLast4, setPhoneLast4] = useState('');
  const [order, setOrder] = useState<TrackedOrder | null>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'cancel'>('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function lookup(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/storefront/order/${encodeURIComponent(trackingCode)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phoneLast4 }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; order?: TrackedOrder } | null;

      if (response.ok && body?.ok && body.order) {
        setOrder(body.order);
      } else {
        setError(labels.notFound);
      }
    } catch {
      setError(labels.errors.failed);
    } finally {
      setBusy(false);
    }
  }

  if (!order) {
    return (
      <form className="sf-checkout" method="post" onSubmit={lookup} noValidate>
        <h1 className="sf-checkout__title">{labels.gateTitle}</h1>
        <p className="sf-note">{labels.gateHint}</p>

        {error ? (
          <p className="sf-checkout__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="sf-field">
          <label className="sf-label" htmlFor="tracking-phone-last4">
            {labels.phoneLast4}
          </label>
          <input
            className="sf-input"
            id="tracking-phone-last4"
            name="phoneLast4"
            type="text"
            inputMode="numeric"
            pattern="\d{4}"
            dir="ltr"
            required
            maxLength={4}
            value={phoneLast4}
            onChange={(event) => setPhoneLast4(event.target.value.replace(/\D/g, '').slice(0, 4))}
          />
        </div>

        <button type="submit" className="sf-btn" disabled={busy || phoneLast4.length !== 4}>
          {busy ? labels.gateSubmitting : labels.gateSubmit}
        </button>
      </form>
    );
  }

  if (mode === 'edit') {
    return (
      <EditOrderForm
        trackingCode={trackingCode}
        phoneLast4={phoneLast4}
        order={order}
        labels={labels}
        onSaved={(updated) => {
          setOrder(updated);
          setMode('view');
        }}
        onCancel={() => setMode('view')}
      />
    );
  }

  if (mode === 'cancel') {
    return (
      <CancelOrderForm
        trackingCode={trackingCode}
        phoneLast4={phoneLast4}
        labels={labels}
        onCancelled={(reason) => {
          setOrder({ ...order, status: 'cancelled', cancelledAt: new Date().toISOString(), cancelReason: reason, canSelfService: false });
          setMode('view');
        }}
        onBack={() => setMode('view')}
      />
    );
  }

  return (
    <div className="sf-cart">
      <h1 className="sf-block__title">{labels.orderNumber.replace('{number}', String(order.number))}</h1>

      <p>
        <span className="sf-badge">{labels.statuses[order.status] ?? order.status}</span>
      </p>

      {order.status === 'cancelled' && order.cancelReason ? (
        <p className="sf-note">{labels.cancelledNotice}: {order.cancelReason}</p>
      ) : null}

      <h2 className="sf-checkout__title">{labels.items}</h2>
      <ul className="sf-cart__lines">
        {order.items.map((item) => (
          <li className="sf-cart__line" key={item.id}>
            <span className="sf-cart__line-name">{item.nameSnapshot} × {item.quantity}</span>
            <span className="sf-price">{(item.subtotalAgorot / 100).toFixed(2)} ₪</span>
          </li>
        ))}
      </ul>

      <dl className="sf-cart__totals">
        {order.subtotalAgorot !== null ? (
          <div>
            <dt>{labels.subtotal}</dt>
            <dd>{(order.subtotalAgorot / 100).toFixed(2)} ₪</dd>
          </div>
        ) : null}
        {order.discountAgorot > 0 ? (
          <div>
            <dt>{labels.discount}</dt>
            <dd>−{(order.discountAgorot / 100).toFixed(2)} ₪</dd>
          </div>
        ) : null}
        <div>
          <dt>{labels.deliveryFee}</dt>
          <dd>{(order.deliveryFeeAgorot / 100).toFixed(2)} ₪</dd>
        </div>
        <div className="sf-cart__totals-grand">
          <dt>{labels.total}</dt>
          <dd className="sf-price">{(order.totalAgorot / 100).toFixed(2)} ₪</dd>
        </div>
      </dl>

      <dl className="sf-facts">
        {order.deliveryArea ? (
          <div>
            <dt>{labels.deliveryArea}</dt>
            <dd>{order.deliveryArea}</dd>
          </div>
        ) : null}
        {order.deliveryAddress ? (
          <div>
            <dt>{labels.deliveryAddress}</dt>
            <dd>{order.deliveryAddress}</dd>
          </div>
        ) : null}
        {order.paymentMethod ? (
          <div>
            <dt>{labels.paymentMethod}</dt>
            <dd>{labels.paymentMethods[order.paymentMethod] ?? order.paymentMethod}</dd>
          </div>
        ) : null}
      </dl>

      {order.canSelfService ? (
        <>
          {order.editWindowEndsAt ? <p className="sf-note">{labels.editUntil}</p> : null}
          <p className="sf-actions">
            <button type="button" className="sf-btn sf-btn--ghost" onClick={() => setMode('edit')}>
              {labels.edit}
            </button>
            <button type="button" className="sf-btn sf-btn--ghost" onClick={() => setMode('cancel')}>
              {labels.cancel}
            </button>
          </p>
        </>
      ) : null}
    </div>
  );
}

function EditOrderForm({
  trackingCode,
  phoneLast4,
  order,
  labels,
  onSaved,
  onCancel,
}: {
  trackingCode: string;
  phoneLast4: string;
  order: TrackedOrder;
  labels: TrackingViewLabels;
  onSaved: (order: TrackedOrder) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);

    const payload = {
      phoneLast4,
      customerName: String(form.get('customerName') ?? '').trim(),
      customerPhone: String(form.get('customerPhone') ?? '').trim(),
      deliveryArea: String(form.get('deliveryArea') ?? '').trim() || undefined,
      deliveryAddress: String(form.get('deliveryAddress') ?? '').trim() || undefined,
      customerNote: String(form.get('customerNote') ?? '').trim() || undefined,
    };

    try {
      const response = await fetch(`/api/storefront/order/${encodeURIComponent(trackingCode)}/edit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        onSaved({
          ...order,
          customerName: payload.customerName,
          customerPhone: payload.customerPhone,
          deliveryArea: payload.deliveryArea ?? null,
          deliveryAddress: payload.deliveryAddress ?? null,
          customerNote: payload.customerNote ?? null,
        });
        return;
      }

      const body = (await response.json().catch(() => null)) as { reason?: string } | null;
      setError(labels.errors[body?.reason ?? 'failed'] ?? labels.errors.failed);
    } catch {
      setError(labels.errors.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="sf-checkout" method="post" onSubmit={submit} noValidate>
      <h2 className="sf-checkout__title">{labels.editHeading}</h2>

      {error ? (
        <p className="sf-checkout__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="sf-field">
        <label className="sf-label" htmlFor="edit-name">
          {labels.name}
        </label>
        <input className="sf-input" id="edit-name" name="customerName" defaultValue={order.customerName} required maxLength={120} />
      </div>

      <div className="sf-field">
        <label className="sf-label" htmlFor="edit-phone">
          {labels.phone}
        </label>
        <input className="sf-input" id="edit-phone" name="customerPhone" dir="ltr" defaultValue={order.customerPhone} required maxLength={20} />
      </div>

      <div className="sf-field">
        <label className="sf-label" htmlFor="edit-area">
          {labels.deliveryArea}
        </label>
        <input className="sf-input" id="edit-area" name="deliveryArea" defaultValue={order.deliveryArea ?? ''} maxLength={80} />
      </div>

      <div className="sf-field">
        <label className="sf-label" htmlFor="edit-address">
          {labels.deliveryAddress}
        </label>
        <input className="sf-input" id="edit-address" name="deliveryAddress" defaultValue={order.deliveryAddress ?? ''} maxLength={500} />
      </div>

      <div className="sf-field">
        <label className="sf-label" htmlFor="edit-note">
          {labels.note}
        </label>
        <textarea className="sf-textarea" id="edit-note" name="customerNote" rows={2} defaultValue={order.customerNote ?? ''} maxLength={500} />
      </div>

      <p className="sf-actions">
        <button type="submit" className="sf-btn" disabled={busy}>
          {busy ? labels.saving : labels.saveEdit}
        </button>
        <button type="button" className="sf-btn sf-btn--ghost" onClick={onCancel}>
          {labels.back}
        </button>
      </p>
    </form>
  );
}

function CancelOrderForm({
  trackingCode,
  phoneLast4,
  labels,
  onCancelled,
  onBack,
}: {
  trackingCode: string;
  phoneLast4: string;
  labels: TrackingViewLabels;
  onCancelled: (reason: string) => void;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();

    try {
      const response = await fetch(`/api/storefront/order/${encodeURIComponent(trackingCode)}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phoneLast4, reason }),
      });

      if (response.ok) {
        onCancelled(reason);
        return;
      }

      const body = (await response.json().catch(() => null)) as { reason?: string } | null;
      setError(labels.errors[body?.reason ?? 'failed'] ?? labels.errors.failed);
    } catch {
      setError(labels.errors.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="sf-checkout" method="post" onSubmit={submit} noValidate>
      <h2 className="sf-checkout__title">{labels.cancelHeading}</h2>

      {error ? (
        <p className="sf-checkout__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="sf-field">
        <label className="sf-label" htmlFor="cancel-reason">
          {labels.cancelReasonLabel}
        </label>
        <textarea className="sf-textarea" id="cancel-reason" name="reason" rows={3} required maxLength={300} />
      </div>

      <p className="sf-actions">
        <button type="submit" className="sf-btn" disabled={busy}>
          {busy ? labels.cancelling : labels.confirmCancel}
        </button>
        <button type="button" className="sf-btn sf-btn--ghost" onClick={onBack}>
          {labels.back}
        </button>
      </p>
    </form>
  );
}
